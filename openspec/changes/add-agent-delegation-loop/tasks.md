## 1. Domain and contract

- [x] 1.1 Add task/run/escalation domain types to `src/shared/domain.ts` (TaskDefinition, TaskState, RunRecord, RunStatusReport, InboxItem, delegation summary fields on ProjectStatus)
- [x] 1.2 Extend `TrackerApi`/`TrackerEvents` in `src/shared/ipc.ts` with task CRUD, delegate/stop/resume, inbox listing, answer/resolve calls, and task/run/inbox change events
- [x] 1.3 Mirror the new API surface in `src/preload/index.ts` and `src/preload/api.d.ts` as thin pass-throughs (no code change needed: the bridge is a generic typed pass-through, so the new surface flows through)

## 2. Run protocol

- [x] 2.1 Implement `src/main/services/RunProtocol.ts`: briefing builder (purpose, acceptance criteria, status-block schema, workspace-workflow instructions, review feedback) and tolerant `apt-status` block parser
- [x] 2.2 Unit-test the parser: valid states, block embedded in prose, malformed JSON, missing block, complete with/without passing gate
- [x] 2.3 Implement workspace-skills detection (patrol skill present under the Claude home dir, honoring the `APT_CLAUDE_HOME` test seam) with the unverified-workflow marker

## 3. Task backlog service

- [x] 3.1 Implement `TaskService` with `tasks.json` persistence (atomic write-via-rename), CRUD, ordering, and lifecycle transitions with timestamps
- [x] 3.2 Guard invalid operations (delete/edit while running) and unit-test lifecycle transitions and persistence round-trip

## 4. SessionService hooks

- [x] 4.1 Extend `SessionService`/`ManagedSession` so a caller can start a session with an owner tag (taskId/runId), observe turn completions and state changes, and send programmatic follow-ups
- [x] 4.2 Surface the task attribution on `SessionSummary` and keep existing session behavior unchanged (unit tests cover both)

## 5. Run orchestrator

- [x] 5.1 Implement `RunOrchestrator`: start run from queued task, briefing injection, status-report handling, and the working/question/blocked/complete state machine
- [x] 5.2 Implement bounded recovery (nudge budget, corrective follow-ups with failure context) and immediate question escalation
- [x] 5.3 Implement completion verification (passing-gate check), review handoff, accept and send-back-with-feedback flows
- [x] 5.4 Implement budgets and control: per-run step budget with interrupt-and-escalate, manual stop to failed, per-project exclusivity, and the global concurrency cap with FIFO queue
- [x] 5.5 Implement `runs.json` persistence, interrupted-on-restart marking, and resume-by-session-id
- [x] 5.6 Unit-test the orchestrator against a scripted fake session: happy path, recovery success, budget exhaustion, question round-trip, false completion, restart/resume

## 6. Inbox and wiring

- [x] 6.1 Implement the derived attention inbox (aggregate needs-input runs, permission prompts, reviews across projects) with live change events
- [x] 6.2 Register all new services in `src/main/index.ts` and `src/main/ipc.ts`, and extend the dashboard status payload with the delegation summary (ipc.ts needed no change: it dispatches TrackerApi generically)

## 7. Renderer UI

- [x] 7.1 Build the Tasks tab: backlog list with states, create/edit dialog (purpose, acceptance criteria, mode and budget options), reorder, delegate/stop/resume actions
- [x] 7.2 Build run detail: live progress note, status history, recovery/escalation timeline, link to session transcript
- [x] 7.3 Build the review flow: completion summary, unverified-workflow marker when applicable, accept and send-back-with-feedback actions
- [x] 7.4 Build the attention inbox view with in-place answers (question reply, permission allow/deny, review actions) plus the global attention indicator in the sidebar
- [x] 7.5 Extend Dashboard cards with the delegation summary and active-run progress; extend Sessions tab with task attribution and navigation to the owning task

## 8. Verification

- [x] 8.1 Extend Playwright E2E: create task → delegate against a scripted fake agent seam → question escalates to inbox → answer resumes → run completes → review accept marks done
- [x] 8.2 E2E cover recovery exhaustion escalating to the inbox and manual stop moving a task to failed
- [x] 8.3 Run the full local gate (typecheck, lint, format, unit, E2E) and fix everything it surfaces
- [x] 8.4 Manual end-to-end pass with a real agent on a sample project, verifying the workspace quality-gate flow is followed and UI states look pixel-right (surfaced and fixed a parallel-permission deadlock in ManagedSession along the way)
