// 照合の直す所を当てる（段階3の設計の 1.5 の DraftPatch・7. の「単体（ルート）」）: find が2回出る・無い時は断る・行を消すと語句も消える・
// claim を null にすると4つがそろう・当てた後に外れた語句・見解と対立見解の数で断る・全部か無しか・subject・area の数え。
// 作り物の話題（src/test/fixtures/sampleTopic.ts）の入力に当て、組み立て（src/domain/assemble.ts）で確かめる
import { describe, expect, it } from 'vitest'
import { fakeAssembleContextOf, fakeDictOfTopic, fakeInputOf } from '../test/fixtures/fakeInputs'
import { makeSampleTopic } from '../test/fixtures/sampleTopic'
import { assembleTopic } from './assemble'
import { PATCHES_MAX, type DraftPatch, type TermRefInput, type TopicDraftInput } from './input'
import { applyPatches } from './patch'
import { resolveTermRef } from './terms'

const sample = makeSampleTopic((t) => (t.outletNames = ['〇〇通信', '◇◇日報']))
const dict = fakeDictOfTopic(sample)
const { input, materials } = fakeInputOf(sample, dict)
const ctx = fakeAssembleContextOf(sample, materials, { dict })
const assemble = (i: TopicDraftInput) => assembleTopic(i, ctx)
const termEntry = (ref: TermRefInput) => {
  if ('new' in ref || 'revise' in ref) return null
  const r = resolveTermRef(ref, dict)
  return r.ok ? r.entry : null
}
const apply = (patches: DraftPatch[]) => applyPatches(input, patches, { termEntry })
const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code)

describe('照合の直す所: 文の置き換え', () => {
  it('find はその欄に1回だけ出る物を置き換える（入力は変えない）', () => {
    const before = JSON.stringify(input)
    const r = apply([{ path: 'summary', find: '320メートル', to: '330メートル', why: 'number' }])
    expect(r.ok).toBe(true)
    expect(r.input.summary).toBe(sample.summary.replace('320メートル', '330メートル'))
    expect(r.fixed).toBe(1)
    expect(r.why).toEqual({ number: 1 })
    expect(JSON.stringify(input)).toBe(before)
    expect(assemble(r.input).errors).toEqual([])
  })

  it('find が欄に無い・2回出る・空の時は断り、何も当てない', () => {
    const missing = apply([{ path: 'summary', find: '無い語句', to: 'x', why: 'other' }])
    expect([missing.ok, codes(missing)]).toEqual([false, ['patch:not-found']])
    expect(missing.input).toBe(input)
    const twice = apply([{ path: 'summary', find: '市', to: '町', why: 'other' }])
    expect(codes(twice)).toEqual(['patch:ambiguous'])
    expect(codes(apply([{ path: 'summary', find: '', to: 'x', why: 'other' }]))).toEqual(['patch:value'])
  })

  it('全部当たるか、何も当てない（1つでも断れば、ほかの直す所も当てない）', () => {
    const r = apply([
      { path: 'summary', find: '320メートル', to: '330メートル', why: 'number' },
      { path: 'headline', find: '無い語句', to: 'x', why: 'other' },
    ])
    expect(r.ok).toBe(false)
    expect(r.input).toBe(input)
    expect(r.fixed).toBe(0)
    expect(r.errors[0].path).toBe('patches.1')
  })

  it('文を直した欄で、文に無くなった強調の語句は外して返す（ほかの欄の語句は残す）', () => {
    const r = apply([{ path: 'summary', find: '15日に開通', to: '16日に開通', why: 'date' }])
    expect(r.ok).toBe(true)
    expect(r.droppedEmphasis).toEqual([{ path: 'emphasis.summary', phrase: '15日に開通' }])
    expect(r.input.emphasis?.summary).toEqual(['通行料はまだ決まっていない'])
    expect(r.input.emphasis?.['soWhat.life']).toEqual(input.emphasis?.['soWhat.life'])
    expect(assemble(r.input).errors).toEqual([])
  })

  it('外した結果、AI の見解と対立見解の強調の数が違えば、何も当てずに「強調も直してください」', () => {
    if (input.view.kind !== 'opposed') throw new Error('作り物の話題は対立見解あり')
    const phrase = (input.emphasis?.['view.aiView'] ?? [])[0]
    const r = apply([{ path: 'view.aiView', find: phrase, to: '別の言い方', why: 'overstate' }])
    expect(r.ok).toBe(false)
    expect(codes(r)).toEqual(['patch:view-count'])
    expect(r.errors[0].message).toContain('強調も直してください（view.aiView と view.counterView の数をそろえる')
    // 強調も直せば当たる
    const fixed = apply([
      { path: 'view.aiView', find: phrase, to: '別の言い方', why: 'overstate' },
      { path: 'view.aiView', emphasis: ['別の言い方'] },
    ])
    expect(fixed.ok).toBe(true)
    expect(fixed.fixed).toBe(1)
    expect(assemble(fixed.input).errors).toEqual([])
  })
})

describe('照合の直す所: 決まった値・消す・足す', () => {
  it('stakeholders.n.claim を null にすると、立場・補足・理由もそろい、主張の強調も外れる', () => {
    const r = apply([{ path: 'stakeholders.0.claim', set: null, why: 'notInSource' }])
    expect(r.ok).toBe(true)
    expect(r.input.stakeholders[0]).toEqual({
      name: input.stakeholders[0].name,
      stance: 'unknown',
      stanceNote: null,
      claim: null,
      reason: null,
    })
    expect(r.droppedEmphasis.map((d) => d.path)).toEqual(['stakeholders.0.claimEmphasis'])
    const a = assemble(r.input)
    expect(a.errors).toEqual([])
    expect(a.topic?.stakeholders[0]).toMatchObject({ stance: 'unknown', claim: null })
  })

  it('決まった値・null にする（conclusion.label・soWhat.life）', () => {
    const r = apply([
      { path: 'conclusion.label', set: 'unsettled', why: 'overstate' },
      { path: 'soWhat.life', set: null, why: 'notInSource' },
    ])
    expect(r.ok).toBe(true)
    expect(r.input.conclusion.label).toBe('unsettled')
    expect(r.input.soWhat.life).toBeNull()
    expect(r.droppedEmphasis).toEqual([{ path: 'emphasis.soWhat.life', phrase: '時間が短くなる見込み' }])
  })

  it('並びの要素を消すと、その要素の強調も一緒に消える。番号は当てる前の入力の番号', () => {
    const r = apply([
      { path: 'timeline.0', remove: true, why: 'notInSource' },
      { path: 'timeline.1.text', find: '新しい橋が開通した', to: '新しい橋が開通した（予定より1日早く）', why: 'date' },
      { path: 'stakeholders.1', remove: true, why: 'quote' },
    ])
    expect(r.ok).toBe(true)
    expect(r.input.timeline.map((e) => e.text)).toEqual(
      input.timeline.slice(1).map((e, i) => (i === 0 ? e.text.replace('開通した', '開通した（予定より1日早く）') : e.text)),
    )
    expect(r.input.stakeholders.map((s) => s.name)).toEqual(input.stakeholders.filter((_, i) => i !== 1).map((s) => s.name))
    const a = assemble(r.input)
    expect(a.topic?.emphasis['timeline.0.text']).toEqual(['新しい橋が開通した'])
    expect(a.topic?.emphasis['stakeholders.1.claim']).toEqual(sample.emphasis['stakeholders.2.claim'])
    expect(r.fixed).toBe(3)
  })

  it('前の要素を消す時も、文を直した要素の文に無くなった強調の語句を外す（道は当てる前の入力の番号）', () => {
    const r = apply([
      { path: 'timeline.0', remove: true, why: 'notInSource' },
      { path: 'timeline.1.text', find: '新しい橋が開通した', to: '橋の通行が始まった', why: 'other' },
    ])
    expect(r.ok).toBe(true)
    expect(r.droppedEmphasis).toEqual([{ path: 'timeline.1.emphasis', phrase: '新しい橋が開通した' }])
    expect(r.input.timeline[0].emphasis).toBeUndefined()
    // 消した要素の後ろの、直していない要素の強調はそのまま
    expect(r.input.timeline.slice(1).map((e) => e.emphasis)).toEqual(input.timeline.slice(2).map((e) => e.emphasis))
    expect(assemble(r.input).errors).toEqual([])
  })

  it('消す要素の中を直す物は、直す所の順に関わらず断る。同じ要素を2回消すのも断る', () => {
    const later = apply([
      { path: 'timeline.1.text', find: '新しい橋', to: '橋', why: 'other' },
      { path: 'timeline.1', remove: true, why: 'other' },
    ])
    expect(codes(later)).toEqual(['patch:conflict'])
    expect(
      codes(
        apply([
          { path: 'timeline.1', remove: true, why: 'other' },
          { path: 'timeline.1', remove: true, why: 'other' },
        ]),
      ),
    ).toEqual(['patch:conflict'])
  })

  it('出典は消すだけ（消すと outletNames も組み立て直る）。ref・社は替えられない', () => {
    const r = apply([{ path: 'sources.1', remove: true, why: 'notInSource' }])
    expect(r.ok).toBe(true)
    expect(assemble(r.input).topic?.outletNames).toEqual(['〇〇通信'])
    expect(codes(apply([{ path: 'sources.0.ref', set: 'c9999', why: 'other' }]))).toEqual(['patch:path'])
    expect(codes(apply([{ path: 'sources.0.outlet', set: '△△新聞', why: 'other' }]))).toEqual(['patch:path'])
  })

  it('確かめられなかった点を足す（unverified だけ）', () => {
    const r = apply([{ path: 'unverified', add: '開通の式の日時は確かめられなかった', why: 'notInSource' }])
    expect(r.input.unverified.at(-1)).toBe('開通の式の日時は確かめられなかった')
    expect(codes(apply([{ path: 'timeline', add: 'x', why: 'other' } as unknown as DraftPatch]))).toEqual(['patch:path'])
  })

  it('並びの要素・まとまりを set で入れ替えるのは断る（null にできるのは followUp などの欄）', () => {
    expect(codes(apply([{ path: 'stakeholders.0', set: null, why: 'other' }]))).toEqual(['patch:path'])
    expect(codes(apply([{ path: 'conclusion', set: 'x', why: 'other' }]))).toEqual(['patch:path'])
    expect(codes(apply([{ path: 'summary', set: { a: 1 }, why: 'other' }]))).toEqual(['patch:value'])
    expect(codes(apply([{ path: 'id', set: 'x', why: 'other' }]))).toEqual(['patch:path'])
    expect(codes(apply([{ path: 'nothing.here', set: 'x', why: 'other' }]))).toEqual(['patch:path'])
  })

  it('null にできるまとまりは followUp だけ。並び（用語・当事者・経緯）を丸ごと替える・無い欄を足すのも断る（投げずに断る）', () => {
    const withNew: TopicDraftInput = {
      ...input,
      terms: [...input.terms, { new: { key: '新語', term: '新語', aliases: [], explanation: '説明です。', asOf: null } }],
    }
    const n = input.terms.length
    for (const patch of [
      { path: 'view', set: null },
      { path: 'conclusion', set: null },
      { path: 'soWhat', set: null },
      { path: `terms.${n}.new`, set: null },
      { path: 'terms', set: ['x'] },
      { path: 'stakeholders', set: [] },
      { path: 'timeline', set: ['x'] },
      { path: 'conclusion.extra', set: 'x' },
      { path: 'summary', set: ['x'] },
    ] as const) {
      const r = applyPatches(withNew, [{ ...patch, why: 'other' }], { termEntry })
      expect([patch.path, codes(r)]).toEqual([patch.path, ['patch:path']])
      expect(r.input).toBe(withNew)
    }
    // 続報でなくする・確かめられなかった点・別名の並びは替えられる
    const ok = applyPatches(
      withNew,
      [
        { path: 'unverified', set: ['確かめられなかった点（作り物）'], why: 'other' },
        { path: `terms.${n}.aliases`, set: ['新しい語'], why: 'term' },
      ],
      { termEntry },
    )
    expect(ok.ok).toBe(true)
    expect(ok.input.unverified).toEqual(['確かめられなかった点（作り物）'])
    expect(ok.input.terms[n]).toMatchObject({ new: { aliases: ['新しい語'] } })
  })
})

describe('照合の直す所: 強調・用語・数え', () => {
  it('強調の入れ替えは直した数に数えない（要素ごとの道・入力の道のどちらでも）', () => {
    const r = apply([
      { path: 'summary', emphasis: ['15日に開通'] },
      { path: 'stakeholders.0.claimEmphasis', emphasis: [] },
    ])
    expect(r.ok).toBe(true)
    expect(r.fixed).toBe(0)
    expect(r.input.emphasis?.summary).toEqual(['15日に開通'])
    expect(r.input.stakeholders[0].claimEmphasis).toBeUndefined()
    expect(codes(apply([{ path: 'headline', emphasis: ['x'] }]))).toEqual(['patch:path'])
  })

  it('辞書の語の説明を直すと、新しい説明（rev ＋1）の指し方に替わる', () => {
    const t0 = sample.terms[0]
    const r = apply([{ path: 'terms.0.explanation', find: t0.explanation, to: '正しい説明（作り物）です。', why: 'term' }])
    expect(r.ok).toBe(true)
    expect(r.input.terms[0]).toEqual({ termId: t0.termId, revise: { explanation: '正しい説明（作り物）です。', asOf: t0.asOf } })
    const a = assemble(r.input)
    expect(a.errors).toEqual([])
    expect(a.termEntries).toEqual([{ ...dict.get(t0.termId), explanation: '正しい説明（作り物）です。', rev: 2 }])
    expect(a.topic?.terms[0].explanation).toBe('正しい説明（作り物）です。')
  })

  it('下書きの中の新しい語の説明は、その文を直す', () => {
    const withNew: TopicDraftInput = {
      ...input,
      terms: [...input.terms, { new: { key: '新語', term: '新語', aliases: [], explanation: '誤った説明です。', asOf: null } }],
    }
    const r = applyPatches(withNew, [
      { path: `terms.${input.terms.length}.explanation`, find: '誤った', to: '正しい', why: 'term' },
    ])
    expect(r.ok).toBe(true)
    expect(r.input.terms.at(-1)).toEqual({
      new: { key: '新語', term: '新語', aliases: [], explanation: '正しい説明です。', asOf: null },
    })
  })

  it('辞書を引けない時の用語の説明の直しは断る', () => {
    const r = applyPatches(input, [{ path: 'terms.0.explanation', find: 'の', to: 'が', why: 'term' }])
    expect(codes(r)).toEqual(['patch:term'])
  })

  it('直した訳の種類ごとに数える（主体 subject・区域 area を含む）。知らない訳は断る', () => {
    const r = apply([
      { path: 'summary', find: '320メートル', to: '330メートル', why: 'number' },
      { path: 'headline', find: '見通しを示す', to: '見通しを示したとしている', why: 'subject' },
      { path: 'soWhat.system', set: null, why: 'area' },
      { path: 'unverified', add: '区域は確かめられなかった', why: 'area' },
    ])
    expect(r.ok).toBe(true)
    expect(r.why).toEqual({ number: 1, subject: 1, area: 2 })
    expect(r.fixed).toBe(4)
    expect(codes(apply([{ path: 'summary', find: '320', to: '330', why: 'guess' } as unknown as DraftPatch]))).toEqual([
      'patch:why',
    ])
  })

  it(`直す所は1回に${PATCHES_MAX}まで`, () => {
    const many = Array.from({ length: PATCHES_MAX + 1 }, () => ({ path: 'summary', emphasis: ['15日に開通'] }))
    expect(codes(applyPatches(input, many))).toEqual(['patch:count'])
  })
})
