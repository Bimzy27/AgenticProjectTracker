import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, WidgetData, WidgetKindDescriptor } from '../src/shared/domain'
import { AnalyticsService } from '../src/main/services/AnalyticsService'
import type { WidgetProvider } from '../src/main/services/AnalyticsService'
import { DashboardStore } from '../src/main/services/DashboardStore'
import { GithubNotConfiguredError } from '../src/main/services/GithubClient'
import type { SecretCipher } from '../src/main/services/TokenStore'

const cipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(`enc:${text}`),
  decrypt: (buf) => buf.toString().slice(4)
}

function project(github: { owner: string; repo: string } | null): Project {
  return {
    id: 'p1',
    name: 'Demo',
    path: 'C:/demo',
    tags: [],
    github,
    vercel: null,
    links: [],
    looping: false,
    agentTaskCreation: false,
    createdAt: '2026-07-01T00:00:00Z'
  }
}

function provider(
  kind: string,
  overrides: Partial<WidgetKindDescriptor> = {},
  fetch: WidgetProvider['fetch'] = async () => ({ shape: 'stat', stats: [] })
): WidgetProvider {
  return {
    descriptor: {
      kind,
      label: kind,
      description: `${kind} widget`,
      requiresGithub: false,
      configFields: [],
      ...overrides
    },
    fetch
  }
}

let dir: string
let store: DashboardStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apt-analytics-'))
  store = new DashboardStore(dir, cipher)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The registry configured like production: the three default GitHub kinds plus a custom one. */
function service(extra: WidgetProvider[] = []): AnalyticsService {
  return new AnalyticsService(
    [
      provider('github-traffic-views', { requiresGithub: true }),
      provider('github-traffic-clones', { requiresGithub: true }),
      provider('github-releases', { requiresGithub: true }),
      ...extra
    ],
    store
  )
}

describe('AnalyticsService layouts', () => {
  it('defaults to the GitHub widgets for a project with a linked repo', () => {
    const widgets = service().getWidgets(project({ owner: 'me', repo: 'demo' }))
    expect(widgets.map((w) => w.kind)).toEqual([
      'github-traffic-views',
      'github-traffic-clones',
      'github-releases'
    ])
  })

  it('defaults to an empty dashboard without a linked repo', () => {
    expect(service().getWidgets(project(null))).toEqual([])
  })

  it('uses the stored layout once customized, even when emptied', () => {
    const svc = service()
    const p = project({ owner: 'me', repo: 'demo' })
    svc.setWidgets(p, [])
    expect(svc.getWidgets(p)).toEqual([])
  })

  it('rejects duplicate provider kinds at construction', () => {
    expect(() => new AnalyticsService([provider('a'), provider('a')], store)).toThrow(/Duplicate/)
  })

  it('rejects unknown widget kinds', () => {
    expect(() => service().setWidgets(project(null), [{ kind: 'nope', title: null, config: {} }])).toThrow(
      /Unknown widget kind/
    )
  })

  it('rejects a widget missing a required config field', () => {
    const kinds = service([
      provider('json-metric', {
        configFields: [
          { key: 'url', label: 'Endpoint URL', type: 'url', required: true, placeholder: null, help: null }
        ]
      })
    ])
    expect(() =>
      kinds.setWidgets(project(null), [{ kind: 'json-metric', title: null, config: { url: '  ' } }])
    ).toThrow(/needs a value for Endpoint URL/)
  })

  it('accepts a required secret that is already stored for the widget', () => {
    const secretField = provider('secured', {
      configFields: [
        {
          key: 'token',
          label: 'Token',
          type: 'secret' as const,
          required: true,
          placeholder: null,
          help: null
        }
      ]
    })
    const svc = service([secretField])
    const p = project(null)
    const [saved] = svc.setWidgets(p, [
      { kind: 'secured', title: null, config: {}, secrets: { token: 's3cret' } }
    ])
    // Re-saving without retyping the secret must pass validation...
    const [kept] = svc.setWidgets(p, [{ id: saved.id, kind: 'secured', title: 'Renamed', config: {} }])
    expect(kept.secretsSet).toEqual(['token'])
    // ...but a brand-new widget without the secret must not.
    expect(() => svc.setWidgets(p, [{ kind: 'secured', title: null, config: {} }])).toThrow(
      /needs a value for Token/
    )
  })
})

describe('AnalyticsService getWidgetData', () => {
  it('resolves default-layout widgets without anything persisted', async () => {
    const data: WidgetData = { shape: 'timeseries', unit: 'views', points: [] }
    const svc = new AnalyticsService(
      [provider('github-traffic-views', { requiresGithub: true }, async () => data)],
      store
    )
    const p = project({ owner: 'me', repo: 'demo' })
    // Store untouched: the default widget id resolves through the effective layout.
    expect(store.getWidgets(p.id)).toBeNull()
    await expect(svc.getWidgetData(p, 'default-github-views')).resolves.toEqual(data)
  })

  it('merges decrypted secrets into the provider config', async () => {
    const fetch = vi.fn().mockResolvedValue({ shape: 'stat', stats: [] })
    const svc = service([provider('json-metric', {}, fetch)])
    const p = project(null)
    const [saved] = svc.setWidgets(p, [
      { kind: 'json-metric', title: null, config: { url: 'https://x.test' }, secrets: { token: 'abc' } }
    ])
    await svc.getWidgetData(p, saved.id)
    expect(fetch).toHaveBeenCalledWith({
      project: p,
      config: { url: 'https://x.test', token: 'abc' }
    })
  })

  it('reports GitHub prerequisites in-band instead of erroring', async () => {
    // A GitHub widget kept on the dashboard after the repo link was removed.
    const svc = service()
    const p = project(null)
    const [saved] = svc.setWidgets(p, [{ kind: 'github-releases', title: null, config: {} }])
    await expect(svc.getWidgetData(p, saved.id)).resolves.toEqual({
      shape: 'unavailable',
      reason: 'Link a GitHub repo to this project to use this widget.'
    })

    const throwing = service([
      provider('github-releases-2', { requiresGithub: true }, async () => {
        throw new GithubNotConfiguredError()
      })
    ])
    const linked = project({ owner: 'me', repo: 'demo' })
    const [tokenless] = throwing.setWidgets(linked, [{ kind: 'github-releases-2', title: null, config: {} }])
    await expect(throwing.getWidgetData(linked, tokenless.id)).resolves.toEqual({
      shape: 'unavailable',
      reason: 'This widget needs a GitHub token. Configure one in Settings.'
    })
  })

  it('reports a stored widget whose source was removed as unavailable', async () => {
    const p = project(null)
    service([provider('legacy')]).setWidgets(p, [{ kind: 'legacy', title: null, config: {} }])
    const without = service()
    const widgets = without.getWidgets(p)
    const result = await without.getWidgetData(p, widgets[0].id)
    expect(result).toMatchObject({ shape: 'unavailable', reason: expect.stringContaining('legacy') })
  })

  it('rejects for widgets that are not on the dashboard', async () => {
    await expect(service().getWidgetData(project(null), 'missing')).rejects.toThrow(/No widget/)
  })

  it('propagates unexpected provider failures to the caller', async () => {
    const failing = service([
      provider('flaky', {}, async () => {
        throw new Error('boom')
      })
    ])
    const p = project(null)
    const [saved] = failing.setWidgets(p, [{ kind: 'flaky', title: null, config: {} }])
    await expect(failing.getWidgetData(p, saved.id)).rejects.toThrow('boom')
  })
})
