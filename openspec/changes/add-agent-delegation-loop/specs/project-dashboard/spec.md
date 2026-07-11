## MODIFIED Requirements

### Requirement: Dashboard lists all tracked projects with status summary

The system SHALL display all registered projects in a single dashboard view.
For each project the dashboard SHALL show: display name, current branch, dirty-state indicator (uncommitted changes), count of agent sessions with their states, latest pipeline status, and a delegation summary (counts of queued, running, and needs-input tasks with the active run's current progress note when present).
The dashboard SHALL show a global attention indicator aggregating pending inbox items across all projects.
The dashboard SHALL support grouping or filtering projects by category tag.

#### Scenario: Viewing the dashboard

- **WHEN** the user opens the app with registered projects
- **THEN** every registered project is listed with branch, dirty state, session count, pipeline status, and its delegation summary

#### Scenario: Filtering by category

- **WHEN** the user selects a category filter
- **THEN** only projects tagged with that category are shown

#### Scenario: Project directory no longer exists

- **WHEN** a registered project's local directory has been moved or deleted
- **THEN** the dashboard shows the project in an error state with an option to relocate or remove it, and other projects are unaffected

#### Scenario: Project has an active delegated run

- **WHEN** a project has a task in the running state
- **THEN** its dashboard card shows the running task and its latest progress note

#### Scenario: Attention indicator on the dashboard

- **WHEN** any project has an item pending in the attention inbox
- **THEN** the dashboard's global attention indicator shows the pending count
