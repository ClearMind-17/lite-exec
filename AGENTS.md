## AF Lite Workflow
1. Start by reading `.af-lite/CONTEXT.md` (or run `af-lite context`) and confirm `git branch --show-current`.
2. Keep changes within task scope; leave local commits/pushes to the operator in T3 Code unless instructed otherwise.
3. Before ending a thread or switching models, record progress via `af-lite handoff` (fallback: `.af-lite/handoff.json`).
4. Never modify external `<stateDir>/config.json` or claim unverified checks as passed (`af-lite verify` is the sole gate).
