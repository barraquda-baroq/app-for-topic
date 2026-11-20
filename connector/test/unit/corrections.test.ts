// 訂正（設計の 1.2 の 8・17・1.6・仕様 7.8 の「訂正を足す・出す」。vault/tools/write.ts）: 30日の内の、版の記録がある版の order の話題だけ・
// ふつうの文・1つの話題に10件・同じ文は「もうある」・1つの回に版の回は3件・訂正だけの回は5件・1日10件・答えに全部出る（版の答えと作れなかった
// 印の答え）。訂正する話題を探す（版・日付・枠・語で絞り、今ある訂正の文も返す。資料の印で囲む）。D21: 答えに作った時刻・回・モデルを出さない。
// 作り物だけ（作り物の版 makeFakeEdition・fake-writer-model）
import { describe, expect, it } from 'vitest'
import { correctionIdOf, topicShortId } from '../../../src/domain/ids'
import { fakeRecordsOf, makeFakeEdition } from '../../../src/test/fixtures/fakeEditions'
import { CORRECTIONS_PER_DAY, CORRECTIONS_PER_RUN } from '../../src/vault/tools/write'
import { FakeFirebase } from '../support/fakeFirebase'
import { draftSetup, jst, seedMaterial, WRITER } from '../support/drafts'
import { drainAlarms, OWNER, seedRecords } from '../support/harness'

/** 作り物の版を2つ置いた上で回を始める（版の order にない話題も1つ置く） */
async function withEditions(kind: 'edition' | 'correction', now = jst(14, 0), lose?: { commits: number }) {
  const fake = new FakeFirebase()
  const a = makeFakeEdition({ date: '2026-11-18', slot: '20', seed: 'corr-a' })
  const b = makeFakeEdition({ date: '2026-11-17', slot: '12', seed: 'corr-b' })
  seedRecords(fake, [...fakeRecordsOf(a), ...fakeRecordsOf(b)])
  // lose: commit を通したあと、答えを 503 にする（届いたのに答えが届かない形）。lose.commits は 503 にする回数
  const losing = {
    on: false,
    left: lose?.commits ?? 0,
  }
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const res = await fake.fetch(input as never, init)
    if (losing.on && url.includes(':commit') && losing.left > 0) {
      losing.left -= 1
      return new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'test' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }
    return res
  }) as typeof globalThis.fetch
  const s = await draftSetup({ kind, fake, now, config: lose ? { fetch } : undefined })
  return { ...s, a, b, losing }
}

describe('訂正を足す（topic_add_correction）', () => {
  it('版の order の話題に訂正を足す（id だけを返し、作った時刻・回・モデルを出さない）。同じ文は「もうある」', async () => {
    const s = await withEditions('correction')
    const topic = s.a.topics[0]
    const text = '作り物の数は 3本ではなく 4本でした'
    const r = await s.call('topic_add_correction', { model: WRITER, topic: topicShortId(topic.id), text })
    expect(r.isError, r.text).toBeUndefined()
    const id = correctionIdOf({ topicId: topic.id, text })
    expect(r.text).toContain(`訂正を足しました: ${id}（${topicShortId(topic.id)} への訂正。話題は書き換えていません）`)
    expect(r.text).not.toContain(s.runId)
    expect(r.text).not.toContain(WRITER)
    expect(r.text).not.toMatch(/createdAt|20\d\d-\d\d-\d\dT/)
    expect(r.structured).toEqual({ created: [{ id, label: topicShortId(topic.id) }], skipped: [] })
    const rec = JSON.parse(String(s.fake.record(OWNER, `corrections:${id}`)!.json)) as Record<string, unknown>
    expect(rec).toMatchObject({ topicId: topic.id, editionId: topic.id.slice(0, 13), text, model: WRITER, runId: s.runId })
    const again = await s.call('topic_add_correction', { model: WRITER, topic: topic.id, text })
    expect(again.isError).toBeUndefined()
    expect(again.text).toContain(`同じ訂正はもうあります: ${id}`)
    expect(s.core.store.runCount(s.runId, 'corrections')).toBe(1)
  })

  it('訂正できない話題・ふつうの文でない text は断る', async () => {
    const s = await withEditions('correction')
    const unknown = await s.call('topic_add_correction', { model: WRITER, topic: 'p:zzzzzzzz', text: '作り物の訂正' })
    expect(unknown.text).toContain('は訂正できる話題にありません')
    // 止まった回の話題（クラウドにあるが、版の記録が無い）: 写しにあっても訂正できず、探しても出ない
    const stopped = makeFakeEdition({ date: '2026-11-19', slot: '12', seed: 'corr-stopped' })
    seedRecords(
      s.fake,
      fakeRecordsOf(stopped).filter((r) => r.table !== 'editions'),
    )
    s.core.store.putTask('mirror', s.core.now())
    await drainAlarms(s.core, s.clock)
    const lone = stopped.topics[0]
    expect(s.core.mirror.has('topics', lone.id)).toBe(true)
    const r = await s.call('topic_add_correction', { model: WRITER, topic: lone.id, text: '作り物の止まった回への訂正' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('は訂正できる話題にありません')
    expect((await s.call('topic_find_topics', {})).text).not.toContain(topicShortId(lone.id))
    for (const text of ['作り物の\n改行', '作り物 https://example.com/x', '**作り物**'])
      expect(
        (await s.call('topic_add_correction', { model: WRITER, topic: topicShortId(s.a.topics[0].id), text })).isError,
        text,
      ).toBe(true)
  })

  it(`1つの回に版の回は${CORRECTIONS_PER_RUN.edition}件・訂正だけの回は${CORRECTIONS_PER_RUN.correction}件。1日${CORRECTIONS_PER_DAY}件（回の種類を分けない）`, async () => {
    const e = await withEditions('edition', jst(10, 16))
    const topics = [...e.a.topics, ...e.b.topics]
    for (let i = 0; i < CORRECTIONS_PER_RUN.edition; i++)
      expect(
        (await e.call('topic_add_correction', { model: WRITER, topic: topics[i].id, text: `作り物の訂正の文${i}` })).isError,
      ).toBeUndefined()
    const over = await e.call('topic_add_correction', { model: WRITER, topic: topics[5].id, text: '作り物の訂正の文x' })
    expect(over.text).toContain(`1つの回に足せる訂正は${CORRECTIONS_PER_RUN.edition}件までです（版の回）`)
    // 訂正だけの回を2つ: 5件 ＋ 2件で、その日の10件に届く
    const begin = async () => {
      const r = await e.core.callTool('topic_begin_run', { kind: 'correction', model: WRITER }, { grant: e.grant })
      return /runId: (\S+)/.exec(r.text)![1]
    }
    const c1 = await begin()
    for (let i = 0; i < CORRECTIONS_PER_RUN.correction; i++)
      expect(
        (
          await e.core.callTool(
            'topic_add_correction',
            { runId: c1, model: WRITER, topic: topics[i].id, text: `作り物の訂正だけの文${i}` },
            { grant: e.grant },
          )
        ).isError,
      ).toBeUndefined()
    const c2 = await begin()
    const call2 = (i: number) =>
      e.core.callTool(
        'topic_add_correction',
        { runId: c2, model: WRITER, topic: topics[i].id, text: `作り物の二つ目の回の文${i}` },
        { grant: e.grant },
      )
    expect((await call2(0)).isError).toBeUndefined()
    expect((await call2(1)).isError).toBeUndefined()
    const day = await call2(2)
    expect(day.isError).toBe(true)
    expect(day.text).toContain(`今日（日本時間）足せる訂正は${CORRECTIONS_PER_DAY}件までです`)
    expect(day.text).not.toMatch(/訂正だけの回|版の回/)
  })

  it('1つの回の上限は、同時に呼ばれても超えない（書き込みの順番の中で数える）', async () => {
    const e = await withEditions('edition', jst(10, 16))
    const topics = [...e.a.topics, ...e.b.topics]
    const n = CORRECTIONS_PER_RUN.edition + 2
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        e.call('topic_add_correction', { model: WRITER, topic: topics[i].id, text: `作り物の同時の訂正${i}` }),
      ),
    )
    expect(results.filter((r) => !r.isError)).toHaveLength(CORRECTIONS_PER_RUN.edition)
    for (const r of results.filter((x) => x.isError))
      expect(r.text).toContain(`1つの回に足せる訂正は${CORRECTIONS_PER_RUN.edition}件までです`)
    expect(e.core.mirror.rows('corrections')).toHaveLength(CORRECTIONS_PER_RUN.edition)
    expect(e.core.store.runCount(e.runId, 'corrections')).toBe(CORRECTIONS_PER_RUN.edition)
  })

  it('1つの話題に訂正は10件まで（11件目は断る）', async () => {
    const fake = new FakeFirebase()
    const a = makeFakeEdition({ date: '2026-11-18', slot: '20', seed: 'corr-full' })
    const t = a.topics[0]
    const ten = Array.from({ length: 10 }, (_, i) => {
      const text = `作り物のもうある訂正${i}`
      return {
        table: 'corrections' as const,
        record: {
          id: correctionIdOf({ topicId: t.id, text }),
          v: 1,
          createdAt: 1,
          by: 'connector',
          ai: 'claude',
          model: WRITER,
          runId: 'r202611182016-zzzz',
          topicId: t.id,
          editionId: t.editionId,
          text,
        },
      }
    })
    seedRecords(fake, [...fakeRecordsOf(a), ...ten] as never)
    const s = await draftSetup({ kind: 'correction', fake, now: jst(14, 0) })
    const r = await s.call('topic_add_correction', { model: WRITER, topic: t.id, text: '作り物の11件目の訂正' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('1つの話題に訂正は 10件までです')
  })

  it('commit は届いたのに答えが 503 でも、この回の訂正として数え、作れなかった印の答えに出る（横断の点検）', async () => {
    const s = await withEditions('edition', jst(10, 16), { commits: 1 })
    const t = s.a.topics[1]
    const text = '作り物の会議の日付は15日ではなく16日でした'
    s.losing.on = true
    const r = await s.call('topic_add_correction', { model: WRITER, topic: t.id, text })
    s.losing.on = false
    expect(r.isError, r.text).toBeUndefined()
    expect(r.text).toContain('訂正を足しました')
    expect(s.core.store.runCount(s.runId, 'corrections')).toBe(1)
    seedMaterial(s.core, s.runId, 1)
    const fail = await s.call('topic_add_edition_fail', { reasonKind: 'no-sources', reason: '読める資料が足りない' })
    expect(fail.text).toContain('この回で足した訂正: 1件')
    expect(fail.text).toContain(`- ${topicShortId(t.id)}「`)
  })

  it('commit は届いたのに答えが3回とも 503 で道具が失敗し、同じ訂正を送り直すと、この回の訂正として数える（横断の点検）', async () => {
    const s = await withEditions('edition', jst(10, 16), { commits: 3 })
    const t = s.a.topics[2]
    const text = '作り物の数は 7件ではなく 8件でした'
    s.losing.on = true
    const first = await s.call('topic_add_correction', { model: WRITER, topic: t.id, text })
    s.losing.on = false
    expect(first.isError).toBe(true)
    const again = await s.call('topic_add_correction', { model: WRITER, topic: t.id, text })
    expect(again.isError, again.text).toBeUndefined()
    expect(again.text).toContain('訂正を足しました')
    expect(s.core.store.runCount(s.runId, 'corrections')).toBe(1)
    // もう一度送っても数えは増えない
    const third = await s.call('topic_add_correction', { model: WRITER, topic: t.id, text })
    expect(third.text).toContain('同じ訂正はもうあります')
    expect(s.core.store.runCount(s.runId, 'corrections')).toBe(1)
    seedMaterial(s.core, s.runId, 1)
    const fail = await s.call('topic_add_edition_fail', { reasonKind: 'no-sources', reason: '読める資料が足りない' })
    expect(fail.text).toContain('この回で足した訂正: 1件')
  })

  it(`上限（版の回 ${CORRECTIONS_PER_RUN.edition}件）に届いた後に最後の訂正を送り直すと「もうある」。新しい訂正はこれまでどおり断る（横断の点検）`, async () => {
    const e = await withEditions('edition', jst(10, 16))
    const topics = [...e.a.topics, ...e.b.topics]
    for (let i = 0; i < CORRECTIONS_PER_RUN.edition; i++)
      await e.call('topic_add_correction', { model: WRITER, topic: topics[i].id, text: `作り物の訂正の文${i}` })
    const last = CORRECTIONS_PER_RUN.edition - 1
    const again = await e.call('topic_add_correction', { model: WRITER, topic: topics[last].id, text: `作り物の訂正の文${last}` })
    expect(again.isError, again.text).toBeUndefined()
    expect(again.text).toContain('同じ訂正はもうあります')
    const over = await e.call('topic_add_correction', { model: WRITER, topic: topics[5].id, text: '作り物の訂正の文y' })
    expect(over.isError).toBe(true)
    expect(over.text).toContain(`1つの回に足せる訂正は${CORRECTIONS_PER_RUN.edition}件までです（版の回）`)
  })

  it('その回で足した訂正は、版の答えと作れなかった印の答えに全部出る（話題の短い id と文の頭20字）', async () => {
    const s = await withEditions('edition', jst(10, 16))
    const t = s.a.topics[1]
    const text = '作り物の会議の日付は15日ではなく16日でした。作り物の長い文を続ける'
    await s.call('topic_add_correction', { model: WRITER, topic: t.id, text })
    seedMaterial(s.core, s.runId, 1)
    const r = await s.call('topic_add_edition_fail', { reasonKind: 'no-sources', reason: '読める資料が足りない' })
    expect(r.text).toContain('この回で足した訂正: 1件')
    expect(r.text).toContain(`- ${topicShortId(t.id)}「作り物の会議の日付は15日ではなく16日[...]」`)
  })
})

describe('訂正する話題を探す（topic_find_topics）', () => {
  it('30日の内の版の order の話題を、版・日付・枠・語で絞り、今ある訂正の文も返す（資料の印で囲む）', async () => {
    const s = await withEditions('correction')
    const all = await s.call('topic_find_topics', {})
    expect(all.text).toContain('<<<訂正する話題（資料）')
    expect(all.text).toContain(`e:${s.a.edition.id}（11/18 20:00版）`)
    expect(all.text).toContain(topicShortId(s.b.topics[0].id))
    const one = await s.call('topic_find_topics', { edition: `e:${s.b.edition.id}` })
    expect(one.text).not.toContain(`e:${s.a.edition.id}`)
    const bySlot = await s.call('topic_find_topics', { date: '2026-11-18', slot: '20' })
    expect(bySlot.text).toContain(topicShortId(s.a.topics[0].id))
    expect(bySlot.text).not.toContain(topicShortId(s.b.topics[0].id))
    const words = await s.call('topic_find_topics', { words: ['作り物にない語ぜったい'] })
    expect(words.text).toContain('訂正できる話題は見つかりませんでした')
    // 今ある訂正の文
    const text = '作り物の訂正の文（探す時に出る）'
    await s.call('topic_add_correction', { model: WRITER, topic: s.a.topics[0].id, text })
    const after = await s.call('topic_find_topics', { edition: s.a.edition.id })
    expect(after.text).toContain(`今ある訂正: ${text}`)
    // D21: 作った時刻・回・モデルは出さない
    expect(after.text).not.toContain(s.runId)
    expect(after.text).not.toContain(WRITER)
  })

  it('1回に返すのは12,000字まで（残りは数だけ。版・日付・語で絞ってもらう。資料の印の囲いは切れない）', async () => {
    const fake = new FakeFirebase()
    const a = makeFakeEdition({ date: '2026-11-18', slot: '20', seed: 'corr-long' })
    const many = a.topics.slice(0, 6).flatMap((t, k) =>
      Array.from({ length: 10 }, (_, i) => {
        const text = `作り物の長い訂正${k}-${i}${'あ'.repeat(280)}`
        return {
          table: 'corrections' as const,
          record: {
            id: correctionIdOf({ topicId: t.id, text }),
            v: 1,
            createdAt: 1,
            by: 'connector',
            ai: 'claude',
            model: WRITER,
            runId: 'r202611182016-zzzz',
            topicId: t.id,
            editionId: t.editionId,
            text,
          },
        }
      }),
    )
    seedRecords(fake, [...fakeRecordsOf(a), ...many] as never)
    const s = await draftSetup({ kind: 'correction', fake, now: jst(14, 0) })
    const r = await s.call('topic_find_topics', {})
    expect(r.isError).toBeUndefined()
    expect(Array.from(r.text).length).toBeLessThan(13_000)
    expect(r.text).toMatch(/ほかに \d+本（版・日付・語で絞ってください）/)
    expect(r.text).toContain('訂正する話題（資料）ここまで>>>')
  })

  it('回は要らない（runId なしで呼べる）。写しを新しくしてから探す', async () => {
    const s = await withEditions('correction')
    const late = makeFakeEdition({ date: '2026-11-19', slot: '12', seed: 'corr-late' })
    seedRecords(s.fake, fakeRecordsOf(late))
    s.clock.now += 60_000
    const r = await s.core.callTool('topic_find_topics', { date: '2026-11-19' }, { grant: s.grant })
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain(`e:${late.edition.id}`)
    await drainAlarms(s.core, s.clock)
  })
})
