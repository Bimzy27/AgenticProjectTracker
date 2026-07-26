# Skills tab: two scope tiers, taxonomy order not precedence order

The Skills tab shows which Claude Code skills apply to a project, so a user can see what's actually installed without leaving the app.
We scoped it to exactly two tiers: Global (`~/.claude/skills`) and Project (`<project>/.claude/skills`, root only).
A third "harness-specific" tier was considered (per-skill `agents/<harness>.yaml` display overrides, or skills from installed plugins), but this app only ever orchestrates via the Claude Agent SDK, so nothing on this machine currently backs a third tier; we dropped it rather than build for a harness that doesn't exist yet.
Nested `.claude/skills/` directories deeper in a project (monorepo sub-packages) are also out of scope for the same reason: added complexity with no case on hand to validate it against.

The lanes are ordered Global then Project, left to right, but this is a taxonomy (broad scope to narrow scope), not an override-precedence ordering.
Claude Code's own docs use "precedence" for this hierarchy, and state that personal (global) skills win over project skills on a name collision - the opposite of what "global, project" reads as if taken as an override chain.
To avoid baking in the wrong direction, the Skills tab instead flags a Project-tier skill as **shadowed** when a same-named Global-tier skill exists, since the shadowed one is the one that never actually loads.

## Considered options

- Reorder the lanes to read as literal precedence (winner first): rejected, since it would only be correct for the collision case and misleading as a general "scope" reading.
- Skip shadow detection entirely: rejected, since a shadowed project skill is silently dead weight a user would otherwise have no way to notice from this tab.
