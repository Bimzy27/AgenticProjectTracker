# pipeline-monitoring Specification

## ADDED Requirements

### Requirement: Poll GitHub Actions status for tracked repos

The system SHALL periodically fetch GitHub Actions workflow run status for every tracked project with a linked GitHub repo.
Polling SHALL use conditional requests (ETags) and per-repo backoff to respect API rate limits.

#### Scenario: Workflow runs are fetched

- **WHEN** the polling interval elapses for a tracked repo
- **THEN** the latest workflow runs are fetched and the project's pipeline state is updated

#### Scenario: Rate limit is near exhaustion

- **WHEN** the GitHub API rate limit is close to exhausted
- **THEN** the system backs off polling and surfaces the rate-limit state in the UI instead of failing silently

### Requirement: Desktop notification on pipeline failure

The system SHALL raise a desktop notification when a workflow run transitions to failed or requires attention (for example, awaiting manual approval).
Notifications SHALL identify the project, workflow, and branch, and clicking a notification SHALL open the corresponding pipeline detail in the app.

#### Scenario: A workflow run fails

- **WHEN** a previously passing or in-progress workflow run completes with failure
- **THEN** a desktop notification names the project, workflow, and branch, and clicking it opens the run's detail view

#### Scenario: No duplicate notifications

- **WHEN** a failed run is polled again without a state change
- **THEN** no additional notification is raised for that run

### Requirement: Pipeline status visible per project

The system SHALL show each project's latest pipeline status on the dashboard and provide a detail view listing recent workflow runs with status, branch, commit, duration, and a link to the run on GitHub.

#### Scenario: Viewing pipeline details

- **WHEN** the user opens a project's pipeline view
- **THEN** recent workflow runs are listed with status, branch, commit, duration, and a link to GitHub

### Requirement: GitHub authentication via securely stored token

The system SHALL authenticate to GitHub with a user-supplied Personal Access Token stored in the operating system's credential store, never in plain text.
The system MUST function in a degraded read-only local mode (no pipelines, no releases) when no token is configured.

#### Scenario: Configuring a token

- **WHEN** the user provides a valid PAT in settings
- **THEN** the token is stored in the OS credential store and pipeline data begins loading for linked repos

#### Scenario: No token configured

- **WHEN** no token is configured
- **THEN** pipeline and release features show a setup prompt, and local features (dashboard, diffs, sessions) work normally
