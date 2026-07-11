# git-diff-viewer Specification

## ADDED Requirements

### Requirement: View uncommitted changes for a project

The system SHALL display the diff of a tracked project's working tree, covering unstaged, staged, and untracked files.
The diff SHALL be computed from the local repository so it works without network access.

#### Scenario: Project has uncommitted changes

- **WHEN** the user opens the diff view for a project with modified, staged, and untracked files
- **THEN** all changed files are listed with their diffs, and each file is labeled as unstaged, staged, or untracked

#### Scenario: Project has a clean working tree

- **WHEN** the user opens the diff view for a project with no changes
- **THEN** the view states that the working tree is clean

### Requirement: Compare branches

The system SHALL allow the user to view the diff between the current branch and the repository's default branch, and between any two selected refs.

#### Scenario: Current branch vs default branch

- **WHEN** the user selects the branch comparison view on a feature branch
- **THEN** the diff between the feature branch and the default branch is shown

#### Scenario: Arbitrary ref comparison

- **WHEN** the user selects two refs (branches, tags, or commits)
- **THEN** the diff between those refs is shown

### Requirement: Categorized diff presentation

The system SHALL categorize changed files by change type (added, modified, deleted, renamed) and SHALL group files by directory.
The user SHALL be able to collapse and expand groups and navigate directly to any file's diff.

#### Scenario: Browsing a large diff

- **WHEN** a diff contains files across multiple directories and change types
- **THEN** files are grouped by directory with change-type indicators, and the user can collapse groups and jump to a specific file

### Requirement: Readable per-file diff rendering

The system SHALL render per-file diffs with syntax highlighting and SHALL offer both unified and side-by-side layouts.
Binary files SHALL be indicated as binary rather than rendered as text.

#### Scenario: Viewing a source file diff

- **WHEN** the user opens the diff of a source code file
- **THEN** the diff is syntax highlighted and the user can switch between unified and side-by-side layouts

#### Scenario: Viewing a binary file change

- **WHEN** a changed file is binary
- **THEN** the file is listed with a binary indicator and no text diff is attempted

### Requirement: Diff view stays current

The system SHALL refresh the diff view when the underlying repository changes, either automatically via file watching or through an explicit refresh action.

#### Scenario: Files change while the diff view is open

- **WHEN** files in the project are modified while its diff view is open
- **THEN** the diff view updates to reflect the new state, automatically or after the user triggers refresh
