// 数の門と締め切り（設計の 1.3・4.5・4.10・4.13。B1 の open「締め切り（定期の回では 11:46・12:46）が答えの頭と決まりの文で合うか」）:
// 門は RECORD_NORMS.editionGate（Q17 の今の決め方 A で 5）を、コネクタの門・下書きの一覧・決まりの文が同じ値で読む。締め切りは回の覚え書きの
// 値だけが正で、答えの頭の残りの分・道具の断る時刻・topic_begin_run の答えが同じ時刻を指す（決まりの文は時刻を書かない）。
// 話題・版・作れなかった印は照合の打ち切りの後も回の期限まで足せる。作り物だけ
import { describe, expect, it } from 'vitest'
import { RECORD_NORMS } from '../../../src/domain/limits'
import { verifiedCount } from '../../src/vault/drafts'
import { guideText } from '../../src/vault/tools/drafts'
import { CHECKER, draftInput, draftSetup, jst, placeVerified, seedMaterial, WRITER } from '../support/drafts'

describe('締め切り（定期実行の 10:16 の回は 11:46・12:46）', () => {
  it('答えの頭の残りの分・置く道具の知らせ・照合の打ち切りが、回の覚え書きの同じ時刻を指す', async () => {
    const s = await draftSetup({ now: jst(10, 16) })
    const run = s.core.store.getRun(s.runId)!
    expect(run.writerMs).toBe(jst(11, 46))
    expect(run.checkerMs).toBe(jst(12, 46))
    for (let i = 1; i <= 3; i++) seedMaterial(s.core, s.runId, i)
    // 11:45（版の時刻の15分前）はまだ締め切りの前（始めて90分の 11:46 の方が遅い）
    s.clock.now = jst(11, 45)
    const before = await s.call('topic_save_draft', { model: WRITER, topic: draftInput(1) })
    expect(before.text.split('\n')[0]).toBe('いま 11:45（日本時間）・書く係の締め切りまで 1分・照合の打ち切りまで 61分')
    expect(before.text).not.toContain('締め切りを過ぎました')
    s.clock.now = jst(11, 46)
    const late = await s.call('topic_save_draft', { model: WRITER, topic: draftInput(2) })
    expect(late.text).toContain('書く係の締め切りを過ぎました')
    // 12:45 は照合できる。12:46 からは照合も置くのも断る
    await s.call('topic_get_draft', { draft: 'd:01' })
    await s.call('topic_get_draft', { draft: 'd:02' })
    s.clock.now = jst(12, 45)
    const ok = await s.call('topic_check_draft', { draft: 'd:01', model: CHECKER, claims: 2, patches: [] })
    expect(ok.isError, ok.text).toBeUndefined()
    expect(ok.text.split('\n')[0]).toBe('いま 12:45（日本時間）・書く係の締め切りを過ぎています・照合の打ち切りまで 1分')
    s.clock.now = jst(12, 46)
    const refused = await s.call('topic_check_draft', { draft: 'd:02', model: CHECKER, claims: 2, patches: [] })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('照合の打ち切りを過ぎました')
    expect(refused.text.split('\n')[0]).toBe(
      'いま 12:46（日本時間）・書く係の締め切りを過ぎています・照合の打ち切りを過ぎています',
    )
    expect((await s.call('topic_save_draft', { model: WRITER, topic: draftInput(3) })).isError).toBe(true)
  })

  it('照合の打ち切りの後も、照合済みの話題と版は回の期限まで足せる', async () => {
    const s = await draftSetup({ now: jst(10, 16) })
    const ids: string[] = []
    for (let i = 1; i <= RECORD_NORMS.editionGate; i++) {
      seedMaterial(s.core, s.runId, i)
      ids.push(await placeVerified(s.call, s.clock, draftInput(i)))
    }
    s.clock.now = jst(13, 30)
    const added = await s.call('topic_add_topics', { items: ids.map((draft, i) => ({ draft, rank: i + 1 })) })
    expect(added.isError, added.text).toBeUndefined()
    const e = await s.call('topic_add_edition', { order: ids, candidateCount: 8 })
    expect(e.isError, e.text).toBeUndefined()
  })

  it('試しの回は始めて90分・150分', async () => {
    const s = await draftSetup({ now: jst(14, 0), kind: 'trial' })
    const run = s.core.store.getRun(s.runId)!
    expect(run.writerMs).toBe(jst(15, 30))
    expect(run.checkerMs).toBe(jst(16, 30))
  })

  it('決まりの文は締め切りの時刻を書かず、答えの頭の残りの分を見る（時刻は回ごとに違う）', () => {
    for (const role of ['select', 'write', 'verify', 'correct'] as const)
      expect(guideText(role), role).not.toMatch(/\d{1,2}:\d{2}/)
    expect(guideText('write')).toContain('答えの頭の「書く係の締め切りまで n分」を見る')
    expect(guideText('verify')).toContain('答えの頭の「照合の打ち切りまで m分」を過ぎると当てられない')
  })
})

describe('数の門（RECORD_NORMS.editionGate）', () => {
  it('門の値は 5（Q17 の今の決め方 A）。下書きの一覧・照合の答え・決まりの文が同じ値を読む', async () => {
    expect(RECORD_NORMS.editionGate).toBe(5)
    expect(RECORD_NORMS.editionTopics).toBe(10)
    expect(RECORD_NORMS.editionSpares).toBe(3)
    expect(guideText('select')).toContain(
      `使える候補が${RECORD_NORMS.editionGate}本に届かない時は、選ばずに「作れない」とだけ返す`,
    )
    const s = await draftSetup()
    for (let i = 1; i <= RECORD_NORMS.editionGate; i++) seedMaterial(s.core, s.runId, i)
    for (let i = 1; i < RECORD_NORMS.editionGate; i++) await placeVerified(s.call, s.clock, draftInput(i))
    expect(verifiedCount(s.core.store, s.runId)).toEqual({ verified: 4, left: 1 })
    expect((await s.call('topic_list_drafts')).text).toContain('照合済み 4本（数の門の5本まであと 1本）')
    const r = await s.call('topic_save_draft', { model: WRITER, topic: draftInput(5) })
    await s.call('topic_get_draft', { draft: 'd:05' })
    s.clock.now += 3 * 60_000
    const last = await s.call('topic_check_draft', { draft: 'd:05', model: CHECKER, claims: 1, patches: [] })
    expect(r.isError).toBeUndefined()
    expect(last.text).toContain('照合済み 5本（数の門の5本まで届きました）')
    expect(last.text).toContain('まとめ役は topic_add_topics で足せます')
  })

  it('照合で外した下書き・照合待ちの下書きは門に数えない', async () => {
    const s = await draftSetup()
    for (let i = 1; i <= 6; i++) seedMaterial(s.core, s.runId, i)
    for (let i = 1; i <= 4; i++) await placeVerified(s.call, s.clock, draftInput(i))
    await s.call('topic_save_draft', { model: WRITER, topic: draftInput(5) })
    await s.call('topic_save_draft', { model: WRITER, topic: draftInput(6) })
    await s.call('topic_get_draft', { draft: 'd:06' })
    await s.call('topic_check_draft', { draft: 'd:06', model: CHECKER, claims: 1, patches: [], reject: '作り物の訳' })
    expect(verifiedCount(s.core.store, s.runId)).toEqual({ verified: 4, left: 1 })
    const r = await s.call('topic_add_topics', { items: [{ draft: 'd:01', rank: 1 }] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('照合済みの下書きが5本そろうまで')
  })
})
