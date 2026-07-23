# pipeline-monitoring Specification

## Purpose

Monitor CI/CD pipelines for tracked projects through a pluggable set of providers (GitHub Actions workflow runs, Vercel deployments, and any future source): rate-limit-aware polling, per-project status display, log inspection, failure notifications, and secure credential handling.

## Requirements

### Requirement: Poll every configured pipeline provider for tracked projects

The system SHALL periodically fetch recent runs from every pipeline provider (GitHub Actions, Vercel, or a future source) configured for a tracked project, and merge them into one combined timeline and status summary.
Adding a new pipeline provider SHALL require no changes to the pipeline data model, the IPC contract, or the Pipelines tab beyond registering the provider.
Polling SHALL use conditional requests (ETags) where the provider supports them, and per-provider backoff to respect API rate limits; one provider's backoff or failure SHALL NOT block another provider's polling for the same project.

#### Scenario: Runs are fetched from every configured provider

- **WHEN** the polling interval elapses for a tracked project
- **THEN** the latest runs are fetched from each of its configured pipeline providers and the project's combined pipeline state is updated

#### Scenario: Rate limit is near exhaustion

- **WHEN** the GitHub API rate limit is close to exhausted
- **THEN** the system backs off polling for GitHub Actions and surfaces the rate-limit state in the UI instead of failing silently

### Requirement: Desktop notification on pipeline failure

The system SHALL raise a desktop notification when a run from any configured provider transitions to failed or requires attention (for example, awaiting manual approval).
Notifications SHALL identify the project, run name, and branch, and clicking a notification SHALL open the corresponding pipeline detail in the app.

#### Scenario: A run fails

- **WHEN** a previously passing or in-progress run completes with failure
- **THEN** a desktop notification names the project, run, and branch, and clicking it opens the run's detail view

#### Scenario: No duplicate notifications

- **WHEN** a failed run is polled again without a state change
- **THEN** no additional notification is raised for that run

### Requirement: Pipeline status and logs visible per project

The system SHALL show each project's combined pipeline status on the dashboard and provide a detail view listing recent runs from every configured provider, each with its pipeline source, status, branch, commit, duration, and a link to view it on the provider's site.
For providers that support it, the system SHALL let the user fetch and inspect a run's build/deploy logs in the app, to make it easier to diagnose and fix failures without leaving the app.

#### Scenario: Viewing pipeline details

- **WHEN** the user opens a project's pipeline view
- **THEN** recent runs from every configured provider are listed with their pipeline source, status, branch, commit, duration, and a link to the provider's site

#### Scenario: Inspecting a run's logs

- **WHEN** the user asks to view logs for a run whose provider supports it
- **THEN** the run's build/deploy logs are fetched and displayed, with a link to view the full logs on the provider's site

### Requirement: Rolling pipeline failure rate on the dashboard

The system SHALL compute, per tracked project, a rolling failure rate over the most recently completed runs (successes and failures, across every configured pipeline provider) and show it on the project's dashboard card as an at-a-glance build-stability indicator.
The computation SHALL be generic over the pipeline run model so it applies unchanged to any current or future provider.

#### Scenario: A project has recent failures

- **WHEN** a project has completed pipeline runs and some of the most recent ones failed
- **THEN** the dashboard card shows the percentage of those runs that failed and the number of runs it was computed from

#### Scenario: No completed runs yet

- **WHEN** a project has no completed (success or failure) pipeline runs yet
- **THEN** the dashboard card shows no failure-rate indicator instead of a misleading value

### Requirement: GitHub authentication via securely stored token

The system SHALL authenticate to GitHub with a user-supplied Personal Access Token stored in the operating system's credential store, never in plain text.
The system MUST function in a degraded read-only local mode (no GitHub Actions pipelines, no releases) when no token is configured.

#### Scenario: Configuring a token

- **WHEN** the user provides a valid PAT in settings
- **THEN** the token is stored in the OS credential store and GitHub Actions pipeline data begins loading for linked repos

#### Scenario: No token configured

- **WHEN** no GitHub token is configured
- **THEN** GitHub-backed pipeline and release features show a setup prompt, and local features (dashboard, diffs, sessions) work normally

### Requirement: Vercel deployment pipelines via a securely stored access token

The system SHALL let the user link a project to a Vercel project and authenticate to Vercel with a user-supplied access token stored in the operating system's credential store, never in plain text.
Once linked and authenticated, the system SHALL poll the Vercel project's deployments as a pipeline alongside any other configured provider.

#### Scenario: Linking a Vercel project

- **WHEN** the user links a project to a Vercel project and configures a Vercel access token in settings
- **THEN** the project's Pipelines tab begins showing that Vercel project's deployments

#### Scenario: No Vercel token configured yet

- **WHEN** a project is linked to a Vercel project but no Vercel access token is configured
- **THEN** the Pipelines tab explains that a token is needed instead of erroring, and other pipeline providers keep working
