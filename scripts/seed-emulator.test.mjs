// @vitest-environment node
// エミュレーターに入れる道具（scripts/seed-emulator.mjs。npm run seed:emu）の引数の読み取りと、書いた結果の文。
// エミュレーターに書く中身は src/test/seedEmulator.test.ts、エミュレーターで流すのは e2e/data.sync.spec.ts
import { describe, expect, it } from 'vitest'
import { SEED_DEFAULTS } from '../src/test/seedEmulator.ts'
import { DEFAULTS, parseArgs, report } from './seed-emulator.mjs'

describe('seed-emulator の引数', () => {
  it('既定は35日分・dev-author・種 fake-month（src/test/seedEmulator.ts の SEED_DEFAULTS と同じ）', () => {
    expect(DEFAULTS).toEqual(SEED_DEFAULTS)
    expect(parseArgs([])).toEqual({
      days: 35,
      sub: 'dev-author',
      uid: null,
      seed: 'fake-month',
      until: null,
      untilSlot: null,
      owner: false,
      help: false,
    })
  })

  it('--days 35・--days=35 のどちらでも読み、ほかの引数も読む', () => {
    expect(parseArgs(['--days', '35']).days).toBe(35)
    expect(parseArgs(['--days=40']).days).toBe(40)
    expect(parseArgs(['--sub', 'e2e-a', '--seed', 's1', '--until', '2026-11-14', '--until-slot', '12', '--owner'])).toMatchObject(
      { sub: 'e2e-a', seed: 's1', until: '2026-11-14', untilSlot: '12', owner: true },
    )
    expect(parseArgs(['--uid', 'AbC123']).uid).toBe('AbC123')
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
  })

  it.each([
    [['--days', '2'], '--days は 3〜366'],
    [['--days', '1.5'], '--days は 3〜366'],
    [['--days', '400'], '--days は 3〜366'],
    [['--days'], '--days の値がありません'],
    [['--days', '--owner'], '--days の値がありません'],
    [['--sub', 'a b'], '--sub は英数字'],
    [['--uid', 'x/y'], '--uid は英数字'],
    [['--until', '11/14'], '--until は YYYY-MM-DD'],
    [['--until-slot', '9'], '--until-slot は 12 か 20'],
    [['--seed', ' '], '--seed が空'],
    [['--day', '3'], '知らない引数です: --day'],
  ])('%j は断る', (argv, msg) => {
    expect(() => parseArgs(argv)).toThrow(msg)
  })
})

describe('seed-emulator の結果の文', () => {
  const plan = {
    counts: { editions: 68, topics: 1360, termPacks: 68, editionFails: 1, corrections: 4 },
    total: 1501,
    newestEditionId: '2026-11-15-12',
    until: '2026-11-15',
    untilSlot: '12',
    beforeFirstSync: 111,
    outsideRetention: 221,
  }

  it('書いた数・いちばん新しい版・32日より前の数と、ログインの仕方を出す', () => {
    const text = report(plan, 'uid-1', parseArgs([]))
    expect(text).toContain('users/uid-1/records')
    expect(text).toContain('版 68・話題 1,360・辞書の束 68・作れなかった印 1・訂正 4（合わせて 1,501件）')
    expect(text).toContain('2026-11-15-12')
    expect(text).toContain('32日）より前: 111件')
    expect(text).toContain("__ts.signInForTest('dev-author')")
    expect(text).not.toContain('config/owner')
  })

  it('--uid の時はログインの仕方を出さず、--owner の時は持ち主の記録も知らせる', () => {
    const text = report(plan, 'uid-2', parseArgs(['--uid', 'uid2', '--owner']))
    expect(text).not.toContain('signInForTest')
    expect(text).toContain('config/owner')
  })
})
