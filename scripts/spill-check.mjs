import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { createExec } from "../lib/exec.js";
import { createFileTools } from "../lib/files.js";
import { createSpill, spillStatus, workspaceSpillPaths } from "../lib/spill.js";

const { values } = parseArgs({ options: { stage: { type: "string", default: tmpdir() } } });
const stage = await realpath(resolve(values.stage));
const workspace = await mkdtemp(join(stage, "lite-spill-check-"));
try {
  const { base, root } = await workspaceSpillPaths(workspace);
  const protectedStore = createSpill(base, root);
  const ioFailure = Object.assign(new Error("fixture path resolution failed"), { code: "EACCES" });
  await assert.rejects(() => protectedStore.open(() => { throw ioFailure; }), error => {
    assert.equal(spillStatus(error).spill.reason, "UNAVAILABLE");
    return true;
  });

  // Pre-existing fixture with inherited Windows DACL or non-private Unix mode.
  const unprotected = join(root, "unprotected");
  await mkdir(unprotected, { mode: 0o755 });
  await assert.rejects(() => createSpill(unprotected, root).open(), error => {
    assert.equal(spillStatus(error).spill.reason, "ACL_DENIED", error.message);
    return true;
  });

  const size = 15 * 1024 * 1024;
  const segment = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 256));
  const repetitions = size / segment.length;
  const expected = createHash("sha256");
  for (let index = 0; index < repetitions; index++) expected.update(segment);
  const digest = expected.digest("hex");
  function* output() {
    for (let index = 0; index < repetitions; index++) yield segment;
  }
  // A deterministic source isolates the Lite collector and physical storage.
  const subprocess = {
    async resolveExecutable(candidate) { return candidate; },
    spawn() {
      return { done: Promise.resolve({ exitCode: 0 }), waitForExit: async () => {}, terminate() {},
        stdout: Readable.from(output()), stderr: Readable.from([]) };
    },
  };
  const spill = { open: () => protectedStore.open() };
  const exec = createExec({ subprocess, resolveCwd: () => root, sandboxFor: () => null,
    bashCandidates: () => ["fixture"], spill });
  const command = await exec({ command: "fixture", maxOutputBytes: 2048 });
  assert.equal(command.ok, true);
  assert.equal(command.truncated, true);
  assert.ok(Buffer.byteLength(command.stdout) + Buffer.byteLength(command.stderr) <= 2048);

  const fixture = join(root, "search.txt");
  await writeFile(fixture, Array.from({ length: 5000 }, (_, index) => `needle-${index + 1}\n`).join(""));
  const files = createFileTools({ fs, authorize: value => resolve(root, value), spill });
  const grep = await files.grep({ path: fixture, pattern: "needle", maxMatches: 3 });
  assert.equal(grep.ok, true);
  assert.equal(grep.complete, true);
  assert.equal(grep.matchCount, 5000);
  assert.equal(grep.matches.length, 3);

  if (!command.spillPath || !grep.fullResultPath) {
    for (const result of [command, grep]) {
      assert.equal(result.spill?.reason, "ACL_DENIED", result.spillError);
      assert.equal(result.spillError, result.spill.message);
    }
    console.log(JSON.stringify({ physicalSpill: false, reason: command.spill.reason, message: command.spill.message }));
    process.exitCode = 1;
  } else {
    const spillDirectory = join(base, "spill");
    assert.equal(dirname(dirname(await realpath(command.spillPath))), spillDirectory);
    assert.equal(dirname(dirname(await realpath(grep.fullResultPath))), spillDirectory);
    const raw = await readFile(command.spillPath);
    assert.equal(raw.length, size);
    assert.equal(createHash("sha256").update(raw).digest("hex"), digest);
    const rows = (await readFile(grep.fullResultPath, "utf8")).trimEnd().split("\n").map(JSON.parse);
    assert.equal(rows.length, 5000);
    for (const [index, row] of rows.entries()) {
      assert.equal(row.path, fixture);
      assert.equal(row.line, index + 1);
      assert.equal(row.column, 1);
      assert.equal(row.text, `needle-${index + 1}`);
    }
    console.log(JSON.stringify({ physicalSpill: true, shellBytes: size, sha256: digest, grepRecords: rows.length }));
  }
} finally {
  const cleanup = await realpath(workspace);
  assert.equal(cleanup, workspace);
  assert.equal(dirname(cleanup), stage);
  await rm(cleanup, { recursive: true, force: true });
}
