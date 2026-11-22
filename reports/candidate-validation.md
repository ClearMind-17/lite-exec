# Lite Exec 与 Memo 个人版首轮候选验收

2026-11-15。Windows，DSH `0.2.2-rc.3`，Electron `44.7.0`。宿主测试使用实际 DSH 工具调度、隔离配置和离线模型替身。图谱、日历和文件均使用合成内容。候选包保留原包版本号，以文件名的 `candidate` 区分。

## 实测结果

| 范围 | 结果 |
| --- | --- |
| `workspace-write` 大输出 | 预设 15 MiB 的命令返回 `ok:true`、`truncated:true`、2,048 字节预览。Windows 私有 ACL 校验拒绝了完整落盘，返回 `spill.reason:"UNAVAILABLE"`。 |
| `workspace-write` 检索 | `ok:true`、`complete:true`，计满 5,000 条匹配，保留 3 条预览。完整结果同样遇到 ACL 限制。 |
| `workspace-write` 连续执行 | 纯 PowerShell 输出组 20/20，0 次目标启动错误。含工作区文件读取的混合组 13/20，7 次读取返回 `EACCES`，未达到错误率 ≤5% 的目标。宿主也拒绝了写入隔离工作区测试文件。 |
| `workspace-write` Shell 与边界 | 默认 PowerShell，`shellFallback:false`。显式 Bash 保留 `3221225794` 并返回 `WINDOWS_BASH_STARTUP`。对工作区外的 PowerShell 非终止写入错误保留退出码 0，返回 `suspectedSandboxDenial:true`，目标文件未生成。超时约 3.03 秒，确认子进程退出。 |
| `read-only` | 只读断言通过。输出返回预览，检索计满 5,000 条，落盘原因 `READ_ONLY`。 |
| `danger-full-access` | 显式 PowerShell 20/20，Flash PTC 1/1，文件工具 5/5，超时清理通过。标准与 Flash PTC 的官方工具集合一致，Lite 的固定注入增量为 0，声明分别增加 338 和 242 token。实际落盘仍受外层 ACL 限制。默认 Git Bash 在当前外层环境启动失败，20 次均未执行用户命令。 |
| Memo 与 Lite 同开 | 两种权限下均 8/8。覆盖 `memory_expand` 和 `memory_trace` 的命中及空结果、默认日历回执与列表一致、Lite 的文件检查和截断输出。Memo 个人版及原型测试 44/44，原版合成测试 3/3。 |

用内存接收器独立核对了 Lite 的输出收集与检索结果流，精确得到 15,728,640 字节和 5,000 条 JSONL 记录。Windows 的实际磁盘落盘仍待复验。独立 PowerShell 冒烟脚本的本地子进程清理断言未通过，实际 DSH 宿主的同类断言通过。安装路径上的 PowerShell 在这个隔离环境报告自身程序目录为当前目录，尝试切换到测试工作区也得到拒绝。相对路径需要在日常 DSH 宿主确认。

## 复验入口

在 Lite 候选包目录运行。通过 `--electron`（或环境变量 `DSH_DESKTOP_EXE`）指定本机 `DeepSeek Harness.exe`，`--stage` 可指定可写的测试父目录。Memo 参数指向解包后的个人版目录。全权限对照使用独立测试配置。

```powershell
node scripts/host-check.mjs --permission-check --mode workspace-write --stdout-control
node scripts/host-check.mjs --permission-check --mode read-only
node scripts/host-check.mjs --mode danger-full-access --full-powershell --flash '<Flash Presets 目录>'
node scripts/host-check.mjs --mode workspace-write --memo '<Memo 候选包目录>'
node scripts/host-check.mjs --mode danger-full-access --memo '<Memo 候选包目录>'
```

优先在日常 DSH 同版本的隔离配置中复验工作区内读写、15 MiB 和 5,000 条结果的完整文件，以及混合命令 20 次。Memo 的当前会话自回声、冷启动、计划输出说明和技能晋升属于后续工作。Lite 历史路径候选继续沿用原指标。
