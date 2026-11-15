// 段階1の部品のつなぎ（docs/SPEC.md の 16.2 の 1〜4・16.3）。並んで作った部品（src/domain の名札・上限・30日の境、src/sync の codec・
// batch・merge、src/db/persistence.ts、作り物の版 src/test/fixtures/fakeEditions.ts）を、同じ記録で通して確かめる。
// - 作り物の版の記録は、codec の外側の文書にして戻すと同じ記録で、置き場・id の形・json の上限がルールと同じ（7.7）
// - 作り物の版を端末に入れると、辞書の束は入らず、版の order の話題がそろい、訂正が話題で引ける（7.8 の「版と話題を受け取る」）
// - 端末の中で消す（expireBefore）・送る前の守り（nothingToSend）・クラウドで消す範囲（expiryDocIdBefore）が、同じ日付で切れる（7.8）
// - 2台の既読・知ってる: 送信待ち → selectBatch・decideBatch → クラウド → もう1台の applyRemote（既定の合わせ方 = mergeRemote）で、
//   両方の分が残る（7.8 の「既読・知ってるを送る・受け取る」）
// クラウドは文書の id → 外側の文書の Map だけの小さな物（偽のクラウド src/test/fakeCloud.ts とエンジンは段階1の 5 で作る）。記録は作り物だけ
import { afterEach, describe, expect, it } from 'vitest'
import { createPersistence, emptyUserRecords, type Change, type Persistence, type UserRecords } from '../db/persistence'
import { deepEqual } from '../domain/equal'
import { editionIdOf, isExpirableDocId, isExpiredDocId, isRecordIdFor, termIdOf } from '../domain/ids'
import { expiryDocIdBefore, firstSyncSinceMs, jstStartOfDayMs, retentionBoundary } from '../domain/jst'
import { isKnownTerm, pressKnownTerm, unpressKnownTerm } from '../domain/known'
import { RECORD_LIMITS } from '../domain/limits'
import { repairTopic } from '../domain/repair'
import { CONNECTOR_DEVICE, EXPIRING_TABLES, isOneOf, type KnownTerm, type ReadMark, type RecordDoc } from '../domain/types'
import { checkKnownTerm, checkReadMark } from '../domain/validate'
import { FAKE_TOPIC_SCENES, fakeRecordsOf, makeFakeMonth } from '../test/fixtures/fakeEditions'
import { FAKE_OUTLETS } from '../test/fixtures/fakeOutlets'
import { SEND_LIMITS, decideBatch, nothingToSend, selectBatch } from './batch'
import { decodeDoc, docIdOf, encodeDoc, placeOf, recordDocOf } from './codec'

const MONTH_OPTS = { until: '2026-11-15', days: 35 } as const
const month = makeFakeMonth(MONTH_OPTS)
const records = fakeRecordsOf(month)
/** until の日の 21:00（日本時間。20:00版の後） */
const NOW = jstStartOfDayMs(MONTH_OPTS.until) + 21 * 60 * 60 * 1000

let seq = 0
const opened: Persistence[] = []
function device(): Persistence {
  const p = createPersistence(`wiring-${++seq}-${Math.random().toString(36).slice(2)}`)
  opened.push(p)
  return p
}

afterEach(() => {
  for (const p of opened.splice(0)) p.close()
})

/** クラウドの文書（updated はサーバー時刻の代わりのミリ秒） */
type Cloud = Map<string, RecordDoc<number>>

/** 外側の文書を codec で読み、反映の1件にする（使えない文書は記録にしない。7.8） */
function changeOf(doc: RecordDoc<number>): Change {
  const r = decodeDoc(doc, { docId: docIdOf(doc.table, doc.id), place: placeOf(doc.table) })
  if (!r.ok) throw new Error(`使えない文書 ${doc.table}:${doc.id}（${r.reason}）`)
  return { table: r.table, id: r.id, record: r.record }
}

/**
 * 送信待ちを1回送る（エンジンの送るトランザクションの骨組み。7.8）。書いた文書はルールの appDoc の決まり（id の形・json の上限・
 * device がコネクタでない）にも当たる事を確かめる
 */
async function send(p: Persistence, cloud: Cloud, deviceId: string, serverNow: number) {
  const items = await p.readOutbox(1_000)
  const batch = selectBatch(items, { ...SEND_LIMITS, serverNow })
  const states = batch.map(({ it }) => {
    const d = cloud.get(docIdOf(it.table, it.id))
    return d ? { exists: true, hash: d.hash } : { exists: false, hash: '' }
  })
  const { write, conflicts } = decideBatch(batch, states)
  const sent: Change[] = []
  batch.forEach((b, i) => {
    if (!write[i]) return
    const doc = recordDocOf(b.it.table, b.it.id, b.enc, { device: deviceId, updated: serverNow })
    expect(isRecordIdFor(doc.table, doc.id)).toBe(true)
    expect(doc.json.length).toBeLessThanOrEqual(RECORD_LIMITS.json[doc.table])
    expect(doc.device).not.toBe(CONNECTOR_DEVICE)
    cloud.set(docIdOf(doc.table, doc.id), doc)
    sent.push({ table: b.it.table, id: b.it.id, record: b.it.local })
  })
  // 送る必要の無い行（local が null・30日の外の既読・base と同じ）は、書かずに送り終わりにする
  for (const it of items) if (nothingToSend(it, serverNow)) sent.push({ table: it.table, id: it.id, record: it.local })
  await p.completeUpload(sent)
  return { written: write.filter(Boolean).length, conflicts }
}

/** クラウドの文書を受け取る（自分の端末が書いた知らせは捨てる。DS のエンジンと同じ） */
async function receive(p: Persistence, cloud: Cloud, deviceId: string): Promise<Change[]> {
  return p.applyRemote([...cloud.values()].filter((d) => d.device !== deviceId).map(changeOf))
}

const userRecordsOf = (known: KnownTerm[] = [], reads: ReadMark[] = []): UserRecords => ({
  knownTerms: Object.fromEntries(known.map((r) => [r.id, r])),
  reads: Object.fromEntries(reads.map((r) => [r.id, r])),
})

function readMark(editionId: string, topicIds: string[], seen: boolean, at: number): ReadMark {
  return { id: editionId, v: 1, createdAt: at, updatedAt: at, by: 'user', ai: null, editionId, topicIds, seen }
}

describe('作り物の版 → codec（docs/SPEC.md の 7.7）', () => {
  it('外側の文書にして戻すと同じ記録。置き場は records、id は表ごとの形、json は上限の内、30日で消せる id の形は表ごと', () => {
    expect(new Set(records.map((r) => r.table))).toEqual(
      new Set(['termPacks', 'topics', 'editions', 'editionFails', 'corrections']),
    )
    for (const { table, record } of records) {
      expect(isRecordIdFor(table, record.id), `${table}:${record.id}`).toBe(true)
      expect(placeOf(table)).toBe('records')
      const doc = encodeDoc(table, record, { device: CONNECTOR_DEVICE, updated: 0 })
      expect(doc.json.length).toBeLessThanOrEqual(RECORD_LIMITS.json[table])
      const back = decodeDoc(doc, { docId: docIdOf(table, record.id), place: 'records' })
      expect(back.ok && deepEqual(back.record, record)).toBe(true)
      // ルールの expirableRecord と同じ形: 辞書の束は消せない
      expect(isExpirableDocId(docIdOf(table, record.id))).toBe(isOneOf(EXPIRING_TABLES, table))
    }
  })
})

describe('作り物の版 → 端末（persistence。docs/SPEC.md の 7.8）', () => {
  it('辞書の束は入れず、版の order の話題がそろい、訂正は話題で引ける。送信待ちには積まない。表示用の写しにもできる', async () => {
    const p = device()
    const docs = records.map(({ table, record }) => encodeDoc(table, record, { device: CONNECTOR_DEVICE, updated: 0 }))
    const written = await p.applyRemote(docs.map(changeOf), { cursor: { place: 'records', at: { s: 1, n: 0 } } })
    expect(written.some((c) => c.table === 'termPacks')).toBe(false)
    expect(written).toHaveLength(records.filter((r) => r.table !== 'termPacks').length)
    expect(await p.outboxCount()).toBe(0)
    expect(await p.getMeta('cursor')).toEqual({ records: { s: 1, n: 0 } })

    const editions = await p.listEditions()
    expect(editions.map((e) => e.id)).toEqual(month.editions.map((e) => e.edition.id))
    for (const fake of month.editions) {
      const got = await p.getTopics(fake.edition.order)
      expect(got).toEqual(fake.topics)
      expect(await p.topicsOfEdition(fake.edition.id)).toHaveLength(fake.topics.length)
    }
    // 続報の鎖は threadId で引ける
    const [first] = month.scenes.chain
    expect((await p.topicsOfThread(first)).map((t) => t.id).sort()).toEqual([...month.scenes.chain].sort())
    // 訂正は話題ごと・版ごとに引ける（1つの話題に2つ）
    const twice = month.scenes.corrections.twice
    expect(await p.correctionsOfTopic(twice)).toHaveLength(2)
    expect((await p.correctionsOfEdition(twice.slice(0, 13))).length).toBeGreaterThanOrEqual(2)
    expect(await p.listEditionFails()).toEqual(month.editionFails)

    // 端末に入れた記録は、どれも表示用の写しにできる（作り物の社の一覧で。断る物を入れた話題・知らない値の話題も、捨てて出す・残して出す）
    const newest = month.editions.at(-1)!
    const shown = (await p.getTopics(newest.edition.order)).map((t) => repairTopic(t, { outlets: FAKE_OUTLETS }))
    expect(shown.map((s) => s.kind)).toEqual(newest.topics.map(() => 'ok'))
    const unknown = shown[FAKE_TOPIC_SCENES.newerValues - 1]
    expect(unknown.kind === 'ok' && unknown.value.genre).toBe('novel')
  })
})

describe('30日の境（docs/SPEC.md の 7.8 の「30日で消す」・「端末の中で消す」）', () => {
  it('端末の中で消す・送る前の守り・クラウドで消す範囲が同じ日付で切れる（訂正は話題と同じ日に消える）', async () => {
    const p = device()
    await p.applyRemote(
      records.map(({ table, record }) => changeOf(encodeDoc(table, record, { device: CONNECTOR_DEVICE, updated: 0 }))),
    )
    // 電波の無い間に、いちばん古い版といちばん新しい版を既読にした（送信待ちのまま）
    const oldest = month.editions[0].edition.id
    const newest = month.editions.at(-1)!.edition.id
    const marks = [readMark(oldest, [], true, NOW), readMark(newest, [], true, NOW)]
    await p.save(emptyUserRecords(), userRecordsOf([], marks))
    // 送る前の守り: 30日の外の既読は送らない（サーバーの時刻の見積もり = ここでは NOW）
    const items = await p.readOutbox(10)
    expect(items.filter((it) => nothingToSend(it, NOW)).map((it) => it.id)).toEqual([oldest])
    expect(selectBatch(items, { ...SEND_LIMITS, serverNow: NOW }).map((b) => b.it.id)).toEqual([newest])

    const { firstKeptDate } = retentionBoundary(NOW)
    const out = await p.expireBefore(firstKeptDate)
    expect(out.outbox).toEqual([`reads/${oldest}`])
    expect(await p.outboxKeys()).toEqual(new Set([`reads/${newest}`]))
    // 消した行は、どれも30日を過ぎた id（ルールの expirableRecord・expiredDay と同じ）で、クラウドで消す範囲の内
    expect(out.removed.length).toBeGreaterThan(0)
    for (const { table, id } of out.removed) {
      expect(isExpiredDocId(docIdOf(table, id), NOW), `${table}:${id}`).toBe(true)
      expect(docIdOf(table, id) < expiryDocIdBefore(table, NOW)).toBe(true)
    }
    const removedIds = new Set(out.removed.map((c) => `${c.table}:${c.id}`))
    expect(out.removed.filter((c) => c.table === 'editions')).toHaveLength(10)
    // 30日の境の外の話題の訂正は、話題と同じ日に消える
    const oldTopic = month.scenes.corrections.oldest
    expect(removedIds.has(`topics:${oldTopic}`)).toBe(true)
    expect(await p.correctionsOfTopic(oldTopic)).toEqual([])
    // 残った物はどれも30日の内
    for (const e of await p.listEditions()) expect(isExpiredDocId(docIdOf('editions', e.id), NOW)).toBe(false)
    for (const c of await p.listCorrections()) expect(isExpiredDocId(docIdOf('corrections', c.id), NOW)).toBe(false)
    expect(Object.keys((await p.loadUserRecords()).reads)).toEqual([newest])
    // 初めての受け取りで購読を始める位置（端末の時計 − 32日）は、残った版より前
    const kept = new Set((await p.listEditions()).map((e) => e.id))
    for (const { edition } of month.editions)
      if (kept.has(edition.id)) expect(edition.createdAt).toBeGreaterThan(firstSyncSinceMs(NOW))
  })
})

describe('2台の既読・知ってる（docs/SPEC.md の 7.8 の「既読・知ってるを送る・受け取る」）', () => {
  const editionId = editionIdOf(MONTH_OPTS.until, '12')
  const t1 = `${editionId}-k3f9a2bq`
  const t2 = `${editionId}-m2n8c4d1`

  it('PC で1本目、スマホで2本目を読み、スマホは版の一覧も見た → 両方の端末で両方とも既読・見た', async () => {
    const cloud: Cloud = new Map()
    const pc = device()
    const phone = device()
    await pc.save(emptyUserRecords(), userRecordsOf([], [readMark(editionId, [t1], false, NOW)]))
    await phone.save(emptyUserRecords(), userRecordsOf([], [readMark(editionId, [t2], true, NOW + 1)]))

    expect((await send(pc, cloud, 'pc', NOW)).written).toBe(1)
    // スマホは、クラウドが先に変わっていたので書けない（受け取りで base が新しくなってから送り直す）
    const first = await send(phone, cloud, 'phone', NOW)
    expect(first.written).toBe(0)
    expect(first.conflicts.map((c) => c.id)).toEqual([editionId])
    await receive(phone, cloud, 'phone')
    expect((await send(phone, cloud, 'phone', NOW)).written).toBe(1)
    await receive(pc, cloud, 'pc')

    const onPc = (await pc.loadUserRecords()).reads[editionId] as ReadMark
    const onPhone = (await phone.loadUserRecords()).reads[editionId] as ReadMark
    expect(onPc).toEqual(onPhone)
    expect([...onPc.topicIds].sort()).toEqual([t1, t2])
    expect(onPc.seen).toBe(true)
    expect(checkReadMark(onPc).errors).toEqual([])
    expect(await pc.outboxCount()).toBe(0)
    expect(await phone.outboxCount()).toBe(0)
  })

  it('スマホで「知ってる」、電波の無い PC で古い話題から押して外す → PC が後で同期すれば「外した」。asOf は新しい方', async () => {
    const cloud: Cloud = new Map()
    const phone = device()
    const pc = device()
    const press = { termId: termIdOf('与党（日本）'), term: '与党' }
    const onPhone = pressKnownTerm(null, { ...press, asOf: '2026-12' }, NOW)
    await phone.save(emptyUserRecords(), userRecordsOf([onPhone]))
    const pressedOnPc = pressKnownTerm(null, { ...press, asOf: '2026-11' }, NOW + 1)
    await pc.save(emptyUserRecords(), userRecordsOf([pressedOnPc]))
    await pc.save(userRecordsOf([pressedOnPc]), userRecordsOf([unpressKnownTerm(pressedOnPc, NOW + 2)]))

    expect((await send(phone, cloud, 'phone', NOW)).written).toBe(1)
    expect((await send(pc, cloud, 'pc', NOW)).conflicts).toHaveLength(1)
    await receive(pc, cloud, 'pc')
    expect((await send(pc, cloud, 'pc', NOW)).written).toBe(1)
    await receive(phone, cloud, 'phone')

    for (const p of [phone, pc]) {
      const k = (await p.loadUserRecords()).knownTerms[press.termId] as KnownTerm
      expect(k).toMatchObject({ on: false, term: '与党', asOf: '2026-12' })
      expect(isKnownTerm(k, '2026-11')).toBe(false)
      expect(checkKnownTerm(k).errors).toEqual([])
      expect(await p.outboxCount()).toBe(0)
    }
  })
})
