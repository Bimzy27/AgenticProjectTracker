# project-dashboard Specification

## Purpose

Register local git projects and present them in a single dashboard with per-project status (branch, dirty state, agent sessions, pipeline status), backed by a persistent registry.
## Requirements
### Requirement: Register a project

The system SHALL allow the user to register a project by selecting a local directory that contains a git repository.
The system SHALL detect the GitHub remote (owner/repo) from the repository's remotes and associate it with the project.
The system SHALL allow the user to set a display name and optional category tags for the project.

#### Scenario: Register a valid git repository

- **WHEN** the user selects a local directory that contains a git repository with a GitHub remote
- **THEN** the project is added to the registry with its detected owner/repo, and appears on the dashboard

#### Scenario: Selected directory is not a git repository

- **WHEN** the user selects a directory that is not a git repository
- **THEN** the system rejects the registration and explains that a git repository is required

#### Scenario: Repository has no GitHub remote

- **WHEN** the user selects a git repository whose remotes do not include GitHub
- **THEN** the system registers the project with GitHub-dependent features (pipelines, releases) marked unavailable, and allows the user to link a GitHub repo manually

### Requirement: Dashboard lists all tracked projects with status summary

The system SHALL display all registered projects in a single dashboard view.
For each project the dashboard SHALL show: display name, current branch, dirty-state indicator (uncommitted changes), count of agent sessions with their states, latest combined pipeline status with its rolling failure rate (see pipeline-monitoring), and a delegation summary (counts of queued, running, and needs-input tasks with the active run's current progress note when present).
The dashboard SHALL show a global attention indicator aggregating pending inbox items across all projects.
The dashboard SHALL support grouping or filtering projects by category tag.

#### Scenario: Viewing the dashboard

- **WHEN** the user opens the app with registered projects
- **THEN** every registered project is listed with branch, dirty state, session count, pipeline status, its rolling failure rate when available, and its delegation summary

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

### Requirement: Remove or edit a tracked project

The system SHALL allow the user to remove a project from the registry or edit its display name, linked GitHub repo, and category tags.
Removing a project SHALL NOT modify the project's files on disk.

#### Scenario: Removing a project

- **WHEN** the user removes a project from the registry
- **THEN** the project disappears from the dashboard and its files on disk are untouched

### Requirement: Configure important links on a project

The system SHALL allow the user to configure a list of important links (label plus absolute http(s) URL) per project, e.g. a Vercel dashboard or the hosted URL of the project's website.
Configured links SHALL appear in the project view and open in the system browser.
The system SHALL reject links without a label or with a URL that is not an absolute http(s) URL, and a rejected edit SHALL leave the stored links unchanged.

#### Scenario: Adding an important link

- **WHEN** the user adds a link with a label and an absolute http(s) URL to a project
- **THEN** the link appears in the project view and clicking it opens the URL in the system browser

#### Scenario: Invalid link URL

- **WHEN** the user saves a link whose URL is not an absolute http(s) URL
- **THEN** the system rejects the edit with an explanatory error and the previously stored links remain unchanged

#### Scenario: Removing links

- **WHEN** the user removes all links from a project
- **THEN** the project view no longer shows any links, only the affordance to add them

### Requirement: Registry persists across restarts

The system SHALL persist the project registry locally so that tracked projects survive app restarts.

#### Scenario: Restarting the app

- **WHEN** the user closes and reopens the app
- **THEN** all previously registered projects are present with their names and tags intact

