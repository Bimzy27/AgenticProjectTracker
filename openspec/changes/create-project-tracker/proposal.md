# Proposal: Create Project Tracker

## Why

Branden runs multiple long running projects in parallel, each with its own GitHub repo, Claude CLI agent sessions, CI/CD pipelines, and release analytics.
Today there is no single place to see the state of all of them, so checking progress means juggling terminals, GitHub tabs, and dashboards.
This change creates a desktop app that acts as a mission control for those projects: view git diffs, curate and respond to agent sessions, get notified of pipeline issues, and surface release and usage metrics.

## What Changes

- Create a new desktop application (greenfield, this repo currently contains only OpenSpec scaffolding).
- Add a project dashboard that registers local project directories, links them to their GitHub repos, and shows each project's current state at a glance.
- Add a git diff viewer that presents working tree and branch diffs in a clean, categorized interface (by project, by file group, by change type).
- Add agent session management built on the Claude CLI: list sessions per project, view transcripts, curate sessions, send responses to waiting sessions, and toggle their permission modes (plan mode, accept edits, auto/bypass mode).
- Add CI/CD pipeline monitoring with desktop notifications when a pipeline fails or needs attention.
- Add a release analytics view that surfaces release history and usage metrics per project.
- Architect the app so the UI layer can later be reused in a web deployment (future iteration, not in scope now).

## Capabilities

### New Capabilities

- `project-dashboard`: Register, list, and view tracked projects, each linked to a local git repo and its GitHub remote, with an at-a-glance status summary (branch, dirty state, active sessions, pipeline health).
- `git-diff-viewer`: Browse git diffs for any tracked project, categorized by file and change type, covering uncommitted changes and branch comparisons.
- `agent-sessions`: Discover, view, and curate Claude CLI agent sessions per project; respond to sessions awaiting input; toggle a session's working mode (plan, accept edits, auto).
- `pipeline-monitoring`: Poll GitHub Actions status for tracked repos and raise desktop notifications on failures or runs requiring attention.
- `release-analytics`: Show release history (GitHub releases/tags) and usage metrics per project in a dashboard view.

### Modified Capabilities

None. This is a greenfield change with no existing specs.

## Impact

- New codebase: desktop app shell, UI, and service layer all created from scratch in this repo.
- External dependencies: git (local repos), GitHub API (repos, Actions, releases), Claude CLI and its session storage, OS notification system.
- No existing code, APIs, or users are affected.
- Future web deployment is a stated constraint on architecture (keep UI decoupled from desktop-only APIs) but introduces no work in this change.
