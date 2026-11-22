# Lite Exec 与 Memo 个人版第二轮验收

2026-11-15。Windows，DSH `0.2.2-rc.3`、Electron `44.7.0`。使用安装版 DSH 后端、隔离配置、离线模型替身与合成文件。常规 Windows 进程启动的测试仍采用 DSH `workspace-write`。日常 DSH 未安装此候选包，候选包保留原版本号并以 `candidate-r2` 区分。

## Lite Exec

| 用例 | 常规隔离 DSH | Codex 嵌套隔离环境 |
| --- | --- | --- |
| 原生 `pwsh` 对照 | 同一会话实际调度 `pwsh` 与 `lite_exec` 共 12 次，12/12 符合预期。两者均使用 PowerShell 7.6.10，工作目录正确，绝对和相对路径的工作区读写成功，工作区外写入被拒，未生成目标。 | 同样调度 12 次。两者都落到 PowerShell 安装目录，绝对路径工作区内读写被拒，工作区外仍未生成目标。相对读取失败，相对写入由测试脚本的目录检查拦下。 |
| 15 MiB Shell 输出 | 15,728,640 字节真实落盘，用 `lite_read` 分窗口读回，字节数与直接流式校验一致。SHA-256 均为 `3cb5693ad1eab973bd9e9c3fe48d7cb19ffa3901e7b121d2ac4833864158e3ad`。内联预览为 2,048 字节。 | 返回 `ok:true` 和 2,048 字节预览。目录继承权限导致完整落盘被拒，新增 `spill.reason: ACL_DENIED` 明确标记该情况。 |
| 5,000 条 grep 结果 | 实际落盘并用 `lite_read` 核对 5,000 条记录的路径、行列、内容和顺序。预览 3 条，`complete:true`。 | 扫完 5,000 条，保留 3 条预览并返回 `ACL_DENIED`。 |
| 连续运行 | 混合命令 20/20，纯输出对照 20/20，均无目标启动错误。 | 混合命令 13/20，7 次工作区文件读取失败。纯输出对照 20/20。 |
| 边界和超时 | 工作区内写入成功，区外终止及非终止写入都未生成目标文件。后者保留退出码 0，并标记 `suspectedSandboxDenial:true`。约 3.04 秒返回 `TIMEOUT`，确认子进程退出。显式 Bash 的 MSYS 初始化拒绝仍按预期给出结构化诊断。 | 只读回归通过，`READ_ONLY` 时保留预览和计数，无落盘。 |

上次的工作目录及绝对路径失败随外层启动条件改变，在普通隔离宿主中已消失。Lite 的 Shell 启动逻辑沿用首轮候选。新的 `ACL_DENIED` 用于明确的私有权限校验拒绝，常规 I/O 错误仍按原有字段报告。物理落盘仍受实际运行环境的私有目录权限约束。

## Memo 个人版

`memory_recall` 的 `sessions` 与 `all` 都按会话 ID 排除发起检索的当前会话。宿主索引按原排序补页，词法兜底在扫描前跳过当前会话。个人版及原型测试 46/46，原版基线测试 3/3。真实宿主 SQLite 合成测试在 `workspace-write` 和全权限各 4/4。测试先验证宿主把当前会话排第一，再核对结果上限为 1 时历史命中仍出现、仅当前会话命中时结果为空。首轮候选在相同对照中 0/4。全文索引仅在隔离测试配置中启用。

两插件同开时，原有图谱、日历、Lite 文件检查与截断输出用例在两种权限模式下仍各通过 8/8。

## 复验入口

在 Lite 候选包解包目录运行。通过 `--electron`（或环境变量 `DSH_DESKTOP_EXE`）指定本机 `DeepSeek Harness.exe`，`--stage` 指向已有的测试父目录。复验物理落盘使用常规 Windows 进程启动，DSH 仍运行在 `workspace-write`。

```powershell
node scripts/host-check.mjs --stage '<测试父目录>' --mode workspace-write --paired-powershell
node scripts/host-check.mjs --stage '<测试父目录>' --mode workspace-write --permission-check --stdout-control
node scripts/host-check.mjs --stage '<测试父目录>' --mode read-only --permission-check
node scripts/host-check.mjs --stage '<测试父目录>' --mode workspace-write --memo '<Memo 候选包解包目录>'
```
