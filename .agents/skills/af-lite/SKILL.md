---
name: af-lite
description: Use AF Lite工程护栏与交接侧车：在 T3 Code 线程开工前读取 .af-lite/CONTEXT.md，开发期间守住边界，收尾或换模型前记录 handoff，验证与合并交由 AF Verify / AF Merge 按钮完成。
---

# AF Lite T3 Code Workflow

## 1. 开工核对（每条新线程必做）
1. 读取工作区 `.af-lite/CONTEXT.md`；若不存在或已过时，运行 `af-lite context`（或按任务执行 `af-lite attach <T-NNNN>` / `af-lite attach --auto`）。
2. 运行只读检查 `git rev-parse --show-toplevel` 与 `git branch --show-current`，确认当前所在目录与分支与 `CONTEXT.md` 首行一致。
3. 严格对照任务书的 `scope.paths` 与 `acceptance` 验收标准推进修改。

## 2. 开发与提交规范
- 所有代码改动仅在当前 T3 worktree 内进行。
- 严禁修改、绕过或伪造仓库外 `<stateDir>/config.json` 中的 `checks` 验证命令。
- 未经运行 `af-lite verify` 通过前，绝不声称测试或验证已通过。
- 默认把 `git add` / `commit` / `push` 留给操作员在 T3 Code Diff 面板审阅完成（除非操作员明确要求在当前分支提交）。

## 3. 结束或跨模型交接
在关闭线程、上下文过长或准备切到另一个模型继续开发前，执行：
```bash
af-lite handoff --summary "本轮完成内容（<=300字）" --next "下一轮接手第一步"
```
若当前环境处于严格沙箱、无法写入全局状态目录，追加 `--sandbox-only` 将结果写入 `.af-lite/handoff.json`，下一次在终端点击 `AF Radar` 或 `AF Verify` 时会自动回收归档。
