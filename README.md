# DSH Lite Exec

Four optional tools for DeepSeek Harness. **Enable the plugin after installation** in the Desktop profile's `cordis.patch.yml`, then reopen Desktop and start a new session.

```yaml
- id: dsh-lite-exec
  config:
    enabled: true
```

[中文使用说明](README.zh.md)

## Installation

Quit Desktop and run the following command from the directory containing the release archive. From a source checkout, run `npm pack` there first. The CLI may need network access to resolve existing Desktop dependencies.

```powershell
dsh plugin --profile desktop add ./dsh-lite-exec-0.1.3.tgz --ignore-scripts
```

Requires Node 24 or later. The declared DSH range is `>=0.2.2-rc.3 <1.0.0`. Earlier host checks covered `0.2.2-rc.3` and `0.2.2-rc.5`. Disable the plugin by setting `enabled: false`.

| Tool | When to use it |
| --- | --- |
| `lite_exec` | Run a command with a bounded preview. Successful stdout shows its beginning, failed or timed-out stdout shows its tail. Stderr shows up to 20 trailing lines. |
| `lite_read` | Read large text files by byte offset, inspect spill files and Electron ASAR entries, decode UTF-16 or GBK/CP936, or inspect binary bytes in hex. |
| `lite_grep` | Search literal text by line. Pass a glob or up to 32 globs in `include` and use `ignoreCase: true` for case-insensitive matching. Overflow results use JSONL. |
| `lite_stat` | Check whether a path exists and inspect its size and modification time, including the physical size of an ASAR container. |

To register a subset, add `tools: [lite_exec, lite_read]` under `config`. Omit `tools` for all four, or use `[]` for none. For a portable Bash installation, set `bashPath` to its absolute executable path in that same config. Restricted Windows sessions default to PowerShell. Full-access Windows sessions prefer Git Bash. Shell commands use the current DSH session's permissions.

The default preview budget is 16 KiB. A spill holds up to 16 MiB. Each storage location retains at most eight results and reuses the oldest completed slot when full. Read-only sessions return the preview. Workspace-write sessions save spills under `.dsh-lite-exec/spill` in the workspace.

Run `npm test` from a source checkout. On Windows, `npm test -- --powershell` also exercises the explicit PowerShell route. Run `node scripts/spill-check.mjs` to verify physical spills and permission checks.
