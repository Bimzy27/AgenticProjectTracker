import { readFileSync } from 'node:fs'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { QueryFn } from './SessionService'

interface FakeScript {
  /** Scripted assistant responses; each user message consumes the next turn. */
  turns: string[]
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

  const fake = (args: { prompt: string | AsyncIterable<SDKUserMessage> }): unknown => {
    // Read per query() call so each app launch (and test) sees the current script.
    const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as FakeScript
    const sessionId = `fake-session-${++sessionCounter}`
    let turn = 0

    async function* stream(): AsyncGenerator<unknown> {
      if (typeof args.prompt === 'string') return
      for await (const userMessage of args.prompt) {
        void userMessage
        const text = script.turns[turn] ?? FALLBACK_TURN
        turn++
        // Yield to the event loop so transcript events interleave like a real stream.
        await new Promise((resolve) => setTimeout(resolve, 25))
        yield {
          type: 'assistant',
          session_id: sessionId,
          message: { content: [{ type: 'text', text }] }
        }
        yield { type: 'result', session_id: sessionId }
      }
    }

    return Object.assign(stream(), {
      interrupt: async () => {},
      setPermissionMode: async () => {}
    })
  }

  return fake as QueryFn
}
