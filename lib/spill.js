import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { issue } from "./errors.js";

const run = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;
const ACL_CACHE_TTL = 30 * 1000;
const STALE_LOCK_MS = 5 * 1000;
const SLOTS = 8;
const FILE_LIMIT = 16 * 1024 * 1024;
const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const options = { windowsHide: true, timeout: 5000, env: {
  SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
  USERPROFILE: process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP,
} };
let sidLookup;
function currentSid() {
  sidLookup ??= run(join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], options)
    .then(({ stdout }) => {
      const sid = stdout.match(/S-1-(?:\d+-)+\d+/u)?.[0];
      if (!sid) throw issue("SPILL", "Cannot determine the current Windows account SID");
      return sid;
    }).catch(error => {
      sidLookup = undefined;
      throw error;
    });
  return sidLookup;
}

export function spillIssue(reason, message) {
  return Object.assign(issue("SPILL", message), { spillReason: reason });
}

export function spillStatus(error) {
  if (!error) return {};
  const message = String(error.message ?? error).slice(0, 1200);
  return { spillError: message, spill: { reason: error.spillReason ?? "UNAVAILABLE", message } };
}

async function realDirectory(path) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || relative(path, await realpath(path)) !== "") {
    throw spillIssue("UNAVAILABLE", "Spill directory must be a real directory at the expected path");
  }
  return info;
}

async function setPrivateWindowsAcl(path, sid) {
  // Replace the entire DACL with a protected single-account rule so explicit
  // non-inherited ACEs from process/sandbox default DACLs are cleared too.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  $acl = New-Object System.Security.AccessControl.DirectorySecurity",
    "  $acl.SetAccessRuleProtection($true, $false)",
    "  $id = New-Object System.Security.Principal.SecurityIdentifier($env:LITE_SPILL_SID)",
    "  $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit",
    "  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($id, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)",
    "  $acl.SetAccessRule($rule)",
    "  Set-Acl -LiteralPath $env:LITE_SPILL_PATH -AclObject $acl",
    "} catch {",
    "  if ($_.Exception -is [System.UnauthorizedAccessException] -or ($_.ErrorRecord -and $_.ErrorRecord.Exception -is [System.UnauthorizedAccessException])) { exit 44 }",
    "  throw",
    "}",
  ].join("\n");
  await run(join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ], { ...options, timeout: 15000, env: { ...options.env, LITE_SPILL_PATH: path, LITE_SPILL_SID: sid } })
    .catch(error => {
      if (error.code === 44) throw spillIssue("ACL_DENIED", "Cannot restrict the spill directory DACL");
      const detail = error.stderr?.match(/<S S="Error">([^<]+)/u)?.[1] ?? error.stderr?.trim() ?? "";
      throw issue("SPILL", `Windows spill ACL setup failed (exit ${error.code}): ${detail.slice(0, 250)}`);
    });
}

async function privateDirectory(path, guard) {
  const created = await mkdir(path, { mode: 0o700 }).then(() => true, error => {
    if (error.code === "EEXIST") return false;
    throw error;
  });
  const info = guard ? await realDirectory(path) : await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw issue("SPILL", "Spill directory must be a real directory");
  if (process.platform !== "win32") {
    if (info.uid !== BigInt(process.getuid()) || (info.mode & 0o077n) !== 0n) {
      throw spillIssue("ACL_DENIED", "Spill directory must be owned by the current account and deny access to other accounts");
    }
    return { created, info };
  }
  if (created) {
    try {
      const sid = await currentSid();
      if (guard) await guard(path);
      await setPrivateWindowsAcl(path, sid);
    } catch (error) {
      try {
        if (guard) await guard(path);
        await rmdir(path);
      } catch {}
      throw error;
    }
  }
  return { created, info };
}

async function verifyWindowsAcl(paths) {
  const sid = await currentSid();
  // An existing directory might have a manually widened ACL. Verify its DACL
  // against the same account and the standard Windows system principals.
  // Reserved exit statuses distinguish DACL rejection from a failed Get-Acl.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "foreach ($path in (ConvertFrom-Json $env:LITE_SPILL_DIRECTORIES)) {",
    "$acl = Get-Acl -LiteralPath $path",
    "if (-not $acl.AreAccessRulesProtected) { exit 42 }",
    "$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])",
    "foreach ($rule in $rules) {",
    "  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($env:LITE_SPILL_SID, 'S-1-5-18', 'S-1-5-32-544')) { exit 43 }",
    "}",
    "}",
  ].join("\n");
  await run(join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ], { ...options, timeout: 15000, env: { ...options.env, LITE_SPILL_DIRECTORIES: JSON.stringify(paths), LITE_SPILL_SID: sid } })
    .catch(error => {
      if (error.code === 42) throw spillIssue("ACL_DENIED", "The spill DACL inherits permissions");
      if (error.code === 43) throw spillIssue("ACL_DENIED", "The spill DACL grants another account access");
      const detail = error.stderr?.match(/<S S="Error">([^<]+)/u)?.[1] ?? error.stderr?.trim() ?? "";
      throw issue("SPILL", `Windows spill ACL verification failed (exit ${error.code}): ${detail.slice(0, 250)}`);
    });
}

async function statIfPresent(path) {
  try { return await lstat(path); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function removeIfPresent(path) {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

function processGone(pid) {
  try { process.kill(pid, 0); } catch (error) { return error.code === "ESRCH"; }
  return false;
}

export async function workspaceSpillPaths(root) {
  if (typeof root !== "string" || !isAbsolute(root) || /^\\\\[.?]\\/u.test(root)) {
    throw spillIssue("UNAVAILABLE", "DSH did not provide an absolute workspace root for spill storage");
  }
  const canonicalRoot = await realpath(root);
  await realDirectory(canonicalRoot);
  return { root: canonicalRoot, base: join(canonicalRoot, ".dsh-lite-exec") };
}

export function createSpill(dataDirectory = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-lite-exec"), workspaceRoot) {
  const base = resolve(dataDirectory);
  const directory = join(base, "spill");
  let ready;

  async function workspaceGuard(path, checkTarget) {
    await realDirectory(workspaceRoot);
    const within = relative(workspaceRoot, path);
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      throw spillIssue("UNAVAILABLE", "Spill target resolves outside the DSH workspace");
    }
    // Directories on the workspace spill path must not redirect, even to a
    // different location inside the workspace. Recheck existing ancestors.
    let current = workspaceRoot;
    for (const part of within.split(sep).slice(0, -1)) {
      current = join(current, part);
      await realDirectory(current);
    }
    const existing = await realpath(path).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    if (existing && relative(path, existing) !== "") {
      throw spillIssue("UNAVAILABLE", "Spill target redirects to a different path");
    }
    await checkTarget?.(path);
  }

  let verifiedAcl;
  async function prepare(guard) {
    if (!guard) await mkdir(resolve(base, ".."), { recursive: true });
    if (guard) await guard(base);
    const { created: newBase, info: baseInfo } = await privateDirectory(base, guard);
    if (process.platform === "win32" && !newBase && !await statIfPresent(directory)) {
      verifiedAcl = undefined;
      await verifyWindowsAcl([base]);
    }
    if (guard) await guard(directory);
    const { created: newDir, info: dirInfo } = await privateDirectory(directory, guard);
    if (process.platform === "win32") {
      const stamp = `${baseInfo.dev}:${baseInfo.ino}|${dirInfo.dev}:${dirInfo.ino}`;
      if (newBase || newDir || verifiedAcl?.stamp !== stamp || Date.now() - verifiedAcl.at >= ACL_CACHE_TTL) {
        verifiedAcl = undefined;
        await verifyWindowsAcl([base, directory]);
        verifiedAcl = { stamp, at: Date.now() };
      }
    }
  }

  return {
    async open(checkTarget) {
      const guard = workspaceRoot ? path => workspaceGuard(path, checkTarget) : undefined;
      try {
        if (guard) {
          // Every invocation runs its own host permission check.
          ready = (ready ?? Promise.resolve()).catch(() => {}).then(() => prepare(guard));
        } else {
          ready ??= prepare().catch(error => { ready = undefined; throw error; });
        }
        await ready;
      } catch (error) {
        throw spillIssue(error.spillReason ?? "UNAVAILABLE", `Cannot prepare private spill directory: ${error.message}`);
      }
      return openSpillFile(directory, guard);
    },
  };
}

async function tryRemoveStaleLock(lock, guard) {
  const info = await statIfPresent(lock);
  if (!info?.isFile()) return false;
  const age = Date.now() - info.mtimeMs;
  if (age < STALE_LOCK_MS) return false;
  let stale = age >= DAY;
  if (!stale) {
    const raw = await readFile(lock, "utf8").catch(error => {
      if (error.code === "ENOENT") return null;
      return "";
    });
    if (raw === null) return true;
    const text = raw.trim();
    if (!text) {
      // An empty lock file untouched for >= STALE_LOCK_MS indicates a crash between open() and writeFile().
      stale = true;
    } else {
      const pid = Number(text);
      stale = !Number.isInteger(pid) || pid <= 0 || processGone(pid);
    }
  }
  if (!stale) return false;
  await guard?.(lock);
  return removeIfPresent(lock);
}

// Serialize slot state transitions under an atomic exclusive lock file (CREATE_NEW / O_CREAT|O_EXCL).
// Unlike rename(), exclusive creation cannot double-claim on Windows NTFS.
async function withSlotLock(directory, slot, guard, action) {
  const lock = join(directory, `.claim-slot-${slot}`);
  let locked = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    await guard?.(lock);
    try {
      const handle = await open(lock, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
        await handle.close();
      } catch (writeError) {
        await handle.close().catch(() => {});
        await guard?.(lock);
        await removeIfPresent(lock).catch(() => {});
        throw writeError;
      }
      locked = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt === 0 && await tryRemoveStaleLock(lock, guard)) continue;
      break;
    }
  }
  if (!locked) return undefined;
  try {
    return await action();
  } finally {
    await guard?.(lock);
    await removeIfPresent(lock);
  }
}

async function claimBucket(directory, guard, id, pendingName) {
  const completed = [];
  const free = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    const bucket = join(directory, `slot-${slot}`);
    await guard?.(bucket);
    const stat = await statIfPresent(bucket);
    if (!stat) {
      free.push({ slot, bucket });
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const names = await readdir(bucket).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return [];
    });
    if (names.length > 1) continue;
    const name = names[0];
    const expired = Date.now() - stat.mtimeMs >= DAY;
    if (name) {
      // Prior versions used .log while writing and .retired-<pid> during handoff. Reclaim those only on expiry.
      const published = /^[\da-f-]{36}\.done\.log$/u.test(name);
      const legacy = /^[\da-f-]{36}\.log$/u.test(name);
      const pending = /^[\da-f-]{36}\.pending-(\d+)$/u.exec(name);
      const retired = /^[\da-f-]{36}\.retired-(\d+)$/u.exec(name);
      if (!published && !(expired && (legacy || (pending && processGone(Number(pending[1])))
        || (retired && processGone(Number(retired[1])))))) continue;
      const path = join(bucket, name);
      const info = await statIfPresent(path);
      if (!info?.isFile()) continue;
      if (!expired || Date.now() - info.mtimeMs < DAY) {
        if (published) completed.push({ slot, bucket, name, path, time: stat.mtimeMs });
        continue;
      }
    } else if (!expired) {
      continue;
    }
    const reclaimed = await withSlotLock(directory, slot, guard, async () => {
      await guard?.(bucket);
      const currentStat = await statIfPresent(bucket);
      if (!currentStat) return true;
      if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) return false;
      const current = await readdir(bucket).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      if (name) {
        if (current.length !== 1 || current[0] !== name) return false;
        const path = join(bucket, name);
        await guard?.(path);
        if (!await removeIfPresent(path)) return false;
      } else if (current.length !== 0) {
        return false;
      }
      await guard?.(bucket);
      await rmdir(bucket).catch(error => {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
      });
      return !await statIfPresent(bucket);
    });
    if (reclaimed) free.push({ slot, bucket });
  }
  // Install a nonempty slot atomically under the shared per-slot lock so cleanup
  // never sees an empty bucket and free/completed transitions stay mutually exclusive.
  if (free.length) {
    const staging = join(directory, `.claim-${id}`);
    const seed = join(staging, pendingName);
    await guard?.(staging);
    await mkdir(staging, { mode: 0o700 });
    let installed = false;
    try {
      await guard?.(seed);
      await (await open(seed, "wx", 0o600)).close();
      for (const { slot, bucket } of free) {
        const claimed = await withSlotLock(directory, slot, guard, async () => {
          await guard?.(bucket);
          if (await statIfPresent(bucket)) return false;
          await guard?.(staging);
          try {
            await rename(staging, bucket);
            return true;
          } catch (error) {
            if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code) || !await statIfPresent(bucket)) throw error;
            return false;
          }
        });
        if (claimed) {
          installed = true;
          return bucket;
        }
      }
    } finally {
      if (!installed) {
        await guard?.(seed);
        await removeIfPresent(seed);
        await guard?.(staging);
        await rmdir(staging);
      }
    }
  }
  // Reuse the oldest published slot under the same per-slot lock, creating the new
  // pending inode before unlinking the old file so open readers keep the old inode.
  for (const { slot, bucket, name, path } of completed.sort((a, b) => a.time - b.time)) {
    const claimed = await withSlotLock(directory, slot, guard, async () => {
      await guard?.(bucket);
      const current = await readdir(bucket).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      if (current.length !== 1 || current[0] !== name) return false;
      const pending = join(bucket, pendingName);
      await guard?.(pending);
      await (await open(pending, "wx", 0o600)).close();
      try {
        await guard?.(path);
        await unlink(path);
      } catch (error) {
        await guard?.(pending);
        await removeIfPresent(pending);
        throw error;
      }
      return true;
    });
    if (claimed) return bucket;
  }
  throw spillIssue("LIMIT", "All eight spill slots are in use");
}

export async function openSpillFile(directory, guard) {
  const id = randomUUID();
  const pendingName = `${id}.pending-${process.pid}`;
  const bucket = await claimBucket(directory, guard, id, pendingName);
  const path = join(bucket, `${id}.done.log`);
  const pending = join(bucket, pendingName);
  let file;
  try {
    await guard?.(pending);
    file = await open(pending, "r+");
    await guard?.(pending);
  } catch (error) {
    if (file) await file.close().catch(() => {});
    try {
      await guard?.(pending);
      await unlink(pending);
      await guard?.(bucket);
      await rmdir(bucket);
    } catch {}
    throw error;
  }

  let bytes = 0;
  return {
    path,
    async write(data) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (bytes + buffer.length > FILE_LIMIT) throw spillIssue("LIMIT", "Spill file exceeded 16 MiB");
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
        if (!bytesWritten) throw issue("SPILL", "Could not write spill data");
        offset += bytesWritten;
        bytes += bytesWritten;
      }
    },
    async commit() {
      await file.close();
      await guard?.(pending);
      await guard?.(path);
      await rename(pending, path);
    },
    async discard() {
      await file.close();
      await guard?.(pending);
      if (await removeIfPresent(pending)) {
        await guard?.(bucket);
        await rmdir(bucket).catch(error => {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
        });
      }
    },
  };
}
