import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AddProjectInput, Project, ProjectPatch } from '@shared/domain'

interface RegistryFile {
  version: 1
  projects: Project[]
}

/**
 * JSON-file registry of tracked projects (D4).
 * Loaded into memory on construction; every mutation is written atomically
 * (write to a temp file, then rename over the registry).
 */
export class ProjectStore {
  private readonly filePath: string
  private projects: Project[] = []

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, 'projects.json')
    this.load()
  }

  list(): Project[] {
    return [...this.projects]
  }

  get(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id)
  }

  getOrThrow(id: string): Project {
    const project = this.get(id)
    if (!project) throw new Error(`Unknown project: ${id}`)
    return project
  }

  add(input: AddProjectInput): Project {
    const name = input.name.trim()
    if (!name) throw new Error('Project name is required')
    if (this.projects.some((p) => samePath(p.path, input.path))) {
      throw new Error(`Project already registered for ${input.path}`)
    }
    const project: Project = {
      id: randomUUID(),
      name,
      path: input.path,
      tags: normalizeTags(input.tags),
      github: input.github,
      createdAt: new Date().toISOString()
    }
    this.projects.push(project)
    this.save()
    return project
  }

  update(id: string, patch: ProjectPatch): Project {
    const project = this.getOrThrow(id)
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) throw new Error('Project name is required')
      project.name = name
    }
    if (patch.tags !== undefined) project.tags = normalizeTags(patch.tags)
    if (patch.github !== undefined) project.github = patch.github
    if (patch.path !== undefined) project.path = patch.path
    this.save()
    return project
  }

  remove(id: string): void {
    const before = this.projects.length
    this.projects = this.projects.filter((p) => p.id !== id)
    if (this.projects.length === before) throw new Error(`Unknown project: ${id}`)
    this.save()
  }

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      this.projects = []
      return
    }
    const parsed = JSON.parse(raw) as RegistryFile
    this.projects = Array.isArray(parsed.projects) ? parsed.projects : []
  }

  private save(): void {
    const file: RegistryFile = { version: 1, projects: this.projects }
    const tmpPath = this.filePath + '.tmp'
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf8')
    renameSync(tmpPath, this.filePath)
  }
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string =>
    p
      .replace(/[\\/]+$/, '')
      .replace(/\\/g, '/')
      .toLowerCase()
  return norm(a) === norm(b)
}
