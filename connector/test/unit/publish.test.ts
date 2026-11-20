// 足す（設計の 1.2 の 14〜16・1.3・1.8。vault/tools/write.ts）: 辞書の束が話題より先（同じ commit の頭）・束は1つの回に1つ（後で新しい語が
// 出た時だけもう1つ）・5本ずつ・順位の付け替え・「もうある」の送り直し・版の order の確かめ（d:… と p:…）・版の後に回の物が消える・
// 版の答え（知らせる物・照合のまとめ・確かめが早すぎる下書き・足した訂正・かかった分）・作れなかった印・試しの回は書かない・書き込みの許可。
// 作り物だけ（〇〇省・example.com・fake-writer-model）
import { describe, expect, it } from 'vitest'
import { editionFailIdOf, termIdOf, topicShortId } from '../../../src/domain/ids'
import { fakeRecordsOf, makeFakeEdition } from '../../../src/test/fixtures/fakeEditions'
import { WRITE_RESERVE as CORE_WRITE_RESERVE } from '../../src/vault/core'
import { WRITE_RESERVE } from '../../src/vault/quota'
import { FakeFirebase } from '../support/fakeFirebase'
import { draftInput, draftSetup, newTerm, placeVerified, seedMaterial } from '../support/drafts'
import { drainAlarms, OWNER, seedRecords } from '../support/harness'

/** commit の書き込みの名前の並び（表:id）を覚える fetch */
function recordingFake() {
  const fake = new FakeFirebase()
  const commits: string[][] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes(':commit') && typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as { writes: { update: { name: string } }[] }
      commits.push(body.writes.map((w) => w.update.name.slice(w.update.name.indexOf('/records/') + 9)))
    }
    return fake.fetch(input as never, init)
  }) as typeof globalThis.fetch
  return { fake, commits, fetch }
}

async function verifiedRun(n: number, opts: { kind?: 'edition' | 'trial'; terms?: boolean } = {}) {
  const rec = recordingFake()
  const s = await draftSetup({ kind: opts.kind, fake: rec.fake, config: { fetch: rec.fetch } })
  const ids: string[] = []
  for (let i = 1; i <= n; i++) {
    seedMaterial(s.core, s.runId, i)
    const terms = opts.terms && i <= 2 ? [newTerm(`作り物の版の語${i}`)] : []
    ids.push(await placeVerified(s.call, s.clock, draftInput(i, { terms })))
  }
  return { ...s, ...rec, ids }
}

const items = (ids: readonly string[]) => ids.map((draft, i) => ({ draft, rank: i + 1 }))

describe('話題を足す（topic_add_topics）', () => {
  it('数の門: 照合済みが4本では断り、辞書の束も書かない。5本で通り、束を話題より先に同じ commit で足す', async () => {
    const four = await verifiedRun(4, { terms: true })
    const refused = await four.call('topic_add_topics', { items: items(four.ids) })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain(
      '照合済みの下書きが5本そろうまで、話題は足せません（照合済み 4本（数の門は5本）。辞書の束も書いていません）',
    )
    expect(four.commits).toEqual([])

    const five = await verifiedRun(5, { terms: true })
    const r = await five.call('topic_add_topics', { items: items(five.ids) })
    expect(r.isError, r.text).toBeUndefined()
    expect(r.text).toContain('話題を足しました: 5件')
    expect(r.text).toContain('辞書の束: 1つ（語 2）を話題より先に足しました')
    expect(r.text).toContain('照合済みの下書きは全部足しました。次: topic_add_edition')
    expect(five.commits).toHaveLength(1)
    const names = five.commits[0]
    expect(names[0]).toMatch(/^termPacks:2026-11-19-12-[0-9a-z]{8}$/)
    expect(names.slice(1).every((n) => n.startsWith('topics:2026-11-19-12-'))).toBe(true)
    expect(names).toHaveLength(6)
    // 束の語は辞書の今の形に入る
    expect(five.core.dictionary.get(termIdOf('作り物の版の語1'))).toMatchObject({ rev: 1 })
    // 足した話題の id（p:…）・下書きに覚える
    const rows = five.core.store.drafts(five.runId)
    for (const d of rows) expect(r.text).toContain(`${topicShortId(d.topicId!)}（${d.draftId}・順位 ${d.rank}）`)
    expect((r.structured!.created as { id: string }[]).map((c) => c.id)).toEqual(rows.map((d) => topicShortId(d.topicId!)))
    // 話題の記録は照合の数え・書いた係のモデル・束の後の辞書の語の写し
    const topic = JSON.parse(String(five.fake.record(OWNER, `topics:${rows[0].topicId}`)!.json)) as Record<string, unknown>
    expect(topic).toMatchObject({
      model: 'fake-writer-model',
      check: { claims: 4, fixed: 0, model: 'fake-checker-model' },
      by: 'connector',
    })
    // 送り直しは「もう足してあります」（書かない）
    const again = await five.call('topic_add_topics', { items: items(five.ids) })
    expect(again.isError).toBeUndefined()
    expect(again.text).toContain('どの下書きも、もう足してあります')
    expect(five.commits).toHaveLength(1)
  })

  it('順位を付け替えて足す（話題の rank は items の rank）。後の呼び出しで新しい語が出た時だけ、もう1つ束を足す', async () => {
    const s = await verifiedRun(5, { terms: true })
    await s.call('topic_add_topics', { items: s.ids.map((draft, i) => ({ draft, rank: 10 - i })) })
    expect(s.core.store.drafts(s.runId).map((d) => d.rank)).toEqual([10, 9, 8, 7, 6])
    seedMaterial(s.core, s.runId, 6)
    const late = await placeVerified(s.call, s.clock, draftInput(6, { terms: [newTerm('作り物の後の語')] }))
    seedMaterial(s.core, s.runId, 7)
    const plain = await placeVerified(s.call, s.clock, draftInput(7, { terms: [{ termId: termIdOf('作り物の版の語1') }] }))
    const r = await s.call('topic_add_topics', {
      items: [
        { draft: late, rank: 1 },
        { draft: plain, rank: 2 },
      ],
    })
    expect(r.isError, r.text).toBeUndefined()
    expect(r.text).toContain('辞書の束: 1つ（語 1）')
    expect(s.commits).toHaveLength(2)
    expect(s.commits[1][0]).toMatch(/^termPacks:/)
    expect(s.commits[1].filter((n) => n.startsWith('termPacks:'))).toHaveLength(1)
  })

  it('照合待ち・照合で外した・この回に無い下書きはとばす（訳を返す）', async () => {
    const s = await verifiedRun(5)
    seedMaterial(s.core, s.runId, 6)
    await s.call('topic_save_draft', { model: 'fake-writer-model', topic: draftInput(6) })
    const r = await s.call('topic_add_topics', {
      items: [
        { draft: s.ids[0], rank: 1 },
        { draft: 'd:06', rank: 2 },
        { draft: 'd:09', rank: 3 },
      ],
    })
    expect(r.text).toContain('話題を足しました: 1件')
    expect(r.structured!.skipped).toEqual([
      { ref: 'd:06', reason: '照合待ちの下書きは足しません' },
      { ref: 'd:09', reason: 'この回に無い下書きです' },
    ])
  })

  it('書き込みの許可がオフなら断る（何も書かない）', async () => {
    const s = await verifiedRun(5)
    s.fake.setWrites(false)
    s.clock.now += 2 * 60_000
    const r = await s.call('topic_add_topics', { items: items(s.ids) })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('書き込みは停止中です')
    expect(s.commits).toEqual([])
  })
})

describe('版を出す（topic_add_edition）', () => {
  it('order は d:… と p:…。5本未満は断る。出したら回の物を消し、答えに知らせる物・照合のまとめ・足した訂正・かかった分', async () => {
    const s = await verifiedRun(5)
    await s.call('topic_add_topics', { items: items(s.ids) })
    const short = await s.call('topic_add_edition', { order: s.ids.slice(0, 4), candidateCount: 12, notChosen: [] })
    expect(short.isError).toBe(true)
    expect(short.text).toContain('版の話題は5本から出せます（order 4本）')
    const rows = s.core.store.drafts(s.runId)
    const order = [topicShortId(rows[0].topicId!), ...s.ids.slice(1)]
    const r = await s.call('topic_add_edition', {
      order,
      candidateCount: 12,
      notChosen: [{ headline: '作り物の選ばなかった見出し', whyNot: '作り物の訳' }],
      tokens: 1234,
    })
    expect(r.isError, r.text).toBeUndefined()
    expect(r.text).toContain('版を出しました: e:2026-11-19-12（11/19 12:00版。話題 5本）')
    expect(r.text).toContain('話題が 5本です（目安は 10本）')
    expect(r.text).toContain('照合のまとめ: 主張 20件・直した 0件・照合で外した 0本')
    expect(r.text).toContain('確かめが早すぎる下書き: 0本')
    expect(r.text).toContain('この回で足した訂正: 0件')
    expect(r.text).toMatch(/かかった分: \d+分（道具の呼び出し \d+回）/)
    expect(r.text).toContain('この回の作業は終わりです（報告を書く）')
    expect(r.structured).toEqual({ created: [{ id: 'e:2026-11-19-12', label: '11/19 12:00版' }], skipped: [] })
    const edition = JSON.parse(String(s.fake.record(OWNER, 'editions:2026-11-19-12')!.json)) as Record<string, unknown>
    expect(edition).toMatchObject({
      order: rows.map((d) => d.topicId),
      candidateCount: 12,
      model: 'fake-writer-model',
      window: { since: '2026-11-18T18:00:00+09:00', until: '2026-11-19T10:16:00+09:00' },
      usage: { tokens: 1234, toolCalls: expect.any(Number) },
    })
    // 道具の呼び出しの数は、回を始めた呼び出しからこの版の呼び出しまで（runId を渡した呼び出し。設計の 4.9）
    const calls = (edition.usage as { toolCalls: number }).toolCalls
    expect(r.text).toContain(`道具の呼び出し ${calls}回`)
    expect(calls).toBeGreaterThanOrEqual(4)
    // 版の後: 候補・控え・下書き・数え・新しい語を消し、回は終わり
    expect(s.core.store.drafts(s.runId)).toEqual([])
    expect(s.core.store.materials(s.runId)).toEqual([])
    expect(s.core.store.candidates(s.runId)).toEqual([])
    expect(s.core.store.runCounts(s.runId)).toEqual({})
    expect(s.core.store.getRun(s.runId)!.done).toBe(true)
    expect((await s.call('topic_list_drafts')).text).toContain('この回は終わりました')
  })

  it('置いてすぐ照合済みになった下書き（2分未満）の数と、直した訳の種類を版の答えに出す', async () => {
    const s = await verifiedRun(4)
    seedMaterial(s.core, s.runId, 5)
    const saved = await s.call('topic_save_draft', { model: 'fake-writer-model', topic: draftInput(5) })
    expect(saved.isError).toBeUndefined()
    await s.call('topic_get_draft', { draft: 'd:05' })
    await s.call('topic_check_draft', {
      draft: 'd:05',
      model: 'fake-checker-model',
      claims: 3,
      patches: [{ path: 'summary', find: '2割ほど', to: '3割ほど', why: 'number' }],
    })
    const ids = [...s.ids, 'd:05']
    await s.call('topic_add_topics', { items: items(ids) })
    const r = await s.call('topic_add_edition', { order: ids, candidateCount: 9 })
    expect(r.text).toContain('確かめが早すぎる下書き: 1本')
    expect(r.text).toContain('照合のまとめ: 主張 19件・直した 1件（数字 1）・照合で外した 0本')
  })

  it('足していない下書き・この版に無い話題・同じ話題の2回は断る。話題が写しに無ければ断る', async () => {
    const s = await verifiedRun(6)
    await s.call('topic_add_topics', { items: items(s.ids.slice(0, 5)) })
    const r = await s.call('topic_add_edition', {
      order: [...s.ids.slice(0, 4), s.ids[5], 'p:zzzzzzzz', s.ids[0]],
      candidateCount: 3,
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('order.4（d:06）: まだ足していない下書きです（先に topic_add_topics）')
    expect(r.text).toContain('order.5（p:zzzzzzzz）: この版の話題にありません')
    expect(r.text).toContain('order.6（d:01）: 同じ話題が2回あります')
    expect(s.fake.record(OWNER, 'editions:2026-11-19-12')).toBeNull()
    // 下書きに覚えた話題がクラウドに無い（書けたか分からないまま止まった時など）: 版を書かない
    const sixth = s.core.store.draft(s.runId, s.ids[5])!
    s.core.store.putDraft({ ...sixth, topicId: '2026-11-19-12-zzzzzzzz' })
    const gone = await s.call('topic_add_edition', { order: [...s.ids.slice(0, 4), s.ids[5]], candidateCount: 3 })
    expect(gone.isError).toBe(true)
    expect(gone.text).toContain('order の話題がクラウドにありません（p:zzzzzzzz）')
    expect(s.fake.record(OWNER, 'editions:2026-11-19-12')).toBeNull()
    expect(s.core.store.getRun(s.runId)!.done).toBe(false)
  })

  it('その枠の版がもうあれば（別の回が出した版）、版を足さない', async () => {
    const s = await verifiedRun(5)
    await s.call('topic_add_topics', { items: items(s.ids) })
    const other = makeFakeEdition({ date: '2026-11-19', slot: '12', seed: 'other-run' })
    seedRecords(s.fake, fakeRecordsOf(other))
    s.core.store.putTask('mirror', s.core.now())
    await drainAlarms(s.core, s.clock)
    const r = await s.call('topic_add_edition', { order: s.ids, candidateCount: 5 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('この枠の版はもうあります（e:2026-11-19-12。11/19 12:00版）')
  })
})

describe('作れなかった印（topic_add_edition_fail）', () => {
  it('印を足し、回の物を消す。同じ枠の版があれば断る', async () => {
    const s = await draftSetup()
    seedMaterial(s.core, s.runId, 1)
    const r = await s.call('topic_add_edition_fail', { reasonKind: 'no-sources', reason: '読める資料が足りない' })
    expect(r.isError, r.text).toBeUndefined()
    const id = editionFailIdOf({
      editionId: '2026-11-19-12',
      runId: s.runId,
      reasonKind: 'no-sources',
      reason: '読める資料が足りない',
    })
    expect(r.text).toContain(`作れなかった印を足しました: ${id}`)
    expect(r.text).toContain('この回で足した訂正: 0件')
    expect(s.fake.record(OWNER, `editionFails:${id}`)).not.toBeNull()
    expect(s.core.store.materials(s.runId)).toEqual([])
    expect(s.core.store.getRun(s.runId)!.done).toBe(true)

    const t = await draftSetup({ now: s.clock.now + 60_000, fake: new FakeFirebase() })
    const e = makeFakeEdition({ date: '2026-11-19', slot: '12', seed: 'taken' })
    seedRecords(t.fake, fakeRecordsOf(e))
    t.core.store.putTask('mirror', t.core.now())
    await drainAlarms(t.core, t.clock)
    const refused = await t.call('topic_add_edition_fail', { reasonKind: 'timeout', reason: '作り物の時間切れ' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('この枠の版はもうあります（e:2026-11-19-12）')
  })
})

describe('試しの回（足す道具は確かめだけ）', () => {
  it('話題も版もクラウドに書かず、足すと何件かを返す。門に届かなくても知らせるだけ。版の確かめの後に回の物を消す', async () => {
    const s = await verifiedRun(4, { kind: 'trial', terms: true })
    const r = await s.call('topic_add_topics', { items: items(s.ids) })
    expect(r.isError, r.text).toBeUndefined()
    expect(r.text).toContain('試しの回なので、クラウドには何も書きません（足すと: 話題 4件・辞書の束 1つ（語 2））')
    expect(r.text).toContain('版の回なら断ります: 照合済み 4本（数の門は5本）')
    const e = await s.call('topic_add_edition', { order: s.ids, candidateCount: 9 })
    expect(e.isError, e.text).toBeUndefined()
    expect(e.text).toContain('試しの回なので、クラウドには何も書きません（出すと: e:2026-11-19-12（11/19 12:00版）・話題 4本）')
    expect(e.text).toContain('版の回なら断ります（版の話題は5本から出せます（order 4本））')
    expect(s.commits).toEqual([])
    expect(s.core.store.getRun(s.runId)!.done).toBe(true)
    expect(s.core.store.drafts(s.runId)).toEqual([])
    expect((await s.call('topic_add_edition_fail', { reasonKind: 'other', reason: '作り物' })).text).toContain(
      'この回は終わりました',
    )
  })
})

describe('書き込みの日枠の残し', () => {
  it('話題・版・辞書の束が残す日枠は quota.ts の WRITE_RESERVE の1か所（core.ts も同じ値を出す。作れなかった印と訂正の分）', () => {
    expect(CORE_WRITE_RESERVE).toBe(WRITE_RESERVE)
    expect(WRITE_RESERVE).toBe(30)
  })

  it('日枠の残りが少ない時、話題は断り、作れなかった印は足せる', async () => {
    const rec = recordingFake()
    const s = await draftSetup({ fake: rec.fake, config: { fetch: rec.fetch, config: { dailyWriteBudget: 33 } } })
    const ids: string[] = []
    for (let i = 1; i <= 5; i++) {
      seedMaterial(s.core, s.runId, i)
      ids.push(await placeVerified(s.call, s.clock, draftInput(i)))
    }
    const r = await s.call('topic_add_topics', { items: items(ids) })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('書き込み枠が足りません')
    expect(rec.commits).toEqual([])
    const f = await s.call('topic_add_edition_fail', { reasonKind: 'quota', reason: '作り物の枠の不足' })
    expect(f.isError, f.text).toBeUndefined()
    expect(rec.commits).toHaveLength(1)
  })
})
