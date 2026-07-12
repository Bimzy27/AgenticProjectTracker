# Police rules

Behaviour rules enforced by the /police skill against every changeset in this project.

Format: each `##` heading is one rule, named in kebab-case.
Optional fields on the first lines under the heading:

- `Scope:` glob(s) limiting which changed files trigger the rule (default: all changes; `repo` means judge the whole repository).
- `Command:` a shell command; a non-zero exit means the rule is violated.

Everything else under the heading is the rule statement, judged by the agent against the diff.

## electron-only-in-composition-root

Scope: src/main/**
Only `src/main/index.ts` and `src/main/ipc.ts` may import from `electron`.
Services under `src/main/services/` and helpers under `src/main/git/` stay Electron-free so they can move to a web backend later; Electron-specific values (paths, safeStorage, dialogs, `app.isPackaged`) are injected from the composition root.

## renderer-through-tracker-api

Scope: src/renderer/**
The renderer must not import Node or Electron APIs, or anything under `src/main/`.
It talks to the main process only through the preload bridge typed by `TrackerApi` and `TrackerEvents` in `src/shared/ipc.ts`; new capabilities extend that contract rather than bypassing it.

## session-parsing-stays-in-storage

Parsing of Claude session JSONL files (an undocumented format) is confined to `src/main/services/SessionStorage.ts` and must stay tolerant: malformed lines or unknown shapes are skipped, and a single bad session must never break a listing.

## never-open-asar-files

Scope: src/**
Code must not stat, read, or watch `*.asar` paths found in tracked project trees.
In a packaged app Electron's patched fs opens the archive and caches the handle for the process lifetime, which locks the file on Windows and breaks builds running inside a watched repo.

## test-seams-default-to-production

Scope: src/**
Test seams are `APT_*` environment variables read at the composition root, and an unset variable must fall back to real production behaviour.
No other mechanism (build flags, global mutable state) may be introduced for testability.

## runtime-deps-stay-lean

Scope: package.json
`dependencies` holds only modules the main process requires at runtime; libraries bundled into the renderer or main output by Vite (react, highlight.js, and similar) belong in `devDependencies` so electron-builder ships a lean package.

## tests-accompany-behaviour

Any change that alters runtime behaviour must include or update an automated test that would fail without the change; packaged-only behaviour that tests cannot reach must be verified against the packaged exe and the verification named in the delivery report.

## no-debug-output

Scope: src/**
No change may add leftover debug printing (`console.log`, timing dumps, commented-out prints).
The established exception is `console.error` as a rejection surface for renderer promise chains.

## no-secrets

No credentials, API keys, tokens, or connection strings may appear anywhere in the diff, including test fixtures and comments.
GitHub tokens flow only through `TokenStore` (OS credential vault), never plain text on disk.

## no-silent-error-swallowing

Catch blocks and error branches must handle, propagate, or log the error, or carry a comment stating why ignoring it is safe (the codebase's existing pattern, e.g. "per-session failure must not break the listing").
A bare empty catch with no comment is a violation.

## public-api-documented

Scope: src/main/services/**, src/shared/**
New exported classes, functions, and IPC contract members must have a doc comment describing purpose and any non-obvious behaviour or failure mode.
