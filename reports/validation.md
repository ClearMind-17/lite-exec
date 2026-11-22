# Token、稳定性与性能验收

0.1.1 使用已安装的 Electron 44.7.0 后端、隔离 Desktop profile、本地 Git 测试仓库和离线模型替身。请求经过实际 agent loop、工具调度和会话投影。测试结束关闭并移除隔离环境。

| 验收项 | 结果 |
| --- | --- |
| 原有工具集合 | 标准和 Flash PTC 在安装前、默认关闭、启用、移除四阶段完全一致，启用阶段仅增加四个 `lite_*`。 |
| 普通会话声明 | 首次请求 `toolsTokens` 增加 **338**，低于 800。0.1.0 为 +310。 |
| Flash PTC 声明 | `toolsTokens` 增量 **0**，宿主生成的 SDK 签名使 `systemTokens` 增加 **242**。0.1.0 为 +214。 |
| 固定注入 | 标准与 Flash PTC 新会话的 `inject` 增量均为 **0**。 |
| Shell 连续执行 | 标准会话 **20/20** 成功，包含 5 次长输出落盘。Flash PTC 实际嵌套执行 **1/1**。用持久化结果的 `isError` 和返回 JSON 的 `ok` 同时计数。 |
| 文件工具 | 隔离标准会话 **5/5**，含本地 stat、read、grep 和真实 `app.asar` 内的 read、grep。 |
| 超时 | 真实 DSH 宿主中的 Git Bash 启动子进程后，约 **1.03 秒**返回 `TIMEOUT`（期限 1 秒）。冒烟测试另核对 Windows 子进程退出、执行标记只出现一次、截断的 stdout 保留末尾。 |
| 权限 | 两种受限模式都用默认参数执行 `echo hi`，实际 Shell 为 PowerShell。工作区写模式允许工作区内写入并拒绝外写，只读模式拒绝两处写入。长输出均返回 `SPILL` 且未创建落盘目录。显式 Bash 对照均重现 MSYS 初始化失败。 |
| 安装、禁用、移除 | 隔离宿主四阶段确认关闭和移除时工具回到基线。0.1.0 曾另通过隔离 profile 的插件管理器离线安装和移除。 |
| 冒烟 | **11/11**。包含大输出失败时保留末尾、原始落盘、退出码提示区分、5,000 条匹配、空预览、部分扫描计数和字面 `\|`。 |

Token 数字来自 DSH 的 `contextBreakdown` 估算。以首次请求对比，避免工具响应和后续步骤改变基线。测试还对照已落盘投影。原始聚合见 [宿主矩阵](host-check.json)、[工作区写模式](host-workspace-write.json) 和[只读模式](host-read-only.json)。

## 性能测量口径

- **冷启动**在 10 个全新 Electron Node 进程中测量。从开始 import 插件到四个工具注册，模拟依赖已就绪。中位数 **9.93 ms**，最慢 **13.92 ms**，低于 200 ms。计时不包括 OS 进程启动、完整 Desktop 启动和服务等待。可用 `scripts/cold-start.mjs` 重现。
- **单次额外开销**在同一个实际 DSH Electron 宿主中做 20 组成功配对。两边使用相同 Git Bash 可执行文件、目录、命令、环境和管道，交替先后顺序，另有一组预热不计。比较 Lite 工具处理阶段与直接调用 DSH 子进程服务，包含 Lite 路径/程序探测、收集和宿主结果渲染。增量 p50 **−5.12 ms**、p95 **16.81 ms**、最大 **30.03 ms**，符合 50 ms 目标。负值来自配对耗时波动。该数字适用于短命令且不发生落盘。 [配对数据](host-benchmark.json)
- **大输出、权限和文件 I/O**有独立成本。例如首次 Windows spill 要创建并校验 ACL，ASAR 读取可能要验证校验块。50 ms 的短命令测量不代表大输出和全树扫描的端到端耗时。

历史验收的分母、失效路径和未达标项目见[历史回放](history.md)。

从插件目录运行以下命令可复现隔离宿主测量。通过 `--electron`（或环境变量 `DSH_DESKTOP_EXE`）和 `--flash` 指向本机的安装位置。

```powershell
node scripts/host-check.mjs --flash "$env:USERPROFILE/.dsh/profiles/desktop/node_modules/dsh-flash-presets"
node scripts/host-check.mjs --permission-check --mode workspace-write
node scripts/host-check.mjs --permission-check --mode read-only
node scripts/host-check.mjs --benchmark
```
