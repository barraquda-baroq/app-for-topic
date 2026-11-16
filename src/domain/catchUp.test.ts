// 追いつき（src/domain/catchUp.ts。docs/SPEC.md の 9.・7.8 の「続報のつなぎ」。設計: 段階2の 1.8）:
// 追いつく版（最後に見た版より後だけ・6版より前は入れない・今の版を入れない・30日の内に見た版が無ければ出さない・夜の 20:00版だけを毎日
// 見る並びでは帯の数に届かない・まる1日開かなかった並びでは届く）と、並べ方（渡した版だけ・今の版を入れない・threadId ごとに最新1本・
// 最新が今の版にある鎖は外す・重大印 → order の位置 → 新しい版の順・知らない値の話題も残す）
import { describe, expect, it } from 'vitest'
import { CATCH_UP_MIN, CATCH_UP_SCAN, catchUpItems, catchUpTargetIds, type CatchUpEdition } from './catchUp'
import { slotTimeMs } from './jst'

/** 2026-11-15 20:40（日本時間） */
const NOW = slotTimeMs('2026-11-15', '20') + 40 * 60 * 1000
/** 11/10 12:00版〜11/15 20:00版の12版 */
const EDITIONS = ['10', '11', '12', '13', '14', '15'].flatMap((d) => [`2026-11-${d}-12`, `2026-11-${d}-20`])
const seenOf = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { seen: true }]))

describe('catchUpTargetIds（追いつく版）', () => {
  it('6版（3日分）の中で、出している版より前で、最後に見た版より後の版（新しい順）', () => {
    expect(CATCH_UP_SCAN).toBe(6)
    expect(CATCH_UP_MIN).toBe(2)
    const ids = catchUpTargetIds({ now: NOW, editionIds: EDITIONS, seen: seenOf('2026-11-13-20'), shownId: '2026-11-15-20' })
    expect(ids).toEqual(['2026-11-15-12', '2026-11-14-20', '2026-11-14-12'])
  })

  it('最後に見た版が6版より前なら、6版の中の出している版より前の版全部（6版より前はさかのぼらない）', () => {
    const ids = catchUpTargetIds({ now: NOW, editionIds: EDITIONS, seen: seenOf('2026-11-10-20'), shownId: '2026-11-15-20' })
    expect(ids).toEqual(['2026-11-15-12', '2026-11-14-20', '2026-11-14-12', '2026-11-13-20', '2026-11-13-12'])
  })

  it('見た版のうち、いちばん新しい物の後だけ（それより前の見ていない版は入れない）', () => {
    const ids = catchUpTargetIds({
      now: NOW,
      editionIds: EDITIONS,
      seen: { ...seenOf('2026-11-13-12', '2026-11-14-12'), '2026-11-14-20': { seen: false } },
      shownId: '2026-11-15-20',
    })
    expect(ids).toEqual(['2026-11-15-12', '2026-11-14-20'])
  })

  it('今の版・今の版より新しい版は入れない。今の版を見ただけでは「見た版」にならない', () => {
    const ids = catchUpTargetIds({
      now: NOW,
      editionIds: EDITIONS,
      seen: seenOf('2026-11-14-12', '2026-11-15-12'),
      shownId: '2026-11-15-12',
    })
    expect(ids).toEqual(['2026-11-14-20'])
    expect(catchUpTargetIds({ now: NOW, editionIds: EDITIONS, seen: seenOf('2026-11-15-12'), shownId: '2026-11-15-12' })).toEqual(
      [],
    )
  })

  it('30日の内に見た版が1つも無い時（初めて使う時）・出している版が無い時は出さない', () => {
    expect(catchUpTargetIds({ now: NOW, editionIds: EDITIONS, seen: {}, shownId: '2026-11-15-20' })).toEqual([])
    // 30日の外の見た版は数えない
    expect(catchUpTargetIds({ now: NOW, editionIds: EDITIONS, seen: seenOf('2026-10-01-20'), shownId: '2026-11-15-20' })).toEqual(
      [],
    )
    expect(catchUpTargetIds({ now: NOW, editionIds: EDITIONS, seen: seenOf('2026-11-14-20'), shownId: null })).toEqual([])
  })

  it('夜の 20:00版だけを毎日見る並びでは、帯の数（2つ）に届かない', () => {
    const ids = catchUpTargetIds({
      now: NOW,
      editionIds: EDITIONS,
      seen: seenOf('2026-11-12-20', '2026-11-13-20', '2026-11-14-20'),
      shownId: '2026-11-15-20',
    })
    expect(ids).toEqual(['2026-11-15-12'])
    expect(ids.length >= CATCH_UP_MIN).toBe(false)
  })

  it('まる1日開かなかった並びでは届く', () => {
    const ids = catchUpTargetIds({
      now: NOW,
      editionIds: EDITIONS,
      seen: seenOf('2026-11-13-20'),
      shownId: '2026-11-15-12',
    })
    expect(ids).toEqual(['2026-11-14-20', '2026-11-14-12'])
    expect(ids.length >= CATCH_UP_MIN).toBe(true)
  })

  it('版の記録の無い枠（作れなかった枠）は数えない・30日の外の版は入れない', () => {
    const editionIds = EDITIONS.filter((id) => id !== '2026-11-14-12')
    expect(catchUpTargetIds({ now: NOW, editionIds, seen: seenOf('2026-11-13-12'), shownId: '2026-11-15-20' })).toEqual([
      '2026-11-15-12',
      '2026-11-14-20',
      '2026-11-13-20',
    ])
    const late = slotTimeMs('2026-12-10', '20')
    expect(
      catchUpTargetIds({ now: late, editionIds: EDITIONS, seen: seenOf('2026-11-12-12'), shownId: '2026-12-10-20' }),
    ).toEqual(['2026-11-15-20', '2026-11-15-12', '2026-11-14-20', '2026-11-14-12', '2026-11-13-20', '2026-11-13-12'])
  })
})

interface T {
  id: string
  threadId: string
  major: boolean
  genre?: string
}
const t = (id: string, threadId = id, major = false, genre?: string): T => ({ id, threadId, major, genre })
const ed = (editionId: string, topics: T[], order = topics.map((x) => x.id)): CatchUpEdition<T> => ({
  editionId,
  order,
  topics,
})

describe('catchUpItems（追いつきの並び）', () => {
  it('渡した版の話題だけ・今の版は入れない', () => {
    const a = ed('2026-11-14-12', [t('a1'), t('a2')])
    const cur = ed('2026-11-15-12', [t('c1')])
    const items = catchUpItems([a, cur], cur)
    expect(items.map((i) => i.topic.id)).toEqual(['a1', 'a2'])
    expect(items.map((i) => i.editionId)).toEqual(['2026-11-14-12', '2026-11-14-12'])
  })

  it('threadId ごとにいちばん新しい版の1本。いちばん新しい1本が今の版にある鎖は外す', () => {
    const older = ed('2026-11-13-12', [t('x1', 'x'), t('y1', 'y'), t('z1', 'z')])
    const newer = ed('2026-11-14-20', [t('x2', 'x'), t('w', 'w')])
    const cur = ed('2026-11-15-12', [t('y3', 'y')])
    const items = catchUpItems([newer, older], cur)
    expect(items.map((i) => i.topic.id).sort()).toEqual(['w', 'x2', 'z1'])
  })

  it('重大印 → 版の order の位置 → 新しい版の順', () => {
    const e1 = ed('2026-11-13-20', [t('p0'), t('p1'), t('p2', 'p2', true)])
    const e2 = ed('2026-11-14-20', [t('q0'), t('q1'), t('q2')])
    const items = catchUpItems([e1, e2], null)
    expect(items.map((i) => [i.topic.id, i.position])).toEqual([
      ['p2', 2],
      ['q0', 0],
      ['p0', 0],
      ['q1', 1],
      ['p1', 1],
      ['q2', 2],
    ])
  })

  it('正は order（話題の並びではなく order の位置で並べる）', () => {
    const e1 = ed('2026-11-14-12', [t('a'), t('b')], ['b', 'a'])
    expect(catchUpItems([e1], null).map((i) => i.topic.id)).toEqual(['b', 'a'])
  })

  it('知らない値の話題（後の版のジャンルなど）も残す（選ぶ話題は変えない）', () => {
    const e1 = ed('2026-11-14-12', [t('n', 'n', false, 'novel'), t('s', 's', false, 'sports')])
    expect(catchUpItems([e1], null).map((i) => i.topic.genre)).toEqual(['novel', 'sports'])
  })

  it('版が無ければ空', () => {
    expect(catchUpItems([], null)).toEqual([])
  })
})
