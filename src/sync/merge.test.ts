// 同期の3者マージ（docs/SPEC.md の 7.8 の「既読・知ってるを送る・受け取る」・16.3）: 既読の並び（足す・相手が消した物を除く・重なり無し）、
// 既読の seen（base が null で、この端末 false・相手 true → true になり、topicIds は足し合わせ）、知ってるの1組と asOf は新しい方、
// 共通の履歴が無い時、同期で記録を消さない事、Claude の記録は受け取ったまま
import { describe, expect, it } from 'vitest'
import { editionIdOf, termIdOf } from '../domain/ids'
import { pressKnownTerm, unpressKnownTerm } from '../domain/known'
import type { KnownTerm, ReadMark, TableName } from '../domain/types'
import {
  FIELD_GROUPS,
  FIELD_RULES,
  LIST_FIELDS,
  contentEqual,
  deepEqual,
  mergeFields,
  mergeList,
  mergeRemote as mergeRemoteRec,
  stableStringify,
  unionList,
  type Rec,
} from './merge'

/** 記録の型のまま渡す（テストを読みやすく） */
const mergeRemote = (
  table: TableName,
  base: object | null,
  mine: object | null,
  theirs: object | null,
  opts?: Parameters<typeof mergeRemoteRec>[4],
) => mergeRemoteRec(table, base as Rec | null, mine as Rec | null, theirs as Rec | null, opts)

const T0 = Date.UTC(2026, 10, 15, 3, 0)
const editionId = editionIdOf('2026-11-15', '12')
/** 作り物の話題の id（版の id ＋ 8字） */
const topic = (fp: string) => `${editionId}-${fp}`
const [P1, P2, P3, P4] = [topic('aaaaaaa1'), topic('aaaaaaa2'), topic('aaaaaaa3'), topic('aaaaaaa4')]

function readMark(p: Partial<ReadMark> = {}): ReadMark {
  return { id: editionId, v: 1, createdAt: T0, updatedAt: T0, by: 'user', ai: null, editionId, topicIds: [], seen: false, ...p }
}

const termId = termIdOf('与党（日本）')
const press = (prev: KnownTerm | null, asOf: string | null, at: number, term = '与党') =>
  pressKnownTerm(prev, { termId, term, asOf }, at)

describe('比較（src/domain/equal.ts から再び公開）', () => {
  it('キーの順番と undefined の欄は問わない。contentEqual は updatedAt を見ない', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(deepEqual({ a: 1, x: undefined }, { a: 1 })).toBe(true)
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}')
    expect(contentEqual({ id: 'a', updatedAt: 1 }, { id: 'a', updatedAt: 2 })).toBe(true)
  })
})

describe('7.8 の表ごとの指定', () => {
  it('並びは既読の topicIds、1組は知ってるの on・term、表の決まりは既読の seen と知ってるの asOf だけ', () => {
    expect(Object.keys(LIST_FIELDS)).toEqual(['reads'])
    expect(Object.keys(LIST_FIELDS.reads!)).toEqual(['topicIds'])
    expect(FIELD_GROUPS).toEqual({ knownTerms: [['on', 'term']] })
    expect(Object.fromEntries(Object.entries(FIELD_RULES).map(([t, r]) => [t, Object.keys(r!)]))).toEqual({
      reads: ['seen'],
      knownTerms: ['asOf'],
    })
  })
})

describe('既読の並び（topicIds）', () => {
  const id = (x: unknown) => String(x)
  it('2台で別々に足した物は両方残る（相手が足した物は、相手の並びの直前の要素の後ろ）', () => {
    expect(mergeList([P1], [P1, P2], [P1, P3], id)).toEqual([P1, P3, P2])
  })
  it('相手が消した物は除き、この端末が消した物は戻さない', () => {
    expect(mergeList([P1, P2], [P1, P2, P3], [P1], id)).toEqual([P1, P3])
    expect(mergeList([P1, P2], [P1], [P1, P2, P4], id)).toEqual([P1, P4])
  })
  it('重なり無し（どちらの並びに重なりがあっても1つ）', () => {
    expect(mergeList([P1], [P1, P2, P2], [P1, P3, P3, P2], id)).toEqual([P1, P3, P2])
    expect(unionList([P1, P1, P2], [P2, P3, P3], id)).toEqual([P1, P2, P3])
  })
  it('片方だけが変えた並びは、その並びのまま', () => {
    expect(mergeList([P1], [P1], [P1, P2], id)).toEqual([P1, P2])
    expect(mergeList([P1], [P2, P1], [P1], id)).toEqual([P2, P1])
  })
  it('PC で1本目、スマホで2本目を読む → 両方とも既読（記録の3者マージで）', () => {
    const base = readMark({ topicIds: [] })
    const pc = { ...base, topicIds: [P1], updatedAt: T0 + 1 }
    const phone = { ...base, topicIds: [P2], updatedAt: T0 + 2 }
    const r = mergeRemote('reads', base, pc, phone).record as ReadMark
    expect([...r.topicIds].sort()).toEqual([P1, P2])
    expect(r.updatedAt).toBe(T0 + 2)
  })
})

describe('既読の seen（どちらかが true なら true）', () => {
  it('base が null（2台がどちらも新しく作った）で、この端末 false・相手 true → true になり、topicIds は足し合わせ', () => {
    const mine = readMark({ topicIds: [P1], seen: false, createdAt: T0 + 5, updatedAt: T0 + 5 })
    const theirs = readMark({ topicIds: [P2], seen: true, updatedAt: T0 + 3 })
    const r = mergeRemote('reads', null, mine, theirs).record as ReadMark
    expect(r.seen).toBe(true)
    expect([...r.topicIds].sort()).toEqual([P1, P2])
    expect(r.updatedAt).toBe(T0 + 5)
  })
  it('逆（この端末 true・相手 false）も true', () => {
    const r = mergeRemote('reads', null, readMark({ seen: true, topicIds: [P1] }), readMark({ topicIds: [P2] }))
      .record as ReadMark
    expect(r.seen).toBe(true)
  })
  it('片方が見た・片方が読んだ → 見たも読んだも残る', () => {
    const base = readMark({ topicIds: [P1] })
    const r = mergeRemote('reads', base, { ...base, topicIds: [P1, P2] }, { ...base, seen: true }).record as ReadMark
    expect(r).toMatchObject({ seen: true, topicIds: [P1, P2] })
  })
  it('どちらも false なら false。知らない欄・知らない値は残る', () => {
    const base = { ...readMark(), extra: 'x' }
    const r = mergeRemote('reads', base, { ...base, topicIds: [P1] }, { ...base, topicIds: [P2], extra: 'y' }).record as ReadMark
    expect(r).toMatchObject({ seen: false, extra: 'y' })
    // seen が知らない値で、どちらも true でない時は、ふつうの合わせ方（両方が変えたらこの端末）
    const odd = mergeFields('reads', null, { ...readMark(), seen: 'partly' } as Rec, readMark({ seen: false }))
    expect((odd as unknown as { seen: unknown }).seen).toBe('partly')
  })
})

describe('知ってる（on・term は1組、asOf は新しい方）', () => {
  it('スマホで「知ってる」、電波の無い PC で外す → PC が後で同期すれば「外した」。asOf は新しい方', () => {
    const base = press(null, '2026-11', T0)
    const phone = press(base, '2026-12', T0 + 10)
    const pc = unpressKnownTerm(base, T0 + 20)
    // PC が後から同期する（PC = この端末、クラウド = スマホの書いた物）
    const r = mergeRemote('knownTerms', base, pc, phone).record as KnownTerm
    expect(r).toMatchObject({ on: false, term: '与党', asOf: '2026-12', updatedAt: T0 + 20 })
  })
  it('同じ場面でスマホが後から同期しても「外した」のまま（スマホが変えたのは asOf だけで、組は変えていない）', () => {
    const base = press(null, '2026-11', T0)
    const phone = press(base, '2026-12', T0 + 10)
    const pc = unpressKnownTerm(base, T0 + 20)
    const r = mergeRemote('knownTerms', base, phone, pc).record as KnownTerm
    expect(r).toMatchObject({ on: false, asOf: '2026-12', updatedAt: T0 + 20 })
  })
  it('両方が組を変えたら、後から同期した端末の組', () => {
    const base = press(null, null, T0, '与党')
    const phone = unpressKnownTerm(base, T0 + 10)
    const pc = press(base, null, T0 + 20, '政権与党')
    expect(mergeRemote('knownTerms', base, phone, pc).record).toMatchObject({ on: false, term: '与党' })
    expect(mergeRemote('knownTerms', base, pc, phone).record).toMatchObject({ on: true, term: '政権与党' })
  })
  it('on・term は混ぜない: 変えた側の2つをまとめて採る', () => {
    const base = press(null, null, T0, '与党')
    // この端末は別の表記で押し直した（on は true のまま、term を変えた）。相手は外した
    const mine = press(base, null, T0 + 5, '政権与党')
    const theirs = unpressKnownTerm(base, T0 + 6)
    const r = mergeRemote('knownTerms', base, mine, theirs).record as KnownTerm
    expect([r.on, r.term]).toEqual([true, '政権与党'])
    // この端末が組を変えていない（知らない欄だけを変えた）時は、相手の組
    const mine2 = { ...base, extra: 1 }
    const r2 = mergeRemote('knownTerms', base, mine2, theirs).record as KnownTerm
    expect([r2.on, r2.term, (r2 as unknown as { extra: number }).extra]).toEqual([false, '与党', 1])
  })
  it('7.4 の例: 2026-12 の説明で押した端末と、11/20 の版（2026-11）で押した端末を合わせても 2026-12。null がいちばん古い', () => {
    const base = unpressKnownTerm(press(null, null, T0), T0 + 1)
    const newer = press(base, '2026-12', T0 + 10)
    const older = press(base, '2026-11', T0 + 20)
    expect((mergeRemote('knownTerms', base, older, newer).record as KnownTerm).asOf).toBe('2026-12')
    expect((mergeRemote('knownTerms', base, newer, older).record as KnownTerm).asOf).toBe('2026-12')
    const withNull = { ...newer, asOf: null, term: '与党（日本）' }
    expect((mergeRemote('knownTerms', base, withNull, older).record as KnownTerm).asOf).toBe('2026-11')
  })
  it('2台がどちらも新しく作った（base が null）: 組はこの端末、asOf は新しい方', () => {
    const mine = press(null, '2026-10', T0 + 30)
    const theirs = unpressKnownTerm(press(null, '2026-12', T0), T0 + 1)
    const r = mergeRemote('knownTerms', null, mine, theirs).record as KnownTerm
    expect(r).toMatchObject({ on: true, asOf: '2026-12', updatedAt: T0 + 30 })
  })
})

describe('共通の履歴が無い時（初めてのログイン・前に別のアカウントで使っていた端末）', () => {
  const noHistory = { noHistory: true }
  it('クラウドを正とし、既読の並びにはこの端末にしか無い話題を足す。seen はどちらかが true なら true', () => {
    const theirs = readMark({ topicIds: [P2, P3], seen: false, updatedAt: T0 + 1 })
    const mine = readMark({ topicIds: [P1, P2], seen: true, createdAt: T0 - 99, updatedAt: T0 + 9 })
    const r = mergeRemote('reads', null, mine, theirs, noHistory).record as ReadMark
    expect(r.topicIds).toEqual([P1, P2, P3])
    expect(r.seen).toBe(true)
    // 並び・決まりの欄のほかはクラウドの中身
    expect([r.createdAt, r.updatedAt]).toEqual([T0, T0 + 1])
  })
  it('知ってるは、on・term はクラウド、asOf は新しい方', () => {
    const theirs = unpressKnownTerm(press(null, '2026-11', T0), T0 + 1)
    const mine = press(null, '2026-12', T0 + 50, '政権与党')
    const r = mergeRemote('knownTerms', null, mine, theirs, noHistory).record as KnownTerm
    expect(r).toMatchObject({ on: false, term: '与党', asOf: '2026-12' })
  })
  it('同じ中身ならクラウドの記録そのもの。クラウドに無ければこの端末の記録（作り直す）', () => {
    const theirs = readMark({ topicIds: [P1], updatedAt: T0 + 1 })
    expect(mergeRemote('reads', null, { ...theirs, updatedAt: T0 + 9 }, theirs, noHistory).record).toBe(theirs)
    const same = readMark({ topicIds: [P1, P2], seen: true })
    expect(mergeRemote('reads', null, readMark({ topicIds: [P2], seen: true }), same, noHistory).record).toBe(same)
    const mine = press(null, null, T0)
    expect(mergeRemote('knownTerms', null, mine, null, noHistory).record).toBe(mine)
  })
})

describe('同期で記録を消さない・Claude の記録は受け取ったまま', () => {
  it('クラウドに無い（ほかの端末が30日で消した・Firebase の画面で消した）時は、この端末の記録。端末に無い時はクラウドの記録', () => {
    const base = readMark({ topicIds: [P1] })
    const mine = { ...base, topicIds: [P1, P2] }
    expect(mergeRemote('reads', base, mine, null).record).toBe(mine)
    expect(mergeRemote('reads', base, base, null).record).toBe(base)
    expect(mergeRemote('reads', base, null, mine).record).toBe(mine)
    expect(mergeRemote('knownTerms', null, null, null).record).toBeNull()
  })
  it('片方だけが変えていればその中身。同じ中身ならクラウドの記録そのもの', () => {
    const base = readMark({ topicIds: [P1] })
    const theirs = { ...base, seen: true, updatedAt: T0 + 1 }
    expect(mergeRemote('reads', base, { ...base, updatedAt: T0 + 5 }, theirs).record).toBe(theirs)
    const mine = { ...base, topicIds: [P1, P2] }
    expect(mergeRemote('reads', base, mine, { ...base, updatedAt: T0 + 9 }).record).toBe(mine)
    const both = { ...base, seen: true, updatedAt: T0 + 2 }
    expect(mergeRemote('reads', base, { ...both, updatedAt: T0 + 3 }, both).record).toBe(both)
  })
  it('アプリが書かない表（版・話題・訂正・作れなかった印・辞書の束）は、クラウドの記録をそのまま', () => {
    for (const table of ['editions', 'topics', 'corrections', 'editionFails', 'termPacks'] as const) {
      const base = { id: 'x', v: 1, by: 'connector', a: 1 }
      const theirs = { ...base, a: 2 }
      expect(mergeRemote(table, base, { ...base, b: 1 }, theirs).record).toBe(theirs)
    }
  })
})
