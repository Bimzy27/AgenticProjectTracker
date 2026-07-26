import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillsService } from '../src/main/services/SkillsService'

function writeSkill(skillsDir: string, folderName: string, body: string): void {
  const dir = join(skillsDir, folderName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), body)
}

describe('SkillsService', () => {
  let claudeHome: string
  let projectPath: string
  let service: SkillsService

  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), 'apt-claude-home-'))
    projectPath = mkdtempSync(join(tmpdir(), 'apt-project-'))
    service = new SkillsService(claudeHome)
  })

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true })
    rmSync(projectPath, { recursive: true, force: true })
  })

  it('returns empty tiers when neither skills directory exists', () => {
    expect(service.list(projectPath)).toEqual({ global: [], project: [] })
  })

  it('parses a well-formed skill from each tier', () => {
    writeSkill(
      join(claudeHome, 'skills'),
      'commit',
      '---\nname: commit\ndescription: Commit and push the current changes.\n---\n\n# Commit\n'
    )
    writeSkill(
      join(projectPath, '.claude', 'skills'),
      'github-release',
      '---\nname: github-release\ndescription: Cut a versioned GitHub release.\n---\n\n# GitHub Release\n'
    )

    const result = service.list(projectPath)

    expect(result.global).toEqual([
      {
        name: 'commit',
        description: 'Commit and push the current changes.',
        folderName: 'commit',
        content: '---\nname: commit\ndescription: Commit and push the current changes.\n---\n\n# Commit\n',
        warning: null,
        shadowed: false
      }
    ])
    expect(result.project).toEqual([
      {
        name: 'github-release',
        description: 'Cut a versioned GitHub release.',
        folderName: 'github-release',
        content:
          '---\nname: github-release\ndescription: Cut a versioned GitHub release.\n---\n\n# GitHub Release\n',
        warning: null,
        shadowed: false
      }
    ])
  })

  it('flags a project skill as shadowed when a global skill shares its name', () => {
    writeSkill(
      join(claudeHome, 'skills'),
      'release',
      '---\nname: release\ndescription: Global release flow.\n---\n'
    )
    writeSkill(
      join(projectPath, '.claude', 'skills'),
      'release',
      '---\nname: release\ndescription: A repo-specific release flow.\n---\n'
    )

    const result = service.list(projectPath)

    expect(result.global[0].shadowed).toBe(false)
    expect(result.project[0].shadowed).toBe(true)
  })

  it('lists a skill with missing frontmatter fields instead of dropping it', () => {
    writeSkill(join(claudeHome, 'skills'), 'broken', '---\nname: broken\n---\n\nNo description field.\n')

    const [entry] = service.list(projectPath).global

    expect(entry.name).toBe('broken')
    expect(entry.description).toBe('')
    expect(entry.warning).toBe('Frontmatter is missing description')
  })

  it('falls back to the folder name when frontmatter has no name at all', () => {
    writeSkill(join(claudeHome, 'skills'), 'no-frontmatter', '# Just a heading, no frontmatter block\n')

    const [entry] = service.list(projectPath).global

    expect(entry.name).toBe('no-frontmatter')
    expect(entry.warning).toBe('Frontmatter is missing name and description')
  })

  it('ignores entries that are not directories or have no SKILL.md', () => {
    const skillsDir = join(claudeHome, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(skillsDir, 'README.md'), 'not a skill')
    mkdirSync(join(skillsDir, 'empty-folder'))

    expect(service.list(projectPath).global).toEqual([])
  })
})
