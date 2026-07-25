# Agentic Project Tracker

Mission control desktop app for long-running software projects: git diffs, Claude agent sessions, CI/CD pipelines, and release analytics, organized per project.

## Language

**Session**:
A structured, agent-managed conversation with the Claude Agent SDK's `query()` protocol - permission modes, transcripts, tasks, escalations. Lives in the Sessions tab.
_Avoid_: Terminal, shell, run (run/RunRecord is the task-delegation execution, a different concept again)

**Terminal**:
An unmanaged, interactive PTY-backed shell process embedded in a project's Terminals tab, for ad hoc work the structured Session protocol doesn't cover (launching an interactive `claude` REPL, `nvim`, or arbitrary CLI commands). The app does not parse or understand what runs inside it - contrast with Session, which is structured and inspectable.
_Avoid_: Session, console, shell (shell is the process running inside a Terminal, not the Terminal itself)

**Terminal instance**:
One live shell process within a project's Terminals tab, shown as its own sub-tab. A project can have several open at once, each independent.
