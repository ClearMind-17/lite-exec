# DSH Lite Exec

Four tools for DeepSeek Harness. The bundle registers all four tools by default.

[中文使用说明](README.zh.md)

## Installation

Quit Desktop and run the following commands from the directory containing the release archive. From a source checkout, run `npm pack` there first. The CLI may need network access to resolve other Desktop dependencies.

```powershell
$archive = (Resolve-Path -LiteralPath './dsh-lite-exec-0.1.5.tgz').Path
dsh plugin --profile desktop add "dsh-lite-exec@file:$archive" --ignore-scripts
```

Keep the archive at that path because the profile records it as a file dependency.

Requires Node 24 or later. The declared DSH range is `>=0.2.2-rc.3 <1.0.0`. Earlier host checks covered `0.2.2-rc.3` and `0.2.2-rc.5`.

Reopen Desktop and start a new session. In a PTC session, use `run_code` to run the following check. A registered tool returns `exists: true` and `isDir: true` for the current directory.

```js
console.log(await tools.lite_stat({ path: "." }))
```

If the tool is missing after an upgrade, check whether the plugin is disabled in Desktop or whether the profile's `cordis.patch.yml` contains an old `config.enabled: false` or `config.tools: []` override. Lite Exec logs the reason when either config value disables registration.

| Tool | When to use it |
| --- | --- |
| `lite_exec` | Run a command with a bounded preview. Successful stdout shows its beginning, failed or timed-out stdout shows its tail. Stderr shows up to 20 trailing lines. |
| `lite_read` | Read large text files by byte offset, inspect spill files and Electron ASAR entries, decode UTF-16 or GBK/CP936, or inspect binary bytes in hex. |
| `lite_grep` | Search literal text by line. Pass a glob or up to 32 globs in `include` and use `ignoreCase: true` for case-insensitive matching. Overflow results use JSONL. |
| `lite_stat` | Check whether a path exists and inspect its size and modification time, including the physical size of an ASAR container. |

Use the Desktop plugin switch to disable Lite Exec. The profile's `cordis.patch.yml` can also configure the `dsh-lite-exec` entry:

```yaml
- id: dsh-lite-exec
  config:
    tools: [lite_exec, lite_read]
```

Omit `tools` for all four, or use `[]` for none. An explicit `enabled: false` under `config` still disables all four. For a portable Bash installation, set `bashPath` to its absolute executable path in the same config. Restricted Windows sessions default to PowerShell. Full-access Windows sessions prefer Git Bash. Shell commands use the current DSH session's permissions.

The default preview budget is 16 KiB. A spill holds up to 16 MiB. Each storage location retains at most eight results and reuses the oldest completed slot when full. Read-only sessions return the preview. Workspace-write sessions save spills under `.dsh-lite-exec/spill` in the workspace. To hide spills from `git status`, add `/.dsh-lite-exec/` to the repository's `.git/info/exclude`. On Windows, workspace path and symlink guards run on every spill while DACL verification is cached for up to 30 seconds per directory identity (and rechecked immediately if a directory is created or replaced).

Run `npm test` from a source checkout or the extracted package. On Windows, `npm test -- --powershell` exercises the explicit PowerShell route. Run `node scripts/spill-check.mjs` to verify physical spills and permission checks.
