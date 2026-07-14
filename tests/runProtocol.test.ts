import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildBriefing,
  hasWorkspaceWorkflow,
  parseStatusBlock,
  parseTaskBlocks
} from '../src/main/services/RunProtocol'

function block(json: string): string {
  return '```apt-status\n' + json + '\n```'
}

function taskBlock(json: string): string {
  return '```apt-task\n' + json + '\n```'
}

describe('parseStatusBlock', () => {
  it('parses each valid state', () => {
    for (const state of ['working', 'question', 'blocked', 'complete'] as const) {
      const report = parseStatusBlock(block(`{ "state": "${state}", "note": "n" }`))
      expect(report).toMatchObject({ state, note: 'n' })
    }
  })

  it('finds the block embedded in surrounding prose', () => {
    const text =
      'I finished the refactor and all tests pass.\n\n' +
      block('{ "state": "working", "note": "refactoring auth" }') +
      '\n\nLet me know if anything looks off.'
    expect(parseStatusBlock(text)).toMatchObject({ state: 'working', note: 'refactoring auth' })
  })

  it('uses the last parseable block when several appear', () => {
    const text =
      'Example of the format: ' +
      block('{ "state": "working", "note": "first" }') +
      '\nActual status:\n' +
      block('{ "state": "complete", "note": "done", "gatePassed": true }')
    expect(parseStatusBlock(text)).toMatchObject({ state: 'complete', note: 'done', gatePassed: true })
  })

  it('returns null for malformed JSON', () => {
    expect(parseStatusBlock(block('{ state: working'))).toBeNull()
  })

  it('returns null when no block is present', () => {
    expect(parseStatusBlock('All done, everything works!')).toBeNull()
  })

  it('returns null for an unknown state value', () => {
    expect(parseStatusBlock(block('{ "state": "cruising", "note": "n" }'))).toBeNull()
  })

  it('skips a malformed block in favor of an earlier valid one', () => {
    const text = block('{ "state": "blocked", "note": "tests fail" }') + '\n' + block('not json at all')
    expect(parseStatusBlock(text)).toMatchObject({ state: 'blocked', note: 'tests fail' })
  })

  it('normalizes complete reports with and without a gate result', () => {
    const passing = parseStatusBlock(
      block('{ "state": "complete", "note": "built it", "gatePassed": true, "gateSummary": "patrol green" }')
    )
    expect(passing).toEqual({
      state: 'complete',
      note: 'built it',
      gatePassed: true,
      gateSummary: 'patrol green',
      debugUrl: null,
      changesUrl: null
    })

    const missingGate = parseStatusBlock(block('{ "state": "complete", "note": "built it" }'))
    expect(missingGate).toEqual({
      state: 'complete',
      note: 'built it',
      gatePassed: null,
      gateSummary: null,
      debugUrl: null,
      changesUrl: null
    })

    const failingGate = parseStatusBlock(block('{ "state": "complete", "gatePassed": false }'))
    expect(failingGate).toMatchObject({ state: 'complete', gatePassed: false })
  })

  it('tolerates unknown extra fields', () => {
    const report = parseStatusBlock(block('{ "state": "working", "note": "n", "mood": "great" }'))
    expect(report).toMatchObject({ state: 'working', note: 'n' })
  })

  it('accepts an http(s) debug link on complete reports', () => {
    const report = parseStatusBlock(
      block(
        '{ "state": "complete", "note": "done", "gatePassed": true, "debugUrl": "http://localhost:5173/" }'
      )
    )
    expect(report).toMatchObject({ state: 'complete', debugUrl: 'http://localhost:5173/' })

    const https = parseStatusBlock(
      block('{ "state": "complete", "note": "done", "debugUrl": "https://preview.example.com/pr-42" }')
    )
    expect(https).toMatchObject({ debugUrl: 'https://preview.example.com/pr-42' })
  })

  it('drops debug links that are not well-formed http(s) URLs', () => {
    for (const bad of ['"run npm start"', '"file:///C:/app/index.html"', '"localhost:5173"', 'true']) {
      const report = parseStatusBlock(block(`{ "state": "complete", "note": "done", "debugUrl": ${bad} }`))
      expect(report).toMatchObject({ state: 'complete', debugUrl: null })
    }
  })

  it('accepts an http(s) changes link on complete reports', () => {
    const report = parseStatusBlock(
      block(
        '{ "state": "complete", "note": "done", "gatePassed": true, "changesUrl": "https://github.com/o/r/pull/42" }'
      )
    )
    expect(report).toMatchObject({ state: 'complete', changesUrl: 'https://github.com/o/r/pull/42' })
  })

  it('drops changes links that are not well-formed http(s) URLs', () => {
    for (const bad of ['"feature/login"', '"git@github.com:o/r.git"', '"file:///C:/repo"', '42']) {
      const report = parseStatusBlock(block(`{ "state": "complete", "note": "done", "changesUrl": ${bad} }`))
      expect(report).toMatchObject({ state: 'complete', changesUrl: null })
    }
  })
})

describe('parseTaskBlocks', () => {
  it('parses a proposal with title, purpose, and acceptance criteria', () => {
    const proposals = parseTaskBlocks(
      'I noticed a defect worth its own task.\n' +
        taskBlock(
          '{ "title": "Fix login flake", "purpose": "The login E2E test fails intermittently.", "acceptanceCriteria": ["test passes 20x in a row"] }'
        )
    )
    expect(proposals).toEqual([
      {
        title: 'Fix login flake',
        purpose: 'The login E2E test fails intermittently.',
        acceptanceCriteria: ['test passes 20x in a row']
      }
    ])
  })

  it('collects multiple blocks in order and skips malformed ones', () => {
    const proposals = parseTaskBlocks(
      taskBlock('{ "title": "First", "purpose": "p1" }') +
        '\n' +
        taskBlock('not json at all') +
        '\n' +
        taskBlock('{ "title": "Second", "purpose": "p2" }')
    )
    expect(proposals.map((p) => p.title)).toEqual(['First', 'Second'])
  })

  it('skips proposals without a non-empty title and purpose', () => {
    for (const bad of [
      '{ "purpose": "no title" }',
      '{ "title": "  ", "purpose": "blank title" }',
      '{ "title": "no purpose" }',
      '{ "title": "t", "purpose": "" }',
      '"just a string"'
    ]) {
      expect(parseTaskBlocks(taskBlock(bad))).toEqual([])
    }
  })

  it('defaults missing criteria to empty and normalizes them (trim, drop empties and non-strings)', () => {
    const [noCriteria] = parseTaskBlocks(taskBlock('{ "title": "t", "purpose": "p" }'))
    expect(noCriteria.acceptanceCriteria).toEqual([])
    const [messy] = parseTaskBlocks(
      taskBlock('{ "title": "t", "purpose": "p", "acceptanceCriteria": [" a ", "", 42, "b"] }')
    )
    expect(messy.acceptanceCriteria).toEqual(['a', 'b'])
  })

  it('trims the title and purpose', () => {
    const [proposal] = parseTaskBlocks(taskBlock('{ "title": " Fix it ", "purpose": " Because. " }'))
    expect(proposal).toMatchObject({ title: 'Fix it', purpose: 'Because.' })
  })

  it('ignores apt-status blocks and returns an empty list when nothing is proposed', () => {
    expect(parseTaskBlocks(block('{ "state": "working", "note": "n" }'))).toEqual([])
    expect(parseTaskBlocks('No blocks here.')).toEqual([])
  })
})

describe('buildBriefing', () => {
  const task = {
    title: 'Add login',
    purpose: 'Build a login page',
    acceptanceCriteria: ['email+password form', 'error states'],
    reviewFeedback: null
  }

  it('includes the task, criteria, and the status protocol', () => {
    const briefing = buildBriefing({ task, workflowVerified: true })
    expect(briefing).toContain('Add login')
    expect(briefing).toContain('Build a login page')
    expect(briefing).toContain('email+password form')
    expect(briefing).toContain('```apt-status')
    expect(briefing).toContain('/patrol')
  })

  it('instructs the agent to include a debug testing link when able', () => {
    for (const workflowVerified of [true, false]) {
      const briefing = buildBriefing({ task, workflowVerified })
      expect(briefing).toContain('"debugUrl"')
      expect(briefing).toContain('debug environment')
    }
  })

  it('instructs the agent to link the branch or pull request holding the changes', () => {
    for (const workflowVerified of [true, false]) {
      const briefing = buildBriefing({ task, workflowVerified })
      expect(briefing).toContain('"changesUrl"')
      expect(briefing).toContain('pull request')
    }
  })

  it('omits workspace skill instructions when the workflow is unverified', () => {
    const briefing = buildBriefing({ task, workflowVerified: false })
    expect(briefing).not.toContain('/patrol')
    expect(briefing).toContain('quality check')
  })

  it('explains apt-task proposals only when task creation is allowed', () => {
    const withCreation = buildBriefing({ task, workflowVerified: true, allowTaskCreation: true })
    expect(withCreation).toContain('```apt-task')
    expect(withCreation).toContain('Creating backlog tasks')

    // Off by default: an unbriefed agent is never invited to create tasks.
    const withoutCreation = buildBriefing({ task, workflowVerified: true })
    expect(withoutCreation).not.toContain('apt-task')
  })

  it('carries review feedback into re-runs', () => {
    const briefing = buildBriefing({
      task: { ...task, reviewFeedback: 'Buttons are misaligned' },
      workflowVerified: true
    })
    expect(briefing).toContain('Buttons are misaligned')
  })
})

describe('hasWorkspaceWorkflow', () => {
  let home: string

  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('detects the patrol skill under the given claude home', () => {
    home = mkdtempSync(join(tmpdir(), 'apt-home-'))
    expect(hasWorkspaceWorkflow(home)).toBe(false)
    mkdirSync(join(home, 'skills', 'patrol'), { recursive: true })
    expect(hasWorkspaceWorkflow(home)).toBe(true)
  })
})
