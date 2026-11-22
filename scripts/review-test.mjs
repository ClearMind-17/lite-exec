import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { failure, issue } from "../lib/errors.js";
import { createExec, gitBashCandidates } from "../lib/exec.js";
import { createFileTools } from "../lib/files.js";
import { apply } from "../lib/index.js";
import { openSpillFile } from "../lib/spill.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "lite-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function registered(config) {
  const result = new Map();
  apply({ inject(_, setup) {
    setup({ tools: { register(tool) { result.set(tool.name, tool); } } });
  } }, config);
  return result;
}

test("registration, glob arrays and case-insensitive literal columns", async t => {
  const root = await fixture(t);
  assert.equal(registered({ enabled: false }).size, 0);
  assert.equal(registered({ enabled: true }).size, 4);
  const tools = registered({ enabled: true, tools: ["lite_grep"] });
  assert.deepEqual([...tools.keys()], ["lite_grep"]);
  assert.equal(registered({ enabled: true, tools: [] }).size, 0);
  assert.throws(() => registered({ enabled: true, tools: ["unknown"] }), { code: "EINVAL" });
  await writeFile(join(root, "one.ts"), "ß ERROR.*\n");
  await writeFile(join(root, "two.tsx"), "error.*\n");
  await writeFile(join(root, "skip.md"), "error.*\n");
  const services = {
    fs: { resolve: async input => resolve(root, input), processPath: p => p, processPathFromHostPath: p => p },
    workingDirectory: { ensure: async () => root },
  };
  const invocation = { agent: { session: {}, ctx: { get: key => services[key] } } };
  const grep = tools.get("lite_grep");
  assert.equal(grep.parameters.properties.include.oneOf[1].maxItems, 32);
  const args = { pattern: "error.*", path: ".", include: ["*.ts", "*.tsx"] };
  assert.equal((await grep.execute(args, invocation)).matchCount, 1);
  const found = await grep.execute({ ...args, ignoreCase: true }, invocation);
  assert.equal(found.matchCount, 2);
  assert.deepEqual(found.matches.map(m => m.column).sort(), [1, 3]);
  for (const invalid of [{ include: [] }, { include: [1] }, { include: Array(33).fill("a") }, { ignoreCase: "true" }]) {
    assert.equal((await grep.execute({ ...args, ...invalid }, invocation)).code, "EINVAL");
  }
  const long = "a".repeat(65536);
  await writeFile(join(root, "long.txt"), "ẞ " + long.toUpperCase() + "\nSTRAẞE\n");
  const search = pattern => grep.execute({ path: "long.txt", pattern, ignoreCase: true, maxBytes: 200000 }, invocation);
  assert.equal((await search(long)).matches[0].column, 3);
  assert.equal((await search("Straße")).matches[0].line, 2);
});

test("ASAR container metadata uses physical file size", async t => {
  const root = await fixture(t);
  const path = join(root, "test.asar");
  await writeFile(path, "12345");
  const electron = { promises: { stat: () => fs.promises.stat(root) } };
  const tools = createFileTools({ fs: electron, originalFs: fs, authorize: async p => p });
  const info = await tools.stat({ path });
  assert.equal(info.isDir, false);
  assert.equal(info.isAsar, true);
  assert.equal(info.size, 5);
  const missing = await tools.stat({ path: join(root, "missing.asar") });
  assert.equal(missing.exists, false);
  assert.equal(missing.isAsar, false);
});

test("mixed output reserves stdout, preserves stderr-only budget and reports actionable hints", async () => {
  for (const [stdout, limit, expected] of [["PASS", 32, "PASS"], ["OK", 1, "O"], ["", 17, ""]]) {
    const exec = createExec({
      sandboxFor: () => null, resolveCwd: () => ".", bashCandidates: () => ["fixture"],
      spill: { open: async () => { throw new Error("read-only fixture"); } },
      subprocess: { resolveExecutable: async p => p, spawn: () => ({
        done: Promise.resolve({ exitCode: 0 }), waitForExit: async () => {}, terminate() {},
        stdout: Readable.from([stdout]), stderr: Readable.from(["x".repeat(100)]),
      }) },
    });
    const result = await exec({ command: "fixture", maxOutputBytes: limit });
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr.length, limit - expected.length);
  }
  const hints = ["EISDIR", "EINVAL", "TIMEOUT", "BINARY"].map(code => failure(issue(code, code), { path: "." }).hint);
  assert.equal(new Set(hints).size, hints.length);
  assert.equal(gitBashCandidates(resolve("custom-bash"))[0], resolve("custom-bash"));
});

test("eight concurrent slots, oldest result reuse and in-flight reader snapshot", async t => {
  const root = await fixture(t);
  const writers = await Promise.all(Array.from({ length: 8 }, () => openSpillFile(root)));
  assert.equal(new Set(writers.map(w => dirname(w.path))).size, 8);
  await assert.rejects(openSpillFile(root), e => e.spillReason === "LIMIT");
  for (const [index, writer] of writers.entries()) {
    await writer.write("old payload " + index);
    await writer.commit();
  }
  const oldest = writers[4].path;
  const earlier = new Date(Date.now() - 60_000);
  await utimes(dirname(oldest), earlier, earlier);
  const reader = await open(oldest, "r");
  try {
    const next = await openSpillFile(root);
    assert.equal(dirname(next.path), dirname(oldest));
    await next.write("new");
    await next.commit();
    assert.equal(await reader.readFile("utf8"), "old payload 4");
    assert.equal(await readFile(next.path, "utf8"), "new");
    await assert.rejects(access(oldest), { code: "ENOENT" });
  } finally { await reader.close(); }
  assert.equal((await readdir(root)).length, 8);

  // Separate Node processes must never recycle the parent's pending slots.
  const held = await Promise.all(Array.from({ length: 7 }, () => openSpillFile(root)));
  const module = new URL("../lib/spill.js", import.meta.url).href;
  const child = "const {openSpillFile} = await import(process.argv[1]);"
    + "const writer = await openSpillFile(process.argv[2]); await writer.write('child'); await writer.commit();";
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", child, module, root]);
  await Promise.all(held.map(w => w.discard()));
  assert.equal((await readdir(root)).length, 1);
});

test("old-format results retain the original 24-hour expiry", async t => {
  const root = await fixture(t);
  const name = "00000000-0000-4000-8000-000000000000.log";
  const old = new Date(Date.now() - 25 * 3600000);
  for (let index = 0; index < 8; index++) {
    const bucket = join(root, "slot-" + index);
    await mkdir(bucket);
    await writeFile(join(bucket, name), "legacy");
  }
  await assert.rejects(openSpillFile(root), e => e.spillReason === "LIMIT");
  const bucket = join(root, "slot-3");
  await utimes(join(bucket, name), old, old);
  await utimes(bucket, old, old);
  const writer = await openSpillFile(root);
  assert.equal(dirname(writer.path), bucket);
  await writer.discard();
});

test("concurrent slot reuse exceeding capacity claims 8 distinct slots cleanly", async t => {
  const root = await fixture(t);
  const initial = await Promise.all(Array.from({ length: 8 }, () => openSpillFile(root)));
  for (const [index, writer] of initial.entries()) {
    await writer.write("seed " + index);
    await writer.commit();
  }
  for (let round = 0; round < 5; round++) {
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => openSpillFile(root)));
    const claimed = outcomes.filter(item => item.status === "fulfilled").map(item => item.value);
    const rejected = outcomes.filter(item => item.status === "rejected").map(item => item.reason);
    assert.equal(claimed.length, 8);
    assert.equal(new Set(claimed.map(writer => dirname(writer.path))).size, 8);
    assert.equal(rejected.length, 4);
    for (const error of rejected) assert.equal(error.spillReason, "LIMIT", error.message);
    for (const [index, writer] of claimed.entries()) {
      await writer.write(`round-${round}-${index}`);
      await writer.commit();
    }
    assert.equal((await readdir(root)).length, 8);
  }
});

test("stale slot lock from a terminated process is reclaimed", async t => {
  const root = await fixture(t);
  const writers = await Promise.all(Array.from({ length: 8 }, () => openSpillFile(root)));
  for (const [index, writer] of writers.entries()) {
    await writer.write("payload " + index);
    await writer.commit();
  }
  const targetSlot = dirname(writers[0].path);
  const older = new Date(Date.now() - 60_000);
  await utimes(targetSlot, older, older);
  const staleLock = join(root, `.claim-${basename(targetSlot)}`);
  await writeFile(staleLock, "99999999\n");
  await utimes(staleLock, older, older);
  const next = await openSpillFile(root);
  assert.equal(dirname(next.path), targetSlot);
  await assert.rejects(access(staleLock), { code: "ENOENT" });
  await next.discard();
});

test("gitBashCandidates resolves PortableGit usr/bin and Scoop while skipping System32", { skip: process.platform !== "win32" }, () => {
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path") ?? "Path";
  const previousPath = process.env[pathKey];
  const previousScoopGlobal = process.env.SCOOP_GLOBAL;
  try {
    process.env[pathKey] = [
      "C:\\Windows\\System32",
      "D:\\Tools\\PortableGit-2.47\\usr\\bin",
      "C:\\Portable\\git\\current\\usr\\bin",
    ].join(";");
    process.env.SCOOP_GLOBAL = "C:\\ProgramData\\scoop";
    const candidates = gitBashCandidates("D:\\Custom\\bash.exe");
    assert.equal(candidates[0], "D:\\Custom\\bash.exe");
    const wrapperIndex = candidates.indexOf("D:\\Tools\\PortableGit-2.47\\bin\\bash.exe");
    const usrBinIndex = candidates.indexOf("D:\\Tools\\PortableGit-2.47\\usr\\bin\\bash.exe");
    assert.ok(wrapperIndex > 0 && usrBinIndex > wrapperIndex);
    assert.ok(candidates.includes("C:\\Portable\\git\\current\\bin\\bash.exe"));
    assert.ok(candidates.includes("C:\\ProgramData\\scoop\\apps\\git\\current\\bin\\bash.exe"));
    assert.ok(!candidates.some(candidate => /\\System32\\/iu.test(candidate)));
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    if (previousScoopGlobal === undefined) delete process.env.SCOOP_GLOBAL;
    else process.env.SCOOP_GLOBAL = previousScoopGlobal;
  }
});
