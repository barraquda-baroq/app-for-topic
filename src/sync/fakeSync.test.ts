// 偽のクラウド（src/test/fakeCloud.ts。エンジンと同じ決まりで送受信する）で確かめる同期の場面（docs/SPEC.md の 16.3 の「偽のクラウド」・7.8）。
// エミュレーター無しで速く回す。16.3 の行の場面（2台の既読・電波の無い間の「知ってる」・返事が届かない書き込み・話題が先で版の記録が後・
// 版の記録が無い話題・30日の削除と端末の中の削除・0時をまたぐ既読・ほかの端末の30日の削除・訂正の届く順）に、初めての受け取りの2段と
// 30日の手入れの決まり（時計の進んだ端末・1日2,000件・1日1回）、持ち主・データの形の版を足した（エミュレーターでも確かめる。16.3）。
// 記録は作り物だけ（src/test/fixtures/fakeEditions.ts。「〇〇市」・https://example.com/…）
import { afterEach, describe, expect, it } from 'vitest'
import type { AnyRecord } from '../db/persistence'
import { correctionIdOf, editionIdOf, isExpiredDocId, termIdOf } from '../domain/ids'
import { addDaysToDate, firstSyncSinceMs, isWithinRetention, jstStartOfDayMs, retentionBoundary } from '../domain/jst'
import { pressKnownTerm } from '../domain/known'
import type { CorrectionRecord, KnownTerm, ReadMark, Topic } from '../domain/types'
import { FakeCloud, FakeDevice, settle, type FakeDeviceOptions } from '../test/fakeCloud'
import { FAKE_MODEL, RULING_JP_KEY, fakeRecordsOf, makeFakeEdition, makeFakeMonth } from '../test/fixtures/fakeEditions'
import { DATA_MODEL } from './appVersion'
import { encodeRecord, recordDocOf } from './codec'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const UNTIL = '2026-11-15'
/** until の日の 23:00（日本時間）。20:00版と、その後に足した訂正より後 */
const NOW = jstStartOfDayMs(UNTIL) + 23 * HOUR
/** until の次の日の 0:05（日本時間。0時をまたいだ後） */
const AFTER_MIDNIGHT = jstStartOfDayMs(addDaysToDate(UNTIL, 1)) + 5 * MIN

const opened: FakeDevice[] = []
afterEach(() => {
  for (const d of opened.splice(0)) d.p.close()
})

function track(d: FakeDevice): FakeDevice {
  opened.push(d)
  return d
}

const newCloud = (opts: { owner?: string | null } = {}) => new FakeCloud({ now: NOW, ...opts })

/** 端末を始めて、最初の受け取りまで済ませる */
async function started(cloud: FakeCloud, name: string, opts: FakeDeviceOptions = {}): Promise<FakeDevice> {
  const d = track(new FakeDevice(name, cloud, opts))
  await d.start()
  await d.sync()
  return d
}

/** 開き直して、最初の受け取りまで済ませる */
async function reopened(d: FakeDevice, opts: Parameters<FakeDevice['reopen']>[0] = {}): Promise<FakeDevice> {
  const next = track(d.reopen(opts))
  await next.start()
  await next.sync()
  return next
}

/** 作り物の記録を、作った時刻を updated にしてクラウドに置く（コネクタが足した時と同じ順） */
function seed(cloud: FakeCloud, src: Parameters<typeof fakeRecordsOf>[0]): void {
  cloud.addAll(fakeRecordsOf(src), (r) => r.createdAt ?? cloud.now)
}

const readOf = async (d: FakeDevice, editionId: string) => (await d.userRecords()).reads[editionId] as ReadMark | undefined
const knownOf = async (d: FakeDevice, termId: string) => (await d.userRecords()).knownTerms[termId] as KnownTerm | undefined

/** 作り物の訂正（コネクタが足す形。docs/SPEC.md の 7.1 の「訂正」） */
function correctionFor(topic: Topic, text: string, createdAt: number): CorrectionRecord {
  return {
    id: correctionIdOf({ topicId: topic.id, text }),
    v: 1,
    createdAt,
    by: 'connector',
    ai: 'claude',
    model: FAKE_MODEL,
    runId: 'r-fake-correction',
    topicId: topic.id,
    editionId: topic.id.slice(0, 13),
    text,
  }
}

const press = { termId: termIdOf(RULING_JP_KEY), term: '与党' }

describe('2台の既読（docs/SPEC.md の 7.8 の「既読・知ってるを送る・受け取る」）', () => {
  it('PC で1本目、スマホで2本目を読み、スマホは版の一覧も見た → 両方の端末で両方とも既読・見た（private に置く）', async () => {
    const cloud = newCloud()
    const fake = makeFakeEdition({ date: UNTIL, slot: '12', seed: 'two-devices' })
    seed(cloud, fake)
    const pc = await started(cloud, 'pc')
    const phone = await started(cloud, 'phone')
    const id = fake.edition.id
    const [t1, t2] = fake.edition.order
    await pc.markRead(id, t1)
    await phone.markRead(id, t2, { seen: true })
    await pc.sync()
    await phone.sync()
    await settle(pc, phone)
    for (const d of [pc, phone]) {
      const r = await readOf(d, id)
      expect([...(r?.topicIds ?? [])].sort()).toEqual([t1, t2].sort())
      expect(r?.seen).toBe(true)
      expect(await d.p.outboxCount()).toBe(0)
    }
    // 既読は Claude が読めない置き場だけにある
    expect(cloud.doc('private', `reads:${id}`)).toBeDefined()
    expect(cloud.doc('records', `reads:${id}`)).toBeUndefined()
    expect(cloud.tombstones()).toEqual([])
  })
})

describe('電波の無い間に「知ってる」と外す', () => {
  it('スマホで「知ってる」、電波の無い PC で押して外す → PC が後で同期すれば「外した」。asOf は新しい方', async () => {
    const cloud = newCloud()
    const phone = await started(cloud, 'phone')
    const pc = await started(cloud, 'pc')
    await phone.know({ ...press, asOf: '2026-12' })
    await phone.sync()
    pc.offline()
    await pc.know({ ...press, asOf: '2026-11' })
    await pc.unknow(press.termId)
    await settle(pc, phone)
    for (const d of [phone, pc]) {
      expect(await knownOf(d, press.termId)).toMatchObject({ on: false, term: '与党', asOf: '2026-12' })
      expect(await d.p.outboxCount()).toBe(0)
    }
  })

  it('両方の端末で受け取った後に、電波の無い PC で外し、スマホは新しい説明の話題で押し直した → 外した。asOf は新しい方', async () => {
    const cloud = newCloud()
    const phone = await started(cloud, 'phone')
    const pc = await started(cloud, 'pc')
    await phone.know({ ...press, asOf: '2026-11' })
    await settle(phone, pc)
    pc.offline()
    await pc.unknow(press.termId)
    await phone.know({ ...press, asOf: '2026-12' })
    await phone.sync()
    await settle(pc, phone)
    for (const d of [phone, pc]) expect(await knownOf(d, press.termId)).toMatchObject({ on: false, asOf: '2026-12' })
  })
})

describe('返事が届かない書き込み', () => {
  // 書き込みは届いたが返事が無く、ほかの端末がその書き込みの上で「知ってる」を外した。送る書き込みの印でその書き込みが届いていたと
  // 分かるので、送った内容を base にして合わせる（古い base = null で合わせると、この端末の「知ってる」が勝って、外したのが戻る）
  for (const order of ['受け取ってから送る', 'もう一度押してから送る'] as const) {
    it(`その上にほかの端末が外した版を、送った内容を base にして合わせる（${order}）`, async () => {
      const cloud = newCloud()
      const a = await started(cloud, 'A')
      const b = await started(cloud, 'B')
      await a.know({ ...press, asOf: '2026-11' })
      await a.uploadBatch({ replyLost: true })
      expect(await a.p.outboxCount()).toBe(1)
      await b.sync()
      expect(await knownOf(b, press.termId)).toMatchObject({ on: true })
      await b.unknow(press.termId)
      await b.sync()
      a.offline()
      if (order === 'もう一度押してから送る') {
        await a.know({ ...press, asOf: '2026-12' })
        await a.uploadBatch()
      } else await a.receive()
      await settle(a, b)
      for (const d of [a, b]) {
        expect(await knownOf(d, press.termId)).toMatchObject({
          on: false,
          asOf: order === 'もう一度押してから送る' ? '2026-12' : '2026-11',
        })
        expect(await d.p.outboxCount()).toBe(0)
      }
    })
  }

  it('返事が届かなかった既読も、2台の分が両方残る', async () => {
    const cloud = newCloud()
    const fake = makeFakeEdition({ date: UNTIL, slot: '20', seed: 'reply-lost' })
    seed(cloud, fake)
    const a = await started(cloud, 'A')
    const b = await started(cloud, 'B')
    const id = fake.edition.id
    await a.markRead(id, fake.edition.order[0])
    await a.uploadBatch({ replyLost: true })
    await b.sync()
    await b.markRead(id, fake.edition.order[1])
    await b.sync()
    await settle(a, b)
    for (const d of [a, b]) expect((await readOf(d, id))?.topicIds).toEqual(fake.edition.order.slice(0, 2))
  })
})

describe('版を出す条件（docs/SPEC.md の 7.8 の「版を出す条件」）', () => {
  it('話題が先・版の記録が後に届く → 版の記録が届き、order の話題がそろうまで出さない', async () => {
    const cloud = newCloud()
    const a = await started(cloud, 'A')
    const fake = makeFakeEdition({ date: UNTIL, slot: '12', seed: 'arrive-late' })
    const id = fake.edition.id
    cloud.add('termPacks', fake.termPack)
    for (const t of fake.topics.slice(0, 10)) cloud.add('topics', t)
    await a.receive()
    expect(await a.p.topicsOfEdition(id)).toHaveLength(10)
    expect(await a.shownEdition(id)).toEqual({ kind: 'none' })
    // 版の記録が届いても、最後の1本がまだ無ければ出さない
    for (const t of fake.topics.slice(10, 19)) cloud.add('topics', t)
    cloud.add('editions', fake.edition)
    await a.receive()
    expect(await a.shownEdition(id)).toEqual({ kind: 'waiting', missing: [fake.topics[19].id] })
    cloud.add('topics', fake.topics[19])
    await a.receive()
    const shown = await a.shownEdition(id)
    expect(shown.kind).toBe('ready')
    expect(shown.kind === 'ready' && shown.topics.map((t) => t.id)).toEqual(fake.edition.order)
    // 辞書の束は端末に入らない
    expect(await a.p.outboxCount()).toBe(0)
  })

  it('最初の受け取りが終わっても欠けている話題は直接読む。クラウドにも無ければ、そろっている話題だけで出す', async () => {
    const cloud = newCloud()
    const late = makeFakeEdition({ date: UNTIL, slot: '12', seed: 'old-updated' })
    const broken = makeFakeEdition({ date: UNTIL, slot: '20', seed: 'connector-bug' })
    // 1本は32日の窓より前に書かれていて、購読では届かない（直接読めば届く）
    for (const t of late.topics.slice(0, 19)) cloud.add('topics', t)
    cloud.add('topics', late.topics[19], { at: NOW - 40 * DAY })
    cloud.add('editions', late.edition)
    // コネクタの不具合: 1本がクラウドに無い
    for (const t of broken.topics.slice(1)) cloud.add('topics', t)
    cloud.add('editions', broken.edition)
    const a = await started(cloud, 'A')
    expect(a.downloaded).toBe(true)
    const w1 = await a.shownEdition(late.edition.id)
    const w2 = await a.shownEdition(broken.edition.id)
    expect(w1).toEqual({ kind: 'waiting', missing: [late.topics[19].id] })
    expect(w2).toEqual({ kind: 'waiting', missing: [broken.topics[0].id] })
    const reads = cloud.readsOf('A')
    const got = await a.fetchTopics([late.topics[19].id, broken.topics[0].id])
    expect(got).toEqual({ found: [late.topics[19].id], missing: [broken.topics[0].id] })
    expect(cloud.readsOf('A') - reads).toBe(2)
    expect((await a.shownEdition(late.edition.id)).kind).toBe('ready')
    const shown = await a.shownEdition(broken.edition.id, new Set(got.missing))
    expect(shown).toMatchObject({ kind: 'ready', missing: [broken.topics[0].id] })
    expect(shown.kind === 'ready' && shown.topics).toHaveLength(19)
  })

  it('版の記録が無い話題（途中で止まった回）は出さない。版の order に無い話題も出さない。作れなかった印だけの枠も版として出さない', async () => {
    const cloud = newCloud()
    const aborted = makeFakeEdition({ date: UNTIL, slot: '12', seed: 'aborted-try' })
    const final = makeFakeEdition({ date: UNTIL, slot: '12', seed: 'final-try' })
    expect(aborted.edition.order.some((t) => final.edition.order.includes(t))).toBe(false)
    const a = await started(cloud, 'A')
    for (const t of aborted.topics) cloud.add('topics', t)
    await a.receive()
    expect(await a.shownEdition(aborted.edition.id)).toEqual({ kind: 'none' })
    seed(cloud, final)
    await a.receive()
    expect(await a.p.topicsOfEdition(final.edition.id)).toHaveLength(40)
    const shown = await a.shownEdition(final.edition.id)
    expect(shown.kind === 'ready' && shown.topics.map((t) => t.id)).toEqual(final.edition.order)

    const month = makeFakeMonth({ until: UNTIL, days: 3, seed: 'fail-only' })
    seed(cloud, month)
    await a.receive()
    expect(await a.shownEdition(month.scenes.failedEditionId)).toEqual({ kind: 'none' })
    expect((await a.p.listEditionFails()).map((f) => f.id)).toEqual(month.editionFails.map((f) => f.id))
  })
})

describe('訂正の届く順（docs/SPEC.md の 7.8 の「訂正を足す・出す」）', () => {
  it('訂正が話題より後に届く・先に届く → どちらも話題に付く。話題の無い訂正は出さない', async () => {
    const cloud = newCloud()
    const e1 = makeFakeEdition({ date: addDaysToDate(UNTIL, -1), slot: '20', seed: 'corr-1' })
    const e2 = makeFakeEdition({ date: UNTIL, slot: '12', seed: 'corr-2' })
    const stray = makeFakeEdition({ date: UNTIL, slot: '12', seed: 'corr-stray' })
    seed(cloud, e1)
    const a = await started(cloud, 'A')

    const after = correctionFor(e1.topics[0], '〇〇市の発表の日付は 11月13日ではなく 11月14日でした', cloud.now)
    cloud.add('corrections', after)
    await a.receive()
    const s1 = await a.shownEdition(e1.edition.id)
    expect(s1.kind === 'ready' && s1.corrections?.get(e1.topics[0].id)?.map((c) => c.id)).toEqual([after.id])

    const before = correctionFor(e2.topics[2], '△△県の人口は 120万人ではなく 102万人でした', cloud.now)
    const orphan = correctionFor(stray.topics[0], '〇〇通信の記事の題が違っていました', cloud.now)
    cloud.add('corrections', before)
    cloud.add('corrections', orphan)
    await a.receive()
    expect(await a.shownEdition(e2.edition.id)).toEqual({ kind: 'none' })
    expect((await a.p.correctionsOfTopic(e2.topics[2].id)).map((c) => c.id)).toEqual([before.id])
    for (const r of fakeRecordsOf(e2)) cloud.add(r.table, r.record)
    await a.receive()
    const s2 = await a.shownEdition(e2.edition.id)
    expect(s2.kind).toBe('ready')
    if (s2.kind !== 'ready') return
    expect(s2.corrections?.get(e2.topics[2].id)?.map((c) => c.id)).toEqual([before.id])
    expect([...(s2.corrections?.values() ?? [])].flat().map((c) => c.id)).not.toContain(orphan.id)
  })
})

describe('30日で消す（docs/SPEC.md の 7.8 の「30日で消す」「端末の中で消す」）', () => {
  it('1台がクラウドから消し、2台目は0件。1日たつと端末の中からも消える（訂正も話題と同じ日に消える）。削除の印は書かない', async () => {
    const cloud = newCloud()
    const month = makeFakeMonth({ until: UNTIL, days: 35 })
    seed(cloud, month)
    const a = await started(cloud, 'A')
    const b = await started(cloud, 'B')
    const { firstKeptDate } = retentionBoundary(NOW)
    // 端末には30日の内の版だけ（初めての受け取りの32日の窓の前の2日分も入れない）
    const kept = month.editions.filter((e) => e.edition.date >= firstKeptDate)
    expect((await a.p.listEditions()).map((e) => e.id)).toEqual(kept.map((e) => e.edition.id))
    // 30日の内でいちばん古い版を既読にし、その話題に訂正を足す（次の日に消える物）
    const edge = kept[0]
    await a.markRead(edge.edition.id, edge.topics[0].id, { seen: true })
    const edgeFix = correctionFor(edge.topics[0], '〇〇市の新しい橋の長さは 320メートルではなく 330メートルでした', cloud.now)
    cloud.add('corrections', edgeFix)
    await settle(a, b)
    expect((await b.p.correctionsOfTopic(edge.topics[0].id)).map((c) => c.id)).toEqual([edgeFix.id])
    // クラウドにはまだ30日の外の物が残っている（誰も手入れしていない）
    const oldest = month.scenes.corrections.oldest
    const oldestFix = month.corrections.find((c) => c.topicId === oldest)!
    expect(cloud.record('topics', oldest)).toBeDefined()
    expect(cloud.record('corrections', oldestFix.id)).toBeDefined()

    const r1 = await a.maintain()
    expect(r1.total).toBeGreaterThan(0)
    expect(r1.deleted.editions).toBe(10)
    expect(r1.deleted.corrections).toBe(1)
    expect(r1.capped).toBe(false)
    for (const d of cloud.docs.values()) expect(isExpiredDocId(d.docId, cloud.now), d.docId).toBe(false)
    expect(cloud.record('topics', oldest)).toBeUndefined()
    expect(cloud.record('corrections', oldestFix.id)).toBeUndefined()
    // 辞書の束・知ってるは消さない
    expect([...cloud.docs.values()].filter((d) => d.data.table === 'termPacks')).toHaveLength(month.editions.length)
    expect((await b.maintain()).total).toBe(0)
    expect(await a.maintain()).toMatchObject({ skipped: 'done-today', total: 0 })

    // 次の日: 端末の中で消す（日付が変わった後の最初の送受信で）。訂正も話題と同じ日に消える
    cloud.tick(DAY)
    await a.sync()
    expect((await a.p.listEditions()).some((e) => e.id === edge.edition.id)).toBe(false)
    expect(await a.p.topicsOfEdition(edge.edition.id)).toEqual([])
    expect(await a.p.correctionsOfTopic(edge.topics[0].id)).toEqual([])
    expect(await readOf(a, edge.edition.id)).toBeUndefined()
    expect(await a.p.outboxCount()).toBe(0)
    // クラウドは次の日の手入れで消える（既読も private から）
    const r2 = await b.maintain()
    expect(r2.deleted).toMatchObject({ editions: 2, reads: 1, corrections: 1 })
    expect(cloud.doc('private', `reads:${edge.edition.id}`)).toBeUndefined()
    expect(cloud.record('corrections', edgeFix.id)).toBeUndefined()
    expect(cloud.tombstones()).toEqual([])
  })

  it('時計の進んだ端末は、サーバーの時刻の見積もりで消すので、30日の内の物を早く消さない', async () => {
    const cloud = newCloud()
    const month = makeFakeMonth({ until: UNTIL, days: 35, seed: 'fast-clock' })
    seed(cloud, month)
    const fast = await started(cloud, 'fast', { clockOffset: 3 * DAY })
    // 自分の書き込みの知らせで、サーバーの時刻の見積もりが本当の時刻に近づく
    await fast.know({ ...press, asOf: null })
    await fast.sync()
    expect(Math.abs((fast.serverNow() ?? 0) - cloud.now)).toBeLessThan(MIN)
    // クラウドは本当に消せる物しか消させない（ルールのまね。早く消そうとすると投げる）
    const r = await fast.maintain()
    expect(r.total).toBeGreaterThan(0)
    const { firstKeptDate } = retentionBoundary(cloud.now)
    expect(cloud.record('editions', editionIdOf(firstKeptDate, '12'))).toBeDefined()
    for (const d of cloud.docs.values()) expect(isExpiredDocId(d.docId, cloud.now), d.docId).toBe(false)
  })

  it('1台1日 2,000件まで（450件ずつ）。続きは次の日に消す', async () => {
    const cloud = newCloud()
    const old = editionIdOf(addDaysToDate(UNTIL, -40), '12')
    for (let i = 0; i < 2_500; i++) {
      const id = `${old}-${i.toString(36).padStart(8, '0')}`
      cloud.add(
        'topics',
        {
          id,
          v: 1,
          createdAt: NOW - 40 * DAY,
          by: 'connector',
          ai: 'claude',
          model: FAKE_MODEL,
          runId: 'r-old',
          editionId: old,
        } as AnyRecord,
        { at: NOW - 40 * DAY },
      )
    }
    const a = await started(cloud, 'A')
    // 古い話題は32日の窓より前なので受け取らない
    expect(await a.p.topicsOfEdition(old)).toEqual([])
    expect(await a.maintain()).toMatchObject({ skipped: 'no-server-time' })
    await a.know({ ...press, asOf: null })
    await a.sync()
    const before = cloud.readsOf('A')
    const r1 = await a.maintain()
    expect(r1).toMatchObject({ total: 2_000, capped: true, deleted: { topics: 2_000 } })
    expect(cloud.readsOf('A') - before).toBe(2_000 + 2)
    expect([...cloud.docs.values()].filter((d) => d.data.table === 'topics')).toHaveLength(500)
    expect(await a.maintain()).toMatchObject({ skipped: 'done-today' })
    cloud.tick(DAY)
    const r2 = await a.maintain()
    expect(r2).toMatchObject({ total: 500, capped: false })
    expect([...cloud.docs.values()].filter((d) => d.data.table === 'topics')).toHaveLength(0)
  })
})

describe('電波の無い間に読んだ既読（docs/SPEC.md の 7.8 の「送る側の守り」）', () => {
  for (const clock of ['端末の時計が合っている', '端末の時計が10分遅れている'] as const) {
    it(`0時をまたいで30日を過ぎても送信が止まらず、削除の印も書かない（${clock}）`, async () => {
      const cloud = newCloud()
      const month = makeFakeMonth({ until: UNTIL, days: 31, seed: 'offline-read' })
      seed(cloud, month)
      const a = await started(cloud, 'A', { clockOffset: clock === '端末の時計が合っている' ? 0 : -10 * MIN })
      // 自分の書き込みの知らせで、サーバーの時刻の見積もりを本当の時刻に近づける
      await a.know({ termId: termIdOf('〇〇法'), term: '〇〇法', asOf: null })
      await a.sync()
      const edge = editionIdOf(retentionBoundary(NOW).firstKeptDate, '20')
      const ed = month.editions.find((e) => e.edition.id === edge)!
      a.offline()
      await a.markRead(edge, ed.topics[0].id, { seen: true })
      await a.know({ ...press, asOf: '2026-11' })
      expect(await a.p.outboxCount()).toBe(2)
      cloud.now = AFTER_MIDNIGHT
      expect(isWithinRetention(edge.slice(0, 10), cloud.now)).toBe(false)
      await a.sync()
      expect(await a.p.outboxCount()).toBe(0)
      expect(cloud.record('knownTerms', press.termId)).toBeDefined()
      expect(cloud.record('reads', edge)).toBeUndefined()
      expect(cloud.tombstones()).toEqual([])
    })
  }

  for (const clock of ['端末の時計が合っている', '端末の時計が遅れ、見積もりも無い（開き直した）'] as const) {
    it(`既読の送信待ちがある端末で、別の端末が30日の削除をした → 送信待ち 0件・作り直さない（${clock}）`, async () => {
      const cloud = newCloud()
      const month = makeFakeMonth({ until: UNTIL, days: 31, seed: 'other-expired' })
      seed(cloud, month)
      let a = await started(cloud, 'A')
      const b = await started(cloud, 'B')
      const edge = editionIdOf(retentionBoundary(NOW).firstKeptDate, '20')
      const ed = month.editions.find((e) => e.edition.id === edge)!
      await a.markRead(edge, ed.topics[0].id)
      await settle(a, b)
      expect(cloud.record('reads', edge)).toBeDefined()
      a.offline()
      await a.markRead(edge, ed.topics[1].id)
      cloud.now = AFTER_MIDNIGHT
      // B が30日の手入れで既読を消した（ほかの記録も。B は A の既読の知らせを受け取った時に、サーバーの時刻の見積もりができている）
      expect((await b.maintain()).deleted.reads).toBe(1)
      expect(cloud.record('reads', edge)).toBeUndefined()
      if (clock !== '端末の時計が合っている') {
        // 開き直した A は、新しい文書を受け取らないので、サーバーの時刻の見積もりが古い文書から（本当の時刻より遅れる）。端末の時計も
        // 遅れているので、送る前の守りでは捨てられず、送るトランザクションでクラウドに無いと分かる（作り直さずに送り終わり）
        a = await reopened(a, { clockOffset: -10 * MIN })
        expect(isWithinRetention(edge.slice(0, 10), a.serverNow() ?? 0)).toBe(true)
        expect((await readOf(a, edge))?.topicIds).toHaveLength(2)
      }
      await a.sync()
      expect(await a.p.outboxCount()).toBe(0)
      expect(cloud.record('reads', edge)).toBeUndefined()
      expect(cloud.tombstones()).toEqual([])
    })
  }
})

describe('初めての受け取り（docs/SPEC.md の 7.8 の「版と話題を受け取る」）', () => {
  it('「知ってる」は全部、版・話題は端末の時計 − 32日より後に書かれた物だけを読む。位置は購読を始めた位置まで進み、firstSync は消える', async () => {
    const cloud = newCloud()
    const month = makeFakeMonth({ until: UNTIL, days: 35, seed: 'first-sync' })
    seed(cloud, month)
    // 100日前にほかの端末が押した「知ってる」
    const old = pressKnownTerm(null, { termId: termIdOf('〇〇法'), term: '〇〇法', asOf: null }, NOW - 100 * DAY)
    cloud.writeApp(
      'records',
      recordDocOf('knownTerms', old.id, encodeRecord(old), { device: 'old-phone', updated: NOW - 100 * DAY }),
      'old-phone',
    )
    const a = track(new FakeDevice('A', cloud))
    await a.start()
    await a.receive()
    expect(a.downloaded).toBe(true)
    expect(a.knownReads).toBe(1)
    expect(await knownOf(a, old.id)).toEqual(old)
    // 30日より前の版・話題は端末に無い
    for (const e of await a.p.listEditions()) expect(isWithinRetention(e.id.slice(0, 10), NOW), e.id).toBe(true)
    // 読んだ文書の数: 持ち主・データの形の版・「知ってる」1・32日の窓の中の文書（辞書の束を除く）・private の空の問い合わせ1
    const since = firstSyncSinceMs(NOW)
    const inWindow = [...cloud.docs.values()].filter(
      (d) => d.place === 'records' && d.data.updated >= since && d.data.table !== 'termPacks',
    ).length
    expect(cloud.readsOf('A')).toBe(2 + 1 + inWindow + 1)
    expect(await a.p.getMeta('firstSync')).toBeNull()
    expect(await a.p.getMeta('caughtUpAt')).toBe(NOW)
    expect(a.cursor.records && a.cursor.records.s * 1000).toBeGreaterThanOrEqual(since - 1000)
  })

  it('記録が1件も無いクラウドでも、位置を購読を始めた位置まで進める', async () => {
    const cloud = newCloud()
    const a = await started(cloud, 'A')
    expect(a.downloaded).toBe(true)
    expect(a.cursor.records).toEqual({ s: Math.floor(firstSyncSinceMs(NOW) / 1000), n: (firstSyncSinceMs(NOW) % 1000) * 1e6 })
    // 開き直しても初めての受け取りに入らない
    const b = await reopened(a)
    expect(b.knownReads).toBe(0)
  })

  it('2. の購読が失敗して再試行しても 1. を読み直さない（開き直した時も）', async () => {
    const cloud = newCloud()
    seed(cloud, makeFakeEdition({ date: UNTIL, slot: '12', seed: 'retry' }))
    cloud.failListen.add('A')
    let a = track(new FakeDevice('A', cloud))
    await a.start()
    await a.receive()
    expect(a.knownReads).toBe(1)
    expect(a.downloaded).toBe(false)
    expect(a.errorCode).toBe('listen')
    expect(await a.p.getMeta('firstSync')).toMatchObject({ knownAt: expect.any(Number) })
    await a.receive()
    expect(a.knownReads).toBe(1)
    a = track(a.reopen())
    await a.start()
    await a.receive()
    expect(a.knownReads).toBe(0)
    cloud.failListen.delete('A')
    await a.receive()
    expect(a.knownReads).toBe(0)
    expect(a.downloaded).toBe(true)
    expect(a.errorCode).toBeNull()
    expect(await a.p.getMeta('firstSync')).toBeNull()
    expect((await a.p.listEditions()).length).toBe(1)
  })

  it('1. が失敗した時は、再試行で 1. から', async () => {
    const cloud = newCloud()
    cloud.failQuery.add('A')
    const a = track(new FakeDevice('A', cloud))
    await a.start()
    expect(a.knownReads).toBe(0)
    expect((await a.p.getMeta('firstSync')) ?? null).toBeNull()
    cloud.failQuery.delete('A')
    await a.receive()
    expect(a.knownReads).toBe(1)
    expect(a.downloaded).toBe(true)
  })

  it('31日書かれない間に10回開いても、「知ってる」を全部読むのは1回', async () => {
    const cloud = newCloud()
    seed(cloud, makeFakeMonth({ until: UNTIL, days: 3, seed: 'quiet' }))
    let a = await started(cloud, 'A')
    let total = a.knownReads
    for (let i = 0; i < 10; i++) {
      cloud.tick(4 * DAY)
      a = await reopened(a)
      total += a.knownReads
    }
    expect(total).toBe(1)
  })

  it('最後にそろってから31日より長く開かなかった端末は、初めての受け取りからやり直す（「知ってる」は位置より後の物だけ）', async () => {
    const cloud = newCloud()
    seed(cloud, makeFakeMonth({ until: UNTIL, days: 3, seed: 'stale' }))
    const a = await started(cloud, 'A')
    await a.know({ ...press, asOf: null })
    await a.sync()
    cloud.tick(40 * DAY)
    const reads = cloud.readsOf('A')
    const b = await reopened(a)
    expect(b.knownReads).toBe(1)
    // 「知ってる」は位置（自分の書き込み）より後の物（=自分の1件）だけ。版は30日の外なので端末から消える
    expect(await knownOf(b, press.termId)).toMatchObject({ on: true })
    expect(await b.p.listEditions()).toEqual([])
    expect(cloud.readsOf('A') - reads).toBeLessThan(10)
  })
})

describe('購読し直し（docs/SPEC.md の 7.8 の engine.ts の reanchor・7.9 の「購読し直し」）', () => {
  /** 位置の時刻（ms） */
  const cursorMs = (d: FakeDevice) => {
    const c = d.cursor.records
    return c ? c.s * 1000 + Math.floor(c.n / 1_000_000) : null
  }

  it('新しい版が届いて位置が進んだ後だけ、位置から購読し直す（読むのは位置と同じ時刻の文書だけ）', async () => {
    const cloud = newCloud()
    seed(cloud, makeFakeEdition({ date: UNTIL, slot: '12', seed: 'reanchor-a' }))
    const a = await started(cloud, 'A')
    // 2. を終えた時に位置から購読し直している。進んでいなければ購読し直さない
    const from0 = a.subscribedFrom('records')
    expect(from0).toBe(cursorMs(a))
    await a.reanchor()
    expect(a.subscribedFrom('records')).toBe(from0)
    // 新しい版が届く
    cloud.tick(HOUR)
    const next = makeFakeEdition({ date: addDaysToDate(UNTIL, 1), slot: '12', seed: 'reanchor-a2' })
    cloud.addAll(fakeRecordsOf(next), () => cloud.now)
    await a.receive()
    expect(cursorMs(a)).toBe(cloud.now)
    expect(a.subscribedFrom('records')).toBe(from0)
    await a.reanchor()
    expect(a.subscribedFrom('records')).toBe(cloud.now)
    const reads = cloud.readsOf('A')
    await a.receive()
    const sameTime = fakeRecordsOf(next).filter((r) => r.table !== 'termPacks').length
    expect(cloud.readsOf('A') - reads).toBe(sameTime)
    expect(a.knownReads).toBe(1)
  })

  it('開いたまま31日そろわなかった後は、初めての受け取りに入り直す（「知ってる」は位置から1回）', async () => {
    const cloud = newCloud()
    seed(cloud, makeFakeEdition({ date: UNTIL, slot: '12', seed: 'reanchor-b' }))
    const a = await started(cloud, 'A')
    expect(a.downloaded).toBe(true)
    cloud.tick(40 * DAY)
    await a.reanchor()
    expect(a.downloaded).toBe(false)
    expect(a.knownReads).toBe(2)
    expect(a.subscribedFrom('records')).toBe(firstSyncSinceMs(a.now()))
    await a.sync()
    expect(a.downloaded).toBe(true)
    expect(cursorMs(a)! >= firstSyncSinceMs(a.now()) - 1000).toBe(true)
    expect(await a.p.getMeta('firstSync')).toBeNull()
    expect(a.caughtUpAt).toBe(a.now())
    expect(await a.p.listEditions()).toEqual([])
  })

  it('初めての受け取りの 2. の途中・購読の再試行を待っている間は、何もしない', async () => {
    const cloud = newCloud()
    const a = track(new FakeDevice('A', cloud))
    await a.start()
    expect(a.firstPending).toBe(true)
    const from = a.subscribedFrom('records')
    cloud.tick(40 * DAY)
    await a.reanchor()
    expect(a.knownReads).toBe(1)
    expect(a.subscribedFrom('records')).toBe(from)
    // 購読が止まって、再試行を待っている
    cloud.failListen.add('A')
    await a.receive()
    expect(a.subscribedFrom('records')).toBeNull()
    await a.reanchor()
    expect(a.subscribedFrom('records')).toBeNull()
    expect(a.knownReads).toBe(1)
  })
})

describe('持ち主・データの形の版（docs/SPEC.md の 7.8 の「持ち主・データの形の版・同期の表示」）', () => {
  it('持ち主の記録が無い → 同期しない（送らない・受け取らない）', async () => {
    const cloud = newCloud({ owner: null })
    seed(cloud, makeFakeEdition({ date: UNTIL, slot: '12', seed: 'no-owner' }))
    const a = track(new FakeDevice('A', cloud))
    await a.start()
    expect(a.errorCode).toBe('owner-missing')
    await a.know({ ...press, asOf: null })
    await a.sync()
    expect(await a.p.outboxCount()).toBe(1)
    expect(await a.p.listEditions()).toEqual([])
    expect(cloud.readsOf('A')).toBe(1)
  })

  it('ほかのアカウントの記録 → 同期せず、この端末の持ち主の印を消す', async () => {
    const cloud = newCloud({ owner: 'someone-else' })
    const a = track(new FakeDevice('A', cloud))
    await a.p.setMeta('ownerSeen', 'fake-user')
    await a.start()
    expect(a.errorCode).toBe('owner-mismatch')
    expect(await a.p.getMeta('ownerSeen')).toBeNull()
  })

  it('前に別のアカウントで同期した端末 → 確かめた印が無ければ同期しない。印があれば写しを消して受け取り直す', async () => {
    const cloudA = new FakeCloud({ now: NOW, owner: 'uid-a' })
    seed(cloudA, makeFakeEdition({ date: UNTIL, slot: '12', seed: 'switch-a' }))
    const a = await started(cloudA, 'A', { uid: 'uid-a' })
    expect(await a.p.listEditions()).toHaveLength(1)
    a.p.close()
    const cloud = newCloud()
    const b = track(new FakeDevice('A', cloud, { dbName: a.dbName }))
    await b.start()
    expect(b.errorCode).toBe('account-mismatch')
    expect(await b.p.getMeta('uid')).toBe('uid-a')
    expect(await b.p.listEditions()).toHaveLength(1)
    const c = await reopened(b, { allowAccountSwitch: true })
    expect(c.errorCode).toBeNull()
    expect(await c.p.getMeta('uid')).toBe('fake-user')
    expect(await c.p.listEditions()).toEqual([])
  })

  it('データの形の版が高い → 受け取りは続け、送らない（送信待ちに残る）', async () => {
    const cloud = newCloud()
    cloud.model = DATA_MODEL + 1
    const a = await started(cloud, 'A')
    expect(a.outdated).toBe(true)
    await a.know({ ...press, asOf: null })
    await a.sync()
    expect(await a.p.outboxCount()).toBe(1)
    expect(cloud.record('knownTerms', press.termId)).toBeUndefined()
    const fake = makeFakeEdition({ date: UNTIL, slot: '20', seed: 'outdated' })
    seed(cloud, fake)
    await a.receive()
    expect((await a.shownEdition(fake.edition.id)).kind).toBe('ready')
    expect(cloud.model).toBe(DATA_MODEL + 1)
  })
})
