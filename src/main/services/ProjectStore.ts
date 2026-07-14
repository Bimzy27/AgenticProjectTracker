import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AddProjectInput, Project, ProjectLink, ProjectPatch } from '@shared/domain'

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
      links: [],
      looping: false,
      createdAt: new Date().toISOString()
    }
    this.projects.push(project)
    this.save()
    return project
  }

  update(id: string, patch: ProjectPatch): Project {
    const project = this.getOrThrow(id)
    // Validate everything before mutating so a rejected patch applies nothing.
    const name = patch.name?.trim()
    if (patch.name !== undefined && !name) throw new Error('Project name is required')
    const links = patch.links !== undefined ? normalizeLinks(patch.links) : undefined
    if (name !== undefined) project.name = name
    if (patch.tags !== undefined) project.tags = normalizeTags(patch.tags)
    if (patch.github !== undefined) project.github = patch.github
    if (links !== undefined) project.links = links
    if (patch.path !== undefined) project.path = patch.path
    if (patch.looping !== undefined) project.looping = patch.looping
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
    const projects = Array.isArray(parsed.projects) ? parsed.projects : []
    // Migrations: registries written before important links existed lack the
    // field, and ones written before looping mode default to it being off.
    this.projects = projects.map((p) => ({
      ...p,
      links: Array.isArray(p.links) ? p.links : [],
      looping: p.looping ?? false
    }))
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

/**
 * Trims and validates important links: every link needs a label and an
 * absolute http(s) URL. Throws on the first invalid entry so the UI can show
 * a precise error instead of silently dropping the user's input.
 */
function normalizeLinks(links: ProjectLink[]): ProjectLink[] {
  return links.map((link) => {
    const label = link.label.trim()
    const url = link.url.trim()
    if (!label) throw new Error(`Link label is required (for ${url || 'an empty link'})`)
    if (!isHttpUrl(url)) throw new Error(`Link URL must be an absolute http(s) URL: "${url}"`)
    return { label, url }
  })
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string =>
    p
      .replace(/[\\/]+$/, '')
      .replace(/\\/g, '/')
      .toLowerCase()
  return norm(a) === norm(b)
}
