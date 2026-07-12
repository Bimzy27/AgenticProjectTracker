import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('starts projects with no important links', () => {
    expect(store.add(input()).links).toEqual([])
  })

  it('updates important links, trimming labels and URLs', () => {
    const project = store.add(input())
    const updated = store.update(project.id, {
      links: [
        { label: ' Vercel ', url: ' https://vercel.com/me/demo ' },
        { label: 'Website', url: 'https://demo.example.com' }
      ]
    })
    expect(updated.links).toEqual([
      { label: 'Vercel', url: 'https://vercel.com/me/demo' },
      { label: 'Website', url: 'https://demo.example.com' }
    ])
  })

  it('persists important links across instances', () => {
    const project = store.add(input())
    store.update(project.id, { links: [{ label: 'Docs', url: 'http://localhost:3000/docs' }] })
    const reloaded = new ProjectStore(dir)
    expect(reloaded.list()[0].links).toEqual([{ label: 'Docs', url: 'http://localhost:3000/docs' }])
  })

  it('clears important links with an empty list', () => {
    const project = store.add(input())
    store.update(project.id, { links: [{ label: 'Site', url: 'https://demo.example.com' }] })
    expect(store.update(project.id, { links: [] }).links).toEqual([])
  })

  it('rejects links without a label or with a non-http(s) URL', () => {
    const project = store.add(input())
    expect(() =>
      store.update(project.id, { links: [{ label: ' ', url: 'https://demo.example.com' }] })
    ).toThrow(/label is required/)
    expect(() => store.update(project.id, { links: [{ label: 'Site', url: 'demo.example.com' }] })).toThrow(
      /absolute http\(s\) URL/
    )
    expect(() =>
      store.update(project.id, { links: [{ label: 'Bad', url: 'file:///C:/secrets.txt' }] })
    ).toThrow(/absolute http\(s\) URL/)
    // A failed update must not partially apply.
    expect(store.getOrThrow(project.id).links).toEqual([])
  })

  it('defaults links for registry files written before links existed', () => {
    const project = store.add(input())
    const registryPath = join(dir, 'projects.json')
    const raw = JSON.parse(readFileSync(registryPath, 'utf8'))
    delete raw.projects[0].links
    writeFileSync(registryPath, JSON.stringify(raw))
    const reloaded = new ProjectStore(dir)
    expect(reloaded.getOrThrow(project.id).links).toEqual([])
  })

  it('removes projects and throws for unknown ids', () => {
    const project = store.add(input())
    store.remove(project.id)
    expect(store.list()).toHaveLength(0)
    expect(() => store.remove(project.id)).toThrow(/Unknown project/)
    expect(() => store.getOrThrow(project.id)).toThrow(/Unknown project/)
  })
})
