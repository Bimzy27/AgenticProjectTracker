import { describe, expect, it, vi } from 'vitest'
import type { Project, TaskDefinition } from '../src/shared/domain'
import type { GithubClient } from '../src/main/services/GithubClient'
import { GithubIssuesService } from '../src/main/services/GithubIssuesService'
import type { TaskService } from '../src/main/services/TaskService'

const project: Project = {
  id: 'p1',
  name: 'Demo',
  path: 'C:/demo',
  tags: [],
  github: { owner: 'me', repo: 'demo' },
  vercel: null,
  links: [],
  looping: false,
  agentTaskCreation: false,
  createdAt: '2026-07-01T00:00:00Z'
}

function githubWith(get: ReturnType<typeof vi.fn>): GithubClient {
  return { get } as never
}

function taskServiceWith(opts: {
  listTasks?: TaskDefinition[]
  create?: ReturnType<typeof vi.fn>
}): TaskService {
  return {
    listTasks: vi.fn().mockReturnValue(opts.listTasks ?? []),
    create: opts.create ?? vi.fn()
  } as never
}

const rawIssue = {
  number: 42,
  title: 'Fix the thing',
  body: 'It is broken.',
  html_url: 'https://github.com/me/demo/issues/42',
  user: { login: 'reporter' },
  labels: [{ name: 'bug' }, 'good first issue'],
  updated_at: '2026-07-20T00:00:00Z'
}

describe('GithubIssuesService.list', () => {
  it('maps open issues and excludes pull requests', async () => {
    const get = vi.fn().mockResolvedValue([
      rawIssue,
      {
        number: 43,
        title: 'A pull request',
        body: null,
        html_url: 'https://github.com/me/demo/issues/43',
        user: null,
        labels: [],
        updated_at: '2026-07-19T00:00:00Z',
        pull_request: { url: 'https://api.github.com/...' }
      }
    ])
    const service = new GithubIssuesService(githubWith(get), taskServiceWith({}))

    const issues = await service.list(project)

    expect(issues).toEqual([
      {
        number: 42,
        title: 'Fix the thing',
        body: 'It is broken.',
        url: 'https://github.com/me/demo/issues/42',
        author: 'reporter',
        labels: ['bug', 'good first issue'],
        updatedAt: '2026-07-20T00:00:00Z'
      }
    ])
    expect(get).toHaveBeenCalledWith('/repos/{owner}/{repo}/issues', {
      owner: 'me',
      repo: 'demo',
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 50
    })
  })

  it('sorts issues by most recently updated first', async () => {
    const get = vi.fn().mockResolvedValue([
      { ...rawIssue, number: 1, updated_at: '2026-07-01T00:00:00Z' },
      { ...rawIssue, number: 2, updated_at: '2026-07-20T00:00:00Z' }
    ])
    const service = new GithubIssuesService(githubWith(get), taskServiceWith({}))

    const issues = await service.list(project)

    expect(issues.map((i) => i.number)).toEqual([2, 1])
  })

  it('rejects when the project has no linked GitHub repo', async () => {
    const service = new GithubIssuesService(githubWith(vi.fn()), taskServiceWith({}))
    await expect(service.list({ ...project, github: null })).rejects.toThrow(/no linked GitHub repo/)
  })
})

describe('GithubIssuesService.import', () => {
  it('creates a draft task briefed from the issue body, with provenance appended', async () => {
    const get = vi.fn().mockResolvedValue(rawIssue)
    const create = vi.fn().mockReturnValue({ id: 't1', title: 'Fix the thing' })
    const service = new GithubIssuesService(githubWith(get), taskServiceWith({ create }))

    const task = await service.import(project, 42)

    expect(get).toHaveBeenCalledWith('/repos/{owner}/{repo}/issues/{issue_number}', {
      owner: 'me',
      repo: 'demo',
      issue_number: 42
    })
    expect(create).toHaveBeenCalledWith('p1', {
      title: 'Fix the thing',
      purpose: 'It is broken.\n\n---\nImported from GitHub issue #42: https://github.com/me/demo/issues/42',
      acceptanceCriteria: [],
      sourceIssueUrl: 'https://github.com/me/demo/issues/42'
    })
    expect(task).toEqual({ id: 't1', title: 'Fix the thing' })
  })

  it('falls back to a placeholder purpose when the issue has no body', async () => {
    const get = vi.fn().mockResolvedValue({ ...rawIssue, body: null })
    const create = vi.fn().mockReturnValue({ id: 't1' })
    const service = new GithubIssuesService(githubWith(get), taskServiceWith({ create }))

    await service.import(project, 42)

    expect(create).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        purpose: expect.stringContaining('(No description provided on the issue.)')
      })
    )
  })

  it('is idempotent: importing an already-imported issue returns the existing task', async () => {
    const get = vi.fn().mockResolvedValue(rawIssue)
    const existing: TaskDefinition = {
      id: 'existing',
      projectId: 'p1',
      title: 'Fix the thing',
      purpose: 'stale',
      acceptanceCriteria: [],
      state: 'draft',
      order: 0,
      mode: 'acceptEdits',
      model: null,
      stepBudget: 30,
      recoveryBudget: 3,
      autoApprove: false,
      reviewFeedback: null,
      archived: false,
      loopEnabled: true,
      sourceIssueUrl: 'https://github.com/me/demo/issues/42',
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
      transitions: []
    }
    const create = vi.fn()
    const service = new GithubIssuesService(
      githubWith(get),
      taskServiceWith({ listTasks: [existing], create })
    )

    const task = await service.import(project, 42)

    expect(task).toBe(existing)
    expect(create).not.toHaveBeenCalled()
  })
})
