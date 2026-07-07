import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/main/services/ProjectStore'

describe('ProjectStore', () => {
  let dir: string
  let store: ProjectStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apt-store-'))
    store = new ProjectStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const input = (overrides: Partial<Parameters<ProjectStore['add']>[0]> = {}) => ({
    path: 'C:\\repos\\demo',
    name: 'Demo',
    tags: ['tools'],
    github: { owner: 'me', repo: 'demo' },
    ...overrides
  })

  it('adds and lists projects', () => {
    const project = store.add(input())
    expect(project.id).toBeTruthy()
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].name).toBe('Demo')
  })

  it('persists across instances (registry file survives reload)', () => {
    store.add(input())
    const reloaded = new ProjectStore(dir)
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.list()[0].github).toEqual({ owner: 'me', repo: 'demo' })
  })

  it('rejects duplicate paths regardless of separators and case', () => {
    store.add(input())
    expect(() => store.add(input({ path: 'c:/repos/demo/' }))).toThrow(/already registered/)
  })

  it('rejects empty names on add and update', () => {
    expect(() => store.add(input({ name: '  ' }))).toThrow(/name is required/)
    const project = store.add(input())
    expect(() => store.update(project.id, { name: '' })).toThrow(/name is required/)
  })

  it('normalizes tags (trim, dedupe, drop empties)', () => {
    const project = store.add(input({ tags: [' a ', 'a', '', 'b'] }))
    expect(project.tags).toEqual(['a', 'b'])
  })

  it('updates fields via patch', () => {
    const project = store.add(input())
    const updated = store.update(project.id, { name: 'Renamed', github: null, path: 'D:\\elsewhere' })
    expect(updated.name).toBe('Renamed')
    expect(updated.github).toBeNull()
    expect(updated.path).toBe('D:\\elsewhere')
  })

  it('removes projects and throws for unknown ids', () => {
    const project = store.add(input())
    store.remove(project.id)
    expect(store.list()).toHaveLength(0)
    expect(() => store.remove(project.id)).toThrow(/Unknown project/)
    expect(() => store.getOrThrow(project.id)).toThrow(/Unknown project/)
  })
})
