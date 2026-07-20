# release-analytics Specification

## Purpose

Give each project a customizable analytics dashboard of pluggable widgets: GitHub release history and usage metrics out of the box, a first-class Vercel Web Analytics source, plus generic third-party JSON endpoints, all rendered through one generic widget contract.

## Requirements

### Requirement: Widget sources are pluggable

The system SHALL retrieve analytics through a widget-provider interface.
Each provider describes itself with a kind descriptor (label, description, declarative config-field schema) and resolves widget data into a generic envelope (timeseries, stat tiles, release list, or an in-band "unavailable" reason), so new sources plug in without changes to the UI or other services.

#### Scenario: Adding a new source

- **WHEN** a new widget provider is registered in the composition root
- **THEN** it appears in the add-widget picker and its widgets render and configure through the existing generic UI

#### Scenario: A stored widget's source is removed

- **WHEN** a dashboard contains a widget whose provider kind is no longer registered
- **THEN** that widget reports the missing source in-band and the rest of the dashboard still renders

### Requirement: Dashboards are customizable per project

The system SHALL let the user add, configure, reorder, and remove widgets per project, persist the layout, and build widget config forms generically from the kind's config-field schema.
A project that was never customized SHALL show a default dashboard: the GitHub views, clones, and releases widgets when a repo is linked, empty otherwise.

#### Scenario: Customizing the dashboard

- **WHEN** the user adds, edits, moves, or removes a widget
- **THEN** the change is persisted for that project and survives reopening the view

#### Scenario: Default dashboard

- **WHEN** a project with a linked GitHub repo opens analytics without prior customization
- **THEN** the GitHub views, clones, and releases widgets render without anything being persisted

### Requirement: Widgets fail independently

The system SHALL load and render every widget independently.
A widget whose source fails SHALL show the error (or an in-band unavailable reason, for expected gaps like a missing token or insufficient repo access) on its own card without affecting other widgets.

#### Scenario: One source is down

- **WHEN** one widget's source returns errors while others succeed
- **THEN** only that widget shows an error and the remaining widgets render their data

#### Scenario: Traffic data unavailable

- **WHEN** the configured token lacks push access to a repo's traffic data
- **THEN** the traffic widgets state the data is unavailable instead of erroring

### Requirement: Widget secrets are stored encrypted

Secret widget config values (e.g. bearer tokens for third-party APIs) SHALL be encrypted with the OS credential vault before touching disk, never returned to the renderer, and reported only as the set of keys that have a stored value.
Editing a widget without retyping a secret SHALL keep the stored value.

#### Scenario: Configuring an authenticated source

- **WHEN** the user saves a widget with a bearer token
- **THEN** the token is stored encrypted, later fetches send it to the source, and the edit form shows only that a value is saved

### Requirement: Release history per project

The system SHALL display a project's release history from GitHub through the releases widget, including tag, release name, publish date, release notes, assets, and per-asset download counts, newest first.

#### Scenario: Viewing releases

- **WHEN** the user opens a dashboard containing the releases widget for a repo with GitHub releases
- **THEN** releases are listed newest first with tag, name, date, notes, assets, and download counts

#### Scenario: Project has no releases

- **WHEN** a project's repo has no releases or tags
- **THEN** the widget states that no releases exist rather than showing an error
