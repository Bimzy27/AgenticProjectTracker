import { useMemo, useState } from 'react'
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
import type { DiffFile, DiffLine, FileChangeType } from '@shared/domain'

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

const CHANGE_LABEL: Record<FileChangeType, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R'
}

interface Props {
  files: DiffFile[]
}

/** Categorized diff browser: directory groups, change badges, per-file diff (task 3.3). */
export function DiffViewer({ files }: Props): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [split, setSplit] = useState(false)

  const groups = useMemo(() => groupByDirectory(files), [files])
  const selectedFile = files.find((f) => fileKey(f) === selected) ?? files[0] ?? null

  if (files.length === 0) return <div className="empty-state">Working tree is clean.</div>

  return (
    <div className="diff-viewer">
      <aside className="diff-files">
        {[...groups.entries()].map(([dir, groupFiles]) => (
          <div key={dir} className="diff-group">
            <button
              className="diff-group-header"
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(dir)) next.delete(dir)
                  else next.add(dir)
                  return next
                })
              }
            >
              {collapsed.has(dir) ? '▸' : '▾'} {dir === '.' ? '(root)' : dir}
              <span className="muted"> {groupFiles.length}</span>
            </button>
            {!collapsed.has(dir) &&
              groupFiles.map((file) => (
                <button
                  key={fileKey(file)}
                  className={`diff-file-row ${selectedFile === file ? 'active' : ''}`}
                  onClick={() => setSelected(fileKey(file))}
                  title={file.path}
                >
                  <span className={`change-badge change-${file.changeType}`}>
                    {CHANGE_LABEL[file.changeType]}
                  </span>
                  <span className="diff-file-name">{baseName(file.path)}</span>
                  {file.area && <span className={`area-badge area-${file.area}`}>{file.area}</span>}
                  <span className="diff-counts">
                    <span className="add">+{file.additions}</span>{' '}
                    <span className="del">-{file.deletions}</span>
                  </span>
                </button>
              ))}
          </div>
        ))}
      </aside>
      <section className="diff-detail">
        {selectedFile && (
          <>
            <div className="diff-detail-header">
              <code>
                {selectedFile.oldPath ? `${selectedFile.oldPath} → ` : ''}
                {selectedFile.path}
              </code>
              <label className="toggle">
                <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
                side by side
              </label>
            </div>
            {selectedFile.binary ? (
              <div className="empty-state">Binary file, no text diff.</div>
            ) : split ? (
              <SplitDiff file={selectedFile} />
            ) : (
              <UnifiedDiff file={selectedFile} />
            )}
          </>
        )}
      </section>
    </div>
  )
}

function UnifiedDiff({ file }: { file: DiffFile }): React.JSX.Element {
  const language = languageFor(file.path)
  return (
    <div className="diff-code">
      {file.hunks.map((hunk, hi) => (
        <div key={hi}>
          <div className="hunk-header">{hunk.header}</div>
          <table className="diff-table">
            <tbody>
              {hunk.lines.map((line, li) => (
                <tr key={li} className={`line-${line.kind}`}>
                  <td className="lineno">{line.oldLineNo ?? ''}</td>
                  <td className="lineno">{line.newLineNo ?? ''}</td>
                  <td className="sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</td>
                  <td className="code">
                    <Highlighted text={line.text} language={language} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

function SplitDiff({ file }: { file: DiffFile }): React.JSX.Element {
  const language = languageFor(file.path)
  return (
    <div className="diff-code">
      {file.hunks.map((hunk, hi) => {
        const rows = pairLines(hunk.lines)
        return (
          <div key={hi}>
            <div className="hunk-header">{hunk.header}</div>
            <table className="diff-table split">
              <tbody>
                {rows.map(([left, right], ri) => (
                  <tr key={ri}>
                    <td className="lineno">{left?.oldLineNo ?? ''}</td>
                    <td className={`code half ${left ? `line-${left.kind}` : 'line-empty'}`}>
                      {left && <Highlighted text={left.text} language={language} />}
                    </td>
                    <td className="lineno">{right?.newLineNo ?? ''}</td>
                    <td className={`code half ${right ? `line-${right.kind}` : 'line-empty'}`}>
                      {right && <Highlighted text={right.text} language={language} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}

function Highlighted({ text, language }: { text: string; language: string | null }): React.JSX.Element {
  const html = useMemo(() => {
    if (!language || !text) return null
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value
    } catch {
      return null
    }
  }, [text, language])
  if (html === null) return <span>{text}</span>
  return <span dangerouslySetInnerHTML={{ __html: html }} />
}

/** Pair del/add runs into side-by-side rows. */
function pairLines(lines: DiffLine[]): Array<[DiffLine | null, DiffLine | null]> {
  const rows: Array<[DiffLine | null, DiffLine | null]> = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.kind === 'context') {
      rows.push([line, line])
      i++
    } else if (line.kind === 'del') {
      const dels: DiffLine[] = []
      const adds: DiffLine[] = []
      while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++])
      while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++])
      for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
        rows.push([dels[j] ?? null, adds[j] ?? null])
      }
    } else {
      rows.push([null, line])
      i++
    }
  }
  return rows
}

function groupByDirectory(files: DiffFile[]): Map<string, DiffFile[]> {
  const groups = new Map<string, DiffFile[]>()
  for (const file of files) {
    const idx = file.path.lastIndexOf('/')
    const dir = idx === -1 ? '.' : file.path.slice(0, idx)
    const group = groups.get(dir)
    if (group) group.push(file)
    else groups.set(dir, [file])
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function baseName(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

function fileKey(file: DiffFile): string {
  return `${file.area ?? 'ref'}:${file.path}`
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

function languageFor(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return EXT_LANGUAGES[ext] ?? null
}
