import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStorage } from '../src/main/services/SessionStorage'

const RECORDS = [
  JSON.stringify({ type: 'summary', summary: 'Fixing the login bug' }),
  JSON.stringify({
    type: 'user',
    timestamp: '2026-07-01T10:00:00Z',
    message: { role: 'user', content: 'Please fix the login bug' }
  }),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-01T10:00:05Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking into it.' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file: 'auth.ts' } }
      ]
    }
  }),
  JSON.stringify({
    type: 'user',
    timestamp: '2026-07-01T10:00:07Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents here' }]
    }
  }),
  'this line is not JSON {{{',
  JSON.stringify({ type: 'some_future_record_kind', payload: 42 }),
  JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } })
].join('\n')

describe('SessionStorage', () => {
  let home: string
  let storage: SessionStorage
  const projectPath = 'C:\\repos\\demo'

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'apt-claude-'))
    storage = new SessionStorage(home)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('encodes project paths the way Claude names its storage directories', () => {
    expect(storage.encodeProjectDir('C:\\Programming\\AgenticProjectTracker')).toBe(
      'C--Programming-AgenticProjectTracker'
    )
    expect(storage.encodeProjectDir('/home/user/my.project')).toBe('-home-user-my-project')
  })

  it('lists session files newest first and returns empty for unknown projects', () => {
    expect(storage.listSessionFiles(projectPath)).toEqual([])
    const dir = storage.sessionDirFor(projectPath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sess-1.jsonl'), RECORDS)
    writeFileSync(join(dir, 'notes.txt'), 'ignored')
    const files = storage.listSessionFiles(projectPath)
    expect(files).toHaveLength(1)
    expect(files[0].sessionId).toBe('sess-1')
  })

  it('parses transcripts, pairs tool results, and captures the summary', () => {
    const dir = storage.sessionDirFor(projectPath)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'sess-1.jsonl')
    writeFileSync(filePath, RECORDS)

    const session = storage.readSession(filePath)
    expect(session.summary).toBe('Fixing the login bug')
    expect(session.firstTimestamp).toBe('2026-07-01T10:00:00Z')
    expect(session.lastTimestamp).toBe('2026-07-01T10:00:07Z')
    expect(session.messageCount).toBe(2)

    const kinds = session.items.map((i) => i.kind)
    expect(kinds).toEqual(['user', 'assistant', 'tool'])
    const tool = session.items[2]
    expect(tool).toMatchObject({ kind: 'tool', name: 'Read', output: 'file contents here' })
  })

  it('skips malformed records without failing the whole session', () => {
    const dir = storage.sessionDirFor(projectPath)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'sess-bad.jsonl')
    writeFileSync(filePath, RECORDS)
    const session = storage.readSession(filePath)
    expect(session.skippedRecords).toBe(1)
    expect(session.items.length).toBeGreaterThan(0)
  })

  it('returns an errored-but-safe result for unreadable files', () => {
    const session = storage.readSession(join(home, 'does-not-exist.jsonl'))
    expect(session.items).toEqual([])
    expect(session.skippedRecords).toBe(1)
  })
})
