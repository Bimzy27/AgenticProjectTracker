# release-analytics Specification

## ADDED Requirements

### Requirement: Release history per project

The system SHALL display a project's release history from GitHub, including tag, release name, publish date, release notes, and assets.

#### Scenario: Viewing releases

- **WHEN** the user opens the releases view for a project with GitHub releases
- **THEN** releases are listed newest first with tag, name, date, notes, and assets

#### Scenario: Project has no releases

- **WHEN** a project's repo has no releases or tags
- **THEN** the view states that no releases exist rather than showing an error

### Requirement: Usage metrics per project

The system SHALL display available usage metrics for a project, including release asset download counts and, where the token permits, repository traffic (views and clones over time).

#### Scenario: Viewing download counts

- **WHEN** the user opens the analytics view for a project with release assets
- **THEN** download counts per asset and per release are shown

#### Scenario: Traffic data unavailable

- **WHEN** the configured token lacks access to traffic data for a repo
- **THEN** traffic panels indicate the data is unavailable and the rest of the analytics view still renders

### Requirement: Metrics providers are pluggable

The system SHALL retrieve metrics through a provider interface so additional analytics sources can be added without changing the UI or other services.
The initial implementation SHALL ship exactly one provider, backed by the GitHub API.

#### Scenario: Only the GitHub provider is configured

- **WHEN** the analytics view loads with the default configuration
- **THEN** all displayed metrics come from the GitHub provider and no other source is contacted
