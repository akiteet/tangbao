# Tangbao v1.1.1

Release date: 2026-08-09

## Parallel Expert Agents

- `explore`, `test`, and `review` agents now return a normalized result containing summaries, findings, evidence, checks, step/tool counts, duration, and errors.
- A parent run can create up to 8 children with at most 3 active at once. Additional children are queued; failed children are never retried automatically.
- The parent waits for all children, then returns every structured result plus an aggregate. Partial success is explicit as `degraded`/`blocked`, so the completion gate cannot report a fully complete run prematurely.
- Subagents remain read-only. File changes continue to be executed only by the parent agent.
- Added `subagent_queued` and `subagent_summary` events. Live cards and run history expose findings, evidence paths, checks, and failure reasons.

## Persistence and Safety

- Reuses SQLite Schema v15 Agent Run, event, and WorkingState records. Added the read-only `agent:runTree(rootRunId)` history API for collaboration trees.
- File transactions now validate real paths and reject existing symlinks or new paths that resolve through an external symlink.
- Skill Runner confirms child-process exit after timeout/abort, preventing leaked processes from consuming concurrency slots.

## Release Notes

- Documentation now lists all six permission modes: `plan / default / acceptEdits / auto / bypass / sandbox`.
- CI installs dependencies and runs the full `npm test`, JavaScript syntax checks, and an Electron build check.
- Provider Canary is skipped when credentials are absent. No automatic child retry and no Schema v16 migration are introduced.
