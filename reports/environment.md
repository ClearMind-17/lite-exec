# 环境诊断与问题归因

核验日期为 2026-11-14（UTC+8）。桌面安装为 DSH 0.2.2-rc.3，Electron 44.7.0，内置 Node 24.21.0。命令行 Node 为 24.22.1，Windows 为 10.0.26200.0。验证针对该 DSH 版本，升级宿主后应重新运行宿主验收。

| 项目 | 实际核查结果 |
| --- | --- |
| 桌面 profile | 日常配置在 `~/.dsh/profiles/desktop`。默认预设是 flash-lean-ptc-v3，flash-presets 为 0.3.1。Windows 平台条件选择官方 `pwsh`，禁用官方 `bash` 的预设注册项。标准预设和 Flash PTC 的实际集合见 `host-check.json`。PTC 请求顶层只声明 `run_code`。 |
| 旧 Ops | desktop patch 只余 `dsh-ops` 的禁用项，包清单无该依赖。发现旧 shell 和输出缓存，未发现仍生效的工具替换。没有确认需要改写日常配置的异常。 |
| Cordis | 使用 `ctx.inject` 获取依赖，以 `tools.register` 注册四个名字。工具运行时从当前 agent scope 取得执行服务；默认关闭时不注册工具。 |
| Shell | 复用已装的 Git for Windows 及官方 `ctx.subprocess`，避免旧 Ops 的 winuxcmd/Git payload 与 PTY 启动链。受限调用使用 `ctx.sandboxPolicy` 与 `ctx.sandbox.confine`。官方 Auto Review 若启用，会在宿主共享的 `tools/pre-execute` 阶段审查。 |
| Windows ACL | 显式 Git Bash 在当前受限 runner 中会以 Windows 状态 3221225794 退出。0.1.1 的工作区写入和只读会话默认在启动前选择 PowerShell，两种权限的内外写入限制均已实测。 |
| 文件系统 | Electron 的 `stat`、`realpath` 和目录枚举支持实际 `app.asar`。Electron 44.7.0 的 `fs.open` 会整条提取 packed entry，内部也会分配对应缓冲。插件依据公开的归档头和偏移，通过 Electron `original-fs` 读取容器区间。 |
| 兼容范围 | 实际运行了隔离 DSH Desktop 后端中的标准和 flash-presets 0.3.1 会话。Lite Exec 只向工具表增加独立 ID。日常 DSH Bridge、Memo、Auto Memory 和 AgentTeam 的共同运行未作端到端验收。 |

需求书中的 13,761 次是历史统计。旧 Ops `ops_bash` 为 5/4,048 错误，官方 `bash` 为 71/2,731，官方 `pwsh` 为 43/605。官方 read 的 49 条历史错误中有 20 条来自旧工具替换，6 条属于 BigInt 问题，5 条属于编码或二进制能力缺口。历史 `rg` 无法直接读取 ASAR 虚拟路径。此处引用历史数据用于归因，当期小样本见验收报告。

宿主源码核对位置为安装包 `app.asar/dsh/node_modules/@deepseek-ai` 下的 `dsh-tools/lib/index.js`、`dsh-tools/lib/pipeline.js`、`dsh-subprocess-local/lib/index.js`、`dsh-sandbox-local/lib/index.js` 和 `dsh-tool-executor-ptc/lib/index.js`。Electron 整条提取行为见 [44.7.0 ASAR fs 包装](https://github.com/electron/electron/blob/v44.7.0/lib/node/asar-fs-wrapper.ts#L335-L353) 和 [临时文件实现](https://github.com/electron/electron/blob/v44.7.0/shell/common/asar/scoped_temporary_file.cc#L47-L67)。
