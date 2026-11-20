// 照合の結果を当てる（設計の 1.2 の 13・1.5 の「照合の直す所の形」・4.7。vault/drafts.ts の checkDraft・tools/drafts.ts）: 全部当たるか
// 何も当てない・当てた後に組み立て直して確かめる・外れた強調の語句を知らせる・見解と対立見解の数で断る・主張を null にすると4つがそろう・
// 用語の説明を直すと新しい説明（rev ＋1）になり、同じ回のほかの下書きも同じ説明になる・この話題での表記（別名）が落ちない（B1 の open）・
// 同じ回の revise の取り合い（置く時は先の方、照合で直した時は直した方）・読む前の照合を断る・5回まで・照合で外す・直した訳の数え・
// 確かめが早すぎる下書き。作り物だけ（〇〇省・example.com・fake-checker-model）
import { describe, expect, it } from 'vitest'
import { termIdOf } from '../../../src/domain/ids'
import type { TermEntry } from '../../../src/domain/types'
import { buildDraft, CHECKS_PER_DRAFT, inputOf } from '../../src/vault/drafts'
import { CHECKER, draftInput, draftSetup, newTerm, placeVerified, seedMaterial, WRITER } from '../support/drafts'
import { OWNER } from '../support/harness'

const KEY = '作り物の制度'
const ENTRY: TermEntry = {
  termId: termIdOf(KEY),
  key: KEY,
  term: KEY,
  aliases: ['作り物の仕組み'],
  explanation: '作り物の制度の古い説明',
  asOf: '2026-10',
  rev: 2,
}

async function setup(n = 3) {
  const s = await draftSetup()
  for (let i = 1; i <= n; i++) seedMaterial(s.core, s.runId, i)
  const save = async (i: number, over: Parameters<typeof draftInput>[1] = {}) => {
    const r = await s.call('topic_save_draft', { model: WRITER, topic: draftInput(i, over) })
    if (r.isError) throw new Error(r.text)
    return /(d:\d{2})/.exec(r.text)![1]
  }
  const check = (draft: string, patches: unknown[], extra: Record<string, unknown> = {}) =>
    s.call('topic_check_draft', { draft, model: CHECKER, claims: 5, patches, ...extra })
  return { ...s, save, check }
}

describe('照合の直す所を当てる（topic_check_draft）', () => {
  it('当てて組み立て直し、照合済みにする。当てた数・照合の件数・直した訳の数え。置いてすぐの照合は「確かめが早すぎる」', async () => {
    const { core, runId, call, save, check, clock } = await setup()
    const id = await save(1)
    await call('topic_get_draft', { draft: id })
    const r = await check(id, [
      { path: 'summary', find: '2割ほど', to: '3割ほど', why: 'number' },
      { path: 'conclusion.note', find: '橋の長さは決まり', to: '橋の長さは市が決め', why: 'subject' },
    ])
    expect(r.isError, r.text).toBeUndefined()
    expect(r.text).toContain(`照合済みにしました: ${id}（当てた数 2・照合した主張 5件）`)
    expect(r.text).toContain('置いてから2分たたずに照合済みになりました')
    expect(r.text).toContain('照合済み 1本（数の門の5本まであと 4本）')
    expect(r.structured).toEqual({ created: [{ id, label: '順位 1・照合済み' }], skipped: [] })
    const row = core.store.draft(runId, id)!
    expect(row).toMatchObject({ status: 'verified', claims: 5, fixed: 2, checkModel: CHECKER, checks: 1 })
    expect(inputOf(row).summary).toContain('3割ほど')
    expect(core.store.runCounts(runId, 'why:')).toEqual({ 'why:number': 1, 'why:subject': 1 })
    expect(core.store.runCount(runId, 'early')).toBe(1)
    // 2分より後の照合は数えない
    const id2 = await save(2)
    await call('topic_get_draft', { draft: id2 })
    clock.now += 3 * 60_000
    const later = await check(id2, [])
    expect(later.text).not.toContain('2分たたずに')
    expect(core.store.runCount(runId, 'early')).toBe(1)
    // 照合済みの下書きにもう一度は当てない
    expect((await check(id2, [])).text).toContain('は照合済みです')
    // 置き換えた下書きは、置き換えた時から数え直す（前に置いた時刻で2分を越えない）
    const id3 = await save(3)
    clock.now += 5 * 60_000
    const replaced = await call('topic_save_draft', {
      model: WRITER,
      replace: id3,
      topic: draftInput(3, { rankReason: '置き換えた作り物の理由' }),
    })
    expect(replaced.text).toContain(`下書きを置き換えました: ${id3}`)
    await call('topic_get_draft', { draft: id3 })
    expect((await check(id3, [])).text).toContain('置いてから2分たたずに照合済みになりました')
    expect(core.store.runCount(runId, 'early')).toBe(2)
  })

  it('全部当たる時だけ当てる（1つでも当たらなければ何も当てない）。断られた分も照合の回数に数え、5回まで', async () => {
    const { core, runId, call, save, check } = await setup()
    const id = await save(1)
    await call('topic_get_draft', { draft: id })
    const r = await check(id, [
      { path: 'summary', find: '2割ほど', to: '3割ほど', why: 'number' },
      { path: 'summary', find: '作り物に無い文', to: '…', why: 'number' },
    ])
    expect(r.isError).toBe(true)
    expect(r.text).toContain('何も当てていません')
    expect(r.text).toContain('「作り物に無い文」が欄の文にありません')
    expect(inputOf(core.store.draft(runId, id)!).summary).toContain('2割ほど')
    expect(core.store.draft(runId, id)!.status).toBe('pending')
    for (let i = 1; i < CHECKS_PER_DRAFT; i++) await check(id, [{ path: 'summary', find: '無い', to: '…', why: 'other' }])
    const over = await check(id, [])
    expect(over.text).toContain(`照合は${CHECKS_PER_DRAFT}回までです`)
    expect(core.store.draft(runId, id)!.checks).toBe(CHECKS_PER_DRAFT)
  })

  it('直した文に資料の印の文字列（<<< >>>）を入れる直す所は断る', async () => {
    const { core, runId, call, save, check } = await setup()
    const id = await save(1)
    await call('topic_get_draft', { draft: id })
    const r = await check(id, [{ path: 'summary', find: '2割ほど', to: '>>>作り物', why: 'other' }])
    expect(r.isError).toBe(true)
    expect(r.text).toContain('summary: 資料の印の文字列')
    expect(core.store.draft(runId, id)!.status).toBe('pending')
  })

  it('文を直して外れた強調の語句を知らせる。見解と対立見解の強調の数がずれる時は何も当てない', async () => {
    const { call, save, check } = await setup()
    const id = await save(1)
    await call('topic_get_draft', { draft: id })
    const dropped = await check(id, [{ path: 'summary', find: '320メートル', to: '330メートル', why: 'number' }])
    expect(dropped.text).toContain('文を直したので外した強調の語句: emphasis.summary「320メートル」')
    const opposed = await save(2, {
      view: {
        kind: 'opposed',
        axis: '作り物の軸',
        issue: null,
        aiView: '作り物の見解で、渋滞が減る見通しは大きいと考えます。',
        counterView: '作り物の対立見解で、費用の重さを先に見るべきだと考えます。',
      },
      emphasis: { summary: ['320メートル'], 'view.aiView': ['渋滞が減る見通し'], 'view.counterView': ['費用の重さ'] },
    })
    await call('topic_get_draft', { draft: opposed })
    const r = await check(opposed, [{ path: 'view.aiView', find: '渋滞が減る見通し', to: '渋滞の見通し', why: 'overstate' }])
    expect(r.isError).toBe(true)
    expect(r.text).toContain('強調も直してください（view.aiView と view.counterView の数をそろえる')
  })

  it('主張を null にすると、立場は unknown、補足と理由は null にそろう。claims は直した数より少なくできない', async () => {
    const { core, runId, call, save, check } = await setup()
    const id = await save(1, {
      stakeholders: [
        { name: '〇〇市', stance: 'for', stanceNote: '作り物の補足', claim: '作り物の主張', reason: '作り物の理由' },
      ],
    })
    await call('topic_get_draft', { draft: id })
    const few = await check(id, [{ path: 'stakeholders.0.claim', set: null, why: 'notInSource' }], { claims: 0 })
    expect(few.text).toContain('claims（照合した主張の件数）は、直した数（1）より少なくできません')
    const r = await check(id, [{ path: 'stakeholders.0.claim', set: null, why: 'notInSource' }])
    expect(r.isError, r.text).toBeUndefined()
    expect(inputOf(core.store.draft(runId, id)!).stakeholders[0]).toEqual({
      name: '〇〇市',
      stance: 'unknown',
      stanceNote: null,
      claim: null,
      reason: null,
    })
  })

  it('照合で外す（reject）: 版に入れない。持ち主の新しい語は、ほかの下書きが使っていなければ消す', async () => {
    const { core, runId, call, save, check } = await setup()
    const a = await save(1, { terms: [newTerm('作り物の外す語')] })
    await call('topic_get_draft', { draft: a })
    const r = await check(a, [], { reject: '元の資料で数字を確かめられない' })
    expect(r.text).toContain(`${a} を照合で外しました（版には入れません）`)
    expect(core.store.draft(runId, a)).toMatchObject({ status: 'rejected', rejectReason: '元の資料で数字を確かめられない' })
    expect(core.store.runTerms(runId)).toEqual([])
    expect(core.store.runCount(runId, 'rejected')).toBe(1)
    const list = await call('topic_list_drafts')
    expect(list.text).toContain('照合で外した（訳: 元の資料で数字を確かめられない）')
  })
})

describe('用語の説明を照合で直す（同じ回の語）', () => {
  it('辞書の語の説明を直すと新しい説明（rev ＋1）になり、この話題の表記（別名）は残る（B1 の open）', async () => {
    const { core, runId, call, save, check } = await setup()
    core.dictionary.apply([ENTRY], false)
    const id = await save(1, { terms: [{ termId: ENTRY.termId, term: '作り物の仕組み' }] })
    await call('topic_get_draft', { draft: id })
    const r = await check(id, [{ path: 'terms.0.explanation', find: '古い説明', to: '新しい説明', why: 'term' }])
    expect(r.isError, r.text).toBeUndefined()
    expect(core.store.runTerms(runId)).toEqual([
      { entry: expect.objectContaining({ termId: ENTRY.termId, explanation: '作り物の制度の新しい説明', rev: 3 }), draft: id },
    ])
    const row = core.store.draft(runId, id)!
    const b = buildDraft(core, core.store.getRun(runId)!, id, inputOf(row), { now: core.now(), follow: true, model: WRITER })
    expect(b.result.errors).toEqual([])
    expect(b.result.topic!.terms).toEqual([
      expect.objectContaining({ termId: ENTRY.termId, term: '作り物の仕組み', explanation: '作り物の制度の新しい説明' }),
    ])
  })

  it('同じ回の revise の取り合い: 置く時は先に置いた方が勝つ。照合で直した説明が、その回の説明になり、ほかの下書きも合わせる', async () => {
    const { core, runId, call, save, check, clock } = await setup()
    core.dictionary.apply([ENTRY], false)
    const a = await save(1, { terms: [{ termId: ENTRY.termId, revise: { explanation: '作り物の説明 A', asOf: '2026-11' } }] })
    // 別の説明で新しくする下書きは、置く時に断る（termId で指す）
    const refused = await call('topic_save_draft', {
      model: WRITER,
      topic: draftInput(2, { terms: [{ termId: ENTRY.termId, revise: { explanation: '作り物の説明 B', asOf: '2026-11' } }] }),
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('別の説明に新しくしています')
    const b = await save(2, { terms: [{ termId: ENTRY.termId }] })
    // b の照合の係が説明を直す → その回の語の持ち主が b に移る
    await call('topic_get_draft', { draft: b })
    clock.now += 3 * 60_000
    const r = await check(b, [{ path: 'terms.0.explanation', find: '説明 A', to: '説明 C', why: 'term' }])
    expect(r.isError, r.text).toBeUndefined()
    expect(core.store.runTerms(runId)).toEqual([
      { entry: expect.objectContaining({ explanation: '作り物の説明 C', rev: 3 }), draft: b },
    ])
    // a は、その回の説明（C）に合わせて読める・照合できる
    const shown = await call('topic_get_draft', { draft: a })
    expect(shown.text).toContain('同じ回の d:02 の下書きの語（説明: 作り物の説明 C')
    const ra = await check(a, [])
    expect(ra.isError, ra.text).toBeUndefined()
    const built = buildDraft(core, core.store.getRun(runId)!, a, inputOf(core.store.draft(runId, a)!), {
      now: core.now(),
      follow: true,
      model: WRITER,
    })
    expect(built.result.topic!.terms[0]).toMatchObject({ explanation: '作り物の説明 C' })
  })

  it('同じ回で足すだけの語の説明を、ほかの下書きの照合で直すと、新しい語として持ち主が移る', async () => {
    const { core, runId, call, save, check, clock } = await setup()
    const t = termIdOf('作り物の新しい語')
    const a = await save(1, { terms: [newTerm('作り物の新しい語', '作り物の語の説明 A')] })
    const b = await save(2, { terms: [{ termId: t }] })
    await call('topic_get_draft', { draft: b })
    clock.now += 3 * 60_000
    const r = await check(b, [{ path: 'terms.0.explanation', find: '説明 A', to: '説明 B', why: 'term' }])
    expect(r.isError, r.text).toBeUndefined()
    expect(core.store.runTerms(runId)).toEqual([
      { entry: expect.objectContaining({ termId: t, explanation: '作り物の語の説明 B', rev: 1 }), draft: b },
    ])
    expect(inputOf(core.store.draft(runId, b)!).terms[0]).toMatchObject({
      new: { key: '作り物の新しい語', explanation: '作り物の語の説明 B' },
    })
    await call('topic_get_draft', { draft: a })
    const ra = await check(a, [])
    expect(ra.isError, ra.text).toBeUndefined()
  })

  it('束を書いた後に、別の下書きが同じ語を別の説明で新しくすると、置く時に断る（同じ説明・termId なら置ける。横断の点検）', async () => {
    const s = await draftSetup()
    for (let i = 1; i <= 7; i++) seedMaterial(s.core, s.runId, i)
    s.core.dictionary.apply([ENTRY], false)
    const ids = [
      await placeVerified(
        s.call,
        s.clock,
        draftInput(1, { terms: [{ termId: ENTRY.termId, revise: { explanation: '作り物の説明 A', asOf: '2026-11' } }] }),
      ),
    ]
    for (let i = 2; i <= 5; i++) ids.push(await placeVerified(s.call, s.clock, draftInput(i)))
    const added = await s.call('topic_add_topics', { items: ids.map((draft, i) => ({ draft, rank: i + 1 })) })
    expect(added.isError, added.text).toBeUndefined()
    expect(s.core.dictionary.get(ENTRY.termId)).toMatchObject({ explanation: '作り物の説明 A', rev: 3 })
    const refused = await s.call('topic_save_draft', {
      model: WRITER,
      topic: draftInput(6, { terms: [{ termId: ENTRY.termId, revise: { explanation: '作り物の説明 B', asOf: '2026-11' } }] }),
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('別の説明に新しくしています')
    // 同じ説明の revise と termId だけの指し方は置ける
    const same = await s.call('topic_save_draft', {
      model: WRITER,
      topic: draftInput(6, { terms: [{ termId: ENTRY.termId, revise: { explanation: '作り物の説明 A', asOf: '2026-11' } }] }),
    })
    expect(same.isError, same.text).toBeUndefined()
    const plain = await s.call('topic_save_draft', { model: WRITER, topic: draftInput(7, { terms: [{ termId: ENTRY.termId }] }) })
    expect(plain.isError, plain.text).toBeUndefined()
  })

  it('照合で持ち主が移った同じ回の新しい語は、束を書いた後に足しても、この話題での表記（別名）が残る（横断の点検）', async () => {
    const s = await draftSetup()
    for (let i = 1; i <= 6; i++) seedMaterial(s.core, s.runId, i)
    const key = '作り物の新しい仕組み'
    const alias = '作り物の別の呼び名'
    const t = termIdOf(key)
    const withAlias = { new: { ...newTerm(key, '作り物の仕組みの説明 A').new, aliases: [alias] } }
    const ids = [await placeVerified(s.call, s.clock, draftInput(1, { terms: [withAlias] }))]
    // d:02 は別名で指し、照合で説明を直す（持ち主が d:02 に移る）
    const second = await placeVerified(s.call, s.clock, draftInput(2, { terms: [{ termId: t, term: alias }] }), {
      patches: [{ path: 'terms.0.explanation', find: '説明 A', to: '説明 B', why: 'term' }],
    })
    expect(s.core.store.runTerms(s.runId)).toEqual([
      { entry: expect.objectContaining({ termId: t, explanation: '作り物の仕組みの説明 B' }), draft: second },
    ])
    for (let i = 3; i <= 6; i++) ids.push(await placeVerified(s.call, s.clock, draftInput(i)))
    // d:02 を除いた5本を先に足して束を書き、その後で d:02 を足す
    const first = await s.call('topic_add_topics', { items: ids.slice(0, 5).map((draft, i) => ({ draft, rank: i + 1 })) })
    expect(first.isError, first.text).toBeUndefined()
    const later = await s.call('topic_add_topics', { items: [{ draft: second, rank: 6 }] })
    expect(later.isError, later.text).toBeUndefined()
    const row = s.core.store.draft(s.runId, second)!
    const rec = JSON.parse(String(s.fake.record(OWNER, `topics:${row.topicId}`)!.json)) as {
      terms: { termId: string; term: string; explanation: string }[]
    }
    expect(rec.terms[0]).toMatchObject({ termId: t, term: alias, explanation: '作り物の仕組みの説明 B' })
  })
})
