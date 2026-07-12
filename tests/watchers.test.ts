import { describe, expect, it } from 'vitest'
import { repoWatchIgnored } from '../src/main/services/Watchers'

describe('repoWatchIgnored', () => {
  it('watches regular source files and directories', () => {
    expect(repoWatchIgnored('C:\\repo\\src\\app.ts')).toBe(false)
    expect(repoWatchIgnored('/repo/src')).toBe(false)
    expect(repoWatchIgnored('/repo/README.md')).toBe(false)
  })

  it('ignores node_modules anywhere in the tree', () => {
    expect(repoWatchIgnored('C:\\repo\\node_modules')).toBe(true)
    expect(repoWatchIgnored('C:\\repo\\node_modules\\pkg\\index.js')).toBe(true)
    expect(repoWatchIgnored('/repo/packages/a/node_modules/x.js')).toBe(true)
  })

  it('ignores .git internals except HEAD and index', () => {
    expect(repoWatchIgnored('/repo/.git/objects/ab/cdef')).toBe(true)
    expect(repoWatchIgnored('/repo/.git/refs/heads/main')).toBe(true)
    expect(repoWatchIgnored('/repo/.git/HEAD')).toBe(false)
    expect(repoWatchIgnored('/repo/.git/index')).toBe(false)
  })

  it('ignores asar archives so Electron never opens and locks them', () => {
    expect(repoWatchIgnored('C:\\repo\\dist\\win-unpacked\\resources\\app.asar')).toBe(true)
    expect(repoWatchIgnored('/repo/dist/resources/default_app.ASAR')).toBe(true)
    expect(repoWatchIgnored('/repo/src/asar-tools.ts')).toBe(false)
  })
})
