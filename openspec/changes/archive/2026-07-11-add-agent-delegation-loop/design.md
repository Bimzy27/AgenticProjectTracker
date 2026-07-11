## Context

The app already runs managed agent sessions through `@anthropic-ai/claude-agent-sdk` (`SessionService` / `ManagedSession`): it streams transcripts, tracks session state (`running`, `awaiting-input`, `permission-prompt`, `idle`), routes permission requests to the UI, and can resume discovered sessions.
What is missing is everything above the session: a durable definition of what to build, an orchestrator that starts and supervises sessions toward that goal, recovery when things go wrong, and a cross-project view of where human input is needed.
The user's machine has the AgenticWorkspace conventions installed globally (`~/.claude/CLAUDE.md` and skills such as `/patrol` and `/ship` at `~/.claude/skills`), so agents launched from this app already inherit those rules; the loop's job is to lean on them, not re-implement them.
Constraints carried over from the existing architecture: services in `src/main/services/` stay Electron-free, the renderer talks only to the typed `TrackerApi`/`TrackerEvents` contract, and persistence uses JSON files in the user data directory.

## Goals / Non-Goals

**Goals:**

- A per-project task backlog with enough structure (purpose, acceptance criteria) for an agent to work unattended.
- A run loop that supervises one agent session per task from start to a verified completion report, with bounded self-recovery before escalating.
- A single attention inbox where all cross-project escalations (questions, permission requests, exhausted retries) wait for the user.
- Everything operable in-app: create task, delegate, answer escalations, review results, accept or send back.
- Run history that survives app restarts.

**Non-Goals:**

- Parallel runs within one project (one active run per project keeps git state sane; parallelism across projects is supported).
- Git worktree or container isolation for runs (future work; runs execute in the project directory like manual sessions today).
- Editing or managing the AgenticWorkspace repo itself from the app.
- Cloud or remote execution; everything runs on the local machine.
- Automatic merging or pushing; delivery beyond what the agent's own `/ship` flow does stays under user control.

## Decisions

### D1: Orchestration is a new main-process service that drives SessionService, not a parallel session stack

`RunOrchestrator` (new service) owns run lifecycle and delegates all agent I/O to the existing `SessionService`, which gains the small hooks the loop needs (start a session with a completion callback, observe state transitions, send follow-up messages programmatically).
Alternative considered: a separate ManagedRun class owning its own SDK `query()` - rejected because it would duplicate transcript handling, permission routing, and the Sessions tab integration that already work.
Loop-started sessions therefore appear in the Sessions tab for free, satisfying the attribution requirement with a `taskId` tag on the session summary.

### D2: Agent/loop protocol is a structured status block in the agent's final message

Each run session is primed with a task briefing that instructs the agent to end every turn with a fenced ` ```apt-status ` JSON block: `{ "state": "working" | "question" | "blocked" | "complete", ... }`, where `question` carries the question text and options, and `complete` carries a summary plus the patrol/verification outcome.
The orchestrator parses only this block to drive the state machine; free-form transcript text is never interpreted.
A missing or malformed block triggers one re-prompt asking for the status block before the turn is treated as `blocked`.
Alternatives considered: MCP tool the agent calls to report status (heavier: needs an MCP server in the app, and tool availability inside `/patrol` sub-flows is uncertain), and sniffing transcript heuristics (fragile by construction).
The protocol lives in one module (`RunProtocol.ts`) mirroring how JSONL-parsing tolerance is isolated in `SessionStorage.ts`.

### D3: Workspace workflow integration is by priming and verification, not enforcement

The briefing tells the agent to follow its installed workspace rules - run `/patrol` before reporting complete, conventional commits, honest reporting - and the `complete` status block must state the patrol result.
The orchestrator verifies shape, not truth: a `complete` without a passing quality-gate field is treated as `blocked` and recycled through recovery.
At delegation time the app checks that `~/.claude/skills/patrol` exists; if the workspace conventions are missing, the task can still run but the run is marked "unverified workflow" in the review summary.
Alternative considered: the app re-running typecheck/lint/tests itself as an external referee - rejected for scope now (per-project toolchains vary); noted as future hardening.

### D4: Recovery is a bounded nudge budget, then escalation

When a session errors, stalls, or reports `blocked`, the orchestrator sends a corrective follow-up (including the error context) to the same session rather than restarting it, preserving the agent's context.
Each run has a recovery budget (default 3 nudges); exhausting it escalates to the attention inbox with the failure history.
`question` states skip recovery and escalate immediately - they are decision points, not failures, and auto-answering them would defeat the purpose of escalation.
Restart-from-scratch was rejected as the default because a fresh session loses everything the agent learned about the failure.

### D5: Runs default to accept-edits mode; permission prompts become inbox items

Delegated work must not stop for every file edit, so runs start in `acceptEdits` mode, with an opt-in per task for `auto` (bypass permissions) for trusted projects.
Permission prompts that still occur (non-edit tools in acceptEdits) route to the attention inbox like questions, answered in-app via the existing permission plumbing.
Full `auto` as the default was rejected: the app may be pointed at repos the user does not fully trust the agent with, and elevating is a one-click per-task choice.

### D6: Persistence is two JSON files in the user data directory, following existing patterns

`tasks.json` stores task definitions and lifecycle state; `runs.json` stores run records (status, session id linkage, escalation history, nudge count, completion report).
Both use the same atomic write-via-rename pattern as `sessions-meta.json`.
On app restart, any run marked active is transitioned to `interrupted`; because the SDK can resume sessions by id, the review/interrupted view offers "resume run", which re-attaches via the existing resume path.
A database was rejected as overkill for the data volume; an event-sourced log was rejected because the run record plus the session transcript (already persisted by Claude) covers the audit need.

### D7: The attention inbox is a derived view, not a new store

Inbox items are computed from current state: runs in `needs-input` (question or exhausted recovery), sessions in `permission-prompt`, and runs in `review`.
Answering an item acts on the underlying object (send message to session, resolve permission, accept/send back task) and the item disappears because the state changed.
A separate inbox store was rejected because it could drift from the truth it summarizes.

## Risks / Trade-offs

- [Agents may not emit the status block reliably] → protocol is re-prompted once, parsing is tolerant (block anywhere in the message, trailing text allowed), and missing protocol degrades to `blocked` + escalation rather than silent misbehavior; the briefing keeps the schema tiny.
- [Self-reported quality-gate results can be wrong] → verification is acknowledged as shape-only in this change; the review step always shows the transcript link so the user can audit, and external re-verification is listed as future hardening.
- [Runaway sessions burning tokens] → per-run step budget (count of agent turns) in addition to the nudge budget; exceeding it interrupts the session and escalates; the user can raise budgets per task.
- [Concurrent runs across many projects strain the machine] → a global concurrency cap (default 3 active runs) with a queued state; simple FIFO, no scheduler.
- [Run executes in the live project directory, so a bad run dirties the working tree] → accepted for this change (matches how manual sessions behave); the git-diff-viewer already makes damage visible, and worktree isolation is future work.
- [AgenticWorkspace conventions absent or changed] → detection at delegation time, "unverified workflow" marking, and the loop never hard-depends on a specific skill's output format.

## Migration Plan

Purely additive: new services, new IPC surface, new UI views; existing capabilities keep working if the user never creates a task.
No data migration; new JSON files are created on first use.
Rollback is removing the new surfaces; no existing file formats change.

## Open Questions

- Should accepting a reviewed task optionally trigger the `/ship` flow (branch/commit/PR) as a follow-up run, or is that always the agent's job within the original run? (Leaning: always in-run, keep the loop single-purpose.)
- Whether the step budget should be measured in agent turns or wall-clock time; turns chosen initially because it is observable from the SDK message stream.
