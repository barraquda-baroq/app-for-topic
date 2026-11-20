// 下書き（設計の 1.2 の 9〜12・1.5・1.6。vault/drafts.ts・vault/tools/drafts.ts）: 置く（組み立てて確かめる・断る物があれば置かない・
// 同じ中身は同じ下書き・照合の前だけ置き換え・1つの回に15本まで・資料の印の文字列を断る）・出典（この回で読んでいない資料と本文が200字未満の
// 控えは出典にできない・outletNames は出典の社だけ）・同じ回の新しい語の取り合い・知ってるの語を外す・読む（資料の印で囲む・読んだ時刻・
// 確かめる所）・一覧（照合済みの数と門まで）。作り物だけ（〇〇省・example.com・fake-writer-model）
import { describe, expect, it } from 'vitest'
import { termIdOf } from '../../../src/domain/ids'
import { FAKE_CREDIT_OUTLETS } from '../../../src/test/fixtures/fakeOutlets'
import { DRAFTS_PER_RUN } from '../../src/vault/drafts'
import { MARK_CLOSE, MARK_OPEN } from '../../src/vault/tools/common'
import { draftIdIn, draftInput, draftSetup, jst, newTerm, pressBody, seedMaterial, WRITER } from '../support/drafts'

describe('下書きを置く（topic_save_draft）', () => {
  it('組み立てて確かめ、d:01 から置く。要点・次の手・structuredContent。クラウドには書かない', async () => {
    const { core, fake, runId, call } = await draftSetup()
    seedMaterial(core, runId, 1)
    const r = await call('topic_save_draft', { model: WRITER, topic: draftInput(1) })
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('下書きを置きました: d:01（順位 1・照合待ち。クラウドには書いていません）')
    expect(r.text).toContain(`出典 1本（${FAKE_CREDIT_OUTLETS.site}）`)
    expect(r.text).toContain('次: 照合の係に d:01 を渡す')
    expect(r.structured).toEqual({ created: [{ id: 'd:01', label: '順位 1・照合待ち' }], skipped: [] })
    const row = core.store.draft(runId, 'd:01')!
    expect(row).toMatchObject({ status: 'pending', model: WRITER, readAt: null, seq: 1 })
    expect(fake.calls.filter((c) => c.op === 'commit')).toEqual([])
  })

  it('同じ中身を送り直すと同じ下書きを返す（数えない）。照合の前は replace で置き換え、照合の後は置き換えない', async () => {
    const { core, runId, call, clock } = await draftSetup()
    seedMaterial(core, runId, 1)
    seedMaterial(core, runId, 2)
    await call('topic_save_draft', { model: WRITER, topic: draftInput(1) })
    const again = await call('topic_save_draft', { model: WRITER, topic: draftInput(1) })
    expect(again.text).toContain('同じ中身の下書きはもうあります: d:01（照合待ち）')
    expect(core.store.drafts(runId)).toHaveLength(1)
    // 置き換え（読んだ時刻は消える。照合の前にもう一度読む）
    await call('topic_get_draft', { draft: 'd:01' })
    expect(core.store.draft(runId, 'd:01')!.readAt).not.toBeNull()
    const replaced = await call('topic_save_draft', {
      model: WRITER,
      replace: 'd:01',
      topic: draftInput(1, { rankReason: '置き換えた作り物の理由' }),
    })
    expect(replaced.text).toContain('下書きを置き換えました: d:01')
    expect(core.store.drafts(runId)).toHaveLength(1)
    expect(core.store.draft(runId, 'd:01')!.readAt).toBeNull()
    const unread = await call('topic_check_draft', { draft: 'd:01', model: 'fake-checker-model', claims: 1, patches: [] })
    expect(unread.text).toContain('先に topic_get_draft で d:01 を読んでください')
    await call('topic_get_draft', { draft: 'd:01' })
    clock.now += 3 * 60_000
    await call('topic_check_draft', { draft: 'd:01', model: 'fake-checker-model', claims: 1, patches: [] })
    const after = await call('topic_save_draft', { model: WRITER, replace: 'd:01', topic: draftInput(2) })
    expect(after.isError).toBe(true)
    expect(after.text).toContain('照合の後の下書きは置き換えられません')
  })

  it(`1つの回に${DRAFTS_PER_RUN}本まで（置き換えは数えない）`, async () => {
    const { core, runId, call } = await draftSetup()
    for (let i = 1; i <= DRAFTS_PER_RUN + 1; i++) seedMaterial(core, runId, i)
    for (let i = 1; i <= DRAFTS_PER_RUN; i++)
      expect((await call('topic_save_draft', { model: WRITER, topic: draftInput(i) })).isError, String(i)).toBeUndefined()
    const over = await call('topic_save_draft', { model: WRITER, topic: draftInput(DRAFTS_PER_RUN + 1) })
    expect(over.text).toContain(`1つの回に置ける下書きは${DRAFTS_PER_RUN}本までです`)
    const replace = await call('topic_save_draft', { model: WRITER, replace: 'd:03', topic: draftInput(DRAFTS_PER_RUN + 1) })
    expect(replace.text).toContain('下書きを置き換えました: d:03')
  })

  it('この回で読んでいない資料・本文が200字未満の控え・この回に無い資料は出典にできない（断る物があれば置かない）', async () => {
    const { core, runId, call } = await draftSetup()
    seedMaterial(core, runId, 1, { readAt: null })
    seedMaterial(core, runId, 2, { body: '作り物の短い本文（PDF の資料だけの発表）', bodyChars: 30 })
    const unread = await call('topic_save_draft', { model: WRITER, topic: draftInput(1) })
    expect(unread.isError).toBe(true)
    expect(unread.text).toContain('sources.0.ref: 「c0001」はこの回で読んでいない資料です')
    const short = await call('topic_save_draft', { model: WRITER, topic: draftInput(2) })
    expect(short.text).toContain('本文が200字未満の資料です')
    const none = await call('topic_save_draft', { model: WRITER, topic: draftInput(9) })
    expect(none.text).toContain('「c0009」はこの回の資料にありません')
    expect(core.store.drafts(runId)).toEqual([])
  })

  it('outletNames は出典の社だけから作る（カードの「nか所」= 出典の社の数）', async () => {
    const { core, runId, call } = await draftSetup()
    seedMaterial(core, runId, 1)
    seedMaterial(core, runId, 2)
    const input = draftInput(1, {
      sources: [
        { ref: 'c0001', outlet: FAKE_CREDIT_OUTLETS.site },
        { ref: 'c0002', outlet: FAKE_CREDIT_OUTLETS.title },
      ],
    })
    const r = await call('topic_save_draft', { model: WRITER, topic: input })
    expect(r.text).toContain(`出典 2本（${FAKE_CREDIT_OUTLETS.site}・${FAKE_CREDIT_OUTLETS.title}）`)
  })

  it('1つのホストに社が2つ以上ある時は、出典の outlet で社を決める（無ければ断る。作り物の社はどれも example.com）', async () => {
    const { core, runId, call } = await draftSetup()
    seedMaterial(core, runId, 1)
    const r = await call('topic_save_draft', { model: WRITER, topic: draftInput(1, { sources: [{ ref: 'c0001' }] }) })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('sources.0.outlet: 「c0001」のホストには社が2つ以上あります')
  })

  it('資料の印の文字列（<<< >>>。全角も）を含む欄は断る', async () => {
    const { core, runId, call } = await draftSetup()
    seedMaterial(core, runId, 1)
    // 結合の文字（U+0338。>>≯ に合わさる）と見えない文字をはさんだ形も（横断の点検）
    for (const mark of [MARK_OPEN, MARK_CLOSE, '＜＜＜', '>>>\u0338', '>>\u226F', '>>\u200B>']) {
      const r = await call('topic_save_draft', {
        model: WRITER,
        topic: draftInput(1, { unverified: [`作り物${mark}の点`] }),
      })
      expect(r.isError, mark).toBe(true)
      expect(r.text).toContain('unverified.0: 資料の印の文字列')
    }
    expect(core.store.drafts(runId)).toEqual([])
  })

  it('同じ回の新しい語: 同じ説明なら通り、別の説明は断る（termId で指す）。語は持ち主の下書きと一緒に引ける', async () => {
    const { core, runId, call } = await draftSetup()
    for (let i = 1; i <= 3; i++) seedMaterial(core, runId, i)
    await call('topic_save_draft', { model: WRITER, topic: draftInput(1, { terms: [newTerm('作り物の橋の制度')] }) })
    const same = await call('topic_save_draft', { model: WRITER, topic: draftInput(2, { terms: [newTerm('作り物の橋の制度')] }) })
    expect(same.isError).toBeUndefined()
    const other = await call('topic_save_draft', {
      model: WRITER,
      topic: draftInput(3, { terms: [newTerm('作り物の橋の制度', '別の作り物の説明')] }),
    })
    expect(other.isError).toBe(true)
    expect(other.text).toContain('同じ回のほかの下書きで別の説明で足しています')
    const t = termIdOf('作り物の橋の制度')
    expect(core.store.runTerms(runId)).toEqual([{ entry: expect.objectContaining({ termId: t, rev: 1 }), draft: 'd:01' }])
    const viaId = await call('topic_save_draft', { model: WRITER, topic: draftInput(3, { terms: [{ termId: t }] }) })
    expect(viaId.isError).toBeUndefined()
    const looked = await call('topic_lookup_terms', { words: ['作り物の橋の制度'] })
    expect(looked.text).toContain('同じ回で足す語')
  })

  it('いまの説明で知ってる語は外して知らせる', async () => {
    const { core, runId, call, fake } = await draftSetup()
    seedMaterial(core, runId, 1)
    const entry = {
      termId: termIdOf('作り物の語'),
      key: '作り物の語',
      term: '作り物の語',
      aliases: [],
      explanation: '作り物の説明',
      asOf: '2026-10',
      rev: 1,
    }
    core.dictionary.apply([entry], false)
    fake.putRecord('owner-uid-1', 'knownTerms', {
      id: entry.termId,
      v: 1,
      createdAt: 1,
      updatedAt: 1,
      by: 'user',
      ai: null,
      term: '作り物の語',
      asOf: '2026-10',
      on: true,
    } as never)
    core.store.putTask('mirror', core.now())
    await core.alarm()
    expect(core.mirror.known().get(entry.termId)).toBeTruthy()
    const r = await call('topic_save_draft', { model: WRITER, topic: draftInput(1, { terms: [{ termId: entry.termId }] }) })
    expect(r.text).toContain('知ってるので外した語 1（「作り物の語」）')
    expect(r.text).toContain('用語 0語')
  })

  it('書く係の締め切りの後は置いて知らせ、照合の打ち切りの後は断る', async () => {
    const { core, runId, call, clock } = await draftSetup({ now: jst(10, 16) })
    seedMaterial(core, runId, 1)
    seedMaterial(core, runId, 2)
    clock.now = jst(11, 46)
    const late = await call('topic_save_draft', { model: WRITER, topic: draftInput(1) })
    expect(late.text).toContain('書く係の締め切りを過ぎました（照合が間に合わないかもしれません）')
    expect(late.text.split('\n')[0]).toBe('いま 11:46（日本時間）・書く係の締め切りを過ぎています・照合の打ち切りまで 60分')
    clock.now = jst(12, 46)
    const refused = await call('topic_save_draft', { model: WRITER, topic: draftInput(2) })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('照合の打ち切りを過ぎました（何も置いていません）')
  })

  it('訂正だけの回では使えない（下書き・照合・一覧）', async () => {
    const { call } = await draftSetup({ kind: 'correction' })
    for (const tool of ['topic_save_draft', 'topic_check_draft', 'topic_get_draft', 'topic_list_drafts'])
      expect((await call(tool, { draft: 'd:01' })).text, tool).toContain('この回（訂正だけの回）では使えません')
  })
})

describe('下書きを読む（topic_get_draft）・一覧（topic_list_drafts）', () => {
  it('欄の道つきで資料の印で囲み、出典は控えの頭の行つき。読んだ時刻を覚え、終わりに確かめる所（資料に見当たらない数字・日付）', async () => {
    const { core, runId, call } = await draftSetup()
    seedMaterial(core, runId, 1)
    const input = draftInput(1, {
      timeline: [
        { when: '2026-11-15', text: '〇〇市が橋の長さを決めた' },
        { when: '2026-11-17', text: '〇〇市が工事の費用を4万5,000円と見積もった' },
      ],
    })
    await call('topic_save_draft', { model: WRITER, topic: input })
    const r = await call('topic_get_draft', { draft: 'd:01' })
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('<<<下書き（資料）')
    expect(r.text).toContain('下書き（資料）ここまで>>>')
    expect(r.text).toContain('summary: 〇〇市は15日')
    expect(r.text).toContain('emphasis.summary（強調）: 「320メートル」')
    expect(r.text).toContain(`sources.0.ref: c0001 → ${FAKE_CREDIT_OUTLETS.site}・題「作り物の発表1」`)
    expect(r.text).toContain('確かめる所（コネクタが機械で照らした物')
    expect(r.text).toContain('- timeline.1.when: 「2026-11-17」')
    expect(r.text).toContain('- timeline.1.text: 「4万5,000」')
    expect(r.text).not.toContain('- summary:')
    expect(core.store.draft(runId, 'd:01')!.readAt).toBe(core.now())
  })

  it('長い下書きは cursor で続き（12,000字ずつ）。確かめる所は最後の頁', async () => {
    const { core, runId, call } = await draftSetup()
    seedMaterial(core, runId, 1, { body: pressBody(1) })
    const many = Array.from({ length: 15 }, (_, i) => `作り物の確かめられなかった点${i} ${'あ'.repeat(280)}`)
    const terms = Array.from({ length: 20 }, (_, i) => newTerm(`作り物の長い語${i}`, `${'説'.repeat(190)}${i}`))
    const stakeholders = Array.from({ length: 10 }, (_, i) => ({
      name: `作り物の当事者${i}`,
      stance: 'for' as const,
      stanceNote: null,
      claim: `作り物の主張${i} ${'い'.repeat(380)}`,
      reason: null,
    }))
    const saved = await call('topic_save_draft', {
      model: WRITER,
      topic: draftInput(1, { unverified: many, terms, stakeholders }),
    })
    expect(saved.isError, saved.text).toBeUndefined()
    const first = await call('topic_get_draft', { draft: 'd:01' })
    const m = /続きがあります（cursor: (o\d+)）/.exec(first.text)
    expect(m).not.toBeNull()
    expect(first.text).not.toContain('確かめる所')
    const second = await call('topic_get_draft', { draft: 'd:01', cursor: m![1] })
    expect(second.text).toContain('確かめる所')
  })

  it('一覧: 照合済みの数と数の門まで・締め切り・下書きごとの状態と照合の件数（見出しは資料の印で囲む）', async () => {
    const { core, runId, call, clock } = await draftSetup()
    seedMaterial(core, runId, 1)
    const empty = await call('topic_list_drafts')
    expect(empty.text).toContain('下書き 0本（1つの回に15本まで）・照合済み 0本（数の門の5本まであと 5本）')
    expect(empty.text).toContain('締め切り: 書く係 11:46・照合の打ち切り 12:46')
    await call('topic_save_draft', { model: WRITER, topic: draftInput(1) })
    const r = await call('topic_list_drafts')
    expect(r.text).toContain('<<<下書き（資料）')
    expect(r.text).toMatch(/d:01 順位 1・照合待ち・照合 0回・知らせる物 \d+｜作り物の見出し1/)
    // 照合済みになると、照合の件数（照合した主張の数）も出る
    await call('topic_get_draft', { draft: 'd:01' })
    clock.now += 3 * 60_000
    await call('topic_check_draft', { draft: 'd:01', model: 'fake-checker-model', claims: 4, patches: [] })
    const after = await call('topic_list_drafts')
    expect(after.text).toMatch(/d:01 順位 1・照合済み・照合 1回・主張 4件・知らせる物 \d+｜作り物の見出し1/)
    expect(after.text).toContain('照合済み 1本（数の門の5本まであと 4本）')
  })

  it('知らない下書きは断る', async () => {
    const { call } = await draftSetup()
    expect((await call('topic_get_draft', { draft: 'd:09' })).text).toContain('この回に下書き「d:09」はありません')
    expect(draftIdIn('… d:07 …')).toBe('d:07')
  })
})
