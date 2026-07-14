# agent-run-loop Specification

## Purpose
TBD - created by archiving change add-agent-delegation-loop. Update Purpose after archive.
## Requirements
### Requirement: Delegating a task starts a supervised agent run

When a task starts, the system SHALL create a managed agent session in the project directory, primed with a briefing containing the task's purpose, acceptance criteria, the status-block reporting protocol, and instructions to follow the machine's installed workspace workflow (quality gate before completion, honest reporting).
The run SHALL be linked to its task and session so the user can open the live transcript at any time.

#### Scenario: Task starts a run

- **WHEN** a queued task reaches the front of the queue with run capacity available
- **THEN** a managed session starts in the project directory with the task briefing, and the task moves to running

#### Scenario: Opening the transcript of a run

- **WHEN** the user opens a running task
- **THEN** the live session transcript is visible, updating as the agent works

### Requirement: Run progress is tracked through structured status reports

The system SHALL parse a structured status block from the agent's responses to determine run progress (working, question, blocked, complete) and SHALL NOT infer state from free-form transcript text.
If a response lacks a parseable status block, the system SHALL re-prompt for it once before treating the response as blocked.

#### Scenario: Agent reports working state

- **WHEN** the agent's response contains a status block with state "working" and a progress note
- **THEN** the run stays active and the progress note is shown on the task

#### Scenario: Status block missing

- **WHEN** an agent response contains no parseable status block
- **THEN** the system re-prompts for the status block, and if it is still missing, treats the run as blocked

### Requirement: Bounded automatic recovery

When a run reports blocked, errors, or completes without a passing quality gate, the system SHALL send corrective follow-ups to the same session, including the failure context, up to a configurable recovery budget (default 3).
When the budget is exhausted, the system SHALL escalate the run to the user instead of retrying further.

#### Scenario: Automatic recovery succeeds

- **WHEN** a run reports blocked and the recovery budget is not exhausted
- **THEN** the system sends a corrective follow-up to the session and the run continues without user involvement

#### Scenario: Recovery budget exhausted

- **WHEN** a run reports blocked after the final recovery attempt
- **THEN** the run escalates to the attention inbox with the accumulated failure history, and the task moves to needs-input

### Requirement: Questions escalate immediately

When the agent reports a question requiring direction, the system SHALL escalate it to the user immediately without consuming recovery attempts, and SHALL deliver the user's answer back to the same session so the run resumes.

#### Scenario: Agent asks for direction

- **WHEN** the agent's status block reports a question with its context
- **THEN** the task moves to needs-input, the question appears in the attention inbox, and no automatic retry occurs

#### Scenario: User answers a question

- **WHEN** the user submits an answer to an escalated question
- **THEN** the answer is sent to the run's session and the task returns to running

### Requirement: Completion requires a verified report and user review

The system SHALL accept a run as complete only when the agent's status block reports complete with a summary and a passing quality-gate result; a complete report without a passing gate SHALL be treated as blocked.
Completed runs SHALL move the task to review, presenting the completion summary and a link to the full transcript, and the user SHALL either accept (task done) or send back with feedback (task re-queued, feedback included in the next briefing).
A task MAY be marked auto-approve (off by default): its completions with a passing gate SHALL be accepted automatically instead of waiting for the user's review, while questions, exhausted recovery, and step-budget escalations still reach the user.
The briefing SHALL instruct the agent to include, when able, an http(s) link to test the changes in a debug environment with its completion report; when a well-formed link is reported, the review presentation (task review and inbox review item) SHALL surface it so the user can try the changes directly, and links that are not well-formed http(s) URLs SHALL be dropped rather than rendered.

#### Scenario: Run completes with passing gate

- **WHEN** the agent reports complete with a passing quality-gate result
- **THEN** the task moves to review showing the completion summary

#### Scenario: Completion includes a debug testing link

- **WHEN** the agent reports complete with a passing gate and a debug environment link
- **THEN** the review view and the inbox review item show the link to test the changes

#### Scenario: Completion claim without passing gate

- **WHEN** the agent reports complete but the quality-gate result is missing or failing
- **THEN** the system treats the run as blocked and applies the recovery flow

#### Scenario: Sending a reviewed task back

- **WHEN** the user reviews a completed task and sends it back with feedback
- **THEN** the task is re-queued and the feedback is part of the briefing when it runs again

#### Scenario: Auto-approve task completes

- **WHEN** a task marked auto-approve completes with a passing quality-gate result
- **THEN** the run is accepted automatically, the task moves to done without a review step, and the auto-approval is recorded in the run history

### Requirement: Run budgets and interruption

Each run SHALL have a step budget limiting agent turns (user-adjustable per task); exceeding it SHALL interrupt the session and escalate to the user.
The user SHALL be able to manually stop any active run, moving the task to failed with its history retained.

#### Scenario: Step budget exceeded

- **WHEN** a run exceeds its step budget
- **THEN** the session is interrupted and the run escalates to the attention inbox

#### Scenario: User stops a run

- **WHEN** the user stops a running task
- **THEN** the session is interrupted, the task moves to failed, and the transcript remains available

### Requirement: Concurrency is capped globally

The system SHALL run at most one active run per project and SHALL cap concurrent active runs across all projects at a configurable limit (default 3), keeping excess delegated tasks queued.

#### Scenario: Capacity is full

- **WHEN** the user delegates a task while the global active-run limit is reached
- **THEN** the task waits in queued state and starts automatically when a slot frees

### Requirement: Runs survive app restarts as resumable records

The system SHALL persist run records (task linkage, session id, state, escalation and recovery history, completion report) across restarts.
Runs active at shutdown SHALL be marked interrupted on next launch, and the system SHALL offer to resume them by reattaching to their session.

#### Scenario: App restarts during a run

- **WHEN** the app is closed while a run is active and then reopened
- **THEN** the task shows as interrupted with its history intact and offers a resume action

### Requirement: Workspace workflow availability is checked

At delegation time the system SHALL check whether the machine's workspace quality-gate skills are installed; if absent, the run SHALL proceed but be marked as having an unverified workflow, and this marking SHALL be visible at review.

#### Scenario: Workspace skills missing

- **WHEN** a task is delegated on a machine without the workspace quality-gate skills
- **THEN** the run proceeds, and the review view shows that workflow verification was unavailable

