import fs from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createExec, gitBashCandidates } from "./exec.js";
import { failure, issue } from "./errors.js";
import { createFileTools } from "./files.js";
import { createSpill, spillIssue, workspaceSpillPaths } from "./spill.js";
import { checkAsarHeaderSize, splitAsar } from "./asar.js";

export const name = "dsh-lite-exec";

const string = { type: "string" };
const integer = { type: "integer" };
const glob = { type: "string", minLength: 1, maxLength: 256 };
const tools = [
  ["lite_exec", "Run shell commands with bounded stdout/stderr and spill files. On Windows use Git Bash for POSIX commands in full access, PowerShell by default under restrictions.", "exec",
    { command: string, cwd: string, timeoutMs: integer, maxOutputBytes: integer,
      shell: { type: "string", enum: ["bash", "powershell"], description: "PowerShell by default on restricted Windows; Bash elsewhere." } }, ["command"]],
  ["lite_read", "Read byte windows from files over 2000 lines, spill logs and Electron ASAR entries. Supports GBK/CP936, UTF-16 and binary hex previews.", "read",
    { path: string, offsetBytes: integer, limitBytes: integer, encoding: string }, ["path"]],
  ["lite_grep", "Find literal text across files or ASAR entries with line numbers, glob filters and bounded results. Use native grep for regex.", "grep",
    { pattern: string, path: string, include: { oneOf: [glob, { type: "array", items: glob, minItems: 1, maxItems: 32 }] },
      ignoreCase: { type: "boolean" }, maxMatches: integer, maxBytes: integer }, ["pattern", "path"]],
  ["lite_stat", "Check existence, size and modification time of files, directories and ASAR paths.", "stat", { path: string }, ["path"]],
];

function validArgument(schema, value) {
  if (schema.oneOf) return schema.oneOf.some(option => validArgument(option, value));
  if (schema.type === "array") return Array.isArray(value) && value.length >= schema.minItems
    && value.length <= schema.maxItems && Array.from(value).every(item => validArgument(schema.items, item));
  if (schema.type === "integer") return Number.isSafeInteger(value);
  if (schema.type === "string") return typeof value === "string" && value.length >= (schema.minLength ?? 0)
    && value.length <= (schema.maxLength ?? Infinity);
  return typeof value === schema.type;
}

function register(owner, impl, selected) {
  for (const [name, description, operation, properties, required] of selected) {
    owner.tools.register({
      name, description,
      parameters: { type: "object", properties, required, additionalProperties: false },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      ...(operation === "exec" ? { timeoutMs: 310000 } : {}),
      async execute(args, invocation) {
        try {
          if (!args || typeof args !== "object" || Array.isArray(args)
            || required.some(key => !Object.hasOwn(args, key))
            || Object.entries(args).some(([key, value]) => !Object.hasOwn(properties, key)
              || !validArgument(properties[key], value))) {
            throw issue("EINVAL", `Invalid arguments for ${name}`);
          }
          return await impl[operation](args, invocation);
        } catch (error) {
          return failure(error);
        }
      },
    });
  }
}

const localProbe = fileURLToPath(import.meta.url);
const compatiblePolicy = new Set(["read-only", "workspace-write", "danger-full-access"]);
const originalFs = process.versions.electron ? createRequire(import.meta.url)("original-fs") : undefined;

function localBackend(backend) {
  if (backend?.processPathFromHostPath?.(localProbe) !== normalize(localProbe)) {
    throw issue("EACCES", "Lite Exec requires the local DSH filesystem backend");
  }
}

function agentContext(invocation) {
  const agent = invocation?.agent;
  if (!agent?.session || typeof agent.ctx?.get !== "function") {
    throw issue("EACCES", "Lite Exec requires a DSH agent session");
  }
  return agent.ctx;
}

function policyFor(invocation) {
  const policy = agentContext(invocation).get("sandboxPolicy")?.resolve({ session: invocation.agent.session });
  if (!compatiblePolicy.has(policy?.mode)) throw issue("EACCES", "DSH permission policy unavailable");
  return policy;
}

async function localPath(input, invocation) {
  const ctx = agentContext(invocation);
  const backend = ctx.get("fs");
  localBackend(backend);
  if (typeof input !== "string" || !input.trim() || input.includes("\0")) throw issue("EINVAL", "Expected a local path");
  const signal = invocation.signal;
  signal?.throwIfAborted();
  const cwd = isAbsolute(input) ? undefined : await ctx.get("workingDirectory").ensure(invocation.agent, signal);
  // The local DSH resolver uses native realpath, which treats ASAR as a file.
  // Resolve archive paths through Electron instead, keeping missing paths for suggestions.
  const absolute = /^~(?:[\\/]|$)/u.test(input)
    ? backend.processPathFromHostPath(resolve(process.env.USERPROFILE ?? process.env.HOME ?? cwd, input.slice(2)))
    : resolve(cwd ?? ".", input);
  if (process.platform === "win32" && /^\\\\[.?]\\/u.test(absolute)) {
    throw issue("EINVAL", "Windows device paths are unsupported");
  }
  const asar = splitAsar(absolute);
  if (asar && originalFs && !process.noAsar) {
    const archive = await backend.resolve(asar.archive, { cwd, signal });
    const canonical = backend.processPath(archive);
    if (!isAbsolute(canonical)) throw issue("EACCES", "DSH did not resolve the ASAR container");
    if (!await checkAsarHeaderSize(originalFs.promises, canonical)) {
      const target = await backend.resolve(absolute, { cwd, signal });
      return backend.processPath(target);
    }
    const candidate = join(canonical, ...asar.entry);
    try {
      return await fs.promises.realpath(candidate);
    } catch (error) {
      if (error.code === "ENOENT" || /not found in .*\.asar(?:[.'"]|$)/iu.test(error.message)) {
        throw issue("ENOENT", `ASAR path does not exist: ${candidate}`);
      }
      throw error;
    }
  }
  const target = await backend.resolve(input, { cwd, signal });
  const path = backend.processPath(target);
  if (!isAbsolute(path)) throw issue("EACCES", "DSH did not resolve a local absolute path");
  return path;
}

export function apply(ctx, config = {}) {
  if (config.enabled !== true) return;
  if (config.tools !== undefined && (!Array.isArray(config.tools)
    || config.tools.some(name => !tools.some(([known]) => known === name)))) {
    throw issue("EINVAL", "tools must be an array of Lite Exec tool names");
  }
  if (config.bashPath !== undefined && (typeof config.bashPath !== "string" || !isAbsolute(config.bashPath)
    || config.bashPath.includes("\0"))) throw issue("EINVAL", "bashPath must be an absolute executable path");
  const selected = tools.filter(([name]) => config.tools === undefined || config.tools.includes(name));
  if (!selected.length) return;
  ctx.inject(["tools", "fs", "workingDirectory", "sandboxPolicy", "subprocess"], owner => {
    const store = createSpill();
    const workspaceStores = new Map();
    const spill = {
      async open(invocation) {
        const policy = policyFor(invocation);
        if (policy.mode === "danger-full-access") return store.open();
        if (policy.mode === "read-only") {
          throw spillIssue("READ_ONLY", "The current DSH session allows preview output only.");
        }
        const backend = agentContext(invocation).get("fs");
        localBackend(backend);
        const { root, base } = await workspaceSpillPaths(policy.workspaceRoot);
        if (!workspaceStores.has(root)) workspaceStores.set(root, createSpill(base, root));
        return workspaceStores.get(root).open(async path => {
          const target = await backend.resolve(path);
          const checked = typeof backend.checkedTarget === "function" ? await backend.checkedTarget(target, policy) : target;
          if (relative(path, backend.processPath(checked)) !== "") {
            throw spillIssue("UNAVAILABLE", "DSH resolved spill storage to a different path");
          }
        });
      },
    };
    const exec = (args, invocation) => createExec({
      subprocess: agentContext(invocation).get("subprocess"),
      resolveCwd: localPath,
      bashCandidates: () => gitBashCandidates(config.bashPath),
      spill,
      sandboxFor(invocation) {
        const policy = policyFor(invocation);
        if (policy.mode === "danger-full-access") return null;
        const sandbox = agentContext(invocation).get("sandbox");
        if (typeof sandbox?.confine !== "function") {
          throw issue("EACCES", `DSH sandbox backend is unavailable for ${policy.mode}`);
        }
        return (argv, signal) => sandbox.confine(argv, policy, signal);
      },
    })(args, invocation);
    async function workspaceSpillDirectory(invocation) {
      try {
        const paths = await workspaceSpillPaths(policyFor(invocation).workspaceRoot);
        return join(paths.base, "spill");
      } catch {
        // Directory exclusion is optional for reads. A spill still requires policy.
        return undefined;
      }
    }
    register(owner, { exec, ...createFileTools({ fs, originalFs, authorize: localPath, spill, workspaceSpillDirectory }) }, selected);
  });
}
