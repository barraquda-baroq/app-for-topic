// 同期のエンジン（src/sync/engine.ts）をエミュレーター無しで動かす確かめ（docs/SPEC.md の 7.8）。firebase/firestore を、エンジンが使う所だけの
// 小さなメモリの中の物に差し替え（vi.mock）、本物のエンジンと端末の保存（src/db/persistence.ts。fake-indexeddb）で、問い合わせの形・
// 2つの置き場・初めての受け取りの2段・送る・30日の手入れ・持ち主・データの形の版が、偽のクラウド（src/test/fakeCloud.ts）と同じに動く事を
// 確かめる。アクセスルール・索引・本物の Firestore の動きは、エミュレーターのテスト（npm run test:sync）で確かめる。
// 差し替えの Firestore は1つの端末の書き込みを1つの時刻で書き、書き込みのたびに購読に知らせる（自分の書き込みも届く）。サーバーの時計は
// db.now（テストが進める）。置き場ごとに購読を誤りで止める・サーバーの知らせの直後に誤りを出す・文書の見張り（meta/app）に誤りを出す・
// 購読を始めても知らせない、もできる（DS の sync.emu.test.ts の購読の止まりと形の版の見張り直しを、ここで写す）
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPersistence, type Persistence, type UserRecords } from '../db/persistence'
import { editionIdOf, termIdOf } from '../domain/ids'
import { addDaysToDate, firstSyncSinceMs, jstDateOf, jstStartOfDayMs, retentionBoundary } from '../domain/jst'
import { pressKnownTerm } from '../domain/known'
import type { ReadMark } from '../domain/types'
import { fakeRecordsOf, makeFakeEdition, makeFakeMonth } from '../test/fixtures/fakeEditions'
import { encodeDoc } from './codec'
import { createSyncEngine, type SyncEngine, type SyncStatus, type SyncTarget } from './engine'

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
    /** この置き場（records・private）の購読は、始めるとすぐ誤り（resource-exhausted）で止まる */
    failListen: Set<string>
    /** この置き場の購読は、次のサーバーの知らせを届けた直後に誤り（resource-exhausted）で止まる（1回だけ） */
    errorAfterServer: Set<string>
    /** この置き場の購読は、始めても知らせを届けない（サーバーの最初の知らせを待っている間） */
    holdListen: Set<string>
    /** 文書の見張り（meta/app）を誤り（permission-denied）で止める関数 */
    docErrors: Set<() => void>
    /** 置き場の購読を始めた位置（updated >= の ms。条件が無ければ null） */
    subs: { place: string; from: number | null }[]
    /** 「知ってる」を読んだ回数（getDocsFromServer の table == 'knownTerms'） */
    knownReads: number
  }
  const createDb = (now: number): Db => ({
    docs: new Map(),
    now,
    last: 0,
    listeners: new Set(),
    offline: false,
    loseReply: false,
    reads: 0,
    failListen: new Set(),
    errorAfterServer: new Set(),
    holdListen: new Set(),
    docErrors: new Set(),
    subs: [],
    knownReads: 0,
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
  const exhausted = () => Object.assign(new Error('無料枠を使い切りました（テスト）'), { code: 'resource-exhausted' })
  const denied = () => Object.assign(new Error('拒否されました（テスト）'), { code: 'permission-denied' })
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
      const fail = () => {
        stopped = true
        db.listeners.delete(fire)
        db.docErrors.delete(fail)
        error?.(denied())
      }
      db.docErrors.add(fail)
      fire = () => {
        if (stopped) return
        if (db.offline) return error?.(unavailable())
        next(docSnap(target.id, db.docs.get(target.path)))
      }
    } else {
      const q = target as Q
      const place = q.path.slice(q.path.lastIndexOf('/') + 1)
      const since = q.cons.find(
        (c): c is Extract<Con, { type: 'where' }> => c.type === 'where' && c.field === 'updated' && c.op === '>=',
      )
      db.subs.push({ place, from: since ? (since.value as InstanceType<typeof Timestamp>).toMillis() : null })
      if (db.failListen.has(place)) {
        const t = setTimeout(() => error?.(exhausted()), 0)
        return () => clearTimeout(t)
      }
      if (db.holdListen.has(place)) return () => undefined
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
        if (db.errorAfterServer.delete(place))
          setTimeout(() => {
            stopped = true
            db.listeners.delete(fire)
            error?.(exhausted())
          }, 1)
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
      if (q.cons.some((c) => c.type === 'where' && c.field === 'table' && c.op === '==' && c.value === 'knownTerms'))
        q.db.knownReads += 1
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

/** コネクタと同じ形の文書を置く（管理者の権限。updated は作った時刻。at を渡せばその時刻） */
function seed(db: Db, list: ReturnType<typeof fakeRecordsOf>, opts: { uid?: string; at?: number } = {}): void {
  for (const { table, record } of list) {
    const at = opts.at ?? record.createdAt
    const d = encodeDoc(table, record, { device: 'claude-connector', updated: mem.Timestamp.fromMillis(at) })
    db.docs.set(`users/${opts.uid ?? UID}/records/${table}:${record.id}`, d as unknown as Data)
  }
}

interface DeviceOptions {
  clockOffset?: number
  appModel?: boolean
  dbName?: string
  /** ログインしたアカウント（既定 UID） */
  uid?: string
  allowAccountSwitch?: boolean
  /** 端末の保存先の口を包む（端末の DB の誤りを起こす時） */
  wrap?: (p: Persistence) => SyncTarget
}

function device(db: Db, name: string, opts: DeviceOptions = {}): Device {
  const p = createPersistence(opts.dbName ?? `engine-${name}-${++seq}`)
  const statuses: SyncStatus[] = []
  const e = createSyncEngine({
    firestore: db as never,
    uid: opts.uid ?? UID,
    deviceId: name,
    target: opts.wrap ? opts.wrap(p) : p,
    ...(opts.allowAccountSwitch ? { allowAccountSwitch: true } : {}),
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** 書き込みの無いまま購読に知らせる（管理者の権限で文書を置いた後） */
const notify = (db: Db) => {
  for (const l of [...db.listeners]) l()
}
const knownDocPath = (uid: string, id: string) => `users/${uid}/records/knownTerms:${id}`

describe('別のアカウントへ切り替えた端末（docs/SPEC.md の 7.8 の「既読・知ってるを送る・受け取る」）', () => {
  const OTHER = 'uid-a'
  const old = makeFakeEdition({ date: addDaysToDate(UNTIL, -1), slot: '20', seed: 'engine-switch-old' })
  const today = makeFakeEdition({ date: UNTIL, slot: '12', seed: 'engine-switch-today' })
  const [t1, t2] = today.edition.order
  const known = pressKnownTerm(null, { termId: termIdOf('〇〇法'), term: '〇〇法', asOf: null }, NOW - HOUR)

  /** OTHER のクラウドで同期した端末（版の写し・位置・送り終えた既読と「知ってる」が残る）の DB の名前 */
  async function deviceUsedBy(): Promise<string> {
    const dbA = mem.createDb(NOW - 2 * HOUR)
    dbA.docs.set('config/owner', { uid: OTHER })
    seed(dbA, fakeRecordsOf(old), { uid: OTHER })
    const dbName = `engine-switch-${++seq}`
    const a = device(dbA, 'pc', { uid: OTHER, dbName })
    await startSynced(a)
    await save(a.p, () => ({
      reads: { [today.edition.id]: readMark(today.edition.id, [t1], false, dbA.now) },
      knownTerms: { [known.id]: known },
    }))
    await flushed(a)
    expect(await a.p.getMeta('uid')).toBe(OTHER)
    expect(await a.p.getMeta('cursor')).toBeTruthy()
    expect(await a.p.getMeta('caughtUpAt')).toBeTruthy()
    expect((await a.p.listEditions()).map((e) => e.id)).toEqual([old.edition.id])
    a.e.stop()
    a.p.close()
    running.splice(running.indexOf(a), 1)
    return dbName
  }

  /** UID のクラウド: 今日の版と、ほかの端末が同じ版に付けた既読（topicIds が違う） */
  function cloudOfUid(): Db {
    const db = newDb()
    seed(db, fakeRecordsOf(today))
    const mark = readMark(today.edition.id, [t2], true, NOW - 30 * 60 * 1000)
    const d = encodeDoc('reads', mark, { device: 'phone', updated: mem.Timestamp.fromMillis(NOW - 30 * 60 * 1000) })
    db.docs.set(`users/${UID}/private/reads:${today.edition.id}`, d as unknown as Data)
    return db
  }

  it('確かめた印があれば: 前のアカウントの版の写しを消して受け取り直し、既読と「知ってる」を共通の履歴が無い物として合わせて送る', async () => {
    const dbName = await deviceUsedBy()
    const db = cloudOfUid()
    const b = device(db, 'pc', { dbName, allowAccountSwitch: true })
    await startSynced(b)
    await flushed(b)
    // ① 前のアカウントの版の写しは消え、このアカウントのクラウドの版だけ
    expect((await b.p.listEditions()).map((e) => e.id)).toEqual([today.edition.id])
    expect(await b.p.getTopics([old.topics[0].id])).toEqual([null])
    // ② 既読は足し合わせて private に送る
    const mark = (await b.p.loadUserRecords()).reads[today.edition.id] as ReadMark
    expect([...mark.topicIds].sort()).toEqual([t1, t2].sort())
    const cloud = db.docs.get(`users/${UID}/private/reads:${today.edition.id}`) as { json: string; device: string }
    expect([...(JSON.parse(cloud.json) as ReadMark).topicIds].sort()).toEqual([t1, t2].sort())
    expect(cloud.device).toBe('pc')
    // ③ 「知ってる」も records に送る
    expect(db.docs.has(knownDocPath(UID, known.id))).toBe(true)
    // ④ _meta の uid はこのアカウント、⑤ 送信待ちは空
    expect(await b.p.getMeta('uid')).toBe(UID)
    expect(await b.p.outboxCount()).toBe(0)
    expect(b.e.status).toMatchObject({ phase: 'synced', pending: 0 })
  })

  it('確かめた印が無ければ: markAllDirty せずに account-mismatch で止まり、何も送らず受け取らない（司令塔の確かめの二重の守り）', async () => {
    const dbName = await deviceUsedBy()
    const db = cloudOfUid()
    const before = JSON.stringify([...db.docs.entries()])
    const b = device(db, 'pc', { dbName })
    await b.e.start()
    await sleep(50)
    expect(b.e.status).toMatchObject({ phase: 'error', errorCode: 'account-mismatch' })
    expect(await b.p.getMeta('uid')).toBe(OTHER)
    expect((await b.p.listEditions()).map((e) => e.id)).toEqual([old.edition.id])
    expect(await b.p.outboxCount()).toBe(0)
    b.e.requestUpload(true)
    await b.e.idle()
    expect(JSON.stringify([...db.docs.entries()])).toBe(before)
    expect(db.subs).toEqual([])
  })

  it('uid の無い端末（新しい端末・段階0からの上がり）は、印が無くても始める', async () => {
    const db = cloudOfUid()
    const b = device(db, 'pc')
    await startSynced(b)
    expect(await b.p.getMeta('uid')).toBe(UID)
  })
})

describe('端末の準備に失敗した時（docs/SPEC.md の 7.8 の8つの「同期できません（理由）」）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('端末の DB を読めなければ「受け取り中…」のままにせず error にし、少し後にやり直して受け取る', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const db = newDb()
    seed(db, fakeRecordsOf(makeFakeEdition({ date: UNTIL, slot: '12', seed: 'engine-prepare-fail' })))
    let failures = 1
    const a = device(db, 'A', {
      wrap: (p) => ({
        ...p,
        getMeta: <T>(key: string) => {
          if (key === 'uid' && failures > 0) {
            failures -= 1
            return Promise.reject(new Error('端末の保存先を読めません（テスト）'))
          }
          return p.getMeta<T>(key)
        },
      }),
    })
    await a.e.start()
    expect(a.e.status).toMatchObject({ phase: 'error', error: '端末の保存先を読めません（テスト）' })
    expect(db.subs).toEqual([])
    await vi.advanceTimersByTimeAsync(5_000)
    await waitFor(() => a.e.status.downloaded === true, '最初の受け取り')
    await a.e.idle()
    expect(a.e.status).toMatchObject({ phase: 'synced', error: null })
    expect(a.statuses.map((s) => s.phase)).toEqual(expect.arrayContaining(['error', 'downloading', 'synced']))
  })
})

describe('購読し直し（reanchor。docs/SPEC.md の 7.8 の engine.ts・7.9 の「購読し直し」）', () => {
  it('位置が進んだ時だけ、位置から購読し直す（読むのは位置と同じ時刻の文書だけ）', async () => {
    const db = newDb()
    seed(db, fakeRecordsOf(makeFakeEdition({ date: UNTIL, slot: '12', seed: 'engine-reanchor-a' })))
    const a = device(db, 'A')
    await startSynced(a)
    // 進んでいない: 購読し直さない
    const subs0 = db.subs.length
    a.e.reanchor()
    await sleep(30)
    await a.e.idle()
    expect(db.subs.length).toBe(subs0)
    // 新しい版が届いて位置が進む
    db.now += HOUR
    const next = makeFakeEdition({ date: addDaysToDate(UNTIL, 1), slot: '12', seed: 'engine-reanchor-a2' })
    seed(db, fakeRecordsOf(next), { at: db.now })
    notify(db)
    await waitFor(async () => (await a.p.listEditions()).length === 2, '新しい版')
    await a.e.idle()
    const cursor = (await a.p.getMeta<{ records?: { s: number; n: number } }>('cursor'))?.records
    const at = (cursor?.s ?? 0) * 1000 + Math.floor((cursor?.n ?? 0) / 1_000_000)
    expect(at).toBe(db.now)
    const reads0 = db.reads
    a.e.reanchor()
    await sleep(30)
    await a.e.idle()
    expect(db.subs.slice(subs0)).toEqual([{ place: 'records', from: at }])
    const sameTime = [...db.docs.entries()].filter(
      ([p, d]) =>
        p.startsWith(`users/${UID}/records/`) &&
        d.table !== 'termPacks' &&
        (d.updated as InstanceType<typeof mem.Timestamp>).toMillis() === at,
    ).length
    expect(db.reads - reads0).toBe(sameTime)
  })

  it('開いたまま31日そろわなかった後は、初めての受け取りに入り直す（「知ってる」は位置から1回、32日の窓から購読）', async () => {
    const db = newDb()
    seed(db, fakeRecordsOf(makeFakeEdition({ date: UNTIL, slot: '12', seed: 'engine-reanchor-b' })))
    const a = device(db, 'A')
    await startSynced(a)
    const known0 = db.knownReads
    db.now += 40 * DAY
    const subs0 = db.subs.length
    a.e.reanchor()
    await waitFor(() => a.statuses.some((s, i) => i > 0 && s.downloaded === false), '受け取りに入り直す')
    await waitFor(() => a.e.status.downloaded === true, '受け取り直す')
    await a.e.idle()
    expect(db.knownReads - known0).toBe(1)
    const records = db.subs.slice(subs0).filter((x) => x.place === 'records')
    expect(records[0]?.from).toBe(firstSyncSinceMs(db.now))
    const cursor = (await a.p.getMeta<{ records?: { s: number } }>('cursor'))?.records
    expect((cursor?.s ?? 0) * 1000).toBeGreaterThanOrEqual(firstSyncSinceMs(db.now) - 1000)
    expect(await a.p.getMeta('firstSync')).toBeNull()
    expect(await a.p.getMeta('caughtUpAt')).toBe(db.now)
    // 30日の外の版は端末に無い
    expect(await a.p.listEditions()).toEqual([])
  })

  it('初めての受け取りの 2. を待っている間・購読の再試行を待っている間は、何もしない', async () => {
    const db = newDb()
    const a = device(db, 'A')
    // 2. の購読がサーバーの最初の知らせを届けない
    db.holdListen.add('records')
    await a.e.start()
    await waitFor(() => db.subs.some((x) => x.place === 'records'), '2. の購読')
    expect(db.knownReads).toBe(1)
    const subs0 = db.subs.length
    // 31日たっても、2. の途中なら入り直さない（1. を読み直さない）
    db.now += 40 * DAY
    a.e.reanchor()
    await sleep(30)
    expect(db.knownReads).toBe(1)
    expect(db.subs.length).toBe(subs0)
    expect(a.e.status.downloaded).toBeFalsy()

    // 購読が止まって再試行を待っている間
    const db2 = newDb()
    const b = device(db2, 'B')
    db2.failListen.add('records')
    await b.e.start()
    await waitFor(() => b.statuses.some((s) => s.errorCode === 'quota'), '購読が止まる')
    const subs1 = db2.subs.length
    b.e.reanchor()
    await sleep(30)
    expect(db2.subs.length).toBe(subs1)
    expect(db2.knownReads).toBe(1)
  })
})

describe('購読の止まり・データの形の版の見張り直し（DS の sync.emu.test.ts の listenFailure・watchModel から）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('同期済みの後、新しい版を反映している間に records の購読が止まると、反映し終えても「同期済み」にしない', async () => {
    const db = newDb()
    seed(db, fakeRecordsOf(makeFakeEdition({ date: UNTIL, slot: '12', seed: 'engine-listen-a' })))
    const a = device(db, 'A')
    await startSynced(a)
    expect(a.e.status.phase).toBe('synced')
    // 次の知らせの直後に止まり、購読し直しても止まったまま
    db.errorAfterServer.add('records')
    db.failListen.add('records')
    db.now += HOUR
    seed(db, fakeRecordsOf(makeFakeEdition({ date: addDaysToDate(UNTIL, 1), slot: '12', seed: 'engine-listen-a2' })), {
      at: db.now,
    })
    notify(db)
    await waitFor(() => a.statuses.some((s) => s.errorCode === 'quota'), '購読が止まる')
    await waitFor(async () => (await a.p.listEditions()).length === 2, '新しい版を反映する')
    await sleep(50)
    await a.e.idle()
    expect(a.e.status).toMatchObject({ phase: 'error', errorCode: 'quota' })
  })

  it('records が止まったまま、ほかの端末の既読が private に届いても「同期済み」にしない（置き場ごとの止まりを見る）', async () => {
    const db = newDb()
    const fake = makeFakeEdition({ date: UNTIL, slot: '12', seed: 'engine-listen-b' })
    seed(db, fakeRecordsOf(fake))
    const a = device(db, 'A')
    const b = device(db, 'B')
    await startSynced(a)
    await startSynced(b)
    db.errorAfterServer.add('records')
    db.failListen.add('records')
    // records に何か届く → その直後に A の records の購読が止まる
    db.now += 1000
    const k = pressKnownTerm(null, { termId: termIdOf('〇〇法'), term: '〇〇法', asOf: null }, db.now)
    db.docs.set(
      knownDocPath(UID, k.id),
      encodeDoc('knownTerms', k, { device: 'other', updated: mem.Timestamp.fromMillis(db.now) }) as unknown as Data,
    )
    notify(db)
    await waitFor(() => a.statuses.some((s) => s.errorCode === 'quota'), 'A の購読が止まる')
    // B が既読を送る → A の private に届く
    const id = fake.edition.id
    await save(b.p, (r) => ({ ...r, reads: { [id]: readMark(id, [fake.edition.order[0]], true, db.now) } }))
    b.e.requestUpload(true)
    await b.e.idle()
    await waitFor(async () => !!(await a.p.loadUserRecords()).reads[id], 'A が既読を受け取る')
    await sleep(50)
    await a.e.idle()
    expect(a.e.status).toMatchObject({ phase: 'error', errorCode: 'quota' })
  })

  it('データの形の版の見張りが誤りで止まっても、少し後に見張り直して、その間に上がった版に気付く（送らない）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const db = newDb()
    const a = device(db, 'A')
    await startSynced(a)
    await waitFor(() => (db.docs.get(`users/${UID}/meta/app`) as { model?: number } | undefined)?.model === 1, '版 1')
    expect(db.docErrors.size).toBe(1)
    for (const f of [...db.docErrors]) f()
    // 見張りが止まっている間に、新しい版のアプリが上げた
    db.docs.set(`users/${UID}/meta/app`, { model: 2, appVersion: '9.0', updatedAt: mem.Timestamp.fromMillis(db.now) })
    notify(db)
    await sleep(50)
    expect(a.e.status.outdated ?? null).toBeNull()
    await vi.advanceTimersByTimeAsync(5_000)
    await waitFor(() => !!a.e.status.outdated, '要更新')
    expect(a.e.status.outdated).toMatchObject({ model: 2 })
    const known = pressKnownTerm(null, { termId: termIdOf('〇〇法'), term: '〇〇法', asOf: null }, db.now)
    await save(a.p, (r) => ({ ...r, knownTerms: { [known.id]: known } }))
    await a.e.flush()
    expect(db.docs.has(knownDocPath(UID, known.id))).toBe(false)
    expect(await a.p.outboxCount()).toBe(1)
  })
})
