import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { createExec, gitBashCandidates } from "../lib/exec.js";
import { createFileTools } from "../lib/files.js";
import { createSpill } from "../lib/spill.js";

const work = await mkdtemp(join(process.env.LITE_SMOKE_PARENT ?? tmpdir(), "lite-smoke-"));
const spill = createSpill(join(work, "data"));
const authorize = async (path, context) => resolve(context?.cwd ?? work, path);
const tools = createFileTools({ fs, authorize, spill });
const windows = process.platform === "win32";
const powershell = process.argv.includes("--powershell");
const commandFor = (bash, ps) => powershell ? { command: ps, shell: "powershell" } : { command: bash };

// Standalone smoke adapter. The actual plugin always uses DSH's subprocess service.
let launchCount = 0;
const subprocess = {
  async resolveExecutable(path) {
    if (path.includes("/") || path.includes("\\")) await access(path);
    return path;
  },
  spawn(spec) {
    launchCount++;
    const proc = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !windows,
      env: { ...process.env, ...spec.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    let started = false;
    const terminate = () => {
      if (!proc.pid) return;
      try {
        if (windows) execFileSync(join(process.env.SystemRoot, "System32", "taskkill.exe"),
          ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        else process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    };
    proc.once("spawn", () => { started = true; if (spec.signal.aborted) terminate(); });
    spec.signal.addEventListener("abort", terminate, { once: true });
    const done = new Promise((resolve, reject) => {
      proc.once("error", error => {
        if (started) error.code = "PROCESS_IO";
        reject(error);
      });
      proc.once("close", (exitCode, signal) => {
        spec.signal.removeEventListener("abort", terminate);
        resolve({ exitCode, signal });
      });
    });
    return { done, terminate, stdout: proc.stdout, stderr: proc.stderr, waitForExit: () => done.catch(() => {}) };
  },
};
const settings = { subprocess, resolveCwd: authorize, sandboxFor: () => null, spill };
const liteExec = createExec(settings);
const timings = [];
async function scenario(name, run) {
  const start = performance.now();
  await run();
  timings.push([name, Math.round(performance.now() - start)]);
}

try {
  await scenario("normal command", async () => {
    const result = await liteExec(commandFor("printf 'ready\\n'", '[Console]::Write("ready`n")'));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.stdout, "ready\n");
  });
  await scenario("nonzero, last 20 stderr lines, no rerun", async () => {
    const before = launchCount;
    const result = await liteExec(commandFor('echo once >> failure-marker; for i in {1..25}; do printf "err%s\\n" "$i" >&2; done; exit 7',
      '[IO.File]::AppendAllText("failure-marker", "once`n"); 1..25 | ForEach-Object { [Console]::Error.WriteLine("err$_") }; exit 7'));
    assert.equal(launchCount, before + 1);
    assert.equal(await readFile(join(work, "failure-marker"), "utf8"), "once\n");
    assert.equal(result.exitCode, 7);
    assert.equal(result.code, "EXIT_NONZERO");
    assert.equal(result.shellUsed, powershell ? "powershell" : "bash");
    assert.equal(result.shellFallback, false);
    assert.deepEqual(result.stderr.split("\n"), Array.from({ length: 20 }, (_, n) => "err" + (n + 6)));
  });
  await scenario("timeout and descendant cleanup", async () => {
    const before = launchCount;
    const start = performance.now();
    const timeoutExec = windows && !powershell ? createExec({ ...settings, bashCandidates: () => [] }) : liteExec;
    const command = windows
      ? 'Add-Content -LiteralPath timeout-marker -Value once; $c = Start-Process -FilePath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -ArgumentList "-NoProfile","-Command","Start-Sleep -Seconds 30" -WindowStyle Hidden -PassThru; Write-Output ("x" * 400); Write-Output $c.Id; $c.WaitForExit()'
      : "echo once >> timeout-marker; sleep 30 & printf '%400s\\n' x; echo $!; wait";
    const result = await timeoutExec({ command, ...(powershell ? { shell: "powershell" } : {}), timeoutMs: 2100, maxOutputBytes: 64 });
    assert.equal(result.code, "TIMEOUT", JSON.stringify(result));
    assert.equal(launchCount, before + 1);
    assert.deepEqual((await readFile(join(work, "timeout-marker"), "utf8")).trimEnd().split(/\r?\n/u), ["once"]);
    assert.equal(result.truncated, true);
    assert.ok(performance.now() - start < 5000, "Process cleanup exceeded the timeout allowance");
    const pid = Number(result.stdout.trimEnd().split(/\r?\n/u).at(-1));
    assert.ok(Number.isInteger(pid) && pid > 1);
    if (windows || process.platform === "darwin") {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } else {
      const info = await readFile("/proc/" + pid + "/stat", "utf8").catch(() => "");
      assert.ok(!info || /\) Z /u.test(info), info);
    }
  });
  await scenario("failure stdout tail, raw spill, and exit hints", async () => {
    const result = await liteExec({
      ...commandFor("printf 'start\\n'; head -c 12000 /dev/zero | tr '\\000' x; printf '\\nLAST-ERROR 中文\\n'; printf 'stderr-detail\\n' >&2; exit 3",
        '[Console]::Write("start`n" + ("x" * 12000) + "`nLAST-ERROR 中文`n"); [Console]::Error.Write("stderr-detail`n"); exit 3'),
      maxOutputBytes: 128,
    });
    assert.equal(result.code, "EXIT_NONZERO", JSON.stringify(result));
    assert.equal(result.exitCode, 3);
    assert.match(result.stdout, /LAST-ERROR 中文\n$/u);
    assert.equal(result.stderr, "stderr-detail");
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 128);
    const raw = await readFile(result.spillPath, "utf8");
    assert.ok(raw.includes("stderr-detail\n"));
    assert.equal(raw.replace("stderr-detail\n", ""), "start\n" + "x".repeat(12000) + "\nLAST-ERROR 中文\n");
    assert.equal(result.hint, `lite_read(${JSON.stringify({ path: result.spillPath })})`);
    const ordinary = await liteExec(commandFor("exit 3", "exit 3"));
    const missing = await liteExec(commandFor("exit 127", "exit 127"));
    if (missing.shellUsed === "bash") {
      assert.notEqual(missing.hint, ordinary.hint);
      assert.match(missing.hint, /PATH/u);
    } else {
      assert.equal(missing.hint, ordinary.hint);
    }
  });
  await scenario("15 MiB and bounded preview", async () => {
    const size = 15 * 1024 * 1024;
    const result = await liteExec({ ...commandFor(`head -c ${size} /dev/zero | tr '\\000' x`,
      '$block = "x" * 60KB; foreach ($n in 1..256) { [Console]::Write($block) }'), maxOutputBytes: 1024 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.truncated, true);
    assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 1024);
    const output = await readFile(result.spillPath);
    assert.equal(output.length, size);
    assert.ok(output.every(byte => byte === 120));
    const edges = await liteExec({ ...commandFor("printf 'first-'; printf '%400s' x; printf 'last'",
      '[Console]::Write("first-" + (" " * 399) + "xlast")'), maxOutputBytes: 16 });
    assert.match(edges.stdout, /^first-/u);
    assert.doesNotMatch(edges.stdout, /last/u);
    const binary = await liteExec({ ...commandFor("printf '\\377\\377'", '[Console]::OpenStandardOutput().Write([byte[]](255,255), 0, 2)'), maxOutputBytes: 4 });
    assert.equal(binary.ok, true, JSON.stringify(binary));
    assert.ok(Buffer.byteLength(binary.stdout) <= 4);
    assert.equal(binary.truncated, true);
    assert.deepEqual(await readFile(binary.spillPath), Buffer.from([255, 255]));
  });
  await scenario("permission-denied spill keeps command result and preview", async () => {
    let spillAttempts = 0;
    const unwritable = createExec({ ...settings, spill: { async open() {
      spillAttempts++;
      throw Object.assign(new Error("spill destination is unwritable"), { code: "EACCES" });
    } } });
    const before = launchCount;
    const result = await unwritable({ ...commandFor("printf 'preview-'; printf '%1024s' x",
      '[Console]::Write("preview-" + (" " * 1023) + "x")'), maxOutputBytes: 64 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, true);
    assert.equal(result.spillPath, null);
    assert.equal(result.spill?.reason, "UNAVAILABLE");
    assert.equal(result.spillError, "spill destination is unwritable");
    assert.match(result.stdout, /^preview-/u);
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 64);
    assert.equal(launchCount, before + 1);
    assert.equal(spillAttempts, 1);
  });
  const chinese = join(work, "中文 空格");
  await mkdir(chinese);
  await writeFile(join(chinese, "测试 文件.txt"), "甲乙😀丙\n第二行 needle\n第三行 needle\n");
  await scenario("Chinese and spaced path, byte boundaries, encodings", async () => {
    const result = await liteExec({ ...commandFor("pwd", "Write-Output (Get-Location).Path"), cwd: "中文 空格" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.cwd, chinese);
    assert.equal(result.shell, powershell ? "powershell" : "bash");
    assert.match(result.stdout, /中文 空格/u);
    const file = join(chinese, "测试 文件.txt");
    assert.equal((await tools.stat({ path: file })).exists, true);
    assert.equal((await tools.read({ path: file, offsetBytes: 1, limitBytes: 7 })).content, "乙");
    for (const [encoding, data, content] of [
      ["utf-16le", [0xff, 0xfe, 0x2d, 0x4e], "中"],
      ["utf-16be", [0xfe, 0xff, 0x4e, 0x2d], "中"],
      ["gbk", [0xd6, 0xd0, 0xce, 0xc4], "中文"],
    ]) {
      const path = join(chinese, encoding);
      await writeFile(path, Buffer.from(data));
      const result = await tools.read({ path });
      assert.equal(result.encoding, encoding, JSON.stringify(result));
      assert.equal(result.content, content);
    }
    const path = join(chinese, "binary");
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 255]));
    assert.equal((await tools.read({ path })).binary, true);
  });
  await scenario("missing path and candidate", async () => {
    const result = await tools.read({ path: join(chinese, "测试 文.txt") });
    assert.equal(result.code, "ENOENT", JSON.stringify(result));
    assert.equal(result.exists, false);
    assert.ok(result.candidates.some(path => path.endsWith("测试 文件.txt")));
  });
  await scenario("grep overflow and complete result", async () => {
    const fixture = join(chinese, "results.json");
    await writeFile(fixture, '{"match":"needle"}\n'.repeat(5000));
    const result = await tools.grep({ path: chinese, pattern: "needle", maxMatches: 3, include: "*.json" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.matches.length, 3);
    assert.equal(result.matchCount, 5000);
    assert.equal(result.complete, true);
    assert.equal(result.truncated, true);
    const rows = (await readFile(result.fullResultPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 5000);
    assert.deepEqual(rows.slice(0, 3), result.matches);
    const small = await tools.grep({ path: chinese, pattern: "needle", maxBytes: 12, include: "*.txt" });
    assert.equal(small.ok, true);
    assert.deepEqual(small.matches, []);
    assert.equal(small.matchCount, 2);
    assert.equal(small.truncated, true);
    assert.equal(small.complete, true);
    assert.ok(small.fullResultPath);
    const denied = createFileTools({ fs, authorize, spill: { async open() { throw new Error("spill unavailable"); } } });
    const preview = await denied.grep({ path: chinese, pattern: "needle", maxMatches: 1, include: "*.json" });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.matchCount, 5000);
    assert.equal(preview.matches.length, 1);
    assert.equal(preview.truncated, true);
    assert.equal(preview.complete, true);
    assert.equal(preview.fullResultPath, null);
    assert.equal(preview.spill?.reason, "UNAVAILABLE");
  });
  await scenario("grep zero matches and literal pipe", async () => {
    const path = join(chinese, "pipe.txt");
    await writeFile(path, "A|B\nA\nB\n");
    const literal = await tools.grep({ path, pattern: "A|B" });
    assert.deepEqual(literal.matches.map(match => match.text), ["A|B"]);
    assert.equal(literal.matchCount, 1);
    assert.equal(literal.truncated, false);
    const zero = await tools.grep({ path, pattern: "A|C" });
    assert.equal(zero.ok, true);
    assert.equal(zero.matchCount, 0);
    assert.equal(zero.truncated, false);
    assert.equal(zero.complete, true);
    assert.match(zero.hint, /Literal only.*native grep/u);
  });
  if (windows) await scenario("PowerShell fallback only before launch", async () => {
    const bashCandidates = () => [join(work, "missing", "bash.exe")];
    const fallback = createExec({ ...settings, bashCandidates });
    const before = launchCount;
    const result = await fallback({ command: "Write-Output 'fallback'" });
    assert.equal(result.ok, true, JSON.stringify({ result, git: gitBashCandidates().map(dirname) }));
    assert.equal(result.stdout.trim(), "fallback");
    assert.equal(result.shell, "powershell");
    assert.equal(result.shellUsed, "powershell");
    assert.equal(result.shellFallback, true);
    assert.equal(launchCount, before + 1);
  });
  if (windows) await scenario("restricted explicit Bash startup diagnosis without fallback", async () => {
    let spawnCount = 0;
    const diagnose = createExec({ ...settings, bashCandidates: () => ["fixture-bash"], sandboxFor: () => () => ({ argv: ["fixture-runner"] }),
      subprocess: {
        resolveExecutable: async program => program,
        spawn({ argv }) {
          assert.deepEqual(argv, ["fixture-runner"]);
          spawnCount++;
          return { stdout: Readable.from([]), stderr: Readable.from([]), terminate() {}, waitForExit: async () => {},
            done: Promise.resolve({ exitCode: 0xc0000142 }) };
        },
      } });
    const result = await diagnose({ command: "printf 'fixture'", shell: "bash" });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, "EXIT_NONZERO");
    assert.equal(result.diagnostic?.code, "WINDOWS_BASH_STARTUP");
    assert.equal(result.shellUsed, "bash");
    assert.equal(result.shellFallback, false);
    assert.equal(spawnCount, 1);
  });
  await scenario("sandbox failure stays closed", async () => {
    const before = launchCount;
    const blocked = createExec({ ...settings, sandboxFor: () => () => {
      throw Object.assign(new Error("sandbox fixture unavailable"), { code: "SANDBOX_UNAVAILABLE" });
    } });
    const result = await blocked({ command: "printf 'must not launch'" });
    assert.equal(result.code, "EACCES");
    assert.equal(launchCount, before);
  });
  console.log(JSON.stringify({ shellControl: powershell ? "explicit powershell" : "default shell", passed: timings.length,
    scenariosMs: Object.fromEntries(timings) }, null, 2));
} catch (error) {
  await rm(work, { recursive: true, force: true, maxRetries: 2 }).catch(cleanup => { error.cleanup = cleanup; });
  throw error;
}
await rm(work, { recursive: true, force: true, maxRetries: 2 });
