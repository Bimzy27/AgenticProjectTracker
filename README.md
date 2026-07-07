# Agentic Project Tracker

A desktop mission control for multiple long running projects: git diffs, Claude agent sessions, CI/CD pipeline health, and release analytics in one place.

## Features

- **Dashboard**: every tracked project at a glance - branch, dirty state, agent sessions needing attention, pipeline status, filterable by category.
- **Diff viewer**: working tree (staged/unstaged/untracked) and ref-to-ref diffs, grouped by directory, syntax highlighted, unified or side-by-side.
- **Agent sessions**: discovers Claude CLI sessions per project, shows transcripts live, lets you respond to waiting sessions, and toggles permission modes (plan / accept edits / auto) on sessions managed by the app.
- **Pipeline monitoring**: polls GitHub Actions with ETag conditional requests and raises desktop notifications on failures; click-through opens the run detail.
- **Release analytics**: GitHub releases with per-asset download counts, plus repository traffic (views/clones) where the token allows.

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
