import { describe, expect, it } from 'vitest'
import { groupByDirectory, parseUnifiedDiff, syntheticAddedFile } from '../src/main/git/parseDiff'

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
 const c = 4
 const d = 5
`

const ADDED = `diff --git a/docs/new.md b/docs/new.md
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1,2 @@
+# Title
+Body
`

const DELETED = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index e69de29..0000000
--- a/old.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-goodbye
`

const RENAMED = `diff --git a/src/before.ts b/src/after.ts
similarity index 95%
rename from src/before.ts
rename to src/after.ts
index 1234567..89abcde 100644
--- a/src/before.ts
+++ b/src/after.ts
@@ -1,2 +1,2 @@
 keep
-old line
+new line
`

const BINARY = `diff --git a/logo.png b/logo.png
index 1234567..89abcde 100644
Binary files a/logo.png and b/logo.png differ
`

describe('parseUnifiedDiff', () => {
  it('parses a modified file with line numbers', () => {
    const [file] = parseUnifiedDiff(MODIFIED, 'unstaged')
    expect(file.path).toBe('src/app.ts')
    expect(file.changeType).toBe('modified')
    expect(file.area).toBe('unstaged')
    expect(file.additions).toBe(1)
    expect(file.deletions).toBe(1)
    const lines = file.hunks[0].lines
    expect(lines[0]).toMatchObject({ kind: 'context', oldLineNo: 1, newLineNo: 1 })
    expect(lines[1]).toMatchObject({ kind: 'del', oldLineNo: 2, newLineNo: null, text: 'const b = 2' })
    expect(lines[2]).toMatchObject({ kind: 'add', oldLineNo: null, newLineNo: 2, text: 'const b = 3' })
  })

  it('classifies added, deleted, renamed, and binary files', () => {
    expect(parseUnifiedDiff(ADDED, 'staged')[0]).toMatchObject({
      path: 'docs/new.md',
      changeType: 'added',
      additions: 2
    })
    expect(parseUnifiedDiff(DELETED, null)[0]).toMatchObject({ path: 'old.txt', changeType: 'deleted' })
    expect(parseUnifiedDiff(RENAMED, null)[0]).toMatchObject({
      path: 'src/after.ts',
      oldPath: 'src/before.ts',
      changeType: 'renamed'
    })
    expect(parseUnifiedDiff(BINARY, null)[0]).toMatchObject({ path: 'logo.png', binary: true, hunks: [] })
  })

  it('parses multiple file blocks from one diff', () => {
    const files = parseUnifiedDiff(MODIFIED + ADDED, 'unstaged')
    expect(files.map((f) => f.path)).toEqual(['src/app.ts', 'docs/new.md'])
  })

  it('returns empty for blank input and skips garbage lines without throwing', () => {
    expect(parseUnifiedDiff('', null)).toEqual([])
    expect(parseUnifiedDiff('not a diff at all\nrandom text', null)).toEqual([])
  })
})

describe('syntheticAddedFile', () => {
  it('marks every line as added with new line numbers', () => {
    const file = syntheticAddedFile('notes.txt', 'one\ntwo\n')
    expect(file).toMatchObject({ changeType: 'added', area: 'untracked', additions: 2, binary: false })
    expect(file.hunks[0].lines.map((l) => l.newLineNo)).toEqual([1, 2])
  })

  it('handles empty and binary content', () => {
    expect(syntheticAddedFile('empty.txt', '').hunks).toEqual([])
    expect(syntheticAddedFile('bin.dat', null).binary).toBe(true)
  })
})

describe('groupByDirectory', () => {
  it('groups by directory with root as "." and sorts groups', () => {
    const files = parseUnifiedDiff(MODIFIED + ADDED + DELETED, null)
    const groups = groupByDirectory(files)
    expect([...groups.keys()]).toEqual(['.', 'docs', 'src'])
    expect(groups.get('src')![0].path).toBe('src/app.ts')
  })
})
