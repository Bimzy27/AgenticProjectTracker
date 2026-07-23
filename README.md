# Agentic Project Tracker

A desktop mission control for multiple long running projects: delegate build tasks to Claude agents, supervise their runs, and keep git diffs, CI/CD pipeline health, and release analytics in one view.

## Quick start (developers)

Get from clone to a running app in under five minutes.

### Prerequisites

- **Node.js 22** (the version CI builds with).
- **git** on PATH.
- **Windows** is the primary platform; macOS/Linux are untested but nothing is intentionally Windows-only.
- Optional: [Claude Code CLI](https://claude.com/claude-code) installed and logged in, needed only for the agent-session and delegation features.
- Optional: a GitHub Personal Access Token, needed only for pipelines and analytics (see First run below).

### Run it

```bash
git clone https://github.com/Bimzy27/AgenticProjectTracker.git
cd AgenticProjectTracker
npm install
npm run dev
```

`npm run dev` starts the Electron app with hot reload for the renderer.
Before your first commit, verify your environment by running the checks CI runs:

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

### First run

1. Click **+ Add project** on the dashboard and pick a local git repository.
   The dashboard, diff viewer, and task backlog work immediately with no further setup.
2. For GitHub features (pipeline monitoring, release analytics), open **Settings** and either paste a Personal Access Token or click **Import from gh CLI** if you are logged in with `gh`.
   Minimum scopes: `repo` (for private repos) plus Actions read; repository traffic additionally requires push access to the repo.
   The token is stored encrypted via the OS credential vault (Electron `safeStorage`), never in plain text.
3. For Vercel deployment pipelines, open **Settings** and paste a Vercel access token, then link the project to its Vercel project on the project view.
   The token is stored encrypted the same way as the GitHub token.
4. For agent features (delegating tasks, viewing sessions), make sure the Claude Code CLI is installed and logged in.
   Sessions started in a terminal are discovered read-only; sessions started or resumed inside the app are fully controllable.

Everything is optional beyond step 1: without a token or the CLI, all local features work normally.

### Everyday commands

| Command              | What it does                                                    |
| -------------------- | --------------------------------------------------------------- |
| `npm run dev`        | Run the app with hot reload                                     |
| `npm run typecheck`  | `tsc` over main/preload/shared and renderer                     |
| `npm run lint`       | ESLint                                                          |
| `npm test`           | Vitest unit tests                                               |
| `npm run test:e2e`   | Builds, then drives the real app with Playwright                |
| `npm run package`    | electron-vite build + electron-builder NSIS installer (`dist/`) |
| `npm run test:smoke` | Drives the packaged build (run `npm run package` first)         |

## Installing the app (users)

Download the latest `AgenticProjectTracker-Setup-<version>.exe` from the [Releases page](https://github.com/Bimzy27/AgenticProjectTracker/releases) and run it.
The installer is unsigned, so Windows SmartScreen will warn on first run; choose "More info" then "Run anyway".

## Features

- **Agent delegation**: give each project a backlog of tasks (purpose plus acceptance criteria) and delegate them to Claude agents.
  A run loop supervises each agent session end to end: structured status reporting, bounded automatic recovery from failures, step and token budgets, and a review step where you accept the result or send it back with feedback.
  Individual tasks can opt into auto-approve, accepting a clean completion without the review step.
- **Looping mode**: a per-project toggle that keeps agents working through the backlog hands-free - completed runs and the delegated runs' permission requests are approved automatically and the next draft task is delegated on its own, while questions and failures still come to you.
- **Attention inbox**: one cross-project queue for everything that needs you - agent questions, tool permission requests, exhausted retries, and completed runs awaiting review - all answerable in place.
- **Dashboard**: every tracked project at a glance - branch, dirty state, delegated task states with live progress, agent sessions needing attention, pipeline status with a rolling build-failure rate, filterable by category.
- **Agent sessions**: discovers Claude CLI sessions per project, shows transcripts live, lets you respond to waiting sessions, and toggles permission modes (plan / accept edits / auto) on sessions managed by the app.
- **Diff viewer**: working tree (staged/unstaged/untracked) and ref-to-ref diffs, grouped by directory, syntax highlighted, unified or side-by-side.
- **Pipeline monitoring**: a pluggable set of pipeline providers (GitHub Actions workflow runs, Vercel deployments) polled per project - ETag conditional requests where supported, per-provider backoff, desktop notifications on failures with click-through to the run, in-app build/deploy log inspection, and a rolling failure-rate indicator on the dashboard for at-a-glance build stability.
  Adding another provider needs no changes to the data model or UI.
- **Analytics dashboard**: a per-project, customizable dashboard of pluggable widgets.
  GitHub releases (per-asset download counts), repository traffic (views/clones), and repo stats ship built in, and a generic JSON metric widget charts any third-party JSON endpoint (e.g. Vercel-style analytics APIs); widget bearer tokens are stored encrypted via the OS credential vault.

## Codebase orientation

The app is Electron + TypeScript + React, split into three strict layers so the UI can later be reused in a web deployment:

- `src/main/services/` - pure TypeScript services (projects, git, sessions, pipelines, analytics).
  These must stay Electron-free; Electron APIs enter only at the composition root (`src/main/index.ts`), which injects paths, `safeStorage`, dialogs, and the like.
- `src/shared/` - the domain model (`domain.ts`) and the typed IPC contract (`TrackerApi` + `TrackerEvents` in `ipc.ts`); implemented over Electron IPC today, swappable for HTTP/WebSocket.
- `src/renderer/` - React UI that talks only to the typed contract via `window.tracker`, never to Node or Electron APIs directly.

Tests live in two places:

- `tests/*.test.ts` - Vitest unit tests, one file per service.
- `tests/e2e/*.spec.ts` - Playwright tests that drive the real built app.
  Test seams are `APT_*` environment variables read at the composition root (e.g. `APT_USER_DATA_DIR` for an isolated data dir, `APT_TEST_PICK_DIR` to bypass the native directory picker); unset variables always fall back to real production behaviour.

These layer rules and other behaviour rules are codified in `POLICE.md` and enforced against every changeset; read it before your first change.
See `openspec/` for the full proposal, design decisions, and per-feature specs.

### Deliberate choices that look like mistakes

Do not "fix" these:

- `react`, `react-dom`, and `highlight.js` are `devDependencies` on purpose: Vite bundles them into the output, and keeping `dependencies` to true runtime modules (SDK, simple-git, octokit, chokidar) keeps the packaged app lean.
- Vite is pinned to v7 with `@vitejs/plugin-react@5` because `electron-vite@5` does not support Vite 8.
- Claude session JSONL parsing (`src/main/services/SessionStorage.ts`) is deliberately tolerant because the format is undocumented; malformed lines are skipped and a bad session must never break a listing.
- Code never stats, reads, or watches `*.asar` files in tracked project trees: in a packaged app Electron's patched `fs` caches an open handle, which locks the file on Windows.

## Development workflow

This repo uses [OpenSpec](https://github.com/Fission-AI/OpenSpec) for spec-driven development.
Specs live in `openspec/specs/` and proposed changes in `openspec/changes/`.

In Claude Code, start a new change with:

```
/opsx:propose "your idea"
```

Every behaviour change must come with a test that would fail without it (see `POLICE.md`), and the CI workflow (`.github/workflows/ci.yml`) runs typecheck, lint, format check, unit tests, and a build on every push.

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
