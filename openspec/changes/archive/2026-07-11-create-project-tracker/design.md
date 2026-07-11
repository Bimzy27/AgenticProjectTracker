# Design: Create Project Tracker

## Context

This repo is empty apart from OpenSpec scaffolding, so everything here is greenfield.
The app is a personal mission control for multiple long running projects.
Each project is a local git working copy with a GitHub remote, zero or more Claude CLI agent sessions, CI/CD pipelines on GitHub Actions, and releases with usage metrics.
The primary user is a single developer on Windows, but nothing should preclude macOS/Linux later.
A stated constraint is that the UI may later be reused in a web deployment, so the UI must not depend directly on desktop-only APIs.

## Goals / Non-Goals

**Goals:**

- One desktop app that shows the live state of all tracked projects.
- Clean, categorized git diff viewing per project.
- Discover, view, curate, and respond to Claude CLI agent sessions, including toggling permission modes.
- Desktop notifications for CI/CD pipeline failures.
- Release history and usage metrics per project.
- A service/UI split that allows a future web frontend without rewriting business logic.

**Non-Goals:**

- No web deployment in this change (architecture only accommodates it).
- No multi-user support, auth, or cloud sync.
- No support for CI providers other than GitHub Actions in this change.
- No editing of code or resolving of diffs inside the app (view and curate, not an IDE).
- No custom analytics ingestion pipeline; only metrics available from GitHub APIs in this change.

## Decisions

### D1: Electron + TypeScript + React for the desktop shell

The Claude Agent SDK is TypeScript-first, the GitHub client (Octokit) is TypeScript, and git tooling (simple-git) is mature in Node.
Electron keeps the whole stack in one language and gives the renderer a plain web UI, which directly serves the future web iteration.
Alternative considered: Tauri (lighter, Rust backend), rejected because every integration this app needs (Claude Agent SDK, Octokit, session JSONL parsing) lives in the Node ecosystem, and a Rust-to-Node sidecar would add complexity without quality gains for a single-user tool.

### D2: Strict three-layer architecture: services, IPC contract, UI

- **Service layer** (Electron main process): `ProjectService`, `GitService`, `SessionService`, `PipelineService`, `AnalyticsService`. Pure TypeScript, no Electron imports except at the composition root, unit testable in isolation.
- **IPC contract**: a single typed API surface (request/response plus event subscriptions) defined in a shared package. Electron IPC implements it now; an HTTP/WebSocket adapter can implement the same interface for the web later.
- **UI** (renderer): React app that talks only to the typed contract, never to Node or Electron APIs.

Alternative considered: calling Node APIs directly from the renderer with nodeIntegration, rejected for security and because it would weld the UI to the desktop.

### D3: Agent session integration via the Claude Agent SDK plus session file discovery

Two complementary mechanisms:

- **Managed sessions**: sessions started or resumed from the app use the Claude Agent SDK with streaming input. This gives programmatic control: sending user responses, receiving streamed output, and switching permission mode (`plan`, `acceptEdits`, `bypassPermissions`/auto) on the live session.
- **Discovered sessions**: sessions started outside the app (plain `claude` in a terminal) are discovered by reading Claude's session storage (`~/.claude/projects/<encoded-path>/*.jsonl`). These are shown read-only with their transcripts. "Respond" and "toggle mode" on a discovered session works by resuming it through the SDK (`resume` with session ID), at which point it becomes a managed session.

Alternative considered: driving the interactive `claude` TUI through a pseudo-terminal, rejected as brittle (screen-scraping, no stable contract) versus the SDK's supported control protocol.

### D4: Project registry stored as a local JSON file

Tracked projects (path, GitHub owner/repo, display name, categories) are stored in a single JSON file in the app's user-data directory, loaded into memory and written atomically on change.
Alternative considered: SQLite, rejected for now because the data is a small list of projects plus settings; no query or migration needs justify a database yet. The `ProjectService` interface hides the storage, so swapping to SQLite later is contained.

### D5: GitHub access via Octokit with a Personal Access Token, polling for pipeline state

- Auth: user supplies a PAT (or the app reads the `gh` CLI's stored token if present); stored in the OS credential vault via `keytar`/Electron `safeStorage`, never in plain JSON.
- Pipeline monitoring: `PipelineService` polls the Actions API (workflow runs per tracked repo) on an interval with ETag caching, diffs against last-known state, and emits events on transitions to `failure`/`action_required`. Desktop notifications go through Electron's `Notification` at the composition root, so the service itself stays platform-agnostic.

Alternative considered: GitHub webhooks, rejected because a desktop app has no stable public endpoint; polling with ETags is free (304s do not count against rate limits) and simple.

### D6: Git operations via simple-git against the local working copy

Diffs (working tree, staged, branch vs default branch) come from local git via simple-git rather than the GitHub API, so uncommitted work is visible and nothing requires network.
Diff rendering categorizes by change type (added/modified/deleted/renamed) and directory grouping, with per-file syntax-highlighted unified or split view.

### D7: Analytics limited to GitHub-native metrics, behind a provider interface

`AnalyticsService` exposes a `MetricsProvider` interface; the first provider implements GitHub releases (list, notes, asset download counts) and repository traffic (views/clones, where the PAT has access).
Future providers (product analytics dashboards, crash reporting) plug in behind the same interface.

## Risks / Trade-offs

- [Claude session storage format is undocumented and may change between CLI versions] → Isolate all JSONL parsing in one adapter with tolerant parsing (skip unknown records), pin known-good CLI versions in docs, and fail per-session rather than crashing discovery.
- [Toggling modes on sessions not started by the app] → Only possible by resuming through the SDK, which cannot attach to a session currently live in another terminal. UI must make this explicit: live external sessions are view-only until the external process ends.
- [GitHub API rate limits with many tracked repos] → ETag-conditional polling, per-repo backoff, and a global poll scheduler; surface rate-limit state in the UI instead of silently stalling.
- [Electron footprint] → Accepted trade-off for ecosystem fit (D1); mitigate with a single window and lazy-loaded views.
- [PAT scope creep] → Document minimum scopes (repo, workflow read); token stored via OS credential vault only.
- [Windows-first development may hide path/encoding bugs on other platforms] → Keep all path handling in Node `path` APIs and the session-storage adapter; add CI runs on macOS/Linux even before those platforms are supported.

## Migration Plan

Greenfield, so no migration.
Rollback is deleting the app; the JSON registry and vault entries are the only local state it creates.

## Open Questions

- Which usage metrics matter most beyond GitHub traffic and release downloads? The provider interface (D7) defers this.
- Should discovered-session transcripts be watched live (file watcher on JSONL) or refreshed on demand? Initial implementation uses a file watcher with on-demand fallback; revisit if watcher reliability on Windows is poor.
