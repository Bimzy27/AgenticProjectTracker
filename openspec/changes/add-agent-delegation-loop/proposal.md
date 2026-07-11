## Why

Today the app can watch and resume agent sessions, but the user still has to drive every session by hand: decide what to work on, start the session, babysit errors, and judge when it is done.
The end goal of the product is mission control: a user defines what each project should become, delegates the building to agents, and supervises many projects from one view.
This change adds the missing middle layer - durable tasks per project and an autonomous run loop that works those tasks using the workflows from the AgenticWorkspace repo (patrol quality gate, ship delivery flow), self-recovers from routine failures, and only interrupts the user when it genuinely needs direction.

## What Changes

- Each project gets a backlog of tasks: a purpose statement plus acceptance criteria, with lifecycle states (draft, queued, running, needs-input, review, done, failed).
- A new run loop takes a queued task, starts a managed agent session for it, and supervises that session end to end.
- Run sessions are primed with the AgenticWorkspace ways of working: conventional commits, the /patrol quality gate before done, and honest reporting; the loop verifies the gate ran before accepting completion.
- When a run hits an issue (failed check, error, denied tool), the loop first lets the agent auto-solve it with bounded retries; only unresolved issues or genuine decision points escalate to the user.
- Escalations surface as an attention inbox: the user answers a question or gives direction in-app, and the run resumes with that answer.
- Completed runs land in a review state with a summary of what was built and what was verified; the user accepts (done) or sends back with feedback (re-queued with notes).
- The dashboard grows into the one-view mission control: per-project task and run status, plus a cross-project attention count so the user can supervise many builds at once.
- Sessions started by the run loop appear in the existing Sessions tab, attributed to their task, so transcripts stay inspectable with the tools that already exist.

## Capabilities

### New Capabilities

- `task-backlog`: defining, editing, ordering, and persisting per-project tasks with purpose, acceptance criteria, and lifecycle state.
- `agent-run-loop`: executing a task through a supervised agent session - priming with workspace workflows, progress tracking, bounded auto-recovery, completion verification, and the review handoff.
- `attention-inbox`: collecting escalations (questions, permission requests, failures) across all projects into one queue the user can answer in-app.

### Modified Capabilities

- `project-dashboard`: project cards additionally summarize task backlog and active run state, and the dashboard surfaces a cross-project attention indicator.
- `agent-sessions`: session listings attribute loop-started sessions to their task and link back to the run that owns them.

## Impact

- New main-process services (`TaskService`, run orchestration) alongside the existing `SessionService`, which the loop drives rather than replaces.
- `src/shared/domain.ts` and `src/shared/ipc.ts` gain task/run/escalation types and API surface; preload stays a thin pass-through.
- New renderer views: a Tasks tab per project, run detail with live progress, and a global attention inbox; Dashboard and Sessions tabs get additions.
- Task and run state persists in the app's user data directory (same pattern as the project registry and session curation).
- Depends on the AgenticWorkspace conventions being installed on the machine (global skills such as /patrol and /ship at `~/.claude/skills`); the loop must degrade gracefully when they are absent.
- No new runtime dependencies expected; the loop builds on `@anthropic-ai/claude-agent-sdk` already in use.
