import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RunStatusReport, TaskDefinition } from '@shared/domain'

// The agent <-> loop protocol (design D2): every agent turn must end with a
// fenced apt-status JSON block, and this module is the only place that builds
// the briefing or interprets the block. Parsing is deliberately tolerant,
// mirroring how JSONL tolerance is isolated in SessionStorage.

const VALID_STATES = new Set(['working', 'question', 'blocked', 'complete'])

/** True when the machine's workspace quality-gate skills (patrol) are installed. */
export function hasWorkspaceWorkflow(claudeHome?: string): boolean {
  const home = claudeHome ?? join(homedir(), '.claude')
  return existsSync(join(home, 'skills', 'patrol'))
}

export interface BriefingInput {
  task: Pick<TaskDefinition, 'title' | 'purpose' | 'acceptanceCriteria' | 'reviewFeedback'>
  /** From hasWorkspaceWorkflow(); changes how completion is instructed. */
  workflowVerified: boolean
}

/** Initial prompt for a run session: the task, the ways of working, and the status protocol. */
export function buildBriefing({ task, workflowVerified }: BriefingInput): string {
  const sections: string[] = []
  sections.push(
    'You are working autonomously on a delegated task. Complete it end to end without waiting for a human unless you genuinely need direction.'
  )
  sections.push(`# Task: ${task.title}\n\n${task.purpose.trim()}`)
  if (task.acceptanceCriteria.length > 0) {
    sections.push('# Acceptance criteria\n\n' + task.acceptanceCriteria.map((c) => `- ${c}`).join('\n'))
  }
  if (task.reviewFeedback) {
    sections.push(
      '# Review feedback\n\nA previous attempt at this task was reviewed and sent back with this feedback. Address it:\n\n' +
        task.reviewFeedback.trim()
    )
  }
  sections.push(
    workflowVerified
      ? '# Ways of working\n\nFollow your installed workspace workflow: run /patrol (the full quality gate) and fix failures until it passes before reporting the task complete, use conventional commits, and report honestly. Never report complete with a failing or skipped gate.'
      : '# Ways of working\n\nRun every quality check available in this project (typecheck, lint, tests) and fix failures until they pass before reporting the task complete. Report honestly; never report complete with failing checks.'
  )
  sections.push(
    `# Status protocol\n\nEnd EVERY response with a fenced status block so the supervisor can track you. The format is:\n\n\`\`\`apt-status\n{ "state": "working", "note": "<one-line progress note>" }\n\`\`\`\n\nStates:\n- "working": still making progress; "note" says what you are doing.\n- "question": you need a decision or information only the user has; put the full question in "note". Use this sparingly - prefer solving problems yourself.\n- "blocked": you hit a failure you cannot resolve; "note" explains what failed and what you tried.\n- "complete": the task is done and verified. Include "gatePassed" (boolean: did the full quality gate pass?) and "gateSummary" (one line on how it was verified), e.g.\n\n\`\`\`apt-status\n{ "state": "complete", "note": "<what was built>", "gatePassed": true, "gateSummary": "patrol green: typecheck, lint, tests" }\n\`\`\`\n\nWhen you can make the completed changes testable in a debug environment (for example a dev server you started and left running, or a preview deployment), also include "debugUrl" with the http(s) link so the reviewer can try the changes directly. Only include a link you have verified is reachable; omit the field when there is nothing to link.\n\nWhen the changes were delivered on a branch or pull request, also include "changesUrl" with the http(s) link to that pull request (or branch comparison) so the reviewer can inspect the files changed during the task. Omit the field when the work never left the local working tree.\n\nThe block must be valid JSON. Never omit it.`
  )
  return sections.join('\n\n')
}

/** Follow-up sent once when a turn arrives without a parseable status block. */
export const STATUS_REPROMPT =
  'Your last response was missing the apt-status block. Reply with your current status as a fenced ```apt-status``` JSON block ({ "state": "working" | "question" | "blocked" | "complete", "note": "..." }), then continue.'

/** Corrective follow-up for a recovery nudge (design D4). */
export function buildNudge(context: string): string {
  return `The run supervisor observed a problem:\n\n${context}\n\nDiagnose the root cause, fix it, and continue the task. If the quality gate failed, fix the failures and run it again. End your response with the apt-status block.`
}

/** Follow-up delivering the user's answer to an escalated question. */
export function buildAnswer(answer: string): string {
  return `The user answered your question:\n\n${answer}\n\nContinue the task with this direction. End your response with the apt-status block.`
}

/** Prompt used when reattaching to an interrupted run session. */
export const RESUME_PROMPT =
  'The supervisor was restarted and has reattached to this session. Report your current status in an apt-status block, then continue the task from where it stands.'

/**
 * Extract and parse the last apt-status block in a message.
 * Tolerant: the block may sit anywhere in the text with prose around it, and
 * unknown fields are ignored. Returns null when no block parses to a valid state.
 */
export function parseStatusBlock(text: string): RunStatusReport | null {
  const matches = [...text.matchAll(/```apt-status\s*\n([\s\S]*?)```/gi)]
  for (let i = matches.length - 1; i >= 0; i--) {
    const report = parseReportJson(matches[i][1])
    if (report) return report
  }
  return null
}

function parseReportJson(raw: string): RunStatusReport | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const state = record.state
  if (typeof state !== 'string' || !VALID_STATES.has(state)) return null
  return {
    state: state as RunStatusReport['state'],
    note: typeof record.note === 'string' ? record.note : '',
    gatePassed: typeof record.gatePassed === 'boolean' ? record.gatePassed : null,
    gateSummary: typeof record.gateSummary === 'string' ? record.gateSummary : null,
    debugUrl: parseHttpUrl(record.debugUrl),
    changesUrl: parseHttpUrl(record.changesUrl)
  }
}

/**
 * Accept a reported link (debugUrl/changesUrl) only when it is a well-formed
 * http(s) URL; anything else (other schemes, prose, local paths) is dropped so
 * the UI never renders an unopenable or unsafe link.
 */
function parseHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : null
}
