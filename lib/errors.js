const hints = {
  ENOENT: "Check the target path or executable name.",
  EACCES: "Check the target path and current DSH permissions.",
  EISDIR: "Select a file to read, or use lite_grep to search the directory.",
  BINARY: "Use lite_read for a hex preview or process the bytes with a script.",
  TIMEOUT: "Narrow the search or command. For lite_exec you can also increase timeoutMs (up to 300000).",
  EXIT_NONZERO: "Check the stderr and stdout tails for the command's error.",
  SPILL: "Narrow the search or command output. Check the spill error before retrying.",
  EINVAL: "Check the tool's required arguments, types and supported limits.",
};

export function issue(code, message) {
  return Object.assign(new Error(message), { code });
}

function executionHint(code, result) {
  const spillPath = result.spillPath ?? result.fullResultPath;
  if (typeof spillPath === "string" && spillPath.length <= 1024) {
    return `lite_read(${JSON.stringify({ path: spillPath })})`;
  }
  if (code === "EXIT_NONZERO" && result.shell === "bash") {
    if (result.exitCode === 127) return "Check the command name and PATH in Bash. Use command -v to check whether the executable is available.";
    if (result.exitCode === 126) return "Check execute permissions and the executable format. See the stderr tail.";
  }
}

export function failure(error, extra = {}) {
  const aliases = {
    EPERM: "EACCES", FS_PERMISSION_DENIED: "EACCES", FS_NOT_FOUND: "ENOENT",
    SUBPROCESS_EXECUTABLE_NOT_FOUND: "ENOENT", SUBPROCESS_SPAWN_NOT_FOUND: "ENOENT",
    SANDBOX_UNAVAILABLE: "EACCES", ABORT_ERR: "ABORTED",
  };
  const raw = error?.code;
  const code = typeof raw === "string" ? (aliases[raw] ?? raw) : error?.name === "AbortError" ? "ABORTED" : "EIO";
  const path = extra.path ?? error?.path;
  const pathHint = typeof path === "string" && path.length <= 1024 && code === "ENOENT"
    ? `lite_stat(${JSON.stringify({ path })})`
    : undefined;
  return {
    ...extra,
    ok: false,
    code,
    message: String(error?.message ?? error).slice(0, 1200),
    hint: extra.diagnostic?.hint ?? extra.hint ?? (code === "TIMEOUT" ? hints.TIMEOUT : executionHint(code, extra))
      ?? pathHint ?? hints[code] ?? "Check the error message and the tool arguments before retrying.",
  };
}
