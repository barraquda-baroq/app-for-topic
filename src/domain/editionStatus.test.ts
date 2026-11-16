// トップの状態の1行の選び方（src/domain/editionStatus.ts。docs/SPEC.md の 4.7・7.2・7.8・16.6 の 57。設計: 段階2の 1.7）: 作れなかった・
// まだ届いていない（29分・30分の境）・待っている・出している版がいちばん新しい枠・枠が替わると消える・版が無い時と出せる版が無く待つ時は
// 出さない・いちばん新しい枠が新しい形の記録の時・同期が落ち着いているか
import { describe, expect, it } from 'vitest'
import {
  editionStatusOf,
  latestFail,
  newerOnlyStatusOf,
  NOT_ARRIVED_AFTER_MIN,
  syncSettled,
  type EditionStatusInput,
} from './editionStatus'
import { slotTimeMs } from './jst'
import type { SyncView } from '../sync/syncView'

const MIN = 60 * 1000
/** 2026-11-15 20:00（日本時間）から m 分 */
const at20 = (m: number) => slotTimeMs('2026-11-15', '20') + m * MIN
const fail = (editionId: string, reasonKind = 'quota', createdAt = 0, id = `${editionId}-aaaaaaaa`) => ({
  id,
  editionId,
  reasonKind,
  createdAt,
})

/** 20:40・12:00版を出していて、20:00版の記録も印も無い。同期は落ち着いている */
const base = (over: Partial<EditionStatusInput> = {}): EditionStatusInput => ({
  now: at20(40),
  editionIds: ['2026-11-14-20', '2026-11-15-12'],
  newerIds: [],
  fails: [],
  shownId: '2026-11-15-12',
  waitingId: null,
  syncSettled: true,
  ...over,
})

describe('syncSettled（同期が落ち着いているか）', () => {
  it('synced・pending・sending だけ true', () => {
    const views: [SyncView | null, boolean][] = [
      [{ kind: 'synced' }, true],
      [{ kind: 'pending', count: 2 }, true],
      [{ kind: 'sending' }, true],
      [null, false],
      [{ kind: 'downloading' }, false],
      [{ kind: 'offline' }, false],
      [{ kind: 'quota', resumeAt: '17:00' }, false],
      [{ kind: 'outdated' }, false],
      [{ kind: 'error', reason: '不明なエラー' }, false],
    ]
    for (const [v, want] of views) expect([v, syncSettled(v)]).toEqual([v, want])
    expect(syncSettled(undefined)).toBe(false)
  })
})

describe('editionStatusOf（トップの状態の1行）', () => {
  it('作れなかった印がある: 「20:00版は作れませんでした（理由の種類）」', () => {
    expect(editionStatusOf(base({ fails: [fail('2026-11-15-20')] }))).toEqual({
      kind: 'failed',
      text: '20:00版は作れませんでした（使用量の上限）',
    })
    expect(editionStatusOf(base({ fails: [fail('2026-11-15-20', 'bug')] }))?.text).toBe('20:00版は作れませんでした（そのほか）')
    // 同期が落ち着いていなくても出す（印は端末にある）
    expect(editionStatusOf(base({ fails: [fail('2026-11-15-20')], syncSettled: false }))?.kind).toBe('failed')
    // ほかの枠の印は見ない
    expect(editionStatusOf(base({ fails: [fail('2026-11-14-12')] }))?.kind).toBe('not-arrived')
  })

  it('同じ枠の印が2つある時は、後に足した方', () => {
    const fails = [fail('2026-11-15-20', 'timeout', 2, '2026-11-15-20-bbbbbbbb'), fail('2026-11-15-20', 'quota', 1)]
    expect(editionStatusOf(base({ fails }))?.text).toBe('20:00版は作れませんでした（時間切れ）')
    expect(latestFail(fails, '2026-11-15-20')?.reasonKind).toBe('timeout')
    expect(latestFail(fails, '2026-11-15-12')).toBeNull()
  })

  it('まだ届いていない: 枠の時刻の30分後から（29分は出さない）・同期が落ち着いている時だけ', () => {
    expect(NOT_ARRIVED_AFTER_MIN).toBe(30)
    expect(editionStatusOf(base({ now: at20(29) }))).toBeNull()
    expect(editionStatusOf(base({ now: at20(30) - 1 }))).toBeNull()
    expect(editionStatusOf(base({ now: at20(30) }))).toEqual({ kind: 'not-arrived', text: '20:00版はまだ届いていません' })
    expect(editionStatusOf(base({ now: at20(30), syncSettled: false }))).toBeNull()
  })

  it('待っている: 「11/15（日）20:00版を受け取っています…」（30分の前でも・同期が落ち着いていなくても）', () => {
    const waiting = base({ now: at20(5), editionIds: ['2026-11-15-12', '2026-11-15-20'], waitingId: '2026-11-15-20' })
    expect(editionStatusOf(waiting)).toEqual({ kind: 'waiting', text: '11/15（日）20:00版を受け取っています…' })
    expect(editionStatusOf({ ...waiting, syncSettled: false })?.kind).toBe('waiting')
  })

  it('出している版がいちばん新しい枠の版なら出さない（印があっても）', () => {
    expect(
      editionStatusOf(
        base({ editionIds: ['2026-11-15-12', '2026-11-15-20'], shownId: '2026-11-15-20', fails: [fail('2026-11-15-20')] }),
      ),
    ).toBeNull()
    // 12:00 から 20:00 の前は 12:00版がいちばん新しい枠
    expect(editionStatusOf(base({ now: slotTimeMs('2026-11-15', '12') + 130 * MIN }))).toBeNull()
  })

  it('枠が替わると消える（次の日の 12:00 の前は 20:00版の枠・12:00 からは次の枠）', () => {
    const fails = [fail('2026-11-15-20')]
    // 0時を過ぎても、12:00 の前は前の日の 20:00版の枠
    expect(editionStatusOf(base({ now: slotTimeMs('2026-11-16', '12') - MIN, fails }))?.kind).toBe('failed')
    // 次の日の 12:00 からは 12:00版の枠（20:00版の印は見ない。12:30 までは何も出さない）
    expect(editionStatusOf(base({ now: slotTimeMs('2026-11-16', '12'), fails }))).toBeNull()
    expect(editionStatusOf(base({ now: slotTimeMs('2026-11-16', '12') + 30 * MIN, fails }))).toEqual({
      kind: 'not-arrived',
      text: '12:00版はまだ届いていません',
    })
  })

  it('版の記録が1つも無い時（top-empty）・出せる版が無く待つ時（top-waiting）は出さない', () => {
    expect(editionStatusOf(base({ editionIds: [], shownId: null, fails: [fail('2026-11-15-20')] }))).toBeNull()
    expect(editionStatusOf(base({ editionIds: [], shownId: null }))).toBeNull()
    expect(
      editionStatusOf(base({ editionIds: ['2026-11-15-20'], shownId: null, waitingId: '2026-11-15-20', now: at20(50) })),
    ).toBeNull()
  })

  it('いちばん新しい枠が新しい形の記録: 「20:00版は新しい形の記録です」で、「まだ届いていません」を出さない', () => {
    const newer = base({ newerIds: ['2026-11-15-20'] })
    expect(editionStatusOf(newer)).toEqual({ kind: 'newer', text: '20:00版は新しい形の記録です（アプリを更新してください）' })
    expect(editionStatusOf({ ...newer, now: at20(5), syncSettled: false })?.kind).toBe('newer')
  })

  // 設計: 段階2の 1.7 の 0. が出さないのは「版の記録が1つも無い（editionIds・newerIds が空）」か「待っている」時だけ。出せる版が無くても、
  // 新しい形の版の記録が届いていれば 3. へ進む（届いているのに何も言わない・「まだ版はありません」と言わない）
  it('版の記録が新しい形の物だけ（出している版が無く、待ってもいない）の時は「{枠}版は新しい形の記録です」', () => {
    const only = base({
      now: slotTimeMs('2026-11-15', '12') + 130 * MIN,
      editionIds: [],
      newerIds: ['2026-11-15-12'],
      shownId: null,
    })
    expect(editionStatusOf(only)).toEqual({ kind: 'newer', text: '12:00版は新しい形の記録です（アプリを更新してください）' })
    expect(editionStatusOf({ ...only, syncSettled: false })?.kind).toBe('newer')
    // 待っている時は今のまま出さない（top-waiting）
    expect(editionStatusOf({ ...only, waitingId: '2026-11-15-12' })).toBeNull()
  })

  it('いちばん新しい枠の版の記録があって出していない時（話題がそろわず、付いていかない前の版など）は、作れなかった・届いていないを出さない', () => {
    expect(editionStatusOf(base({ editionIds: ['2026-11-15-12', '2026-11-15-20'], fails: [fail('2026-11-15-20')] }))).toBeNull()
  })
})

describe('newerOnlyStatusOf（出せる版が無く、新しい形の版の記録だけがある時の1行）', () => {
  const only = (over: Partial<EditionStatusInput> = {}) =>
    base({ now: slotTimeMs('2026-11-15', '12') + 130 * MIN, editionIds: [], newerIds: ['2026-11-15-12'], shownId: null, ...over })

  it('いちばん新しい枠が新しい形の記録なら、状態の1行と同じ「{枠}版は新しい形の記録です（アプリを更新してください）」', () => {
    expect(newerOnlyStatusOf(only())).toEqual({ kind: 'newer', text: '12:00版は新しい形の記録です（アプリを更新してください）' })
  })

  it('状態の1行が言う物が無い時（新しい形の記録が前の枠・同期が落ち着く前）は、決まった文「新しい形の記録（アプリを更新してください）」', () => {
    expect(newerOnlyStatusOf(only({ newerIds: ['2026-11-14-20'], syncSettled: false }))).toEqual({
      kind: 'newer',
      text: '新しい形の記録（アプリを更新してください）',
    })
    // 状態の1行が言う物（いちばん新しい枠が作れなかった）があればそれ
    expect(newerOnlyStatusOf(only({ newerIds: ['2026-11-14-20'], fails: [fail('2026-11-15-12')] }))?.kind).toBe('failed')
  })

  it('出している版がある・待っている・新しい形の記録が無い時は null（今のまま。状態の1行・top-waiting・top-empty）', () => {
    expect(newerOnlyStatusOf(only({ shownId: '2026-11-14-20', editionIds: ['2026-11-14-20'] }))).toBeNull()
    expect(newerOnlyStatusOf(only({ waitingId: '2026-11-15-12' }))).toBeNull()
    expect(newerOnlyStatusOf(only({ newerIds: [] }))).toBeNull()
  })
})
