import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
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

function registered(config, info) {
  const result = new Map();
  apply({ logger: { info }, inject(_, setup) {
    setup({ tools: { register(tool) { result.set(tool.name, tool); } } });
  } }, config);
  return result;
}

test("bundled tools register by default and explicit configuration still controls registration", () => {
  assert.deepEqual([...registered().keys()], ["lite_exec", "lite_read", "lite_grep", "lite_stat"]);
  const messages = [];
  const info = message => messages.push(message);
  assert.equal(registered({ enabled: false }, info).size, 0);
  assert.equal(registered({ tools: [] }, info).size, 0);
  assert.match(messages[0], /config\.enabled is false/u);
  assert.match(messages[1], /config\.tools is empty/u);
  assert.throws(() => registered({ enabled: "false" }), { code: "EINVAL" });
  assert.throws(() => registered({ enabled: false, tools: ["unknown"] }), { code: "EINVAL" });
  assert.throws(() => registered({ enabled: false, bashPath: "relative/bash" }), { code: "EINVAL" });
});

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

test("grep keeps the encoding detected by read across GBK lines and byte windows", async t => {
  const root = await fixture(t);
  const path = join(root, "gbk.txt");
  const firstLine = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0x0a]); // 测试 in GBK
  const ambiguous = Buffer.from([0xc2, 0xa1]); // 隆 in GBK, ¡ in UTF-8
  const chunkBytes = 64 * 1024;
  const filler = Buffer.alloc(chunkBytes - firstLine.length - 2, "x");
  const bytes = Buffer.concat([firstLine, filler, Buffer.from("\n"), ambiguous, Buffer.from("\r\n"), ambiguous]);
  await writeFile(path, bytes);
  const tools = createFileTools({ fs, authorize: async p => p });
  const read = await tools.read({ path, limitBytes: bytes.length });
  assert.equal(read.encoding, "gbk");
  assert.equal(read.content, `测试\n${filler}\n隆\r\n隆`);
  const result = await tools.grep({ path, pattern: "隆" });
  assert.equal(result.complete, true);
  assert.equal(result.matchCount, 2);
  assert.deepEqual(result.matches.map(({ line, column, text }) => ({ line, column, text })), [
    { line: 3, column: 1, text: "隆" }, { line: 4, column: 1, text: "隆" },
  ]);
  assert.equal((await tools.grep({ path, pattern: "¡" })).matchCount, 0);

  const asciiFirst = join(root, "ascii-first.txt");
  const head = Buffer.alloc(chunkBytes, "x");
  head[chunkBytes - 1] = 10;
  await writeFile(asciiFirst, Buffer.concat([head, firstLine]));
  const fallback = await tools.grep({ path: asciiFirst, pattern: "测试" });
  assert.equal(fallback.matchCount, 1);
  assert.equal(fallback.matches[0].line, 2);
});

test("grep skips both plugin spill locations while read still opens the logs", async t => {
  const root = await realpath(await fixture(t));
  const previousDshHome = process.env.DSH_HOME;
  const dshHome = join(root, "profile");
  process.env.DSH_HOME = dshHome;
  t.after(() => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
  });
  const tools = registered({ enabled: true, tools: ["lite_read", "lite_grep"] });
  const published = "00000000-0000-4000-8000-000000000000.done.log";
  const globalSlot = join(dshHome, "dsh-lite-exec", "spill", "slot-0");
  const workspaceSlot = join(root, ".dsh-lite-exec", "spill", "slot-0");
  for (const slot of [globalSlot, workspaceSlot]) {
    await mkdir(slot, { recursive: true });
    await writeFile(join(slot, published), "grep-marker\n");
  }
  const source = join(dshHome, "dsh-lite-exec", "spill-notes.txt");
  await writeFile(source, "grep-marker\n");
  for (const mode of ["danger-full-access", "workspace-write", "read-only"]) {
    const services = {
      fs: { resolve: async input => resolve(root, input), processPath: p => p, processPathFromHostPath: p => p },
      workingDirectory: { ensure: async () => root },
      sandboxPolicy: { resolve: () => ({ mode }) },
    };
    const invocation = { agent: { session: {}, ctx: { get: key => services[key] } } };
    const grep = tools.get("lite_grep");
    const result = await grep.execute({ path: ".", pattern: "grep-marker" }, invocation);
    assert.equal(result.complete, true, mode);
    assert.deepEqual(result.matches.map(match => match.path), [source], mode);
    for (const slot of [globalSlot, workspaceSlot]) {
      const path = join(slot, published);
      const direct = await grep.execute({ path, pattern: "grep-marker" }, invocation);
      assert.equal(direct.matchCount, 0, mode);
      const read = await tools.get("lite_read").execute({ path }, invocation);
      assert.equal(read.content, "grep-marker\n", mode);
    }
  }
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

test("ASAR read and grep verify 4 KiB blocks across byte ranges", async t => {
  const root = await fixture(t);
  const blockSize = 4096;
  const marker = "cross-block";
  const offsetBytes = blockSize - 4;
  const data = Buffer.alloc(blockSize * 2 + 31, "x");
  data.write(marker, offsetBytes);
  const blocks = [];
  for (let offset = 0; offset < data.length; offset += blockSize) {
    blocks.push(createHash("sha256").update(data.subarray(offset, offset + blockSize)).digest("hex"));
  }
  const filename = "entry.txt";
  const json = Buffer.from(JSON.stringify({ files: { [filename]: {
    size: data.length, offset: "0", integrity: { algorithm: "SHA256", blockSize, blocks },
  } } }));
  const header = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4);
  header.writeUInt32LE(header.length - 4, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);

  const archive = join(root, "small-blocks.asar");
  await writeFile(archive, Buffer.concat([size, header, data]));
  const electron = { promises: { stat: async () => ({ size: data.length, isFile: () => true, isDirectory: () => false }) } };
  const tools = createFileTools({ fs: electron, originalFs: fs, authorize: async p => p });
  const path = join(archive, filename);
  const read = await tools.read({ path, offsetBytes, limitBytes: marker.length });
  assert.equal(read.content, marker);
  const result = await tools.grep({ path, pattern: marker });
  assert.equal(result.complete, true);
  assert.equal(result.matchCount, 1);
  assert.equal(result.matches[0].column, offsetBytes + 1);

  const damaged = join(root, "damaged-block.asar");
  data[blockSize + 50] ^= 1;
  await writeFile(damaged, Buffer.concat([size, header, data]));
  const bad = await tools.read({ path: join(damaged, filename), offsetBytes, limitBytes: marker.length });
  assert.equal(bad.code, "ASAR_INTEGRITY");
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

test("interrupted slot reuse drops only expired pending files from exited writers", async t => {
  const root = await fixture(t);
  const published = "00000000-0000-4000-8000-000000000000.done.log";
  const deadPid = 99999999;
  const old = new Date(Date.now() - 48 * 3600000);
  for (let slot = 0; slot < 8; slot++) {
    const bucket = join(root, `slot-${slot}`);
    const pid = slot < 2 || slot === 7 ? deadPid : process.pid;
    const pending = join(bucket, `00000000-0000-4000-8000-000000000001.pending-${pid}`);
    await mkdir(bucket);
    const finished = join(bucket, published);
    await writeFile(finished, `published ${slot}`);
    await utimes(finished, old, old);
    await writeFile(pending, "");
    if (slot !== 7) await utimes(pending, old, old);
    const age = slot === 0 ? new Date(old.getTime() - 1000) : old;
    await utimes(bucket, age, age);
  }
  const staleLock = join(root, ".claim-slot-0");
  await writeFile(staleLock, `${deadPid}\n`);
  await utimes(staleLock, old, old);

  const writer = await openSpillFile(root);
  try {
    assert.equal(dirname(writer.path), join(root, "slot-0"));
    assert.deepEqual(await readdir(join(root, "slot-1")), [published]);
    assert.equal(await readFile(join(root, "slot-1", published), "utf8"), "published 1");
    for (let slot = 2; slot < 8; slot++) assert.equal((await readdir(join(root, `slot-${slot}`))).length, 2);
    await writer.write("replacement");
    await writer.commit();
    assert.equal(await readFile(writer.path, "utf8"), "replacement");
  } finally { await writer.discard(); }
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

test("stale slot locks (dead PID and empty crash lock) are reclaimed", async t => {
  const root = await fixture(t);
  const writers = await Promise.all(Array.from({ length: 8 }, () => openSpillFile(root)));
  for (const [index, writer] of writers.entries()) {
    await writer.write("payload " + index);
    await writer.commit();
  }
  const older = new Date(Date.now() - 60_000);
  // 1. Stale lock containing a terminated PID on a completed slot.
  const targetSlot = dirname(writers[0].path);
  await utimes(targetSlot, older, older);
  const deadPidLock = join(root, `.claim-${basename(targetSlot)}`);
  await writeFile(deadPidLock, "99999999\n");
  await utimes(deadPidLock, older, older);
  const first = await openSpillFile(root);
  assert.equal(dirname(first.path), targetSlot);
  await assert.rejects(access(deadPidLock), { code: "ENOENT" });
  await first.write("reclaimed-dead-pid");
  await first.commit();

  // 2. Empty 0-byte lock left by a crash between open() and writeFile().
  const secondSlot = dirname(writers[1].path);
  const evenOlder = new Date(Date.now() - 120_000);
  await utimes(secondSlot, evenOlder, evenOlder);
  const emptyLock = join(root, `.claim-${basename(secondSlot)}`);
  await writeFile(emptyLock, "");
  await utimes(emptyLock, older, older);
  const second = await openSpillFile(root);
  assert.equal(dirname(second.path), secondSlot);
  await assert.rejects(access(emptyLock), { code: "ENOENT" });
  await second.discard();
});

test("concurrent free-slot installation and mixed free/completed claiming stay exclusive", async t => {
  const root = await fixture(t);
  // 16 concurrent callers racing on 8 empty slots.
  const emptyRace = await Promise.allSettled(Array.from({ length: 16 }, () => openSpillFile(root)));
  const claimed = emptyRace.filter(item => item.status === "fulfilled").map(item => item.value);
  const rejected = emptyRace.filter(item => item.status === "rejected").map(item => item.reason);
  assert.equal(claimed.length, 8);
  assert.equal(new Set(claimed.map(writer => dirname(writer.path))).size, 8);
  assert.equal(rejected.length, 8);
  for (const error of rejected) assert.equal(error.spillReason, "LIMIT", error.message);

  // Discard 4 slots (back to free) and commit 4 slots (to completed), then race 12 callers.
  for (let index = 0; index < 4; index++) await claimed[index].discard();
  for (let index = 4; index < 8; index++) {
    await claimed[index].write("mixed-" + index);
    await claimed[index].commit();
  }
  const mixedRace = await Promise.allSettled(Array.from({ length: 12 }, () => openSpillFile(root)));
  const mixedClaimed = mixedRace.filter(item => item.status === "fulfilled").map(item => item.value);
  const mixedRejected = mixedRace.filter(item => item.status === "rejected").map(item => item.reason);
  assert.equal(mixedClaimed.length, 8);
  assert.equal(new Set(mixedClaimed.map(writer => dirname(writer.path))).size, 8);
  assert.equal(mixedRejected.length, 4);
  for (const error of mixedRejected) assert.equal(error.spillReason, "LIMIT", error.message);
  for (const writer of mixedClaimed) await writer.discard();
  assert.equal((await readdir(root)).length, 0);
});

test("expired legacy retired marker from a dead process is reclaimed after 24 hours", async t => {
  const root = await fixture(t);
  const retiredName = "00000000-0000-4000-8000-000000000000.retired-99999999";
  for (let index = 0; index < 8; index++) {
    const bucket = join(root, "slot-" + index);
    await mkdir(bucket);
    await writeFile(join(bucket, retiredName), "legacy-retired");
  }
  await assert.rejects(openSpillFile(root), e => e.spillReason === "LIMIT");
  const target = join(root, "slot-5");
  const expired = new Date(Date.now() - 25 * 3600000);
  await utimes(join(target, retiredName), expired, expired);
  await utimes(target, expired, expired);
  const writer = await openSpillFile(root);
  assert.equal(dirname(writer.path), target);
  await writer.discard();
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
