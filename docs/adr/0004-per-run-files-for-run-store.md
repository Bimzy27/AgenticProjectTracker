# Run history is stored one file per run, not one monolithic runs.json

`RunOrchestrator` persisted every run (all projects, full event history) as a single `RunsFile { version: 1, runs: RunRecord[] }`, and `save()` rewrote and `JSON.stringify`'d the entire array on every agent turn, nudge, and status change (12 call sites) via a synchronous `writeFileSync`.
Since Electron's main process shares its event loop with IPC and window compositing, this stalled the whole UI mid-run, and the cost scaled with total accumulated run history across every project, not just the active run - it got worse the longer the app had been used.
We decided to split storage into one file per run (keyed by run id) with async, debounced writes, so a write's cost scales with that run's own history instead of the whole store.
This requires a one-time migration of the existing monolithic `runs.json` into per-run files on first load after upgrade.
