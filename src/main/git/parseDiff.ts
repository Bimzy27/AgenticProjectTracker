import type { DiffFile, DiffHunk, DiffLine, FileChangeType, WorkingTreeArea } from '@shared/domain'

/**
 * Parse `git diff` unified output (with rename detection) into the structured
 * diff model. Tolerates unknown header lines by skipping them.
 */
export function parseUnifiedDiff(raw: string, area: WorkingTreeArea | null): DiffFile[] {
  const files: DiffFile[] = []
  if (!raw.trim()) return files

  const blocks = splitFileBlocks(raw)
  for (const block of blocks) {
    const file = parseFileBlock(block, area)
    if (file) files.push(file)
  }
  return files
}

/** Build a synthetic all-added diff for an untracked file. */
export function syntheticAddedFile(path: string, content: string | null): DiffFile {
  if (content === null) {
    return {
      path,
      oldPath: null,
      changeType: 'added',
      binary: true,
      area: 'untracked',
      additions: 0,
      deletions: 0,
      hunks: []
    }
  }
  const rawLines = content.length === 0 ? [] : content.replace(/\r\n/g, '\n').split('\n')
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop()
  const lines: DiffLine[] = rawLines.map((text, i) => ({
    kind: 'add',
    oldLineNo: null,
    newLineNo: i + 1,
    text
  }))
  return {
    path,
    oldPath: null,
    changeType: 'added',
    binary: false,
    area: 'untracked',
    additions: lines.length,
    deletions: 0,
    hunks: lines.length > 0 ? [{ header: `@@ -0,0 +1,${lines.length} @@`, lines }] : []
  }
}

function splitFileBlocks(raw: string): string[][] {
  const blocks: string[][] = []
  let current: string[] | null = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) blocks.push(current)
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  if (current) blocks.push(current)
  return blocks
}

function parseFileBlock(lines: string[], area: WorkingTreeArea | null): DiffFile | null {
  let oldPath: string | null = null
  let newPath: string | null = null
  let changeType: FileChangeType = 'modified'
  let binary = false
  let renamed = false

  const headerPaths = parseDiffGitLine(lines[0])

  let i = 1
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('@@')) break
    if (line.startsWith('new file mode')) changeType = 'added'
    else if (line.startsWith('deleted file mode')) changeType = 'deleted'
    else if (line.startsWith('rename from ')) {
      renamed = true
      oldPath = line.slice('rename from '.length)
    } else if (line.startsWith('rename to ')) {
      renamed = true
      newPath = line.slice('rename to '.length)
    } else if (line.startsWith('copy from ') || line.startsWith('copy to ')) {
      // treat copies as additions of the new path
      if (line.startsWith('copy to ')) newPath = line.slice('copy to '.length)
      changeType = 'added'
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true
    } else if (line.startsWith('--- ')) {
      const p = stripPathPrefix(line.slice(4))
      if (p !== null && oldPath === null) oldPath = p
    } else if (line.startsWith('+++ ')) {
      const p = stripPathPrefix(line.slice(4))
      if (p !== null && newPath === null) newPath = p
    }
  }
  if (renamed) changeType = 'renamed'

  const path = newPath ?? headerPaths?.newPath ?? oldPath ?? headerPaths?.oldPath ?? null
  if (path === null) return null

  const hunks: DiffHunk[] = []
  let additions = 0
  let deletions = 0
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (!m) continue
      oldNo = parseInt(m[1], 10)
      newNo = parseInt(m[2], 10)
      hunk = { header: line, lines: [] }
      hunks.push(hunk)
    } else if (hunk) {
      if (line.startsWith('+')) {
        hunk.lines.push({ kind: 'add', oldLineNo: null, newLineNo: newNo++, text: line.slice(1) })
        additions++
      } else if (line.startsWith('-')) {
        hunk.lines.push({ kind: 'del', oldLineNo: oldNo++, newLineNo: null, text: line.slice(1) })
        deletions++
      } else if (line.startsWith(' ')) {
        hunk.lines.push({ kind: 'context', oldLineNo: oldNo++, newLineNo: newNo++, text: line.slice(1) })
      }
      // '\ No newline at end of file' and anything else is skipped
    }
  }

  return {
    path,
    oldPath: changeType === 'renamed' ? oldPath : null,
    changeType,
    binary,
    area,
    additions,
    deletions,
    hunks
  }
}

function parseDiffGitLine(line: string): { oldPath: string; newPath: string } | null {
  // `diff --git a/foo b/foo` (paths with spaces are ambiguous here; the
  // ---/+++ or rename headers below are authoritative when present)
  const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
  if (!m) return null
  return { oldPath: m[1], newPath: m[2] }
}

function stripPathPrefix(p: string): string | null {
  let path = p
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
  if (path === '/dev/null') return null
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2)
  return path
}

/** Group diff files by top-level directory for the categorized view. */
export function groupByDirectory(files: DiffFile[]): Map<string, DiffFile[]> {
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
