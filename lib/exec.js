import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { failure, issue } from "./errors.js";
import { spillStatus } from "./spill.js";

const MISSING_EXECUTABLE = new Set(["ENOENT", "SUBPROCESS_EXECUTABLE_NOT_FOUND"]);
const RESOLUTION_ERRORS = new Set([...MISSING_EXECUTABLE, "EACCES", "EPERM", "ENOEXEC"]);

function positive(value, fallback, maximum, name) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw issue("EINVAL", `${name} must be an integer from 1 to ${maximum}`);
  }
  return selected;
}

async function findProgram(subprocess, candidates, signal) {
  let rejected;
  for (const candidate of new Set(candidates)) {
    try {
      return await subprocess.resolveExecutable(candidate, undefined, signal);
    } catch (error) {
      if (!RESOLUTION_ERRORS.has(error.code)) throw error;
      if (!MISSING_EXECUTABLE.has(error.code)) rejected ??= error;
    }
  }
  throw rejected ?? issue("ENOENT", "No supported executable found");
}

async function missingSpawnProgram(error, program, cwd) {
  if (error?.code !== "ENOENT" || error.path !== program || error.syscall !== `spawn ${program}`) return false;
  try {
    if (!(await stat(cwd)).isDirectory()) return false;
    await access(cwd, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function gitBashCandidates(bashPath) {
  const preferred = bashPath ? [bashPath] : [];
  if (process.platform !== "win32") return [...preferred, "/bin/bash", "/usr/bin/bash"];
  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs"),
  ].filter(Boolean);
  // Use Git for Windows, not the Bash launcher for WSL.
  const gitOnPath = (process.env.Path ?? process.env.PATH ?? "").split(delimiter)
    .map(path => path.replace(/^"|"$/gu, ""))
    .filter(path => /(?:^|[\\/])(?:portablegit|git)(?:[\\/]current)?[\\/](?:usr[\\/])?(?:bin|cmd)[\\/]?$/iu.test(path))
    .map(path => join(path, "..", "bin", "bash.exe"));
  const scoop = process.env.SCOOP ?? (process.env.USERPROFILE && join(process.env.USERPROFILE, "scoop"));
  return [...preferred, ...roots.map(root => join(root, "Git", "bin", "bash.exe")), ...gitOnPath,
    ...(scoop ? [join(scoop, "apps", "git", "current", "bin", "bash.exe")] : [])];
}

export function powerShellCandidates() {
  if (process.platform !== "win32") return ["pwsh"];
  return [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ];
}

function shellArgv(program, command, bash) {
  if (bash) return [program, "--noprofile", "--norc", "-c", command];
  const script = "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {\n"
    + "  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n"
    + "  $OutputEncoding = [Console]::OutputEncoding\n}\n" + command;
  return [program, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")];
}

function keepTail(previous, bytes, limit) {
  if (bytes.length >= limit) return Buffer.from(bytes.subarray(bytes.length - limit));
  return Buffer.concat([previous.subarray(Math.max(0, previous.length + bytes.length - limit)), bytes]);
}

function skipPartialStart(buffer) {
  let start = 0;
  while (start < 3 && start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}

function utf8Preview(buffer, bytes, limit, fromEnd) {
  const clipped = bytes > limit;
  if (clipped) {
    buffer = fromEnd ? skipPartialStart(buffer.subarray(Math.max(0, buffer.length - limit))) : buffer.subarray(0, limit);
  }
  const text = clipped && !fromEnd ? new StringDecoder("utf8").write(buffer) : buffer.toString("utf8");
  if (Buffer.byteLength(text) <= limit) return { text, truncated: clipped };
  const encoded = Buffer.from(text);
  const fitted = fromEnd
    ? skipPartialStart(encoded.subarray(encoded.length - limit)).toString("utf8")
    : new StringDecoder("utf8").write(encoded.subarray(0, limit));
  return { text: fitted, truncated: true };
}

function stderrTail(buffer, bytes, limit) {
  const clipped = bytes > buffer.length;
  const text = (clipped ? skipPartialStart(buffer) : buffer).toString("utf8");
  const lines = text.replace(/\r?\n$/u, "").split(/\r?\n/u);
  const tail = Buffer.from(lines.slice(-20).join("\n"));
  const preview = utf8Preview(tail, tail.length, limit, true);
  return { text: preview.text, truncated: clipped || lines.length > 20 || preview.truncated };
}

async function collect(handle, limit, spill, invocation, signal) {
  const prefix = [];
  let prefixBytes = 0;
  let stdoutTail = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderr = Buffer.alloc(0);
  let stderrBytes = 0;
  let stderrNewlines = 0;
  let stderrEndsWithNewline = false;
  let total = 0;
  let writer;
  let spillError;
  let outputError;
  let queue = Promise.resolve();
  async function write(kind, bytes) {
    total += bytes.length;
    if (kind === "stdout") {
      stdoutBytes += bytes.length;
      stdoutTail = keepTail(stdoutTail, bytes, limit);
      if (prefixBytes < limit) {
        const part = bytes.subarray(0, limit - prefixBytes);
        prefix.push(Buffer.from(part));
        prefixBytes += part.length;
      }
    } else if (kind === "stderr") {
      stderrBytes += bytes.length;
      if (!writer && !spillError) {
        for (const byte of bytes) if (byte === 10) stderrNewlines++;
        stderrEndsWithNewline = bytes.at(-1) === 10;
      }
      stderr = keepTail(stderr, bytes, Math.max(limit, 4096));
    }
    try {
      const longStderr = stderrNewlines + Number(stderrBytes > 0 && !stderrEndsWithNewline) > 20;
      if ((total > limit || longStderr) && !writer && !spillError) {
        writer = await spill.open(invocation);
        for (const entry of firstChunks) await writer.write(entry);
        firstChunks.length = 0;
      }
      if (writer && !spillError) await writer.write(bytes);
      else if (!spillError) firstChunks.push(Buffer.from(bytes));
    } catch (error) {
      spillError = error;
      firstChunks.length = 0;
    }
  }
  const firstChunks = [];
  async function pump(kind, stream) {
    try {
      for await (const chunk of stream) {
        queue = queue.then(() => write(kind, Buffer.from(chunk)));
        await queue;
      }
    } catch (error) {
      outputError ??= error;
      handle.terminate();
    }
  }
  const processResult = Promise.allSettled([handle.done, handle.waitForExit()])
    .then(([done, cleanup]) => ({ done, cleanup, stopped: signal.aborted }));
  const [{ done, cleanup, stopped }] = await Promise.all([
    processResult, pump("stdout", handle.stdout), pump("stderr", handle.stderr),
  ]);
  const exitCode = done.status === "fulfilled" ? done.value.exitCode : null;
  const reserved = Math.min(stdoutBytes, 4096, Math.ceil(limit / 2));
  const stderrPreview = stderrTail(stderr, stderrBytes, limit - reserved);
  const stdoutLimit = limit - Buffer.byteLength(stderrPreview.text);
  const useTail = stopped || exitCode !== 0;
  const stdout = utf8Preview(useTail ? stdoutTail : Buffer.concat(prefix, prefixBytes), stdoutBytes, stdoutLimit, useTail);
  if (!writer && !spillError && (stdout.truncated || stderrPreview.truncated)
    && done.status === "fulfilled" && cleanup.status === "fulfilled" && !outputError) {
    try {
      writer = await spill.open(invocation);
      for (const entry of firstChunks) await writer.write(entry);
    } catch (error) {
      spillError = error;
    }
  }
  let spillPath = null;
  if (writer) {
    try {
      if (spillError || outputError || done.status === "rejected" || cleanup.status === "rejected") await writer.discard();
      else {
        await writer.commit();
        spillPath = writer.path;
      }
    } catch (error) {
      spillError ??= error;
      await writer.discard().catch(() => {});
    }
  }
  const result = {
    exitCode,
    stdout: stdout.text, stderr: stderrPreview.text,
    truncated: total > limit || stdout.truncated || stderrPreview.truncated,
    spillPath,
  };
  let processError;
  if (cleanup.status === "rejected") processError = issue("CLEANUP", `Process-tree cleanup could not be verified: ${cleanup.reason?.message}`);
  else if (done.status === "rejected") processError = done.reason;
  else if (outputError) processError = issue("PROCESS_IO", `Cannot capture Shell output: ${outputError.message}`);
  return {
    result, spillError, processError, stopped, diagnosticStderr: stderr.toString("utf8"),
    startupError: cleanup.status === "fulfilled" && done.status === "rejected" && total === 0 && !outputError
      ? done.reason : undefined,
  };
}

function sandboxFailure(confinement, result, stderr, windowsPowerShell) {
  if (!confinement || result.exitCode === null) return;
  const lines = stderr.toLowerCase().split(/\r?\n/u);
  if (result.exitCode !== 0) {
    for (const rule of confinement.runnerFailureRules ?? []) {
      if (rule.allowedExitCodes && !rule.allowedExitCodes.includes(result.exitCode)) continue;
      const skip = new Set((rule.informationalLines ?? []).map(line => line.toLowerCase()));
      if (lines.some(line => !skip.has(line)
        && rule.fatalSignatures.some(signature => signature.trim() && line.includes(signature.toLowerCase())))) {
        return issue("EACCES", "The DSH sandbox runner reported a failure");
      }
    }
  }
  const denialSignature = confinement.denialSignatures?.some(signature => lines.some(line => line.includes(signature.toLowerCase())));
  if (windowsPowerShell) {
    result.suspectedSandboxDenial = Boolean(denialSignature
      || /\b(?:UnauthorizedAccessException|PermissionDenied|access is denied|access to the path|permission denied|operation not permitted)\b|拒绝访问|拒絕存取/iu.test(stderr));
  }
  if (result.exitCode !== 0 && denialSignature) {
    return issue("EACCES", "The DSH sandbox rejected an operation");
  }
}

const empty = () => ({
  cwd: null, shell: null, shellUsed: null, shellFallback: false, suspectedSandboxDenial: false,
  exitCode: null, stdout: "", stderr: "", truncated: false, spillPath: null,
});

function windowsBashStartup(exitCode, stderr) {
  return (exitCode >>> 0) === 0xc0000142
    || /\b(?:msys|cygwin)\b[^\r\n]*\*\*\* fatal error|could(?: not|n't) create signal pipe/iu.test(stderr);
}

export function createExec({ subprocess, resolveCwd, sandboxFor, spill, bashCandidates = gitBashCandidates, psCandidates = powerShellCandidates }) {
  return async function exec(args, invocation) {
    const result = empty();
    let signal;
    let deadline;
    try {
      if (typeof args.command !== "string" || !args.command.trim() || args.command.includes("\0")) {
        throw issue("EINVAL", "command must be a non-empty string without NUL");
      }
      if (args.shell !== undefined && !["bash", "powershell"].includes(args.shell)) {
        throw issue("EINVAL", "shell must be bash or powershell");
      }
      const timeout = positive(args.timeoutMs, 30000, 300000, "timeoutMs");
      const limit = positive(args.maxOutputBytes, 16384, 65536, "maxOutputBytes");
      deadline = AbortSignal.timeout(timeout);
      signal = invocation?.signal ? AbortSignal.any([deadline, invocation.signal]) : deadline;
      const cwd = await resolveCwd(args.cwd ?? ".", { ...invocation, signal });
      result.cwd = cwd;
      const sandbox = await sandboxFor(invocation);
      const restrictedWindows = process.platform === "win32" && Boolean(sandbox);
      const preferredShell = args.shell ?? (restrictedWindows ? "powershell" : "bash");
      const shells = args.shell === undefined && preferredShell === "bash" ? ["bash", "powershell"] : [preferredShell];
      let execution;
      let confinement;
      for (const shell of shells) {
        const bash = shell === "bash";
        const canFallback = bash && shells.length === 2;
        signal.throwIfAborted();
        let program;
        try {
          program = await findProgram(subprocess, bash ? bashCandidates() : psCandidates(), signal);
        } catch (error) {
          if (canFallback && !signal.aborted && MISSING_EXECUTABLE.has(error.code)) continue;
          throw error;
        }
        result.shell = shell;
        result.shellUsed = shell;
        result.shellFallback = shell !== preferredShell;
        const argv = shellArgv(program, args.command, bash);
        confinement = sandbox ? await sandbox(argv, signal) : null;
        if (sandbox && (!Array.isArray(confinement?.argv) || !confinement.argv[0])) {
          throw issue("EACCES", "DSH sandbox did not return an enforcing command");
        }
        signal.throwIfAborted();
        let handle;
        try {
          handle = subprocess.spawn({
            argv: confinement?.argv ?? argv, cwd, signal, graceMs: 500,
            env: { BASH_ENV: "", ENV: "", CDPATH: "" },
            stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
          });
        } catch (error) {
          // Confined argv names a runner. Its launch errors do not establish
          // that an alternate Shell can safely use the same permission policy.
          if (canFallback && !sandbox && !signal.aborted && await missingSpawnProgram(error, program, cwd)) continue;
          throw error;
        }
        execution = await collect(handle, limit, spill, invocation, signal);
        if (canFallback && !sandbox && !signal.aborted
          && await missingSpawnProgram(execution.startupError, program, cwd)) continue;
        break;
      }
      Object.assign(result, execution.result, spillStatus(execution.spillError));
      if (execution.stopped && execution.processError?.code !== "CLEANUP") {
        return failure(issue(signal.reason === deadline.reason ? "TIMEOUT" : "ABORTED", "Shell execution stopped"), result);
      }
      if (execution.processError) return failure(execution.processError, result);
      const denied = sandboxFailure(confinement, result, execution.diagnosticStderr,
        restrictedWindows && result.shellUsed === "powershell");
      if (result.suspectedSandboxDenial) {
        result.hint = "PowerShell reported a possible file-access denial. Check the target path and current DSH permissions.";
      }
      if (denied) return failure(denied, result);
      if (result.exitCode !== 0) {
        if (restrictedWindows && args.shell === "bash" && windowsBashStartup(result.exitCode, execution.diagnosticStderr)) {
          result.diagnostic = {
            code: "WINDOWS_BASH_STARTUP",
            message: "Git Bash could not initialize under the current Windows DSH sandbox.",
            hint: 'Use shell: "powershell" for a PowerShell-compatible command under the current permissions.',
          };
        }
        return failure(issue("EXIT_NONZERO", `Shell exited with code ${result.exitCode}`), result);
      }
      return { ok: true, ...result };
    } catch (error) {
      if (signal?.aborted && error?.code !== "CLEANUP") {
        error = issue(signal.reason === deadline.reason ? "TIMEOUT" : "ABORTED", "Shell execution stopped");
      }
      return failure(error, result);
    }
  };
}
