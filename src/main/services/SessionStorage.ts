import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { TranscriptItem } from '@shared/domain'

export interface StoredSessionFile {
  sessionId: string
  filePath: string
  modifiedAt: Date
}

export interface StoredSession {
  sessionId: string
  items: TranscriptItem[]
  /** From Claude's summary records, when present. */
  summary: string | null
  firstTimestamp: string | null
  lastTimestamp: string | null
  messageCount: number
  /** Records that failed to parse and were skipped. */
  skippedRecords: number
}

/**
 * Adapter over Claude Code's local session storage
 * (`~/.claude/projects/<encoded-path>/<session-id>.jsonl`).
 *
 * The format is undocumented, so parsing is deliberately tolerant: any record
 * that cannot be understood is counted and skipped, never thrown (D3 risk).
 */
export class SessionStorage {
  constructor(private readonly claudeHome: string = join(homedir(), '.claude')) {}

  /** Claude encodes the project path by replacing path separators and punctuation with '-'. */
  encodeProjectDir(projectPath: string): string {
    return projectPath.replace(/[^a-zA-Z0-9-]/g, '-')
  }

  sessionDirFor(projectPath: string): string {
    return join(this.claudeHome, 'projects', this.encodeProjectDir(projectPath))
  }

  listSessionFiles(projectPath: string): StoredSessionFile[] {
    const dir = this.sessionDirFor(projectPath)
    if (!existsSync(dir)) return []
    const files: StoredSessionFile[] = []
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.jsonl')) continue
      const filePath = join(dir, entry)
      try {
        const stat = statSync(filePath)
        files.push({
          sessionId: basename(entry, '.jsonl'),
          filePath,
          modifiedAt: stat.mtime
        })
      } catch {
        // file disappeared between readdir and stat; skip
      }
    }
    return files.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime())
  }

  readSession(filePath: string): StoredSession {
    const sessionId = basename(filePath, '.jsonl')
    const items: TranscriptItem[] = []
    const toolItemsByUseId = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>()
    let summary: string | null = null
    let firstTimestamp: string | null = null
    let lastTimestamp: string | null = null
    let skippedRecords = 0

    let raw: string
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch {
      return { sessionId, items, summary, firstTimestamp, lastTimestamp, messageCount: 0, skippedRecords: 1 }
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let record: Record<string, unknown>
      try {
        record = JSON.parse(line) as Record<string, unknown>
      } catch {
        skippedRecords++
        continue
      }
      try {
        const at = typeof record.timestamp === 'string' ? record.timestamp : null
        if (at) {
          if (!firstTimestamp) firstTimestamp = at
          lastTimestamp = at
        }
        if (record.type === 'summary' && typeof record.summary === 'string') {
          summary = record.summary
          continue
        }
        if (record.isMeta === true) continue
        if (record.type === 'user' || record.type === 'assistant') {
          this.extractMessage(record, at, items, toolItemsByUseId)
        }
        // unknown record types are ignored, not errors
      } catch {
        skippedRecords++
      }
    }

    const messageCount = items.filter((i) => i.kind === 'user' || i.kind === 'assistant').length
    return { sessionId, items, summary, firstTimestamp, lastTimestamp, messageCount, skippedRecords }
  }

  private extractMessage(
    record: Record<string, unknown>,
    at: string | null,
    items: TranscriptItem[],
    toolItemsByUseId: Map<string, Extract<TranscriptItem, { kind: 'tool' }>>
  ): void {
    const message = record.message as { role?: string; content?: unknown } | undefined
    if (!message) return
    const { role, content } = message

    if (typeof content === 'string') {
      if (content.trim() && (role === 'user' || role === 'assistant')) {
        items.push({ kind: role, text: content, at })
      }
      return
    }
    if (!Array.isArray(content)) return

    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        if (role === 'user' || role === 'assistant') items.push({ kind: role, text: part.text, at })
      } else if (part.type === 'tool_use') {
        const item: Extract<TranscriptItem, { kind: 'tool' }> = {
          kind: 'tool',
          name: typeof part.name === 'string' ? part.name : 'unknown',
          input: safeStringify(part.input),
          output: null,
          at
        }
        items.push(item)
        if (typeof part.id === 'string') toolItemsByUseId.set(part.id, item)
      } else if (part.type === 'tool_result') {
        const useId = typeof part.tool_use_id === 'string' ? part.tool_use_id : null
        const target = useId ? toolItemsByUseId.get(useId) : undefined
        if (target) target.output = flattenToolResult(part.content)
      }
    }
  }
}

function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && (part as Record<string, unknown>).type === 'text'
          ? String((part as Record<string, unknown>).text ?? '')
          : ''
      )
      .filter(Boolean)
      .join('\n')
  }
  return safeStringify(content)
}
