import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import type { DiffHunk } from '@shared/domain'

for (const [name, language] of Object.entries({
  bash,
  c,
  cpp,
  csharp,
  css,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml
})) {
  hljs.registerLanguage(name, language)
}

const EXT_LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  css: 'css',
  html: 'xml',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  cpp: 'cpp',
  c: 'c',
  h: 'c',
  sh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  sql: 'sql'
}

/** Highlighting language for a path, or null when the extension is unknown. */
export function languageFor(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return EXT_LANGUAGES[ext] ?? null
}

/**
 * Split highlight.js output into one HTML string per source line.
 *
 * Highlighted spans routinely straddle newlines (a block comment, a template
 * literal), which is exactly why highlighting has to happen on whole text
 * rather than line by line. Emitting such a span into per-line markup would
 * leave unbalanced tags, so at every newline the still-open spans are closed
 * and re-opened on the next line - each line then stands alone while keeping
 * the classes the multi-line construct gave it.
 *
 * highlight.js emits only `<span>` elements and HTML entities, so tracking a
 * stack of opening tags is sufficient; no general HTML parsing is needed.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = []
  const openTags: string[] = []
  let current = ''
  let i = 0

  while (i < html.length) {
    const char = html[i]
    if (char === '<') {
      const close = html.indexOf('>', i)
      if (close === -1) {
        // Malformed tail: keep it verbatim rather than dropping content.
        current += html.slice(i)
        break
      }
      const tag = html.slice(i, close + 1)
      if (tag.startsWith('</')) openTags.pop()
      else if (!tag.endsWith('/>')) openTags.push(tag)
      current += tag
      i = close + 1
    } else if (char === '\n') {
      lines.push(current + '</span>'.repeat(openTags.length))
      current = openTags.join('')
      i++
    } else {
      // Copy the run of plain text up to the next tag or newline in one go.
      let end = i
      while (end < html.length && html[end] !== '<' && html[end] !== '\n') end++
      current += html.slice(i, end)
      i = end
    }
  }
  lines.push(current + '</span>'.repeat(openTags.length))
  return lines
}

/**
 * Highlighted HTML for every line of a hunk, positionally matching
 * `hunk.lines`; entries are null when the language is unknown, so the caller
 * renders the raw text instead.
 *
 * Each side of the hunk is highlighted as one document - the removed side
 * (context + deletions) and the added side (context + additions) - rather than
 * per line, so constructs spanning several lines are classified correctly.
 * A hunk, not the whole file, is the unit because a diff only carries its
 * hunks: the gaps between them are unknown here, and stitching hunks together
 * would feed the highlighter text that never existed.
 */
export function highlightHunk(hunk: DiffHunk, language: string | null): Array<string | null> {
  if (!language) return hunk.lines.map(() => null)

  const oldSide = highlightSide(
    hunk.lines.filter((line) => line.kind !== 'add').map((line) => line.text),
    language
  )
  const newSide = highlightSide(
    hunk.lines.filter((line) => line.kind !== 'del').map((line) => line.text),
    language
  )

  let oldIndex = 0
  let newIndex = 0
  return hunk.lines.map((line) => {
    if (line.kind === 'add') return newSide[newIndex++] ?? null
    if (line.kind === 'del') return oldSide[oldIndex++] ?? null
    // A context line exists on both sides and the two can disagree - deleted
    // code may have left a construct open that the added code closes. Take the
    // added side: it reflects the file as it now stands, which is what the
    // reader is reasoning about.
    oldIndex++
    return newSide[newIndex++] ?? null
  })
}

function highlightSide(texts: string[], language: string): string[] {
  if (texts.length === 0) return []
  try {
    const html = hljs.highlight(texts.join('\n'), { language, ignoreIllegals: true }).value
    const split = splitHighlightedLines(html)
    // A highlighter that returned an unexpected line count would silently
    // shift every following line's colouring; fall back rather than mislead.
    return split.length === texts.length ? split : []
  } catch {
    // An unusable grammar must not break the diff; the caller renders plain text.
    return []
  }
}
