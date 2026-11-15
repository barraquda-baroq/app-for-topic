// 同期のエンジン（src/sync/engine.ts）をエミュレーター無しで動かす確かめ（docs/SPEC.md の 7.8）。firebase/firestore を、エンジンが使う所だけの
// 小さなメモリの中の物に差し替え（vi.mock）、本物のエンジンと端末の保存（src/db/persistence.ts。fake-indexeddb）で、問い合わせの形・
// 2つの置き場・初めての受け取りの2段・送る・30日の手入れ・持ち主・データの形の版が、偽のクラウド（src/test/fakeCloud.ts）と同じに動く事を
// 確かめる。アクセスルール・索引・本物の Firestore の動きは、エミュレーターのテスト（npm run test:sync）で確かめる。
// 差し替えの Firestore は1つの端末の書き込みを1つの時刻で書き、書き込みのたびに購読に知らせる（自分の書き込みも届く）。サーバーの時計は
// db.now（テストが進める）
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPersistence, type Persistence, type UserRecords } from '../db/persistence'
import { editionIdOf, termIdOf } from '../domain/ids'
import { addDaysToDate, firstSyncSinceMs, jstDateOf, jstStartOfDayMs, retentionBoundary } from '../domain/jst'
import { pressKnownTerm } from '../domain/known'
import type { ReadMark } from '../domain/types'
import { fakeRecordsOf, makeFakeEdition, makeFakeMonth } from '../test/fixtures/fakeEditions'
import { encodeDoc } from './codec'
import { createSyncEngine, type SyncEngine, type SyncStatus } from './engine'

type Data = Record<string, unknown>

const mem = vi.hoisted(() => {
  class Timestamp {
    constructor(
      readonly seconds: number,
      readonly nanoseconds: number,
    ) {}
    static fromMillis(ms: number): Timestamp {
      const s = Math.floor(ms / 1000)
      return new Timestamp(s, Math.round(ms - s * 1000) * 1_000_000)
    }
    toMillis(): number {
      return this.seconds * 1000 + Math.floor(this.nanoseconds / 1_000_000)
    }
  }
  const SERVER_TS = { serverTimestamp: true }
  const DOC_ID = { documentId: true }
  interface Db {
    docs: Map<string, Record<string, unknown>>
    now: number
    last: number
    listeners: Set<() => void>
    offline: boolean
    /** 次のトランザクションは書き込みが届くが、返事を受け取れない */
    loseReply: boolean
    /** 読んだ文書の数（問い合わせが0件でも1） */
    reads: number
  }
  const createDb = (now: number): Db => ({
    docs: new Map(),
    now,
    last: 0,
    listeners: new Set(),
    offline: false,
    loseReply: false,
    reads: 0,
  })
  return { Timestamp, SERVER_TS, DOC_ID, createDb }
})

vi.mock('firebase/firestore', () => {
  const { Timestamp, SERVER_TS, DOC_ID } = mem
  type Db = ReturnType<typeof mem.createDb>
  type Ref = { kind: 'col' | 'doc'; db: Db; path: string; id: string }
  type Con =
    | { type: 'where'; field: unknown; op: string; value: unknown }
    | { type: 'orderBy'; field: unknown }
    | { type: 'limit'; n: number }
  type Q = { kind: 'query'; db: Db; path: string; cons: Con[] }
  type Row = { path: string; id: string; data: Data }
  const dbOf = (x: { db?: Db } | Db): Db => ('db' in x && x.db ? x.db : (x as Db))
  const child =
    (kind: Ref['kind']) =>
    (parent: Ref | Db, ...segs: string[]): Ref => {
      const base = 'kind' in parent ? `${parent.path}/` : ''
      return { kind, db: dbOf(parent), path: base + segs.join('/'), id: segs[segs.length - 1] }
    }
  const unavailable = () => Object.assign(new Error('通信できません（テスト）'), { code: 'unavailable' })
  const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/'))
  const valueOf = (r: Row, field: unknown) => (field === DOC_ID ? r.id : r.data[field as string])
  const cmp = (a: unknown, b: unknown): number => {
    if (a instanceof Timestamp && b instanceof Timestamp) return a.toMillis() - b.toMillis()
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
    return Number.NaN
  }
  const test = (r: Row, c: Extract<Con, { type: 'where' }>) => {
    const v = valueOf(r, c.field)
    if (c.op === '==') return v === c.value
    if (c.op === 'in') return (c.value as unknown[]).includes(v)
    const d = cmp(v, c.value)
    if (Number.isNaN(d)) return false
    return c.op === '>=' ? d >= 0 : c.op === '>' ? d > 0 : c.op === '<' ? d < 0 : c.op === '<=' ? d <= 0 : false
  }
  const run = (q: Q): Row[] => {
    let rows: Row[] = [...q.db.docs.entries()]
      .filter(([p]) => parentOf(p) === q.path)
      .map(([path, data]) => ({ path, id: path.slice(path.lastIndexOf('/') + 1), data }))
    for (const c of q.cons) if (c.type === 'where') rows = rows.filter((r) => test(r, c))
    const ob = q.cons.find((c): c is Extract<Con, { type: 'orderBy' }> => c.type === 'orderBy')
    rows.sort((a, b) => (ob ? cmp(valueOf(a, ob.field), valueOf(b, ob.field)) : 0) || cmp(a.id, b.id))
    const lim = q.cons.find((c): c is Extract<Con, { type: 'limit' }> => c.type === 'limit')
    return lim ? rows.slice(0, lim.n) : rows
  }
  const docSnap = (id: string, data: Data | undefined) => ({
    id,
    exists: () => data !== undefined,
    data: () => (data ? { ...data } : undefined),
    metadata: { fromCache: false },
  })
  const stamp = (db: Db) => {
    if (db.now <= db.last) db.now = db.last + 1
    db.last = db.now
    return Timestamp.fromMillis(db.now)
  }
  const commit = (db: Db, writes: [string, Data | null][]) => {
    const ts = stamp(db)
    for (const [p, d] of writes) {
      if (d === null) db.docs.delete(p)
      else db.docs.set(p, Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === SERVER_TS ? ts : v])))
    }
    setTimeout(() => {
      for (const l of [...db.listeners]) l()
    }, 0)
  }
  const onSnapshot = (target: Ref | Q, ...rest: unknown[]) => {
    const fns = rest.filter((x): x is (s: unknown) => void => typeof x === 'function')
    const [next, error] = fns
    const db = target.db
    let stopped = false
    let fire: () => void
    if (target.kind === 'doc') {
      fire = () => {
        if (stopped) return
        if (db.offline) return error?.(unavailable())
        next(docSnap(target.id, db.docs.get(target.path)))
      }
    } else {
      const q = target as Q
      let seen = new Map<string, Data>()
      let first = true
      fire = () => {
        if (stopped) return
        if (db.offline) {
          stopped = true
          db.listeners.delete(fire)
          return error?.(unavailable())
        }
        const rows = run(q)
        const changes = rows
          .filter((r) => seen.get(r.path) !== r.data)
          .map((r) => ({ type: seen.has(r.path) ? 'modified' : 'added', doc: docSnap(r.id, r.data) }))
        if (!first && !changes.length) return
        db.reads += first ? Math.max(1, rows.length) : changes.length
        first = false
        seen = new Map(rows.map((r) => [r.path, r.data]))
        next({ metadata: { fromCache: false }, docs: rows.map((r) => docSnap(r.id, r.data)), docChanges: () => changes })
      }
    }
    db.listeners.add(fire)
    setTimeout(fire, 0)
    return () => {
      stopped = true
      db.listeners.delete(fire)
    }
  }
  const read = async (ref: Ref) => {
    if (ref.db.offline) throw unavailable()
    ref.db.reads += 1
    return docSnap(ref.id, ref.db.docs.get(ref.path))
  }
  return {
    Timestamp,
    collection: child('col'),
    doc: child('doc'),
    documentId: () => DOC_ID,
    where: (field: unknown, op: string, value: unknown): Con => ({ type: 'where', field, op, value }),
    orderBy: (field: unknown): Con => ({ type: 'orderBy', field }),
    limit: (n: number): Con => ({ type: 'limit', n }),
    query: (col: Ref, ...cons: Con[]): Q => ({ kind: 'query', db: col.db, path: col.path, cons }),
    serverTimestamp: () => SERVER_TS,
    getDoc: read,
    getDocFromServer: read,
    getDocsFromServer: async (q: Q) => {
      if (q.db.offline) throw unavailable()
      const rows = run(q)
      q.db.reads += Math.max(1, rows.length)
      return { docs: rows.map((r) => docSnap(r.id, r.data)), size: rows.length }
    },
    onSnapshot,
    runTransaction: async (db: Db, fn: (tx: unknown) => Promise<unknown>) => {
      if (db.offline) throw unavailable()
      const writes: [string, Data | null][] = []
      const tx = {
        get: (ref: Ref) => read(ref),
        set(ref: Ref, data: Data) {
          writes.push([ref.path, data])
          return tx
        },
        delete(ref: Ref) {
          writes.push([ref.path, null])
          return tx
        },
      }
      const result = await fn(tx)
      if (writes.length) commit(db, writes)
      if (db.loseReply) {
        db.loseReply = false
        throw unavailable()
      }
      return result
    },
    writeBatch: (db: Db) => {
      const writes: [string, Data | null][] = []
      return {
        delete(ref: Ref) {
          writes.push([ref.path, null])
        },
        set(ref: Ref, data: Data) {
          writes.push([ref.path, data])
        },
        commit: async () => {
          if (db.offline) throw unavailable()
          commit(db, writes)
        },
      }
    },
  }
})

const UID = 'owner-uid'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const UNTIL = '2026-11-15'
const NOW = jstStartOfDayMs(UNTIL) + 23 * HOUR

type Db = ReturnType<typeof mem.createDb>

interface Device {
  name: string
  p: Persistence
  e: SyncEngine
  statuses: SyncStatus[]
}

const running: Device[] = []
afterEach(() => {
  for (const d of running.splice(0)) {
    d.e.stop()
    d.p.close()
  }
})

let seq = 0
function newDb(): Db {
  const db = mem.createDb(NOW)
  db.docs.set('config/owner', { uid: UID })
  return db
}

/** コネクタと同じ形の文書を置く（管理者の権限。updated は作った時刻） */
function seed(db: Db, list: ReturnType<typeof fakeRecordsOf>): void {
  for (const { table, record } of list) {
    const d = encodeDoc(table, record, { device: 'claude-connector', updated: mem.Timestamp.fromMillis(record.createdAt) })
    db.docs.set(`users/${UID}/records/${table}:${record.id}`, d as unknown as Data)
  }
}

function device(db: Db, name: string, opts: { clockOffset?: number; appModel?: boolean; dbName?: string } = {}): Device {
  const p = createPersistence(opts.dbName ?? `engine-${name}-${++seq}`)
  const statuses: SyncStatus[] = []
  const e = createSyncEngine({
    firestore: db as never,
    uid: UID,
    deviceId: name,
    target: p,
    uploadDelay: 0,
    uploadMaxWait: 0,
    modelWait: 200,
    ...(opts.appModel === false ? {} : { appModel: { model: 1, appVersion: '0.1' } }),
    now: () => db.now + (opts.clockOffset ?? 0),
    onStatus: (s) => statuses.push(s),
  })
  const d = { name, p, e, statuses }
  running.push(d)
  return d
}

async function waitFor(cond: () => boolean | Promise<boolean>, what = '条件'): Promise<void> {
  const end = Date.now() + 5_000
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`${what}を待ちきれませんでした`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** 同期を始め、最初の受け取りが終わるまで待つ */
async function startSynced(d: Device): Promise<void> {
  await d.e.start()
  await waitFor(() => d.e.status.downloaded === true, `${d.name} の最初の受け取り`)
  await d.e.idle()
}

/** 送り終わり、送信待ちが空になるまで待つ */
async function flushed(...ds: Device[]): Promise<void> {
  for (let i = 0; i < 3; i++) {
    for (const d of ds) {
      d.e.requestUpload(true)
      await d.e.idle()
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  for (const d of ds) await waitFor(async () => (await d.p.outboxCount()) === 0, `${d.name} の送信待ち`)
}

async function save(p: Persistence, edit: (r: UserRecords) => UserRecords): Promise<void> {
  const prev = await p.loadUserRecords()
  await p.save(prev, edit(prev))
}

function readMark(editionId: string, topicIds: string[], seen: boolean, at: number): ReadMark {
  return { id: editionId, v: 1, createdAt: at, updatedAt: at, by: 'user', ai: null, editionId, topicIds, seen }
}

describe('エンジン（メモリの中の Firestore で）', () => {
  it('2台の既読が両方残る。既読は private に、外側の8つの欄で書く（削除の印・コネクタの名前を書かない）', async () => {
    const db = newDb()
    const fake = makeFakeEdition({ date: UNTIL, slot: '12', seed: 'engine-two' })
    seed(db, fakeRecordsOf(fake))
    const a = device(db, 'pc')
    const b = device(db, 'phone')
    await startSynced(a)
    await startSynced(b)
    expect((await a.p.listEditions()).map((e) => e.id)).toEqual([fake.edition.id])
    const id = fake.edition.id
    const [t1, t2] = fake.edition.order
    await save(a.p, (r) => ({ ...r, reads: { [id]: readMark(id, [t1], false, db.now) } }))
    await save(b.p, (r) => ({ ...r, reads: { [id]: readMark(id, [t2], true, db.now) } }))
    await flushed(a, b)
    await waitFor(async () => {
      const ra = (await a.p.loadUserRecords()).reads[id] as ReadMark | undefined
      const rb = (await b.p.loadUserRecords()).reads[id] as ReadMark | undefined
      return ra?.topicIds.length === 2 && rb?.topicIds.length === 2 && ra.seen && rb.seen
    }, '2台の既読')
    const doc = db.docs.get(`users/${UID}/private/reads:${id}`)
    expect(Object.keys(doc ?? {}).sort()).toEqual(['chunks', 'deleted', 'device', 'hash', 'id', 'json', 'table', 'updated'])
    expect(doc).toMatchObject({ table: 'reads', id, chunks: 0, deleted: false })
    expect(['pc', 'phone']).toContain(doc?.device)
    expect(db.docs.has(`users/${UID}/records/reads:${id}`)).toBe(false)
    expect(db.docs.get(`users/${UID}/sync/pc`)).toMatchObject({ tx: expect.any(String) })
    expect(a.e.status).toMatchObject({ phase: 'synced', pending: 0 })
  })

  it('初めての受け取り: 「知ってる」は全部、版・話題は − 32日から（30日の外は入れない）。位置・caughtUpAt を書き、firstSync を消す', async () => {
    const db = newDb()
    const month = makeFakeMonth({ until: UNTIL, days: 35, seed: 'engine-first' })
    seed(db, fakeRecordsOf(month))
    const old = pressKnownTerm(null, { termId: termIdOf('〇〇法'), term: '〇〇法', asOf: null }, NOW - 100 * DAY)
    const knownDoc = encodeDoc('knownTerms', old, { device: 'old-phone', updated: mem.Timestamp.fromMillis(NOW - 100 * DAY) })
    db.docs.set(`users/${UID}/records/knownTerms:${old.id}`, knownDoc as unknown as Data)
    const a = device(db, 'A')
    await startSynced(a)
    expect((await a.p.loadUserRecords()).knownTerms[old.id]).toEqual(old)
    const { firstKeptDate } = retentionBoundary(NOW)
    const ids = (await a.p.listEditions()).map((e) => e.id)
    expect(ids).toEqual(month.editions.filter((e) => e.edition.date >= firstKeptDate).map((e) => e.edition.id))
    expect(await a.p.getMeta('firstSync')).toBeNull()
    expect(await a.p.getMeta('caughtUpAt')).toBe(NOW)
    const cursor = (await a.p.getMeta<{ records?: { s: number } }>('cursor'))?.records
    expect((cursor?.s ?? 0) * 1000).toBeGreaterThanOrEqual(firstSyncSinceMs(NOW) - 1000)
    // 32日の窓より前の版・話題・辞書の束は読んでいない（読んだ数が窓の中の数ほど）
    const since = firstSyncSinceMs(NOW)
    const inWindow = [...db.docs.entries()].filter(
      ([p, d]) =>
        p.startsWith(`users/${UID}/records/`) &&
        d.table !== 'termPacks' &&
        (d.updated as InstanceType<typeof mem.Timestamp>).toMillis() >= since,
    ).length
    expect(db.reads).toBeLessThanOrEqual(inWindow + 12)
    expect(db.reads).toBeGreaterThanOrEqual(inWindow)
  })

  it('30日の手入れ: サーバーの時刻の見積もりで30日を過ぎた物だけを、id の範囲で消す（削除の印を書かない）。1日1回', async () => {
    const db = newDb()
    const month = makeFakeMonth({ until: UNTIL, days: 35, seed: 'engine-maintain' })
    seed(db, fakeRecordsOf(month))
    const a = device(db, 'A')
    expect(await a.e.maintain()).toMatchObject({ skipped: 'not-ready' })
    await startSynced(a)
    // 自分の書き込みの知らせで、サーバーの時刻の見積もりを本当の時刻に近づける
    const known = pressKnownTerm(null, { termId: termIdOf('〇〇法'), term: '〇〇法', asOf: null }, db.now)
    await save(a.p, (r) => ({ ...r, knownTerms: { [known.id]: known } }))
    await flushed(a)
    await waitFor(() => Math.abs((a.e.serverNow() ?? 0) - db.now) < 1000, 'サーバーの時刻の見積もり')
    const r = await a.e.maintain()
    expect(r.skipped).toBeNull()
    expect(r.deleted.editions).toBe(10)
    expect(r.capped).toBe(false)
    const { firstKeptDate } = retentionBoundary(db.now)
    for (const p of db.docs.keys()) {
      const m = /:(\d{4}-\d{2}-\d{2})-/.exec(p)
      if (m && !p.includes('/termPacks:')) expect(m[1] >= firstKeptDate, p).toBe(true)
    }
    expect([...db.docs.keys()].filter((p) => p.includes('/termPacks:'))).toHaveLength(month.editions.length)
    expect(await a.p.getMeta('lastMaintainDay')).toBe(jstDateOf(db.now))
    expect(await a.e.maintain()).toMatchObject({ skipped: 'done-today', total: 0 })
  })

  it('電波の無い間に読んだ既読が 0時をまたいで30日を過ぎても、送信が止まらず、削除の印も書かない', async () => {
    const db = newDb()
    const month = makeFakeMonth({ until: UNTIL, days: 31, seed: 'engine-midnight' })
    seed(db, fakeRecordsOf(month))
    const a = device(db, 'A')
    await startSynced(a)
    const edge = editionIdOf(retentionBoundary(NOW).firstKeptDate, '20')
    const known = pressKnownTerm(null, { termId: termIdOf('〇〇法'), term: '〇〇法', asOf: null }, db.now)
    db.offline = true
    await save(a.p, () => ({ knownTerms: { [known.id]: known }, reads: { [edge]: readMark(edge, [], true, db.now) } }))
    a.e.requestUpload(true)
    await a.e.idle()
    expect(await a.p.outboxCount()).toBe(2)
    db.now = jstStartOfDayMs(addDaysToDate(UNTIL, 1)) + 5 * 60 * 1000
    db.offline = false
    await a.e.flush()
    await waitFor(async () => (await a.p.outboxCount()) === 0, '送信待ち')
    expect(db.docs.has(`users/${UID}/records/knownTerms:${known.id}`)).toBe(true)
    expect(db.docs.has(`users/${UID}/private/reads:${edge}`)).toBe(false)
    for (const d of db.docs.values()) if ('deleted' in d) expect(d.deleted).toBe(false)
  })

  it('返事を受け取れなかった書き込みも、送る書き込みの印で確かめて送り終わりにする', async () => {
    const db = newDb()
    const a = device(db, 'A')
    await startSynced(a)
    const known = pressKnownTerm(null, { termId: termIdOf('〇〇法'), term: '〇〇法', asOf: null }, db.now)
    db.loseReply = true
    await save(a.p, (r) => ({ ...r, knownTerms: { [known.id]: known } }))
    a.e.requestUpload(true)
    await a.e.idle()
    expect(db.docs.has(`users/${UID}/records/knownTerms:${known.id}`)).toBe(true)
    await waitFor(async () => (await a.p.outboxCount()) === 0, '送信待ち')
  })

  it('欠けた話題を直接読む（クラウドに無ければ missing）', async () => {
    const db = newDb()
    const fake = makeFakeEdition({ date: UNTIL, slot: '20', seed: 'engine-fetch' })
    seed(
      db,
      fakeRecordsOf(fake).filter((r) => r.record.id !== fake.topics[0].id && r.record.id !== fake.topics[1].id),
    )
    const t0 = fake.topics[0]
    const d0 = encodeDoc('topics', t0, { device: 'claude-connector', updated: mem.Timestamp.fromMillis(NOW - 40 * DAY) })
    db.docs.set(`users/${UID}/records/topics:${t0.id}`, d0 as unknown as Data)
    const a = device(db, 'A')
    await startSynced(a)
    expect((await a.p.getTopics([t0.id]))[0]).toBeNull()
    expect(await a.e.fetchTopics([t0.id, fake.topics[1].id])).toEqual({ found: [t0.id], missing: [fake.topics[1].id] })
    expect((await a.p.getTopics([t0.id]))[0]).toEqual(t0)
  })

  it('持ち主の記録が無い → 同期しない（owner-missing）', async () => {
    const db = newDb()
    db.docs.delete('config/owner')
    const a = device(db, 'A')
    await a.e.start()
    expect(a.e.status).toMatchObject({ phase: 'error', errorCode: 'owner-missing' })
    const known = pressKnownTerm(null, { termId: termIdOf('〇〇法'), term: '〇〇法', asOf: null }, db.now)
    await save(a.p, (r) => ({ ...r, knownTerms: { [known.id]: known } }))
    a.e.requestUpload(true)
    await a.e.idle()
    expect([...db.docs.keys()]).toEqual([])
  })

  it('データの形の版が高い → 受け取りは続け、送らない（要更新）', async () => {
    const db = newDb()
    db.docs.set(`users/${UID}/meta/app`, { model: 2, appVersion: '9.0', updatedAt: mem.Timestamp.fromMillis(NOW) })
    const fake = makeFakeEdition({ date: UNTIL, slot: '12', seed: 'engine-outdated' })
    seed(db, fakeRecordsOf(fake))
    const a = device(db, 'A')
    await startSynced(a)
    await waitFor(() => a.e.status.outdated?.model === 2, '要更新')
    expect((await a.p.listEditions()).map((e) => e.id)).toEqual([fake.edition.id])
    const known = pressKnownTerm(null, { termId: termIdOf('〇〇法'), term: '〇〇法', asOf: null }, db.now)
    await save(a.p, (r) => ({ ...r, knownTerms: { [known.id]: known } }))
    await a.e.flush()
    expect(await a.p.outboxCount()).toBe(1)
    expect(db.docs.has(`users/${UID}/records/knownTerms:${known.id}`)).toBe(false)
  })

  it('データの形の版が無ければ、この版に上げる', async () => {
    const db = newDb()
    const a = device(db, 'A')
    await startSynced(a)
    await waitFor(() => db.docs.has(`users/${UID}/meta/app`), 'データの形の版')
    expect(db.docs.get(`users/${UID}/meta/app`)).toMatchObject({ model: 1, appVersion: '0.1' })
  })
})
