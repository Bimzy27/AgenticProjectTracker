import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectSkills, SkillEntry } from '@shared/domain'

/**
 * Discovers Claude Code skills that apply to a project: personal
 * (~/.claude/skills, or APT_CLAUDE_HOME) and project-level
 * (<project.path>/.claude/skills, root only - no nested/monorepo dirs, no
 * plugin-contributed skills). See docs/adr for why the scope stops there.
 */
export class SkillsService {
  constructor(private readonly claudeHome: string = join(homedir(), '.claude')) {}

  /** Global and project-tier skills for one project; a project-tier entry is `shadowed` when a same-named global skill overrides it. */
  list(projectPath: string): ProjectSkills {
    const global = readSkillsDir(join(this.claudeHome, 'skills'))
    const project = readSkillsDir(join(projectPath, '.claude', 'skills'))
    const globalNames = new Set(global.map((s) => s.name))
    return {
      global: global.map((s) => ({ ...s, shadowed: false })),
      project: project.map((s) => ({ ...s, shadowed: globalNames.has(s.name) }))
    }
  }
}

function readSkillsDir(dir: string): Array<Omit<SkillEntry, 'shadowed'>> {
  if (!existsSync(dir)) return []
  const entries: Array<Omit<SkillEntry, 'shadowed'>> = []
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const skillMdPath = join(dir, dirent.name, 'SKILL.md')
    if (!existsSync(skillMdPath)) continue
    // A single unreadable/corrupt skill must not break the rest of the listing.
    try {
      entries.push(parseSkill(dirent.name, skillMdPath))
    } catch {
      entries.push({
        name: dirent.name,
        description: '',
        folderName: dirent.name,
        content: '',
        warning: 'SKILL.md could not be read'
      })
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

function parseSkill(folderName: string, skillMdPath: string): Omit<SkillEntry, 'shadowed'> {
  const content = readFileSync(skillMdPath, 'utf-8')
  const frontmatter = parseFrontmatter(content)
  const name = frontmatter.name?.trim()
  const description = frontmatter.description?.trim()
  return {
    name: name || folderName,
    description: description ?? '',
    folderName,
    content,
    warning:
      !name && !description
        ? 'Frontmatter is missing name and description'
        : !name
          ? 'Frontmatter is missing name'
          : !description
            ? 'Frontmatter is missing description'
            : null
  }
}

/**
 * Tolerant frontmatter parser for the flat `---\nkey: value\n---` block every
 * skill uses. Only reads top-level scalar keys (name, description); nested or
 * multi-line YAML values are not a real-world shape for skill frontmatter, so
 * a full YAML parser is not worth the dependency (POLICE: runtime-deps-stay-lean).
 */
function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const result: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue
    const key = line.slice(0, colonIndex).trim()
    let value = line.slice(colonIndex + 1).trim()
    if (value.length >= 2 && /^(".*"|'.*')$/.test(value)) value = value.slice(1, -1)
    result[key] = value
  }
  return result
}
