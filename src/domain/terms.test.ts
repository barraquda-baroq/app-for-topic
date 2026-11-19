// 辞書の今の形と表記の重なり（docs/SPEC.md の 7.3・段階3の設計の 1.5）: 語ごとに rev のいちばん大きい物・外した語は外す・束の順に左右されない、
// 表記は key の添え字を除いた形・term・別名をそろえた物、key の括弧の添え字だけ違う語どうしの重なりは通し、別名が当たるのは断る、
// termId か表記で引く（表記が2つ以上に当たれば ambiguous）。語は作り物（A 党・〇〇市）
import { describe, expect, it } from 'vitest'
import { termIdOf } from './ids'
import {
  applyPack,
  dictionaryOf,
  keyBaseOf,
  liveTerms,
  newerTermEntry,
  resolveTermRef,
  termFormsOf,
  termOverlapProblems,
} from './terms'
import type { TermEntry } from './types'

const entry = (key: string, over: Partial<TermEntry> = {}): TermEntry => ({
  termId: termIdOf(key),
  key,
  term: key.replace(/（.*）$/, ''),
  aliases: [],
  explanation: `${key}の説明（作り物）`,
  asOf: null,
  rev: 1,
  ...over,
})

describe('辞書の今の形', () => {
  it('語ごとに rev のいちばん大きい物。束の順に左右されない', () => {
    const a1 = entry('A 党')
    const a2 = entry('A 党', { explanation: '新しい説明', asOf: '2026-11', rev: 2 })
    const b = entry('〇〇市')
    const forward = dictionaryOf([{ entries: [a1, b] }, { entries: [a2] }])
    const backward = dictionaryOf([{ entries: [a2] }, { entries: [a1, b] }])
    expect(forward.get(a1.termId)).toEqual(a2)
    expect([...backward.entries()].sort()).toEqual([...forward.entries()].sort())
    expect(forward.size).toBe(2)
  })

  it('同じ rev なら外した物、それも同じなら中身で決める（どの順でも同じ）', () => {
    const live = entry('A 党', { rev: 3 })
    const retired = entry('A 党', { rev: 3, retired: true })
    expect(newerTermEntry(live, retired)).toBe(retired)
    expect(newerTermEntry(retired, live)).toBe(retired)
    const x = entry('A 党', { explanation: '説明あ', rev: 2 })
    const y = entry('A 党', { explanation: '説明い', rev: 2 })
    expect(newerTermEntry(x, y)).toBe(newerTermEntry(y, x))
  })

  it('外した語は今の語に出ない（rev の大きい外す印が、後から届いた古い説明に勝つ）', () => {
    const a1 = entry('A 党')
    const gone = entry('A 党', { rev: 2, retired: true })
    const dict = applyPack(applyPack(new Map(), [gone]), [a1])
    expect(dict.get(a1.termId)).toEqual(gone)
    expect(liveTerms(dict)).toEqual([])
  })

  it('applyPack は辞書を変えない', () => {
    const dict = dictionaryOf([{ entries: [entry('A 党')] }])
    const before = [...dict.entries()]
    applyPack(dict, [entry('B 党')])
    expect([...dict.entries()]).toEqual(before)
  })
})

describe('表記', () => {
  it('key の括弧の添え字を除いた形・term・別名を、全角と半角・大文字・空白をそろえて', () => {
    expect(keyBaseOf('与党（日本）')).toBe('与党')
    expect(keyBaseOf('与党 (米国)')).toBe('与党')
    expect(keyBaseOf('A 党')).toBe('a 党')
    expect(keyBaseOf('（注）')).toBe('(注)')
    expect(termFormsOf(entry('与党（日本）', { aliases: ['政権与党', 'ＡＢＣ'] }))).toEqual(['与党', '政権与党', 'abc'])
  })

  it('key の括弧の添え字だけ違う語どうしの重なりは通す', () => {
    const dict = dictionaryOf([{ entries: [entry('与党（日本）')] }])
    expect(termOverlapProblems([entry('与党（米国）')], dict)).toEqual([])
    expect(termOverlapProblems([entry('与党')], dict)).toEqual([])
  })

  it('別名が、ほかの語の表記に当たるのは断る（辞書の語・同じ束の語とも）', () => {
    const dict = dictionaryOf([{ entries: [entry('A 党')] }])
    const leader = entry('A 党の代表', { aliases: ['a 党'] })
    const problems = termOverlapProblems([leader], dict)
    expect(problems.map((p) => [p.termId, p.form, p.other.termId])).toEqual([[leader.termId, 'a 党', termIdOf('A 党')]])
    expect(problems[0].message).toContain('「a 党」')
    // 同じ束の中の2語
    const x = entry('〇〇市', { aliases: ['市'] })
    const y = entry('△△市', { aliases: ['市'] })
    expect(termOverlapProblems([x, y], new Map())).toHaveLength(1)
  })

  it('説明を新しくする語は、辞書の古い物と比べない。外した語・外す語は数えない', () => {
    const a1 = entry('A 党')
    const dict = dictionaryOf([{ entries: [a1, entry('B 党', { aliases: ['党'], retired: true })] }])
    expect(termOverlapProblems([{ ...a1, explanation: '新しい説明', rev: 2 }], dict)).toEqual([])
    expect(termOverlapProblems([entry('C 党', { aliases: ['党'] })], dict)).toEqual([])
    expect(termOverlapProblems([entry('D 党', { aliases: ['a 党'], retired: true })], dict)).toEqual([])
  })
})

describe('語の指し方', () => {
  const japan = entry('与党（日本）')
  const us = entry('与党（米国）')
  const party = entry('A 党', { aliases: ['A'] })
  const gone = entry('B 党', { retired: true })
  const dict = dictionaryOf([{ entries: [japan, us, party, gone] }])

  it('termId で引く（表記を添えると、その語の表記かも見る）', () => {
    expect(resolveTermRef({ termId: party.termId }, dict)).toEqual({ ok: true, entry: party })
    expect(resolveTermRef({ termId: party.termId, term: 'Ａ' }, dict)).toEqual({ ok: true, entry: party })
    expect(resolveTermRef({ termId: party.termId, term: '〇〇' }, dict)).toMatchObject({ ok: false, reason: 'not-a-form' })
    expect(resolveTermRef({ termId: 'tzzzzzzzzzzzz' }, dict)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(resolveTermRef({ termId: gone.termId }, dict)).toMatchObject({ ok: false, reason: 'retired' })
  })

  it('表記で引く（2つ以上に当たれば ambiguous、外した語は当たらない）', () => {
    expect(resolveTermRef({ term: ' a 党 ' }, dict)).toEqual({ ok: true, entry: party })
    const r = resolveTermRef({ term: '与党' }, dict)
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' })
    expect(!r.ok && [...r.matches].sort()).toEqual([japan.termId, us.termId].sort())
    expect(resolveTermRef({ term: 'B 党' }, dict)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(resolveTermRef({ term: '' }, dict)).toMatchObject({ ok: false, reason: 'not-found' })
  })
})
