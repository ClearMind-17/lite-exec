import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const measures = [];
const moduleURL = new URL("../lib/index.js", import.meta.url).href;
const source = `
  import { performance } from "node:perf_hooks";
  const start = performance.now();
  const { apply } = await import(${JSON.stringify(moduleURL)});
  const definitions = [];
  apply({ inject: (_, callback) => callback({ tools: { register: tool => definitions.push(tool) } }) }, { enabled: true });
  console.log(JSON.stringify({ elapsedMs: performance.now() - start, registered: definitions.length }));
`;
for (let run = 0; run < 10; run++) {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
    env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const { elapsedMs, registered } = JSON.parse(child.stdout);
  assert.equal(registered, 4);
  measures.push(elapsedMs);
}
measures.sort((a, b) => a - b);
const result = {
  scope: "Plugin module import and four registrations with services ready. Excludes OS process startup and host startup.",
  node: process.versions.node,
  electron: process.versions.electron ?? null,
  runs: measures.length,
  medianMs: Number(((measures[4] + measures[5]) / 2).toFixed(2)),
  maxMs: Number(measures.at(-1).toFixed(2)),
};
console.log(JSON.stringify(result, null, 2));
if (result.maxMs > 200) process.exitCode = 1;
