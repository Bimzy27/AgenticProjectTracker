# task-backlog Specification

## Purpose
TBD - created by archiving change add-agent-delegation-loop. Update Purpose after archive.
## Requirements
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

### Requirement: Task archiving

The system SHALL allow the user to archive settled tasks (draft, done, or failed) within the project view, and SHALL refuse to archive tasks that are queued, running, needing input, or in review.
The system SHALL archive a task automatically when it completes.
Archived tasks SHALL be hidden from the default backlog view, with a control to view the archive on demand.
The system SHALL allow the user to revive an archived task back to the backlog; reviving a completed task removes its done state so it returns to draft and can be delegated again.

#### Scenario: Completing a task archives it

- **WHEN** the user accepts a reviewed task as done
- **THEN** the task is archived and no longer appears in the default backlog view

#### Scenario: Viewing archived tasks

- **WHEN** the user enables the archived filter in the project's task view
- **THEN** the archived tasks are listed with their states

#### Scenario: Reviving a completed task

- **WHEN** the user revives an archived task that is done
- **THEN** the task returns to the backlog in the draft state, ready to be delegated again

#### Scenario: Archiving an active task is prevented

- **WHEN** the user attempts to archive a task that is queued, running, needing input, or in review
- **THEN** the system refuses and explains the run must finish or be stopped first

### Requirement: Task list filtering and sorting

The system SHALL let the user filter the task list by text (matched case-insensitively against title and purpose) and sort it by creation time, last-update time, or title, each ascending or descending, in addition to the default manual backlog order.
The same filter and sort controls SHALL apply to the backlog view and the archived view.
Position-based reorder controls SHALL be available only while the plain manual backlog order is shown, since positional moves are ambiguous in a filtered or re-sorted list.

#### Scenario: Filtering the backlog

- **WHEN** the user types text into the task filter
- **THEN** only tasks whose title or purpose contains the text (ignoring case) remain listed

#### Scenario: Sorting alphabetically and by date

- **WHEN** the user picks a title or date sort and toggles the direction
- **THEN** the list reorders accordingly, ascending or descending

#### Scenario: Filtering and sorting the archive

- **WHEN** the user enables the archived view and applies a filter or sort
- **THEN** the archived tasks are filtered and sorted with the same controls

#### Scenario: Manual reordering is confined to backlog order

- **WHEN** a filter or a non-default sort is active
- **THEN** the move up/down controls are hidden until the plain backlog order is restored

### Requirement: Backlog persists across restarts

The system SHALL persist tasks and their states locally so the backlog survives app restarts.

#### Scenario: Restarting the app

- **WHEN** the user closes and reopens the app
- **THEN** all tasks are present with their states, purposes, and order intact

