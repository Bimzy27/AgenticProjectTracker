# Agentic Project Tracker

A desktop mission control for multiple long running projects: delegate build tasks to Claude agents, supervise their runs, and keep git diffs, CI/CD pipeline health, and release analytics in one view.

## Features

- **Agent delegation**: give each project a backlog of tasks (purpose plus acceptance criteria) and delegate them to Claude agents.
  A run loop supervises each agent session end to end: structured status reporting, bounded automatic recovery from failures, step and token budgets, and a review step where you accept the result or send it back with feedback.
  Individual tasks can opt into auto-approve, accepting a clean completion without the review step.
- **Looping mode**: a per-project toggle that keeps agents working through the backlog hands-free - completed runs are approved automatically and the next draft task is delegated on its own, while questions and failures still come to you.
- **Attention inbox**: one cross-project queue for everything that needs you - agent questions, tool permission requests, exhausted retries, and completed runs awaiting review - all answerable in place.
- **Dashboard**: every tracked project at a glance - branch, dirty state, delegated task states with live progress, agent sessions needing attention, pipeline status, filterable by category.
- **Agent sessions**: discovers Claude CLI sessions per project, shows transcripts live, lets you respond to waiting sessions, and toggles permission modes (plan / accept edits / auto) on sessions managed by the app.
- **Diff viewer**: working tree (staged/unstaged/untracked) and ref-to-ref diffs, grouped by directory, syntax highlighted, unified or side-by-side.
- **Pipeline monitoring**: polls GitHub Actions with ETag conditional requests and raises desktop notifications on failures; click-through opens the run detail.
- **Release analytics**: GitHub releases with per-asset download counts, plus repository traffic (views/clones) where the token allows.

## Installation

Download the latest `AgenticProjectTracker-Setup-<version>.exe` from the [Releases page](https://github.com/Bimzy27/AgenticProjectTracker/releases) and run it.
The installer is unsigned, so Windows SmartScreen will warn on first run; choose "More info" then "Run anyway".
Alternatively, build from source with `npm run package` (see Development below).

## Requirements

- Windows (macOS/Linux untested but nothing is intentionally Windows-only).
- git on PATH.
- [Claude Code CLI](https://claude.com/claude-code) installed and logged in for agent-session features.
  Sessions started in a terminal are discovered read-only; sessions started or resumed inside the app are fully controllable.
- A GitHub Personal Access Token for pipelines, releases, and traffic.
  Minimum scopes: `repo` (private repos) plus Actions read; traffic requires push access to the repo.
  The token is stored encrypted via the OS credential vault (Electron `safeStorage`), never in plain text.
  Without a token, all local features (dashboard, diffs, sessions) work normally.

## Development

```bash
npm install
npm run dev          # run the app with hot reload
npm run typecheck    # tsc over main/preload/shared and renderer
npm run lint         # eslint
npm test             # vitest unit tests
npm run test:e2e     # builds, then drives the real app with Playwright
npm run package      # electron-vite build + electron-builder NSIS installer (dist/)
npm run test:smoke   # drives the packaged build (run `npm run package` first)
```

### Architecture

Three strict layers so the UI can later be reused in a web deployment:

- `src/main/services/` - pure TypeScript services (projects, git, sessions, pipelines, analytics); Electron APIs only enter at the composition root (`src/main/index.ts`).
- `src/shared/` - the domain model and the typed IPC contract (`TrackerApi` + `TrackerEvents`); implemented over Electron IPC today, swappable for HTTP/WebSocket.
- `src/renderer/` - React UI that talks only to the typed contract via `window.tracker`.

See `openspec/` for the full proposal, design decisions, and specs.

## Development workflow

This repo uses [OpenSpec](https://github.com/Fission-AI/OpenSpec) for spec-driven development.
Specs live in `openspec/specs/` and proposed changes in `openspec/changes/`.

In Claude Code, start a new change with:

```
/opsx:propose "your idea"
```

## Releasing

Releases are cut by pushing a version tag; `.github/workflows/release.yml` re-runs the quality checks, packages the installer, silently installs it, smoke-tests the installed app (`npm run test:smoke` driving the delegation flow through Playwright), and publishes a GitHub release with generated notes.
Dev-build E2E cannot catch asar packaging bugs (v0.1.0 shipped two), so the smoke test gates every release on the actual installed exe.

```bash
# after bumping "version" in package.json and pushing main
git tag v0.2.0
git push origin v0.2.0
```

The workflow refuses tags that do not match the `package.json` version.
In Claude Code, the repo's `github-release` skill drives the whole flow including preflight and verification.
