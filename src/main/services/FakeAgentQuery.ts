import { readFileSync, writeFileSync } from 'node:fs'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { QueryFn } from './SessionService'

/** One scripted turn: plain text, or text plus files the turn "edits" via Edit tool calls. */
type FakeTurn = string | { text: string; files?: string[] }

interface FakeScript {
  /** Scripted assistant responses; each user message consumes the next turn. */
  turns: FakeTurn[]
}

const FALLBACK_TURN =
  'Nothing scripted for this turn.\n```apt-status\n{ "state": "blocked", "note": "fake agent script exhausted" }\n```'

/**
 * E2E test seam (like APT_USER_DATA_DIR / APT_CLAUDE_HOME): replaces the Agent
 * SDK's query() with a scripted agent driven by a JSON file, so Playwright can
 * exercise the delegation loop without a real Claude process.
 */
export function createFakeAgentQuery(scriptPath: string): QueryFn {
  let sessionCounter = 0

  const fake = (args: {
    prompt: string | AsyncIterable<SDKUserMessage>
    options?: { model?: string; permissionMode?: string }
  }): unknown => {
    // Read per query() call so each app launch (and test) sees the current script.
    const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as FakeScript
    const sessionId = `fake-session-${++sessionCounter}`
    let turn = 0
    recordCall(scriptPath, {
      model: args.options?.model ?? null,
      permissionMode: args.options?.permissionMode ?? null
    })

    async function* stream(): AsyncGenerator<unknown> {
      if (typeof args.prompt === 'string') return
      for await (const userMessage of args.prompt) {
        void userMessage
        const scripted = script.turns[turn] ?? FALLBACK_TURN
        const { text, files = [] } = typeof scripted === 'string' ? { text: scripted } : scripted
        turn++
        // Yield to the event loop so transcript events interleave like a real stream.
        await new Promise((resolve) => setTimeout(resolve, 25))
        yield {
          type: 'assistant',
          session_id: sessionId,
          message: {
            content: [
              ...files.map((filePath) => ({
                type: 'tool_use',
                id: `fake-tool-${turn}-${filePath}`,
                name: 'Edit',
                input: { file_path: filePath }
              })),
              { type: 'text', text }
            ]
          }
        }
        yield {
          type: 'result',
          session_id: sessionId,
          usage: { input_tokens: 100, output_tokens: 25 }
        }
      }
    }

    return Object.assign(stream(), {
      interrupt: async () => {},
      setPermissionMode: async () => {},
      // Live model switches are recorded so E2E tests can assert them.
      setModel: async (model?: string) => recordCall(scriptPath, { setModel: model ?? null })
    })
  }

  return fake as QueryFn
}

/**
 * Append one SDK interaction to `<script>.calls.json`, so E2E tests can assert
 * what would have reached the real Agent SDK: query() options as
 * `{ model, permissionMode }` entries, live model switches as `{ setModel }`.
 */
function recordCall(scriptPath: string, entry: Record<string, unknown>): void {
  const callsPath = scriptPath + '.calls.json'
  let calls: unknown[] = []
  try {
    const parsed = JSON.parse(readFileSync(callsPath, 'utf8')) as unknown
    if (Array.isArray(parsed)) calls = parsed
  } catch {
    // First call: no file yet.
  }
  calls.push(entry)
  writeFileSync(callsPath, JSON.stringify(calls))
}
