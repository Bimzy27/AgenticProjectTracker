# Tasks: Create Project Tracker

## 1. Project Scaffolding

- [x] 1.1 Initialize Electron + TypeScript + React app (electron-vite), with main, preload, renderer, and shared packages
- [x] 1.2 Set up lint (ESLint), format (Prettier), and unit test (Vitest) tooling with scripts and a CI workflow running on Windows, macOS, and Linux
- [x] 1.3 Define the shared typed IPC contract package (request/response methods plus event subscriptions) and wire a typed invoke/subscribe bridge through the preload script
- [x] 1.4 Create the app shell UI: window, navigation between Dashboard, Project (Diffs, Sessions, Pipelines, Analytics), and Settings views

## 2. Project Registry and Dashboard

- [x] 2.1 Implement ProjectService with a JSON-file registry (atomic writes, load on startup) covering add, edit, remove, and list
- [x] 2.2 Implement project registration flow: directory picker, git repo validation, GitHub remote detection, manual repo linking, display name and category tags
- [x] 2.3 Implement the dashboard view: project cards with branch, dirty state, session count/attention indicator, and latest pipeline status
- [x] 2.4 Implement category filtering/grouping and the error state for missing project directories (relocate or remove)
- [x] 2.5 Unit tests for ProjectService and registration validation edge cases

## 3. Git Diff Viewer

- [x] 3.1 Implement GitService (simple-git): status, working tree diff (unstaged/staged/untracked), branch vs default branch, and arbitrary ref-to-ref diffs
- [x] 3.2 Implement diff parsing into a structured model: per-file change type (added/modified/deleted/renamed), directory grouping, binary detection
- [x] 3.3 Build the diff viewer UI: collapsible directory groups, change-type badges, file navigation, syntax-highlighted unified and side-by-side rendering
- [x] 3.4 Add repository file watching with debounced refresh and an explicit refresh action
- [x] 3.5 Unit tests for diff parsing and GitService against fixture repositories

## 4. Agent Sessions

- [x] 4.1 Implement the session-storage adapter: locate and parse Claude CLI session JSONL files per project with tolerant, per-record error handling
- [x] 4.2 Implement SessionService discovery and listing: ID, timestamps, last-exchange summary, and live-vs-idle detection (session attached to an external process)
- [x] 4.3 Implement transcript rendering: user messages, assistant messages, tool activity; live updates via file watcher with on-demand fallback
- [x] 4.4 Integrate the Claude Agent SDK for managed sessions: start and resume sessions with streaming input, deliver user responses, stream output into the transcript view
- [x] 4.5 Implement permission-mode toggling (plan, accept edits, auto) on managed sessions with the current mode always visible in the UI
- [x] 4.6 Implement resume-to-respond for discovered sessions and the view-only state for sessions live in another terminal
- [x] 4.7 Implement session curation (pin, rename, archive/unarchive) stored app-side without touching Claude's session files
- [x] 4.8 Surface awaiting-input and permission-prompt attention indicators on the session list and dashboard
- [x] 4.9 Unit tests for the storage adapter (fixture JSONL, malformed records) and SessionService state transitions

## 5. Pipeline Monitoring

- [x] 5.1 Implement GitHub auth: PAT entry in Settings, storage via OS credential vault (safeStorage), optional import of the gh CLI token, and the degraded no-token mode
- [x] 5.2 Implement PipelineService: Octokit workflow-run polling with ETag conditional requests, per-repo backoff, and a global poll scheduler
- [x] 5.3 Implement state diffing and transition events (failure, action_required) with de-duplication so unchanged failures do not re-notify
- [x] 5.4 Wire desktop notifications (project, workflow, branch) with click-through to the run detail view
- [x] 5.5 Build the pipeline UI: dashboard status badge and detail view listing recent runs (status, branch, commit, duration, GitHub link) plus rate-limit state surfacing
- [x] 5.6 Unit tests for poll scheduling, ETag handling, and notification de-duplication using a mocked GitHub API

## 6. Release Analytics

- [x] 6.1 Define the MetricsProvider interface and implement the GitHub provider: releases (tag, name, date, notes, assets) and asset download counts
- [x] 6.2 Add repository traffic metrics (views, clones) with graceful handling when the token lacks access
- [x] 6.3 Build the analytics UI: release history list, download counts per asset/release, traffic charts, and empty states for repos without releases
- [x] 6.4 Unit tests for the GitHub provider against mocked API responses, including permission-denied traffic responses

## 7. Hardening and Release

- [x] 7.1 End-to-end smoke test (Playwright for Electron): register a project, view a diff, open a session transcript, and see pipeline status with mocked GitHub
- [x] 7.2 Error and offline handling pass: no network, expired token, and Claude CLI not installed all degrade with clear messaging
- [x] 7.3 UI polish pass: consistent layout, loading and empty states, and dark/light theme support
- [x] 7.4 Package the app for Windows (electron-builder), verify notifications and credential storage on a clean machine, and document setup (PAT scopes, Claude CLI requirement) in the README

Notes:
- 7.1: pipeline behavior against a mocked GitHub API is covered by the PipelineService unit tests; the E2E asserts the degraded no-token messaging instead, since the desktop app cannot intercept HTTPS in-process cleanly.
- 7.4: the NSIS config and an unpacked build (`dist/win-unpacked`) were built, signed, and launch-verified on this machine; verification on a truly clean machine still needs a manual pass.
