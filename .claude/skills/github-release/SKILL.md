---
name: github-release
description: Cut a versioned GitHub release of the app with the packaged Windows installer attached. Use when asked to release a new version, cut vX.Y.Z, or publish the installer.
---

# GitHub Release

Cut a versioned release of Agentic Project Tracker.
Pushing a `v*` tag triggers `.github/workflows/release.yml`, which re-runs the quality checks, packages the NSIS installer, silently installs it and smoke-tests the installed app (`npm run test:smoke`, a Playwright run of the fake-agent delegation flow against the installed exe), and publishes a GitHub release with the installer attached.
Release notes are built in the workflow from conventional commit subjects since the previous tag, grouped by type (Features, Bug Fixes, and so on), with GitHub's Full Changelog compare link appended.
The smoke gate exists because dev-build E2E cannot catch asar packaging bugs; no release publishes without it passing.
This skill owns everything up to and including that tag push, then watches the workflow to completion.

## Preflight

1. Working tree clean and on `main`, pulled fresh; stray changes go through /commit first.
2. /patrol green this session; a release never ships an unverified tree.
3. CI green on the head commit: `gh run list --branch main --limit 1`.

## Steps

1. Pick the version: semver bump from the current `package.json` version based on what shipped since the last tag (`git log $(git describe --tags --abbrev=0)..HEAD --oneline`, or all history for the first release).
   Breaking changes bump major, features bump minor, fixes bump patch.
   If the user named a version, use it.
2. Update `version` in `package.json` (skip when it already matches, e.g. the first release).
   Commit as `chore: release vX.Y.Z` and push.
3. Tag and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. Watch the Release workflow: `gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')`.
   The workflow re-verifies that the tag matches `package.json`; a mismatch fails fast and means step 2 was skipped.
5. Verify the release exists and carries the installer: `gh release view vX.Y.Z` must list an `AgenticProjectTracker-Setup-X.Y.Z.exe` asset.
6. Sanity-check the published notes; edit with `gh release edit` if the generated notes are misleading.

## Failure handling

- Workflow failed before the release step: fix the cause on `main`, then delete and re-push the tag (`git tag -d vX.Y.Z && git push origin :vX.Y.Z`) once the fix landed.
  Never leave a tag pointing at a commit that failed its release build.
- Release exists but is wrong: prefer `gh release edit` or uploading a corrected asset over deleting a public release others may already link to.

## Report

State the version, the release URL, the attached assets, and the workflow run result.
Name anything skipped or left for a human decision.
