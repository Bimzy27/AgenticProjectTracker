# attention-inbox Specification

## Purpose
TBD - created by archiving change add-agent-delegation-loop. Update Purpose after archive.
## Requirements
### Requirement: One inbox aggregates escalations across all projects

The system SHALL present a single attention inbox listing every item that needs the user across all projects: agent questions, permission requests from runs, exhausted-recovery escalations, and completed runs awaiting review.
Each item SHALL identify its project and task, show the relevant context (question text, failure history, or completion summary), and link to the underlying session transcript.

#### Scenario: Escalations from multiple projects

- **WHEN** runs in two different projects each escalate a question
- **THEN** both items appear in the one inbox, each labeled with its project and task

#### Scenario: Inbox item links to transcript

- **WHEN** the user opens an inbox item
- **THEN** the item offers navigation to the owning session's transcript

### Requirement: Items are answerable in place

The system SHALL let the user resolve inbox items directly from the inbox: answer a question, allow or deny a permission request, accept or send back a reviewed task, and resume or stop an escalated run.
Resolving an item SHALL act on the underlying run or session, and the item SHALL leave the inbox because the underlying state changed.

#### Scenario: Answering a question from the inbox

- **WHEN** the user types an answer on a question item and submits
- **THEN** the answer reaches the run's session, the task returns to running, and the item leaves the inbox

#### Scenario: Resolving a permission request

- **WHEN** the user allows a permission request from the inbox
- **THEN** the run's session proceeds with the tool use and the item leaves the inbox

### Requirement: Attention is visible without opening the inbox

The system SHALL show a global indicator of pending inbox items (count) that is visible from anywhere in the app, updating live as items arrive and resolve.

#### Scenario: New escalation while elsewhere in the app

- **WHEN** a run escalates while the user is viewing another project
- **THEN** the global attention indicator increments without a page change

### Requirement: Inbox reflects current state only

The inbox SHALL be derived from the live state of tasks, runs, and sessions rather than stored separately, so it can never disagree with the objects it summarizes.

#### Scenario: Item resolved outside the inbox

- **WHEN** the user answers an awaiting session directly from the Sessions tab
- **THEN** the corresponding inbox item disappears without separate cleanup

