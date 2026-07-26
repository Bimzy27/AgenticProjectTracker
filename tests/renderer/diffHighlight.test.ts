import { describe, expect, it } from 'vitest'
import type { DiffHunk, DiffLine } from '../../src/shared/domain'
import {
  highlightHunk,
  languageFor,
  splitHighlightedLines
} from '../../src/renderer/src/components/diffHighlight'

function line(kind: DiffLine['kind'], text: string): DiffLine {
  return { kind, text, oldLineNo: null, newLineNo: null }
}

function hunk(...lines: DiffLine[]): DiffHunk {
  return { header: '@@ -1 +1 @@', lines }
}

/**
 * The visible text of highlighted markup: tags stripped and the entities
 * highlight.js escapes decoded, so assertions read as the original source.
 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
}

describe('languageFor', () => {
  it('maps known extensions and returns null for the rest', () => {
    expect(languageFor('src/a.ts')).toBe('typescript')
    expect(languageFor('src/a.tsx')).toBe('typescript')
    expect(languageFor('Makefile')).toBeNull()
    expect(languageFor('notes.unknownext')).toBeNull()
  })
})

describe('splitHighlightedLines', () => {
  it('splits plain text with no tags into its lines', () => {
    expect(splitHighlightedLines('a\nb\nc')).toEqual(['a', 'b', 'c'])
  })

  it('keeps a span that sits entirely on one line intact', () => {
    const lines = splitHighlightedLines('x\n<span class="hljs-string">"s"</span>\ny')
    expect(lines).toEqual(['x', '<span class="hljs-string">"s"</span>', 'y'])
  })

  it('closes and reopens a span that straddles newlines so each line is balanced', () => {
    const lines = splitHighlightedLines('<span class="hljs-comment">/* one\ntwo\nthree */</span>')

    expect(lines).toEqual([
      '<span class="hljs-comment">/* one</span>',
      '<span class="hljs-comment">two</span>',
      '<span class="hljs-comment">three */</span>'
    ])
    // Every line independently balances its tags.
    for (const html of lines) {
      expect((html.match(/<span/g) ?? []).length).toBe((html.match(/<\/span>/g) ?? []).length)
    }
  })

  it('handles nested spans crossing a newline', () => {
    const lines = splitHighlightedLines('<span class="a">x<span class="b">y\nz</span></span>')
    expect(lines).toEqual([
      '<span class="a">x<span class="b">y</span></span>',
      '<span class="a"><span class="b">z</span></span>'
    ])
  })

  it('preserves entities and never drops content', () => {
    const lines = splitHighlightedLines('a &amp; b\n&lt;tag&gt;')
    expect(lines).toEqual(['a &amp; b', '&lt;tag&gt;'])
  })
})

describe('highlightHunk', () => {
  it('returns null for every line when the language is unknown', () => {
    const result = highlightHunk(hunk(line('context', 'a'), line('add', 'b')), null)
    expect(result).toEqual([null, null])
  })

  it('classifies a block comment spanning several lines, which per-line highlighting cannot', () => {
    const result = highlightHunk(
      hunk(line('context', '/* explain'), line('context', '   more'), line('context', '*/')),
      'typescript'
    )

    // The middle line is only a comment by virtue of the line above it.
    expect(result[1]).toContain('hljs-comment')
    expect(textOf(result[1]!)).toBe('   more')
  })

  it('highlights each side independently so a deletion does not poison the added side', () => {
    // The removed line opens a string that the added line closes properly.
    const result = highlightHunk(
      hunk(line('del', 'const a = "unterminated'), line('add', 'const a = "fine"'), line('context', 'end')),
      'typescript'
    )

    expect(textOf(result[0]!)).toBe('const a = "unterminated')
    expect(textOf(result[1]!)).toBe('const a = "fine"')
    // The shared context line takes the added side, so the removed line's
    // dangling quote does not swallow it into a string.
    expect(textOf(result[2]!)).toBe('end')
    expect(result[2]).not.toContain('hljs-string')
  })

  it('returns one entry per line, positionally aligned with hunk.lines', () => {
    const lines = [
      line('context', 'const x = 1'),
      line('del', 'const y = 2'),
      line('add', 'const y = 3'),
      line('context', 'export { x, y }')
    ]
    const result = highlightHunk(hunk(...lines), 'typescript')

    expect(result).toHaveLength(lines.length)
    for (const [i, html] of result.entries()) {
      expect(textOf(html!)).toBe(lines[i].text)
    }
  })

  it('handles an empty hunk and blank lines without throwing', () => {
    expect(highlightHunk(hunk(), 'typescript')).toEqual([])
    const result = highlightHunk(hunk(line('context', ''), line('add', 'x')), 'typescript')
    expect(result).toHaveLength(2)
    expect(textOf(result[0] ?? '')).toBe('')
  })
})
