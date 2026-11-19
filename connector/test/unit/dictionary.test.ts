// 辞書の今の形（vault/dictionary.ts・設計の 1.5・1.9）: 語ごとに rev の最大・外した語は引けない・束の順に左右されない・表記の索引は
// 外していない語だけ・部分の辞書（subsetFor・forInput）が全部の辞書と同じ答え（resolveTermRef・termOverlapProblems・assembleTopic）・
// 作り直しは別の表で進め、その間は今の表で引ける
import { describe, expect, it } from 'vitest'
import { assembleTopic } from '../../../src/domain/assemble'
import { termIdOf } from '../../../src/domain/ids'
import { dictionaryOf, liveTerms, resolveTermRef, termOverlapProblems } from '../../../src/domain/terms'
import type { TermEntry } from '../../../src/domain/types'
import { fakeInputCasesOf } from '../../../src/test/fixtures/fakeInputs'
import { makeFakeMonth, RULING_JP_KEY, RULING_US_KEY } from '../../../src/test/fixtures/fakeEditions'
import { Dictionary } from '../../src/vault/dictionary'
import { MirrorStore } from '../../src/vault/store'
import { nodeSql } from '../support/nodeSql'

const entry = (key: string, rev: number, over: Partial<TermEntry> = {}): TermEntry => ({
  termId: termIdOf(key),
  key,
  term: key.replace(/（.*）$/, ''),
  aliases: [],
  explanation: `作り物の説明 ${key} ${rev}`,
  asOf: '2026-11',
  rev,
  ...over,
})

function dict() {
  const store = new MirrorStore(nodeSql())
  return { store, d: new Dictionary(store) }
}

describe('束を当てる', () => {
  it('語ごとに rev の最大だけを書く（古い説明で書き直さない）。束の順に左右されない', () => {
    const packs = [
      [entry('〇〇法', 1), entry('△△制度', 1)],
      [entry('〇〇法', 2), entry('□□計画', 1)],
      [entry('〇〇法', 1, { explanation: '古い説明' })],
    ]
    const a = dict()
    for (const p of packs) a.d.apply(p)
    const b = dict()
    for (const p of [...packs].reverse()) b.d.apply(p)
    expect(a.store.allTerms()).toEqual(b.store.allTerms())
    expect(a.d.get(termIdOf('〇〇法'))!.rev).toBe(2)
    // 同じ語を古い rev で当てても書かない（行の数は 0）
    expect(a.d.apply([entry('〇〇法', 1)])).toBe(0)
    expect(a.store.allTerms()).toEqual(
      liveTerms(dictionaryOf(packs.map((entries) => ({ entries })))).sort((x, y) => x.termId.localeCompare(y.termId)),
    )
  })

  it('外した語は表記の索引から外れて引けない（rev の比べのために行は残す）。別名を替えると索引も替わる', () => {
    const { d } = dict()
    d.apply([entry('〇〇法', 1, { aliases: ['〇〇法律'] })])
    expect(d.idsOfForm('〇〇法律')).toEqual([termIdOf('〇〇法')])
    d.apply([entry('〇〇法', 2, { aliases: ['〇〇の法'] })])
    expect(d.idsOfForm('〇〇法律')).toEqual([])
    expect(d.idsOfForm('〇〇の法')).toEqual([termIdOf('〇〇法')])
    d.apply([entry('〇〇法', 3, { retired: true })])
    expect(d.idsOfForm('〇〇法')).toEqual([])
    expect(d.get(termIdOf('〇〇法'))!.retired).toBe(true)
  })

  it('表記はそろえた形で引く（全角・空白・英字の大小）', () => {
    const { d } = dict()
    d.apply([entry('ＡＢＣ 計画', 1, { term: 'ＡＢＣ 計画' })])
    expect(d.idsOfForm('abc  計画')).toEqual([termIdOf('ＡＢＣ 計画')])
  })
})

describe('部分の辞書（全部を読み込まない）', () => {
  it('作り物の1か月分の入力で、forInput の部分の辞書は全部の辞書と同じ組み立ての答えになる', () => {
    const m = makeFakeMonth({ until: '2026-11-19', days: 8, untilSlot: '12' })
    const cases = fakeInputCasesOf(m)
    expect(cases.length).toBeGreaterThan(20)
    let checked = 0
    // 同じ版の話題は同じ辞書（版ごとに1つ作る）
    const made = new Map<unknown, Dictionary>()
    for (const c of cases) {
      let d = made.get(c.ctx.dict)
      if (!d) {
        d = dict().d
        d.apply([...c.ctx.dict.values()], false)
        made.set(c.ctx.dict, d)
      }
      const full = assembleTopic(c.input, c.ctx)
      const part = assembleTopic(c.input, { ...c.ctx, dict: d.forInput(c.input) })
      expect(part).toEqual(full)
      expect(part.errors).toEqual([])
      checked += 1
    }
    expect(checked).toBe(cases.length)
  })

  it('添え字だけ違う語（与党（日本）・与党（米国））: 表記で指すと2つに当たり、termId で指せる。重なりの確かめも同じ', () => {
    const { d } = dict()
    const jp = entry(RULING_JP_KEY, 1)
    const us = entry(RULING_US_KEY, 1)
    d.apply([jp, us, entry('〇〇法', 1)])
    const full = new Map([jp, us, entry('〇〇法', 1)].map((e) => [e.termId, e]))
    const sub = d.subsetFor({ forms: ['与党'] })
    expect([...sub.keys()].sort()).toEqual([jp.termId, us.termId].sort())
    // 当たった語の並びは辞書の順（部分の辞書は引いた順）なので、並べてから比べる
    const sorted = (r: ReturnType<typeof resolveTermRef>) => (r.ok ? r : { ...r, matches: [...r.matches].sort() })
    expect(sorted(resolveTermRef({ term: '与党' }, sub))).toEqual(sorted(resolveTermRef({ term: '与党' }, full)))
    expect(resolveTermRef({ term: '与党' }, sub)).toMatchObject({ ok: false, reason: 'ambiguous' })
    expect(resolveTermRef({ termId: jp.termId }, d.subsetFor({ termIds: [jp.termId] }))).toEqual(
      resolveTermRef({ termId: jp.termId }, full),
    )
    // 別の語が同じ表記（別名）を持つのは断る（部分の辞書でも同じ）
    const clash = entry('△△協定', 1, { aliases: ['〇〇法'] })
    expect(termOverlapProblems([clash], d.subsetFor({ entries: [clash] }))).toEqual(termOverlapProblems([clash], full))
    expect(termOverlapProblems([clash], d.subsetFor({ entries: [clash] }))).toHaveLength(1)
  })
})

describe('作り直し（別の表。日をまたいで）', () => {
  it('作り直しの間は今の表で引け、届いた束は両方に当てる。終わったら入れ替える', () => {
    const { store, d } = dict()
    d.apply([entry('〇〇法', 1), entry('△△制度', 1)])
    d.startRebuild(1)
    expect(d.rebuilding()).toBe(true)
    expect(store.termCount(true)).toBe(0)
    // 作り直しの1ページ目（△△制度の束は無くなった）
    expect(d.rebuildApply([{ name: 'n1', entries: [entry('〇〇法', 1)] }], 'n1')).toBe(true)
    expect(d.idsOfForm('△△制度')).toEqual([termIdOf('△△制度')])
    // 作り直しの間に届いた束は両方に当たる
    d.apply([entry('□□計画', 1)])
    expect(store.getTerm(termIdOf('□□計画'), true)).not.toBeNull()
    d.finishRebuild()
    expect(d.rebuilding()).toBe(false)
    expect(d.idsOfForm('△△制度')).toEqual([])
    expect(
      store
        .allTerms()
        .map((e) => e.key)
        .sort(),
    ).toEqual(['〇〇法', '□□計画'].sort())
    expect(store.termCount(true)).toBe(0)
  })
})
