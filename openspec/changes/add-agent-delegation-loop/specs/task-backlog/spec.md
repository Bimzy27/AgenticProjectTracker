## ADDED Requirements

### Requirement: Define tasks per project

The system SHALL allow the user to create tasks for a tracked project, each with a title, a purpose statement describing what to build, and optional acceptance criteria.
The system SHALL allow editing and deleting tasks that are not currently running.

#### Scenario: Creating a task

- **WHEN** the user creates a task with a title and purpose on a project
- **THEN** the task appears in the project's backlog in the draft state

#### Scenario: Editing a queued task

- **WHEN** the user edits the purpose of a task that is not running
- **THEN** the changes are saved and visible in the backlog

#### Scenario: Deleting a running task is prevented

- **WHEN** the user attempts to delete a task whose run is active
- **THEN** the system refuses and explains the run must be stopped first

### Requirement: Task lifecycle states

Each task SHALL be in exactly one of the states: draft, queued, running, needs-input, review, done, or failed.
The system SHALL record state transitions with timestamps, and the current state SHALL be visible wherever the task is shown.

#### Scenario: Delegating a draft task

- **WHEN** the user delegates a draft task to an agent
- **THEN** the task moves to queued (or directly to running if capacity allows) and its state change is timestamped

#### Scenario: Task states are visible

- **WHEN** the user views a project's backlog
- **THEN** every task shows its current state distinctly

### Requirement: Backlog ordering

The system SHALL allow the user to reorder queued tasks, and queued tasks SHALL start in backlog order as run capacity becomes available.

#### Scenario: Reordering the queue

- **WHEN** the user moves a queued task above another queued task
- **THEN** the moved task starts first when capacity frees up

### Requirement: Backlog persists across restarts

The system SHALL persist tasks and their states locally so the backlog survives app restarts.

#### Scenario: Restarting the app

- **WHEN** the user closes and reopens the app
- **THEN** all tasks are present with their states, purposes, and order intact
