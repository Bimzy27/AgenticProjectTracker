import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { DiffFile, DiffLine, FileChangeType } from '@shared/domain'
import { highlightHunk, languageFor } from './diffHighlight'

const CHANGE_LABEL: Record<FileChangeType, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R'
}

/**
 * Starting guess for a row's height before it is measured. Rows wrap, so real
 * heights vary; this only has to be close enough that the initial scrollbar is
 * not wildly wrong.
 */
const ESTIMATED_ROW_HEIGHT = 18

/** Rows kept mounted outside the viewport, so scrolling does not flash blanks. */
const OVERSCAN = 24

interface Props {
  files: DiffFile[]
}

/** One rendered row: hunk headers share the virtual list with their lines. */
type DiffRow =
  | { kind: 'header'; header: string }
  | { kind: 'unified'; line: DiffLine; html: string | null }
  | {
      kind: 'split'
      left: DiffLine | null
      leftHtml: string | null
      right: DiffLine | null
      rightHtml: string | null
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
            ) : (
              // Keyed so switching file or mode starts a fresh scroll and a
              // fresh set of row measurements rather than inheriting the last
              // file's.
              <FileDiff
                key={`${fileKey(selectedFile)}:${split ? 'split' : 'unified'}`}
                file={selectedFile}
                split={split}
              />
            )}
          </>
        )}
      </section>
    </div>
  )
}

/**
 * The selected file's diff, windowed: only rows near the viewport are in the
 * DOM, so a large diff costs the same as a small one to render. Row heights are
 * measured rather than assumed because code lines wrap.
 */
function FileDiff({ file, split }: { file: DiffFile; split: boolean }): React.JSX.Element {
  const rows = useMemo(() => (split ? buildSplitRows(file) : buildUnifiedRows(file)), [file, split])
  const scrollRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN
  })

  return (
    <div className="diff-code" ref={scrollRef}>
      <div className="diff-rows" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="diff-row-slot"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <DiffRowView row={rows[item.index]} />
          </div>
        ))}
      </div>
    </div>
  )
}

function DiffRowView({ row }: { row: DiffRow }): React.JSX.Element {
  if (row.kind === 'header') return <div className="hunk-header">{row.header}</div>

  if (row.kind === 'split') {
    const { left, leftHtml, right, rightHtml } = row
    return (
      <div className="diff-row diff-row-split">
        <span className="lineno">{left?.oldLineNo ?? ''}</span>
        <span className={`code half ${left ? `line-${left.kind}` : 'line-empty'}`}>
          {left && <Code text={left.text} html={leftHtml} />}
        </span>
        <span className="lineno">{right?.newLineNo ?? ''}</span>
        <span className={`code half ${right ? `line-${right.kind}` : 'line-empty'}`}>
          {right && <Code text={right.text} html={rightHtml} />}
        </span>
      </div>
    )
  }

  const { line, html } = row
  return (
    <div className={`diff-row line-${line.kind}`}>
      <span className="lineno">{line.oldLineNo ?? ''}</span>
      <span className="lineno">{line.newLineNo ?? ''}</span>
      <span className="sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</span>
      <span className="code">
        <Code text={line.text} html={html} />
      </span>
    </div>
  )
}

/** Pre-highlighted markup when the language is known, otherwise the raw text. */
function Code({ text, html }: { text: string; html: string | null }): React.JSX.Element {
  if (html === null) return <span>{text}</span>
  return <span dangerouslySetInnerHTML={{ __html: html }} />
}

function buildUnifiedRows(file: DiffFile): DiffRow[] {
  const language = languageFor(file.path)
  const rows: DiffRow[] = []
  for (const hunk of file.hunks) {
    rows.push({ kind: 'header', header: hunk.header })
    const highlighted = highlightHunk(hunk, language)
    hunk.lines.forEach((line, i) => {
      rows.push({ kind: 'unified', line, html: highlighted[i] ?? null })
    })
  }
  return rows
}

function buildSplitRows(file: DiffFile): DiffRow[] {
  const language = languageFor(file.path)
  const rows: DiffRow[] = []
  for (const hunk of file.hunks) {
    rows.push({ kind: 'header', header: hunk.header })
    const highlighted = highlightHunk(hunk, language)
    const htmlFor = new Map(hunk.lines.map((line, i) => [line, highlighted[i] ?? null]))
    for (const [left, right] of pairLines(hunk.lines)) {
      rows.push({
        kind: 'split',
        left,
        leftHtml: left ? (htmlFor.get(left) ?? null) : null,
        right,
        rightHtml: right ? (htmlFor.get(right) ?? null) : null
      })
    }
  }
  return rows
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
