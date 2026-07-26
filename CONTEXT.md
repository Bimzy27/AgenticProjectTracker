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
One live shell process within a project's Terminals tab, shown as its own sub-tab.
A project can have several open at once, each independent.

**Skill**:
A Claude Code capability package: a directory containing a `SKILL.md` with a `name` and `description`, discovered from `~/.claude/skills` or a project's `.claude/skills`.
Shown in the Skills tab, grouped by scope tier.
_Avoid_: Command, plugin (a plugin can bundle skills, but is a separate distribution mechanism the Skills tab does not read)

**Scope tier**:
Which of the two directories a skill was discovered in: Global (`~/.claude/skills`, applies to every project) or Project (`<project>/.claude/skills`, applies to that project alone).
The Skills tab lists tiers broad-to-narrow, left to right; this is a taxonomy, not an override-precedence ordering.
_Avoid_: Precedence order, level (Claude Code's own docs use "precedence," but personal skills actually win over project skills on a name collision, the opposite of what a naive "global, project" reading suggests - see the shadowed-skill ADR)

**Shadowed skill**:
A Project-tier skill whose name matches a Global-tier skill, so the personal one wins and the project one never actually loads.
Flagged in the Skills tab rather than hidden, since the file is still there but dead.
