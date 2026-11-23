# DSH Lite Exec

安装后默认注册 `lite_exec`、`lite_read`、`lite_grep` 和 `lite_stat`。

## 安装 0.1.5

完全退出 DSH Desktop，在准备长期保留安装包的目录运行下列命令。源码用户可先在插件目录运行 `npm pack` 生成安装包。CLI 可能需要联网解析 Desktop profile 中的其他依赖。

```powershell
$archive = (Resolve-Path -LiteralPath './dsh-lite-exec-0.1.5.tgz').Path
dsh plugin --profile desktop add "dsh-lite-exec@file:$archive" --ignore-scripts
```

profile 会记录安装包的路径，请保留该文件。

运行环境为 Node.js 24 及以上。DSH 声明范围为 `>=0.2.2-rc.3 <1.0.0`，此前宿主实测覆盖 `0.2.2-rc.3` 和 `0.2.2-rc.5`。

重开 Desktop 并新建会话。在 Flash PTC 会话中通过 `run_code` 执行下列代码，当前目录应返回 `exists: true` 和 `isDir: true`。

```js
console.log(await tools.lite_stat({ path: "." }))
```

升级后仍缺少工具时，检查 Desktop 插件开关，以及 profile 的 `cordis.patch.yml` 中是否已有 `config.enabled: false` 或 `config.tools: []`。这两种覆盖项会阻止工具注册，插件会在启动日志中记录原因。

## 配置

需要限定工具时，在 Desktop profile 的 `cordis.patch.yml` 中修改 `dsh-lite-exec` 条目。例如只启用 Shell：

```yaml
- id: dsh-lite-exec
  config:
    tools: [lite_exec]
```

省略 `tools` 时注册全部四个，空数组关闭全部。使用自定义 PortableGit 时，可在同一 `config` 下设置 `bashPath`，填写 Bash 可执行文件的绝对路径。

## 工具

| 工具 | 参数与返回 |
| --- | --- |
| `lite_exec` | `command` 必填。支持 `cwd`、`timeoutMs`、`maxOutputBytes` 和 `shell`。默认 30 秒、16 KiB，分别上限 300 秒、64 KiB。返回实际 `cwd`、`shell`、退出码、stdout 和末尾最多 20 行 stderr。stdout 成功取开头，失败或超时取末尾。stdout 和 stderr 共享输出字节预算；同时产生大量输出时，stdout 至少分到半数预算或 4 KiB 中的较小值（以实际输出为限）。 |
| `lite_read` | `path` 必填。支持从 0 开始的 `offsetBytes`、`limitBytes` 和 `encoding`。默认读 64 KiB，单次最多 1 MiB。支持 `auto`、UTF-8、UTF-16LE/BE、GBK、CP936。二进制返回 `binary:true` 和最多 512 字节的十六进制。缺失路径返回 `ENOENT`、`exists:false` 和最多三个近名候选。 |
| `lite_grep` | `pattern`、`path` 必填。默认区分大小写，传入 `ignoreCase: true` 可忽略大小写。空字符串匹配可解码行。普通文件的正则搜索可用原生 `grep`。`include` 可传单个 glob 或最多 32 个 glob，例如 `["*.ts", "*.tsx"]`，支持 `*`、`**`、`?`。`maxMatches` 默认 100、最大 5,000，`maxBytes` 默认 64 KiB、最大 1 MiB。完整溢出结果写入成功时，`fullResultPath` 返回 JSONL 路径。 |
| `lite_stat` | `path` 必填。返回存在性、是否目录、字节数、修改时间和 ASAR 路径标记。仅在需要检查元数据时调用。 |

读取窗口可能以半个字符开头或结束。UTF-8 和 UTF-16 会尽量舍弃不完整边界字符。GBK 的前导字节和尾字节范围有重叠，随意切入 GBK 文件可能无法判定字符边界。已知编码时可以显式传入，使用可确认的字节边界继续读取。返回的 `bytes` 表示实际读取的窗口字节数。

`lite_grep` 的 `matchCount` 以匹配行为单位。同一行出现多次只计一次。`complete:false` 时，计数只覆盖已检查的部分。`truncated:true` 表示预览省略了至少一条已找到的匹配。若首条匹配超出预览预算，`matches` 可能为空，完整扫描仍会返回计数和可用的落盘路径。工作区落盘目录跳过搜索，已落盘的文件可通过 `lite_read` 读取。

grep 上限为 128 层、100,000 个目录项、单文件 256 MiB、总扫描 1 GiB、单行 32 MiB，设有 30 秒扫描时限。遍历跳过符号链接，二进制文件及无法解码的行有独立计数。搜索超过扫描预算或时限时返回 `complete:false` 和已有预览。落盘受限、超过预算或失败时，继续执行有界扫描并返回 `spill.reason` 和兼容字段 `spillError`。搜索 ASAR 时须显式指定归档或其内部路径，扫描普通父目录时略过其中的归档文件。

读取 ASAR 内部路径时，Electron 负责路径解析和目录枚举。插件按 ASAR 公开格式读取归档中的字节窗口。文件有 SHA-256 块校验信息时，按块核验读到的范围。校验以归档未被并发改写为前提。ASAR 头最大 16 MiB。直接读取归档容器路径时，`lite_read` 返回容器原始字节。

## Shell 和权限

Windows 的 `workspace-write` 和 `read-only` 默认在启动前选 PowerShell，此时 `shellFallback:false`。Windows 全访问默认使用 Git for Windows 的 Bash，其他平台也默认 Bash。找不到默认 Bash 时可以在同一权限策略下尝试 PowerShell。全访问下，只有明确识别为 Bash 可执行文件未启动的 `ENOENT` 会触发启动回退。显式 `shell: "bash"` 或 `shell: "powershell"` 只使用指定的 Shell。`shellUsed` 和兼容字段 `shell` 记录使用的 Shell。

每次执行使用当前会话的 DSH 权限。受限模式走宿主的 OS 沙箱。Windows 受限权限中，显式 Bash 命中已知初始化失败时返回 `diagnostic.code: "WINDOWS_BASH_STARTUP"`。PowerShell 的 stderr 有访问拒绝迹象时返回 `suspectedSandboxDenial:true` 和提示，保留命令退出码。对支持 `-ErrorAction Stop` 的写入命令可加上该参数，使非终止错误以失败退出。写入后可用 `lite_stat` 核对产物。

全访问将完整输出写到 `$DSH_HOME/dsh-lite-exec/spill`，缺省为 `~/.dsh/dsh-lite-exec/spill`。工作区写入使用当前会话工作区根目录下的 `.dsh-lite-exec/spill`。`lite_grep` 跳过该目录，避免把之前的结果算入匹配。可用 `lite_read` 读取已有落盘文件。只读模式在发生溢出时返回已有预览和 `spill.reason: "READ_ONLY"`。确认目录不满足私有权限要求时返回 `ACL_DENIED`。其他存储或 I/O 故障返回 `UNAVAILABLE`。落盘问题保留预览和命令本身的结果。每个存储位置最多八个槽、每槽 16 MiB、总计 128 MiB。后续写入时清理超过 24 小时的过期文件。槽位已满时复用最早完成的结果，之后读取旧路径会返回文件不存在。正在写入的槽位保留。旧版日志继续按 24 小时过期。Windows 目录 ACL 限制在当前账号和允许的系统主体内，Unix 目录和文件分别用 0700、0600。Windows 工作区模式下，路径与防软链校验每次落盘都会执行，目录 DACL 校验则按目录标识缓存最多 30 秒（目录新建或被替换时会立即复检）。

如果希望 `git status` 隐藏落盘目录，可在目标仓库的 `.git/info/exclude` 中添加一行 `/.dsh-lite-exec/`。

## 禁用、卸载与回滚

- **禁用**：使用 Desktop 插件开关。已有 `config.enabled: false` 的配置仍然有效。修改 YAML 后重开 DSH Desktop，删除该覆盖值可恢复默认启用。
- **卸载**：使用 Desktop 插件页面。也可在完全退出 Desktop 后删除本插件的覆盖项，运行 `dsh plugin --profile desktop remove dsh-lite-exec`，再打开 Desktop。
- **回滚**：如安装过程中出现配置异常，退出 Desktop，核对安装前备份与当前文件，恢复该次安装造成的 `package.json`、`pnpm-lock.yaml` 和 `cordis.patch.yml` 变动。若期间没有其它修改，可恢复整份备份。落盘文件可以独立保留或清理。

## 验证

在源码或解包目录运行 `npm test`。Windows 可运行 `npm test -- --powershell` 验证显式 PowerShell。运行 `node scripts/spill-check.mjs` 可检查私有目录权限、15 MiB 命令输出和 5,000 条搜索结果的实际落盘。
