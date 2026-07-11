## ADDED Requirements

### Requirement: Loop-started sessions are attributed to their task

Sessions started by the agent run loop SHALL be attributed to their owning task in session listings, and the session view SHALL link back to the task and run that own the session.
Attribution SHALL NOT change how the session itself behaves (transcript viewing, responding, permission control all work as for any managed session).

#### Scenario: Run session in the sessions list

- **WHEN** the user opens the Sessions tab for a project with an active delegated run
- **THEN** the run's session appears in the list labeled with its task, and behaves like any other managed session

#### Scenario: Navigating from session to task

- **WHEN** the user views a session that belongs to a run
- **THEN** the view offers navigation to the owning task and its run detail
