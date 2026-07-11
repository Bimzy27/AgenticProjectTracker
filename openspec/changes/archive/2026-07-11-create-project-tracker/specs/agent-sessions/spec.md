# agent-sessions Specification

## ADDED Requirements

### Requirement: Discover Claude CLI sessions per project

The system SHALL discover Claude CLI sessions associated with each tracked project by reading Claude's local session storage.
Discovery SHALL tolerate unknown or malformed session records by skipping them without failing the overall listing.

#### Scenario: Project has existing sessions

- **WHEN** the user opens the sessions view for a project that has Claude CLI session history
- **THEN** the sessions are listed with their ID, start time, last activity, and a summary of the most recent exchange

#### Scenario: Session storage contains an unreadable record

- **WHEN** one session file is malformed or in an unknown format
- **THEN** that session is skipped or shown in an error state, and all other sessions are listed normally

### Requirement: View session transcripts

The system SHALL display the transcript of any discovered or managed session, including user messages, assistant messages, and tool activity.
Transcripts of active sessions SHALL update as new content is produced.

#### Scenario: Viewing a past session

- **WHEN** the user opens a completed session
- **THEN** the full transcript is shown in order

#### Scenario: Watching an active session

- **WHEN** the user opens a session that is actively producing output
- **THEN** new transcript content appears in the view as it is produced

### Requirement: Respond to sessions awaiting input

The system SHALL allow the user to send a response to a managed session that is awaiting user input.
For a session that is not currently managed by the app and not live in another process, the system SHALL resume it via the Claude Agent SDK so the user can respond.

#### Scenario: Responding to a managed session

- **WHEN** a managed session is awaiting input and the user submits a response
- **THEN** the response is delivered to the session and the transcript shows the session continuing

#### Scenario: Responding to a discovered session

- **WHEN** the user responds to a discovered session that is not live in another process
- **THEN** the system resumes the session with the user's message and it becomes a managed session

#### Scenario: Session is live in another terminal

- **WHEN** the user attempts to respond to a session that is currently attached to an external process
- **THEN** the system explains that the session is controlled elsewhere and offers view-only access

### Requirement: Toggle session working mode

The system SHALL allow the user to switch a managed session's permission mode among plan mode, accept-edits mode, and auto (bypass permissions) mode.
The current mode SHALL be visible on the session at all times.

#### Scenario: Switching to accept-edits mode

- **WHEN** the user switches a managed session from plan mode to accept-edits mode
- **THEN** the session continues with file edits applied without per-edit prompts, and the UI shows the new mode

#### Scenario: Switching to auto mode

- **WHEN** the user switches a managed session to auto mode
- **THEN** subsequent tool use proceeds without permission prompts and the UI clearly indicates the elevated mode

### Requirement: Curate sessions

The system SHALL allow the user to curate the session list per project: pin important sessions, rename session titles, archive sessions from the default view, and unarchive them.
Curation SHALL NOT delete or modify Claude's underlying session files.

#### Scenario: Pinning and renaming a session

- **WHEN** the user pins a session and gives it a custom title
- **THEN** the session appears at the top of the project's session list under the custom title, and persists across app restarts

#### Scenario: Archiving a session

- **WHEN** the user archives a session
- **THEN** it is hidden from the default list, remains available under an archived filter, and its underlying session file is untouched

### Requirement: Sessions needing attention are surfaced

The system SHALL indicate on the dashboard and in the sessions view when a session is awaiting user input or has hit a permission prompt.

#### Scenario: Session hits a permission prompt

- **WHEN** a managed session requests permission for a tool use
- **THEN** the project's dashboard entry and the session list show an attention indicator until the user responds
