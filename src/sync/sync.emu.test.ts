// 同期の結合テスト（docs/SPEC.md の 16.3 の「エミュレーター（2台）」・7.8）。Firebase エミュレーター（Auth・Firestore）と本番のアクセスルール
// （firestore.rules）の中で、本物の同期のエンジン（src/sync/engine.ts）と端末の保存（src/db/persistence.ts。fake-indexeddb）を2台動かす。
// 実行: npm run test:sync
// DS の src/sync/sync.emu.test.ts の仕組み（vi.mock('firebase/firestore') で onSnapshot・getDocs・runTransaction を包む・makeDevice・settle・
// waitFor）を写し、TS の形に直した:
// - 読んだ文書の数を端末ごとに数える（購読でサーバーから届いた文書・getDocsFromServer・getDoc(FromServer)・トランザクションの get）。
//   7.9 の見積もりと照らすため。問い合わせの形（置き場・where）も覚えて、「知ってる」を読んだ回数を数え、置き場ごとに購読を止められる
// - 偽のコネクタ: アプリから作れないコネクタの記録（版・話題・訂正・辞書の束・作れなかった印）を、管理者の権限で、コネクタと同じ外側の文書
//   （codec の encodeRecord。device: 'claude-connector'）で書く。作り物の1か月分（src/test/fixtures/fakeEditions.ts）は、作った時刻を
//   updated にして過去に置く（32日より前の物も混ぜる）
// - 端末の時計は、エンジンの now で端末ごとにずらす（時計の進んだ端末・0時をまたいだ端末・31日開かなかった端末）。エミュレーターの時計
//   （request.time・serverTimestamp）は、この機械の時計のまま
// - どのテストも本番のルールで、持ち主の記録（config/owner）を管理者の権限で作ってから動かす（ownerLock: true。アプリと同じ）
// - DS の場面のうち TS に無い物（分けた文書・ゴミ箱・復元・月の束・受け取り箱・競合の控え・85日の受け取り直し）は写していない（16.5）
// 記録はすべて作り物（「〇〇市」・https://example.com/…。公開のリポジトリ。docs/SPEC.md の 3.）
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { GoogleAuthProvider, connectAuthEmulator, getAuth, signInWithCredential } from 'firebase/auth'
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  initializeFirestore,
  memoryLocalCache,
  terminate,
  type Firestore,
} from 'firebase/firestore'
import emuRules from '../../firestore.emu.rules?raw'
import prodRules from '../../firestore.rules?raw'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence, type AnyRecord, type Persistence, type UserRecords } from '../db/persistence'
import { correctionsByTopic, editionShowState } from '../domain/editionShow'
import { stableStringify } from '../domain/equal'
import { correctionIdOf, editionIdOf, isExpiredDocId, termIdOf } from '../domain/ids'
import {
  addDaysToDate,
  firstSyncSinceMs,
  jstDateOf,
  jstStartOfDayMs,
  latestSlotAt,
  retentionBoundary,
  slotTimeMs,
} from '../domain/jst'
import { pressKnownTerm, unpressKnownTerm, type KnownTermPress } from '../domain/known'
import { RECORD_LIMITS } from '../domain/limits'
import { repairCorrection, repairEdition } from '../domain/repair'
import type { CorrectionRecord, KnownTerm, Place, ReadMark, Slot, Topic } from '../domain/types'
import {
  adminCreateOwner,
  adminDocIds,
  adminExists,
  adminGoogleUser,
  adminWriteRecords,
  clearFirestore,
  emulatorRequest,
  EMU_PROJECT,
  useRules,
  type AdminRecordDoc,
} from '../test/emulatorAdmin'
import {
  FAKE_MODEL,
  RULING_JP_KEY,
  fakeRecordsOf,
  makeFakeEdition,
  makeFakeMonth,
  type FakeEdition,
  type FakeMonth,
  type FakeRecord,
} from '../test/fixtures/fakeEditions'
import { APP_VERSION, DATA_MODEL, appModelRef, type AppModel } from './appModel'
import { encodeRecord, type Rec } from './codec'
import { OWNER_MISSING_MESSAGE, SENT_MARKS, SYNC_SCHEMA, createSyncEngine, type SyncEngine, type SyncStatus } from './engine'

// ---------- Firestore を包む（読んだ文書の数・問い合わせの形・止める・返事を落とす） ----------

/** where の1つ（欄・比べ方・値。documentId() は '__name__'） */
interface Filter {
  field: string
  op: string
  value: unknown
}

/** 問い合わせの形（集まりの道と where の並び） */
interface QueryTag {
  path: string
  filters: Filter[]
}

/** 購読でサーバーから届いた1件 */
interface Received {
  place: string
  docId: string
  /** 文書の updated（ミリ秒。サーバーの時刻がまだ付いていなければ null） */
  updated: number | null
}

const net = vi.hoisted(() => ({
  wheres: new WeakMap<object, Filter>(),
  queries: new WeakMap<object, QueryTag>(),
  /** Firestore ごとの、サーバーから読んだ文書の数（請求の数え方に近い見積もり。空の問い合わせも1） */
  reads: new Map<unknown, number>(),
  /** Firestore ごとの、購読でサーバーから届いた文書 */
  received: new Map<unknown, Received[]>(),
  /** Firestore ごとの、「知ってる」を読んだ回数（all = 全部、since = 位置から。初めての受け取りの 1.） */
  knownReads: new Map<unknown, { all: number; since: number }>(),
  /** 購読（問い合わせの onSnapshot）を、すぐに resource-exhausted（無料枠を使い切った）で止める置き場 */
  failListen: new Map<unknown, Set<string>>(),
  /** 次の送るトランザクションの返事を受け取れない Firestore（書き込みはクラウドに届く） */
  loseReply: new Set<unknown>(),
  /** 送るトランザクションが「通信できない」で失敗する Firestore（受け取りは続く） */
  offline: new Set<unknown>(),
  /** 記録の購読の通知を捨てる Firestore（自分の書き込みの知らせを受け取らないまま送り直す時の再現） */
  deaf: new Set<unknown>(),
}))

vi.mock('firebase/firestore', async (importOriginal) => {
  const m = await importOriginal<typeof import('firebase/firestore')>()
  type Snap = {
    metadata: { fromCache: boolean }
    docChanges?: () => { type: string; doc: { id: string; data: (o?: unknown) => { updated?: unknown } } }[]
  }
  type Tx = { get: (ref: { path: string }) => Promise<unknown> }
  const bump = (map: Map<unknown, number>, fs: unknown, n: number) => map.set(fs, (map.get(fs) ?? 0) + n)
  const fail = (code: string, message: string) => Object.assign(new Error(message), { name: 'FirebaseError', code })
  /** 集まりの道（users/{uid}/{置き場}）の置き場 */
  const placeOfPath = (path: string) => path.split('/')[2] ?? ''
  const knownKind = (tag: QueryTag | undefined): 'all' | 'since' | null => {
    if (!tag?.filters.some((f) => f.field === 'table' && f.op === '==' && f.value === 'knownTerms')) return null
    return tag.filters.some((f) => f.field === 'updated') ? 'since' : 'all'
  }

  const where = ((field: unknown, op: unknown, value: unknown) => {
    const c = (m.where as unknown as (...a: unknown[]) => object)(field, op, value)
    net.wheres.set(c, { field: typeof field === 'string' ? field : '__name__', op: String(op), value })
    return c
  }) as unknown as typeof m.where

  const query = ((base: object, ...cs: object[]) => {
    const q = (m.query as unknown as (...a: unknown[]) => object)(base, ...cs)
    const parent = net.queries.get(base)
    const filters = cs.flatMap((c) => {
      const f = net.wheres.get(c)
      return f ? [f] : []
    })
    net.queries.set(q, {
      path: parent?.path ?? String((base as { path?: unknown }).path ?? ''),
      filters: [...(parent?.filters ?? []), ...filters],
    })
    return q
  }) as unknown as typeof m.query

  const getDocsFromServer = (async (q: { firestore: unknown }) => {
    const kind = knownKind(net.queries.get(q))
    if (kind) {
      const k = net.knownReads.get(q.firestore) ?? { all: 0, since: 0 }
      k[kind] += 1
      net.knownReads.set(q.firestore, k)
    }
    const snap = await (m.getDocsFromServer as unknown as (x: unknown) => Promise<{ size: number }>)(q)
    bump(net.reads, q.firestore, Math.max(1, snap.size))
    return snap
  }) as unknown as typeof m.getDocsFromServer

  const single = (orig: (ref: unknown) => Promise<unknown>) => async (ref: { firestore: unknown }) => {
    const snap = await orig(ref)
    bump(net.reads, ref.firestore, 1)
    return snap
  }

  const onSnapshot = (ref: { firestore: unknown; type?: string; path?: string }, ...rest: unknown[]) => {
    const fs = ref.firestore
    const isQuery = ref.type !== 'document'
    const place = placeOfPath(net.queries.get(ref)?.path ?? ref.path ?? '')
    const i = rest.findIndex((x) => typeof x === 'function')
    const next = rest[i] as (snap: Snap) => void
    const onError = rest[i + 1] as ((e: unknown) => void) | undefined
    if (isQuery && net.failListen.get(fs)?.has(place)) {
      const t = setTimeout(() => onError?.(fail('resource-exhausted', '無料枠を使い切りました（テスト）')), 20)
      return () => clearTimeout(t)
    }
    let first = true
    rest[i] = (snap: Snap) => {
      if (!snap.metadata.fromCache) {
        if (isQuery && snap.docChanges) {
          const changes = snap.docChanges().filter((c) => c.type !== 'removed')
          bump(net.reads, fs, first ? Math.max(1, changes.length) : changes.length)
          const list = net.received.get(fs) ?? []
          for (const c of changes) {
            const u = c.doc.data({ serverTimestamps: 'none' }).updated
            list.push({ place, docId: c.doc.id, updated: u instanceof m.Timestamp ? u.toMillis() : null })
          }
          net.received.set(fs, list)
        } else if (first) bump(net.reads, fs, 1)
        first = false
      }
      if (isQuery && net.deaf.has(fs)) return
      next(snap)
    }
    return (m.onSnapshot as unknown as (...a: unknown[]) => () => void)(ref, ...rest)
  }

  const runTransaction = (async (fs: unknown, fn: (tx: Tx) => Promise<unknown>, ...more: unknown[]) => {
    /** 送るトランザクション（送る書き込みの印 sync/{端末} を読む）か。データの形の版を上げるトランザクションと分ける */
    let upload = false
    const wrapped = (tx: Tx) => {
      const get = tx.get.bind(tx)
      tx.get = (r: { path: string }) => {
        bump(net.reads, fs, 1)
        if (r.path.includes('/sync/')) upload = true
        return get(r)
      }
      return fn(tx)
    }
    if (net.offline.has(fs)) throw fail('unavailable', '通信できません（テスト）')
    const r = await (m.runTransaction as unknown as (...a: unknown[]) => Promise<unknown>)(fs, wrapped, ...more)
    if (upload && net.loseReply.delete(fs)) throw fail('unavailable', '返事を受け取れませんでした（テスト）')
    return r
  }) as unknown as typeof m.runTransaction

  return {
    ...m,
    where,
    query,
    onSnapshot,
    runTransaction,
    getDocsFromServer,
    getDoc: single(m.getDoc as unknown as (ref: unknown) => Promise<unknown>) as unknown as typeof m.getDoc,
    getDocFromServer: single(
      m.getDocFromServer as unknown as (ref: unknown) => Promise<unknown>,
    ) as unknown as typeof m.getDocFromServer,
  }
})

// ---------- 時刻 ----------

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/**
 * 作り物の版の、いちばん新しい枠（2時間前に出ているはずの枠）。訂正（版の 90分後まで）も含めて、どの記録の作った時刻も今より前になる
 * （updated を作った時刻に合わせるので、未来の時刻を置かない）
 */
function pastSlot(): { until: string; untilSlot: Slot } {
  const s = latestSlotAt(Date.now() - 2 * HOUR)
  return { until: s.date, untilSlot: s.slot }
}

/**
 * 日本時間の 0時の直前には、30日の境が途中で動かないよう、0時を過ぎるまで待つ（エミュレーターの request.time はこの機械の時計）。
 * 待つのは長くて margin＋1秒（そのテストの時間切れは長くしてある）
 */
async function awayFromJstMidnight(marginMs = 40_000): Promise<void> {
  const now = Date.now()
  const next = jstStartOfDayMs(addDaysToDate(jstDateOf(now), 1))
  if (next - now < marginMs) await new Promise((r) => setTimeout(r, next - now + 1_000))
}

// ---------- 端末 ----------

/** テストのアプリのデータの形の版（src/sync/appVersion.ts の値。アプリと同じく見張る） */
const APP: AppModel = { model: DATA_MODEL, appVersion: APP_VERSION }

interface DeviceOptions {
  /** 端末の中の保存先の名前（同じ名前で作ると、アプリを開き直した端末になる） */
  dbName?: string
  /** 端末の時計のずれ（ms。エンジンの now） */
  clockOffset?: number
  /** データの形の版（null なら確かめない） */
  appModel?: AppModel | null
}

interface Device {
  /** 端末の ID（送る書き込みの印 sync/{端末} の名前・文書の device） */
  name: string
  uid: string
  fs: Firestore
  p: Persistence
  dbName: string
  /** 端末の時計のずれ（途中で変えられる） */
  clock: { offset: number }
  engine: SyncEngine | null
  statuses: SyncStatus[]
  now(): number
  online(): Promise<void>
  /** 電波の無い間（エンジンを止める。端末の中の保存と送信待ちはそのまま） */
  offline(): void
  /** アプリを閉じる（エンジン・保存先・Firestore を閉じる。保存先の中身は残る） */
  close(): Promise<void>
  reads(): number
  knownReads(): { all: number; since: number }
  received(place?: Place): Received[]
  userRecords(): Promise<UserRecords>
  know(press: KnownTermPress): Promise<KnownTerm>
  unknow(termId: string): Promise<KnownTerm>
  markRead(editionId: string, topicId: string | null, opts?: { seen?: boolean }): Promise<ReadMark>
}

let seq = 0
const devices: Device[] = []

const uniqueDb = () => `emu-sync-${++seq}-${Math.random().toString(36).slice(2)}`
const account = () => `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** 作者のアカウントを作り、持ち主の記録（config/owner）を管理者の権限で置く（作者が Firebase の画面で作るのと同じ。形1） */
async function ownerAccount(): Promise<{ sub: string; uid: string }> {
  const sub = account()
  const uid = await adminGoogleUser(sub)
  await adminCreateOwner(uid)
  return { sub, uid }
}

/** 端末を作る（エミュレーターの仮の Google アカウントでログインする。同じ sub なら同じアカウント） */
async function makeDevice(name: string, sub: string, opts: DeviceOptions = {}): Promise<Device> {
  const app: FirebaseApp = initializeApp(
    { projectId: EMU_PROJECT, apiKey: 'fake-api-key', authDomain: 'localhost' },
    `${name}-${++seq}`,
  )
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const cred = GoogleAuthProvider.credential(JSON.stringify({ sub, email: `${sub}@example.com`, email_verified: true }))
  const { user } = await signInWithCredential(auth, cred)
  const fs = initializeFirestore(app, { localCache: memoryLocalCache() })
  connectFirestoreEmulator(fs, '127.0.0.1', 8080)
  const dbName = opts.dbName ?? uniqueDb()
  const p = createPersistence(dbName)
  const clock = { offset: opts.clockOffset ?? 0 }
  const statuses: SyncStatus[] = []
  let closed = false

  /** アプリの記録を1件書く（ストアと同じく、記録の参照だけを変えて save。端末の書き込みと送信待ちは同じトランザクション） */
  const put = async (table: 'knownTerms' | 'reads', rec: AnyRecord) => {
    const prev = await p.loadUserRecords()
    await p.save(prev, { ...prev, [table]: { ...prev[table], [rec.id]: rec } })
    device.engine?.requestUpload(true)
  }

  const device: Device = {
    name,
    uid: user.uid,
    fs,
    p,
    dbName,
    clock,
    engine: null,
    statuses,
    now: () => Date.now() + clock.offset,
    async online() {
      if (device.engine) return
      device.engine = createSyncEngine({
        firestore: fs,
        uid: user.uid,
        deviceId: name,
        target: p,
        uploadDelay: 10,
        uploadMaxWait: 50,
        ownerLock: true,
        appModel: opts.appModel === null ? undefined : (opts.appModel ?? APP),
        now: device.now,
        onStatus: (s) => statuses.push(s),
      })
      await device.engine.start()
    },
    offline() {
      device.engine?.stop()
      device.engine = null
    },
    async close() {
      if (closed) return
      closed = true
      device.offline()
      p.close()
      await terminate(fs)
      await deleteApp(app)
    },
    reads: () => net.reads.get(fs) ?? 0,
    knownReads: () => ({ ...(net.knownReads.get(fs) ?? { all: 0, since: 0 }) }),
    received: (place) => (net.received.get(fs) ?? []).filter((r) => !place || r.place === place),
    userRecords: () => p.loadUserRecords(),
    async know(press) {
      const prev = (await p.loadUserRecords()).knownTerms[press.termId] as KnownTerm | undefined
      const rec = pressKnownTerm(prev ?? null, press, device.now())
      await put('knownTerms', rec)
      return rec
    },
    async unknow(termId) {
      const prev = (await p.loadUserRecords()).knownTerms[termId] as KnownTerm | undefined
      if (!prev) throw new Error(`知ってるの記録がありません: ${termId}`)
      const rec = unpressKnownTerm(prev, device.now())
      await put('knownTerms', rec)
      return rec
    },
    // 話題を読んだ（topicId が null なら版の一覧を見ただけ）。topicIds は重なり無し・30件まで（src/test/fakeCloud.ts の markRead と同じ）
    async markRead(editionId, topicId, o = {}) {
      const prev = (await p.loadUserRecords()).reads[editionId] as ReadMark | undefined
      const at = device.now()
      const topicIds = [...(prev?.topicIds ?? [])]
      if (topicId && !topicIds.includes(topicId) && topicIds.length < RECORD_LIMITS.read.topicIds) topicIds.push(topicId)
      const rec = {
        ...(prev ?? { id: editionId, v: 1, createdAt: at, by: 'user', ai: null, editionId, seen: false }),
        updatedAt: at,
        topicIds,
        seen: (prev?.seen ?? false) || o.seen === true,
      } as ReadMark
      await put('reads', rec)
      return rec
    },
  }
  devices.push(device)
  return device
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false> | T, label: string, timeout = 20_000): Promise<T> {
  const until = Date.now() + timeout
  let last: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    if (Date.now() > until) throw new Error(`待ちきれませんでした: ${label}${last ? ` (${String(last)})` : ''}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** 最初の受け取り（2つの置き場とも。初めての受け取りなら 2. まで）が終わるまで待つ */
const downloaded = (d: Device, timeout = 30_000) =>
  waitFor(() => d.engine?.status.downloaded === true, `${d.name} の最初の受け取りが終わる`, timeout)

/**
 * 送受信がひと段落し、読んだ文書の数が 500ms 変わらなくなるまで待つ（最初の受け取りの後の、位置から購読し直す知らせ・データの形の版を
 * 上げるトランザクションは、downloaded の後に届くことがある。読んだ数を比べる前に）
 */
async function quiet(d: Device): Promise<void> {
  let last = -1
  await waitFor(async () => {
    await d.engine?.idle()
    const n = d.reads()
    if (n === last) return true
    last = n
    await new Promise((r) => setTimeout(r, 500))
    return false
  }, `${d.name} の送受信が静まる`)
}

/** 端末どうしの、アプリの記録と版の一覧（同期で同じになる物） */
async function viewOf(d: Device): Promise<string> {
  return stableStringify({ user: await d.p.loadUserRecords(), editions: (await d.p.listEditions()).map((e) => e.id) })
}

/** どの端末の送信待ちも空になり、アプリの記録と版の一覧がそろうまで待つ */
async function settle(...ds: Device[]): Promise<void> {
  let why = ''
  await waitFor(async () => {
    for (const d of ds) {
      await d.engine?.idle()
      const n = await d.p.outboxCount()
      if (n > 0) {
        why = `${d.name} の送信待ち ${n} 件: ${JSON.stringify(await d.p.readOutbox(3)).slice(0, 600)} / ${JSON.stringify(d.engine?.status)}`
        return false
      }
    }
    const views = await Promise.all(ds.map(viewOf))
    const ok = views.every((v) => v === views[0])
    if (!ok) why = `内容が違う: ${views.map((v) => v.slice(0, 600)).join(' <> ')}`
    return ok
  }, '端末の内容がそろう').catch((e: unknown) => {
    throw new Error(`${(e as Error).message}\n${why}`)
  })
}

/**
 * 版を出すか（画面のストアと同じく、端末から版と order の話題と訂正を読み、src/domain/editionShow.ts で決める。端末の時計。
 * src/test/fakeCloud.ts の shownEdition と同じ）
 */
async function shown(d: Device, editionId: string, gone: ReadonlySet<string> = new Set()) {
  const raw = (await d.p.listEditions()).find((e) => e.id === editionId)
  if (!raw) return { kind: 'none' as const }
  const ed = repairEdition(raw)
  if (ed.kind !== 'ok') return { kind: 'broken' as const }
  const state = editionShowState(ed.value, await d.p.getTopics(ed.value.order), d.now(), gone)
  if (state.kind !== 'ready') return state
  const corrections = (await d.p.correctionsOfEdition(editionId))
    .map((c) => repairCorrection(c))
    .flatMap((r) => (r.kind === 'ok' ? [r.value] : []))
  return {
    ...state,
    corrections: correctionsByTopic(
      corrections,
      state.topics.map((t) => t.id),
    ),
  }
}

// ---------- クラウドに置く（偽のコネクタ・ほかの端末） ----------

/** 外側の文書にする記録（表・記録・updated・書いた端末） */
interface PutRecord {
  table: string
  record: Rec
  at: number
  device?: string
}

function adminDoc(r: PutRecord): AdminRecordDoc {
  const enc = encodeRecord(r.record)
  return { table: r.table, id: r.record.id, json: enc.json, hash: enc.hash, updated: new Date(r.at), device: r.device }
}

/**
 * 偽のコネクタが記録を足す: 管理者の権限で、コネクタと同じ外側の文書（device: 'claude-connector'）を書く（docs/SPEC.md の 16.3）。
 * at は updated（既定は記録の作った時刻。作り物の1か月分を過去に置く）
 */
async function connectorAdds(
  uid: string,
  list: readonly FakeRecord[],
  at: (r: FakeRecord, i: number) => number = (r) => r.record.createdAt,
): Promise<void> {
  await adminWriteRecords(
    uid,
    'records',
    list.map((r, i) => adminDoc({ table: r.table, record: r.record, at: at(r, i) })),
  )
}

/** 偽のコネクタが、いま足す（updated は今の少し前から1ミリ秒ずつ。購読している端末にリアルタイムで届く） */
async function connectorAddsNow(uid: string, list: readonly FakeRecord[]): Promise<void> {
  const base = Date.now() - list.length - 1
  await connectorAdds(uid, list, (_, i) => base + i)
}

/** ほかの端末（前に使っていた端末）が書いたアプリの記録を、過去の updated で置く */
async function otherDeviceWrote(uid: string, place: Place, list: readonly Omit<PutRecord, 'device'>[]): Promise<void> {
  await adminWriteRecords(
    uid,
    place,
    list.map((r) => adminDoc({ ...r, device: 'old-phone' })),
  )
}

/** 既読の記録（docs/SPEC.md の 7.4） */
function readMarkAt(editionId: string, topicIds: string[], at: number): ReadMark {
  return { id: editionId, v: 1, createdAt: at, updatedAt: at, by: 'user', ai: null, editionId, topicIds, seen: true }
}

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
    editionId: topic.editionId,
    text,
  }
}

/** 何日分かの版から、日付が keep に当たる版（と、その話題・辞書の束・訂正・作れなかった印）だけを、コネクタが足す順に */
function pick(month: FakeMonth, keep: (date: string) => boolean): FakeRecord[] {
  const eds = month.editions.filter((e) => keep(e.edition.date))
  const topicIds = new Set(eds.flatMap((e) => e.edition.order))
  return fakeRecordsOf({
    editions: eds,
    editionFails: month.editionFails.filter((f) => keep(f.editionId.slice(0, 10))),
    corrections: month.corrections.filter((c) => topicIds.has(c.topicId)),
    scenes: month.scenes,
  })
}

/** 置き場の文書（持ち主の SDK で読む。ルールで持ち主は読める） */
async function cloudDocs(d: Device, place: Place) {
  return (await getDocs(collection(d.fs, 'users', d.uid, place))).docs.map((x) => ({ id: x.id, data: x.data() }))
}

/** クラウドに削除の印（deleted: true）・分けた文書が無い事を確かめる（TS は削除の印を書かない。7.8） */
async function expectNoTombstones(d: Device): Promise<void> {
  for (const place of ['records', 'private'] as const)
    for (const x of await cloudDocs(d, place)) {
      expect(x.data.deleted, x.id).toBe(false)
      expect(x.data.chunks, x.id).toBe(0)
    }
}

const adminHas = (uid: string, place: Place, docId: string) => adminExists(`users/${uid}/${place}/${encodeURIComponent(docId)}`)

const press = { termId: termIdOf(RULING_JP_KEY), term: '与党' }
const pressLaw = { termId: termIdOf('〇〇法'), term: '〇〇法', asOf: null }

// ---------- 用意と片付け ----------

beforeEach(async () => {
  await useRules(prodRules)
  await clearFirestore()
})

afterEach(async () => {
  for (const d of devices.splice(0)) await d.close()
  net.reads.clear()
  net.received.clear()
  net.knownReads.clear()
  net.failListen.clear()
  net.loseReply.clear()
  net.offline.clear()
  net.deaf.clear()
})

afterAll(async () => {
  // 次のテストファイルを本番のルールのまま流さない
  await useRules(emuRules)
})

// ---------- テスト ----------

describe('版を受け取る（エミュレーター・本番のルール。docs/SPEC.md の 7.8 の「版と話題を受け取る」）', () => {
  it('偽のコネクタ（管理者の権限・device: claude-connector）が版を足す → 2台が受け取って出す。辞書の束は受け取らない。訂正・作れなかった印も届く', async () => {
    const { sub, uid } = await ownerAccount()
    const pc = await makeDevice('pc', sub)
    const phone = await makeDevice('phone', sub)
    await pc.online()
    await phone.online()
    await Promise.all([downloaded(pc), downloaded(phone)])
    await Promise.all([quiet(pc), quiet(phone)])
    const before = { pc: pc.reads(), phone: phone.reads() }

    const fake = makeFakeEdition({ date: jstDateOf(Date.now()), slot: '12', seed: 'emu-connector' })
    await connectorAddsNow(uid, fakeRecordsOf(fake))
    const id = fake.edition.id
    for (const d of [pc, phone]) {
      const s = await waitFor(async () => {
        const x = await shown(d, id)
        return x.kind === 'ready' ? x : null
      }, `${d.name} に版が出る`)
      expect(s.topics.map((t) => t.id)).toEqual(fake.edition.order)
      // 辞書の束は購読の表に無いので届かない（端末にも入らない。7. の要点の 7）
      expect(d.received('records').some((r) => r.docId.startsWith('termPacks:'))).toBe(false)
      // 届いたのは版1・話題20（7.9 の「Claude の記録 42 × 3台」の1台・1版の分）
      expect(d.reads() - before[d.name as 'pc' | 'phone']).toBeLessThanOrEqual(1 + fake.topics.length + 2)
      expect(await d.p.outboxCount()).toBe(0)
    }
    // コネクタの記録は受け取ったまま入れる（知らない値・欄も残す。repair で直すのは表示用の写しだけ）
    const raw = (await pc.p.getTopics([fake.topics[0].id]))[0]
    expect(raw).toEqual(fake.topics[0])

    // 訂正（話題の id で始まる）と、次の枠の作れなかった印も届く
    const fix = correctionFor(fake.topics[3], '〇〇市の発表の日付は 11月13日ではなく 11月14日でした', Date.now())
    const failed = makeFakeMonth({ until: jstDateOf(Date.now()), days: 3, seed: 'emu-fail' }).editionFails[0]
    await connectorAddsNow(uid, [
      { table: 'corrections', record: fix },
      { table: 'editionFails', record: failed },
    ])
    for (const d of [pc, phone]) {
      await waitFor(async () => (await d.p.correctionsOfTopic(fake.topics[3].id)).length === 1, `${d.name} に訂正が届く`)
      const s = await shown(d, id)
      expect(s.kind === 'ready' && s.corrections.get(fake.topics[3].id)?.map((c) => c.id)).toEqual([fix.id])
      await waitFor(
        async () => (await d.p.listEditionFails()).some((f) => f.id === failed.id),
        `${d.name} に作れなかった印が届く`,
      )
    }
    // アプリは Claude の記録を書かない（送信待ちに積まず、クラウドの文書は管理者が置いた物のまま）
    expect((await getDoc(doc(pc.fs, 'users', uid, 'records', `topics:${fake.topics[0].id}`))).data()?.device).toBe(
      'claude-connector',
    )
  })

  it('最初の受け取りが終わっても欠けている話題は直接読む（32日の窓より前に書かれた話題）。クラウドにも無ければ、そろっている話題だけで出す', async () => {
    const { sub, uid } = await ownerAccount()
    const today = jstDateOf(Date.now())
    const late = makeFakeEdition({ date: today, slot: '12', seed: 'emu-old-updated' })
    const broken = makeFakeEdition({ date: today, slot: '20', seed: 'emu-connector-bug' })
    const recs = fakeRecordsOf(late)
    // 1本は32日の窓より前に書かれていて、購読では届かない（直接読めば届く）
    const stale = late.topics[19].id
    await connectorAdds(uid, recs, (r) => (r.record.id === stale ? Date.now() - 40 * DAY : Date.now() - HOUR))
    // コネクタの不具合: 1本がクラウドに無い
    await connectorAdds(
      uid,
      fakeRecordsOf(broken).filter((r) => r.record.id !== broken.topics[0].id),
      () => Date.now() - HOUR,
    )
    const a = await makeDevice('pc', sub)
    await a.online()
    await downloaded(a)
    expect(await shown(a, late.edition.id)).toEqual({ kind: 'waiting', missing: [stale] })
    expect(await shown(a, broken.edition.id)).toEqual({ kind: 'waiting', missing: [broken.topics[0].id] })
    await quiet(a)
    const before = a.reads()
    const got = await a.engine!.fetchTopics([stale, broken.topics[0].id])
    expect(got).toEqual({ found: [stale], missing: [broken.topics[0].id] })
    expect(a.reads() - before).toBe(2)
    expect((await shown(a, late.edition.id)).kind).toBe('ready')
    const s = await shown(a, broken.edition.id, new Set(got.missing))
    expect(s).toMatchObject({ kind: 'ready', missing: [broken.topics[0].id] })
    expect(s.kind === 'ready' && s.topics).toHaveLength(19)
  })
})

describe('既読・知ってるを送る・受け取る（エミュレーター・本番のルール。docs/SPEC.md の 7.8）', () => {
  it('PC で1本目、スマホで2本目を読み、スマホは版の一覧も見た → 両方の端末で両方とも既読・見た。既読は private だけにある', async () => {
    const { sub, uid } = await ownerAccount()
    const fake = makeFakeEdition({ date: jstDateOf(Date.now()), slot: '12', seed: 'emu-two-devices' })
    await connectorAdds(uid, fakeRecordsOf(fake), () => Date.now() - HOUR)
    const pc = await makeDevice('pc', sub)
    const phone = await makeDevice('phone', sub)
    await pc.online()
    await phone.online()
    await Promise.all([downloaded(pc), downloaded(phone)])
    const id = fake.edition.id
    const [t1, t2] = fake.edition.order
    await pc.markRead(id, t1)
    await phone.markRead(id, t2, { seen: true })
    await settle(pc, phone)
    for (const d of [pc, phone]) {
      const r = (await d.userRecords()).reads[id] as ReadMark
      expect([...r.topicIds].sort()).toEqual([t1, t2].sort())
      expect(r.seen).toBe(true)
    }
    // 既読は Claude が読めない置き場だけにある（D21。codec の placeOf）
    expect(await adminHas(uid, 'private', `reads:${id}`)).toBe(true)
    expect(await adminHas(uid, 'records', `reads:${id}`)).toBe(false)
    await expectNoTombstones(pc)
  })

  it('電波の無い PC で押して外す → スマホの「知ってる」の後に PC が同期すれば「外した」。asOf は新しい方', async () => {
    const { sub } = await ownerAccount()
    const phone = await makeDevice('phone', sub)
    const pc = await makeDevice('pc', sub)
    await phone.online()
    await pc.online()
    await Promise.all([downloaded(phone), downloaded(pc)])
    pc.offline()
    await phone.know({ ...press, asOf: '2026-12' })
    await settle(phone)
    await pc.know({ ...press, asOf: '2026-11' })
    await pc.unknow(press.termId)
    await pc.online()
    await settle(pc, phone)
    for (const d of [phone, pc])
      expect((await d.userRecords()).knownTerms[press.termId]).toMatchObject({ on: false, term: '与党', asOf: '2026-12' })
  })

  // 書き込みは届いたが返事が無く、ほかの端末がその書き込みの上で「知ってる」を外した。送る書き込みの印でその書き込みが届いていたと
  // 分かるので、送った内容を base にして合わせる（古い base = null で合わせると、この端末の「知ってる」が勝って、外したのが戻る。DS と同じ）
  for (const when of ['送る時', '送れない間に受け取る時'] as const) {
    it(`返事を受け取れなかった書き込みの上にほかの端末が外した版は、${when}に送る書き込みの印で気付き、送った内容を base にして合わせる`, async () => {
      const { sub, uid } = await ownerAccount()
      const a = await makeDevice('a', sub)
      const b = await makeDevice('b', sub)
      await a.online()
      await b.online()
      await Promise.all([downloaded(a), downloaded(b)])
      net.loseReply.add(a.fs)
      net.deaf.add(a.fs)
      await a.know({ ...press, asOf: '2026-11' })
      await waitFor(async () => (await b.userRecords()).knownTerms[press.termId], 'A の書き込みが B に届く')
      await waitFor(async () => (await a.p.readOutbox(5))[0]?.unconfirmed, 'A は返事を受け取っていない')
      a.offline()
      await b.unknow(press.termId)
      await settle(b)
      // A は閉じている間に、新しい説明の話題でもう一度押した（送信待ちが残る）
      await a.know({ ...press, asOf: '2026-12' })
      net.deaf.delete(a.fs)
      if (when === '送れない間に受け取る時') {
        net.offline.add(a.fs)
        await a.online()
        await waitFor(
          async () => ((await a.userRecords()).knownTerms[press.termId] as KnownTerm | undefined)?.on === false,
          'A が B の版を受け取って合わせる',
        )
        net.offline.delete(a.fs)
        a.engine!.requestUpload(true)
      } else await a.online()
      await settle(a, b)
      for (const d of [a, b])
        expect((await d.userRecords()).knownTerms[press.termId]).toMatchObject({ on: false, asOf: '2026-12' })
      expect((await getDoc(doc(a.fs, 'users', uid, SENT_MARKS, 'a'))).data()?.tx).toEqual(expect.any(String))
    })
  }

  it('続けて既読を付けても、先に送った古い版の知らせで巻き戻らない。送り終わると送信待ちが空になり、同じ内容を書き直し続けない', async () => {
    const { sub, uid } = await ownerAccount()
    const fake = makeFakeEdition({ date: jstDateOf(Date.now()), slot: '12', seed: 'emu-many-reads' })
    await connectorAdds(uid, fakeRecordsOf(fake), () => Date.now() - HOUR)
    const pc = await makeDevice('pc', sub)
    const phone = await makeDevice('phone', sub)
    await pc.online()
    await phone.online()
    await Promise.all([downloaded(pc), downloaded(phone)])
    const id = fake.edition.id
    const order = fake.edition.order.slice(0, 8)
    for (const t of order) {
      await pc.markRead(id, t)
      await new Promise((r) => setTimeout(r, 30))
    }
    await settle(pc, phone)
    for (const d of [pc, phone]) expect(((await d.userRecords()).reads[id] as ReadMark).topicIds).toEqual(order)
    const ref = doc(pc.fs, 'users', uid, 'private', `reads:${id}`)
    const first = (await getDoc(ref)).data()?.updated
    await new Promise((r) => setTimeout(r, 800))
    await pc.engine!.idle()
    expect(await pc.p.outboxCount()).toBe(0)
    expect((await getDoc(ref)).data()?.updated).toEqual(first)
    expect(pc.engine!.status.phase).toBe('synced')
  })

  it('同期の形の版が変わった端末は、位置を消して初めての受け取りからやり直す', async () => {
    const { sub } = await ownerAccount()
    const a = await makeDevice('a', sub)
    const dbName = uniqueDb()
    const b = await makeDevice('b', sub, { dbName })
    await a.online()
    await b.online()
    await Promise.all([downloaded(a), downloaded(b)])
    await b.close()
    await a.know({ ...pressLaw })
    await settle(a)
    // b は受け取った位置を進めたまま、その記録を知らない（古い版が知らない表を飛ばした時の再現）
    const p = createPersistence(dbName)
    await p.setMeta('cursor', { records: { s: Math.floor(Date.now() / 1000) + 60, n: 0 } })
    await p.setMeta('syncSchema', SYNC_SCHEMA - 1)
    p.close()
    const b2 = await makeDevice('b', sub, { dbName })
    await b2.online()
    await waitFor(async () => (await b2.userRecords()).knownTerms[pressLaw.termId], '受け取り直して届く')
    expect(await b2.p.getMeta('syncSchema')).toBe(SYNC_SCHEMA)
    expect(b2.knownReads()).toEqual({ all: 1, since: 0 })
  })
})

describe('初めての受け取り（エミュレーター・本番のルール。docs/SPEC.md の 7.8・7.9）', () => {
  it('「知ってる」は全部、版・話題・既読は端末の時計 − 32日より後に書かれた物だけを読む。32日より前の物は0件で、受け取った数は見積もり（7.9）の範囲', async () => {
    await awayFromJstMidnight()
    const { sub, uid } = await ownerAccount()
    const { until, untilSlot } = pastSlot()
    const month = makeFakeMonth({ until, days: 34, untilSlot, seed: 'emu-first-sync' })
    const recs = fakeRecordsOf(month)
    await connectorAdds(uid, recs)
    const now = Date.now()
    // ほかの端末が前に押した「知ってる」（100日前・3日前）と、付けた既読（40日前の版・31日前の版・きのうの版）
    const oldKnown = pressKnownTerm(null, pressLaw, now - 100 * DAY)
    const newKnown = pressKnownTerm(null, { ...press, asOf: '2026-11' }, now - 3 * DAY)
    await otherDeviceWrote(uid, 'records', [
      { table: 'knownTerms', record: oldKnown, at: oldKnown.updatedAt },
      { table: 'knownTerms', record: newKnown, at: newKnown.updatedAt },
    ])
    const readOn = (daysAgo: number) => {
      const date = addDaysToDate(jstDateOf(now), -daysAgo)
      const at = slotTimeMs(date, '12') + 2 * HOUR
      return { table: 'reads', record: readMarkAt(editionIdOf(date, '12'), [], at), at }
    }
    const reads = { old: readOn(40), edge: readOn(31), recent: readOn(1) }
    await otherDeviceWrote(uid, 'private', Object.values(reads))
    // 32日の窓より前に書かれた物が、クラウドにある（テストの前提）
    const t0 = Date.now()
    const before = recs.filter((r) => r.record.createdAt < firstSyncSinceMs(t0))
    expect(before.filter((r) => r.table === 'editions').length).toBeGreaterThan(0)
    expect(before.filter((r) => r.table === 'topics').length).toBeGreaterThan(0)

    const a = await makeDevice('pc', sub)
    await a.online()
    await downloaded(a, 60_000)
    const t1 = Date.now()
    await quiet(a)

    // 1.「知ってる」は全部を1回だけ読む（100日前の物も）
    expect(a.knownReads()).toEqual({ all: 1, since: 0 })
    const known = (await a.userRecords()).knownTerms
    expect(known[oldKnown.id]).toEqual(oldKnown)
    expect(known[newKnown.id]).toEqual(newKnown)
    // 2. 購読で届いたのは、購読を始めた位置（t0〜t1 の端末の時計 − 32日）より後に書かれた物だけ。辞書の束は届かない
    const got = a.received()
    for (const r of got) expect(r.updated ?? Infinity, r.docId).toBeGreaterThanOrEqual(firstSyncSinceMs(t0))
    expect(got.some((r) => r.docId.startsWith('termPacks:'))).toBe(false)
    const ids = new Set(got.map((r) => `${r.place}/${r.docId}`))
    for (const r of before) expect(ids.has(`records/${r.table}:${r.record.id}`), r.record.id).toBe(false)
    const window = recs.filter((r) => r.table !== 'termPacks' && r.record.createdAt >= firstSyncSinceMs(t1))
    for (const r of window) expect(ids.has(`records/${r.table}:${r.record.id}`), r.record.id).toBe(true)
    // 3. private も − 32日から: 40日前の既読は届かない。31日前の既読は届くが30日の外なので端末に入れない
    expect(ids.has(`private/reads:${reads.old.record.id}`)).toBe(false)
    expect(ids.has(`private/reads:${reads.recent.record.id}`)).toBe(true)
    expect(Object.keys((await a.userRecords()).reads)).toEqual([reads.recent.record.id])
    // 端末には30日の内の版だけ（端末の時計）
    const { firstKeptDate } = retentionBoundary(t1)
    expect((await a.p.listEditions()).map((e) => e.id)).toEqual(
      month.editions.filter((e) => e.edition.date >= firstKeptDate).map((e) => e.edition.id),
    )
    // 受け取った数（7.9 の「新しい端末の初めての受け取り」）: 持ち主 1・「知ってる」全部 2・32日分の版・話題・訂正・作れなかった印と、
    // その間に押された「知ってる」・既読（購読で届く）。多い方は、データの形の版の見張り 1・上げるトランザクション 1 と、2. を終えた後に
    // 位置から購読し直した分（位置と同じ時刻の文書だけ）の余裕 10
    const inWindow = (since: number) =>
      recs.filter((r) => r.table !== 'termPacks' && r.record.createdAt >= since).length +
      [oldKnown, newKnown].filter((k) => k.updatedAt >= since).length +
      Object.values(reads).filter((r) => r.at >= since).length
    const least = 1 + 2 + inWindow(firstSyncSinceMs(t1))
    const most = 1 + 2 + 2 + inWindow(firstSyncSinceMs(t0)) + 10
    expect(a.reads()).toBeGreaterThanOrEqual(least)
    expect(a.reads()).toBeLessThanOrEqual(most)
    expect(a.reads()).toBeLessThanOrEqual(5_500)
    // 32日分の版 64・話題 1,280 を超えない（7.9）
    const unique = (prefix: string) => new Set(got.filter((r) => r.docId.startsWith(prefix)).map((r) => r.docId)).size
    expect(unique('editions:')).toBeLessThanOrEqual(64)
    expect(unique('topics:')).toBeLessThanOrEqual(1_280)
    // 位置は購読を始めた位置より後へ進み、firstSync は消え、caughtUpAt を書いた
    expect(await a.p.getMeta('firstSync')).toBeNull()
    const caughtUpAt = await a.p.getMeta<number>('caughtUpAt')
    expect(caughtUpAt).toBeGreaterThanOrEqual(t0)
    expect(caughtUpAt).toBeLessThanOrEqual(t1)
    const cursor = await a.p.getMeta<{ records?: { s: number } }>('cursor')
    expect((cursor?.records?.s ?? 0) * 1000).toBeGreaterThanOrEqual(firstSyncSinceMs(t0) - 1000)
  }, 150_000)

  it('31日書かれない間に10回開いても、「知ってる」を全部読むのは1回（入るかを caughtUpAt で決める）', async () => {
    const { sub, uid } = await ownerAccount()
    const { until, untilSlot } = pastSlot()
    await connectorAdds(uid, fakeRecordsOf(makeFakeMonth({ until, days: 3, untilSlot, seed: 'emu-quiet' })))
    const dbName = uniqueDb()
    const total = { all: 0, since: 0 }
    for (let i = 0; i <= 10; i++) {
      // 4日ごとに開く（端末の時計を進める。コネクタはその間に何も書かない）
      const d = await makeDevice('pc', sub, { dbName, clockOffset: i * 4 * DAY })
      await d.online()
      await downloaded(d)
      await quiet(d)
      const k = d.knownReads()
      total.all += k.all
      total.since += k.since
      // 開き直した時に読むのは、位置と同じ時刻の文書と持ち主・データの形の版くらい（32日分を読み直さない）
      if (i > 0) expect(d.reads(), `${i}回目`).toBeLessThan(30)
      expect(await d.p.getMeta<number>('caughtUpAt'), `${i}回目`).toBeGreaterThanOrEqual(d.now() - MIN)
      await d.close()
    }
    expect(total).toEqual({ all: 1, since: 0 })
  }, 120_000)

  it('2. の購読が失敗して再試行しても、開き直しても、1. を読み直さない', async () => {
    const { sub, uid } = await ownerAccount()
    const fake = makeFakeEdition({ date: jstDateOf(Date.now()), slot: '12', seed: 'emu-retry' })
    await connectorAdds(uid, fakeRecordsOf(fake), () => Date.now() - HOUR)
    await otherDeviceWrote(uid, 'records', [
      { table: 'knownTerms', record: pressKnownTerm(null, pressLaw, Date.now() - DAY), at: Date.now() - DAY },
    ])
    const dbName = uniqueDb()
    const a = await makeDevice('pc', sub, { dbName })
    net.failListen.set(a.fs, new Set(['records']))
    await a.online()
    await waitFor(() => a.engine?.status.errorCode === 'quota', '2. の購読が止まる')
    expect(a.knownReads()).toEqual({ all: 1, since: 0 })
    expect(await a.p.getMeta('firstSync')).toMatchObject({ knownAt: expect.any(Number) })
    expect(a.engine!.status.downloaded).toBeFalsy()
    expect((await a.userRecords()).knownTerms[pressLaw.termId]).toBeDefined()
    await a.close()

    // 開き直した（2. はまだ止まったまま）: 1. は読まずに 2. から
    const b = await makeDevice('pc', sub, { dbName })
    net.failListen.set(b.fs, new Set(['records']))
    await b.online()
    await waitFor(() => b.engine?.status.errorCode === 'quota', '開き直しても 2. の購読が止まる')
    expect(b.knownReads()).toEqual({ all: 0, since: 0 })
    // 受け取りが止まっている間も送るが、送り終えても同期の状態は止まった理由のまま（「同期済み」と出さない。DS の listenFailure）
    await b.know({ ...press, asOf: '2026-11' })
    await waitFor(async () => (await b.p.outboxCount()) === 0, '止まっている間も送る')
    await b.engine!.idle()
    expect(b.engine!.status).toMatchObject({ phase: 'error', errorCode: 'quota' })
    expect(await adminHas(uid, 'records', `knownTerms:${press.termId}`)).toBe(true)
    // 購読が戻る（エンジンが少し後に再試行する）: 1. を読み直さずに 2. を終える
    net.failListen.delete(b.fs)
    await downloaded(b, 45_000)
    expect(b.knownReads()).toEqual({ all: 0, since: 0 })
    expect(await b.p.getMeta('firstSync')).toBeNull()
    expect((await shown(b, fake.edition.id)).kind).toBe('ready')
    expect(b.engine!.status.errorCode ?? null).toBeNull()
  }, 90_000)
})

describe('30日で消す（エミュレーター・本番のルール。docs/SPEC.md の 7.8 の「30日で消す」「端末の中で消す」）', () => {
  /**
   * 30日の境の前後の日（境の外の3日・内の4日）と、いちばん新しい版を置く。境の外と内の1本ずつに訂正を足し、境の外と内の版に既読を置く
   * （ほかの端末が付けた物）
   */
  async function seedAroundBoundary(uid: string) {
    const now = Date.now()
    const { lastExpiredDate, firstKeptDate } = retentionBoundary(now)
    const { until, untilSlot } = pastSlot()
    const month = makeFakeMonth({ until, days: 34, untilSlot, seed: 'emu-expire' })
    const near = (date: string) =>
      (date >= addDaysToDate(lastExpiredDate, -2) && date <= addDaysToDate(firstKeptDate, 3)) || date === until
    const recs = pick(month, near)
    const edition = (date: string, slot: Slot): FakeEdition =>
      month.editions.find((e) => e.edition.id === editionIdOf(date, slot))!
    const expiredEd = edition(lastExpiredDate, '20')
    const keptEd = edition(firstKeptDate, '12')
    const expiredFix = correctionFor(
      expiredEd.topics[2],
      '△△県の人口は 120万人ではなく 102万人でした',
      expiredEd.edition.createdAt + HOUR,
    )
    const keptFix = correctionFor(keptEd.topics[2], '〇〇通信の記事の題が違っていました', keptEd.edition.createdAt + HOUR)
    await connectorAdds(uid, [...recs, { table: 'corrections', record: expiredFix }, { table: 'corrections', record: keptFix }])
    const readsOf = [expiredEd, keptEd].map((e) => {
      const at = e.edition.createdAt + 2 * HOUR
      return { table: 'reads', record: readMarkAt(e.edition.id, [e.topics[0].id], at), at }
    })
    await otherDeviceWrote(uid, 'private', readsOf)
    const docIds = [
      ...recs.map((r) => ({ place: 'records' as const, docId: `${r.table}:${r.record.id}` })),
      { place: 'records' as const, docId: `corrections:${expiredFix.id}` },
      { place: 'records' as const, docId: `corrections:${keptFix.id}` },
      ...readsOf.map((r) => ({ place: 'private' as const, docId: `reads:${r.record.id}` })),
    ]
    return { month, recs, docIds, expiredEd, keptEd, expiredFix, keptFix, lastExpiredDate, firstKeptDate }
  }

  /** サーバーの時刻の見積もりを本当の時刻に近づける（自分の書き込みの知らせを受け取る。7.8 の「時刻」） */
  async function nearServerTime(d: Device, term = pressLaw): Promise<void> {
    await d.know(term)
    await waitFor(
      () => Math.abs((d.engine?.serverNow() ?? 0) - Date.now()) < MIN,
      `${d.name} のサーバーの時刻の見積もりが今に近づく`,
    )
  }

  it('1台目が版・話題・訂正・作れなかった印・既読の30日の外を消し、2台目は0件。訂正は話題と同じ日に消え（クラウドも端末の中も）、辞書の束・知ってるは残る。削除の印は書かない', async () => {
    await awayFromJstMidnight()
    const { sub, uid } = await ownerAccount()
    const s = await seedAroundBoundary(uid)
    const a = await makeDevice('a', sub)
    const b = await makeDevice('b', sub)
    await a.online()
    await b.online()
    await Promise.all([downloaded(a), downloaded(b)])
    await nearServerTime(a)
    await settle(a, b)
    await waitFor(() => Math.abs((b.engine?.serverNow() ?? 0) - Date.now()) < MIN, 'B の見積もりも今に近づく')
    // 端末には30日の内の物だけ（境の外の訂正も入れない）
    expect(await a.p.correctionsOfTopic(s.expiredFix.topicId)).toEqual([])
    expect((await a.p.correctionsOfTopic(s.keptFix.topicId)).map((c) => c.id)).toEqual([s.keptFix.id])

    const now = Date.now()
    const expired = s.docIds.filter((x) => isExpiredDocId(x.docId, now))
    const count = (table: string) => expired.filter((x) => x.docId.startsWith(`${table}:`)).length
    expect(count('editions')).toBe(6)
    expect(count('corrections')).toBeGreaterThanOrEqual(1)
    const r1 = await a.engine!.maintain()
    expect(r1).toMatchObject({ skipped: null, capped: false, total: expired.length })
    expect(r1.deleted).toEqual(
      Object.fromEntries(
        (['editions', 'editionFails', 'topics', 'corrections', 'reads'] as const)
          .filter((t) => count(t) > 0)
          .map((t) => [t, count(t)]),
      ),
    )
    const left = new Set([
      ...(await adminDocIds(uid, 'records')).map((x) => `records/${x}`),
      ...(await adminDocIds(uid, 'private')).map((x) => `private/${x}`),
    ])
    for (const x of s.docIds) expect(left.has(`${x.place}/${x.docId}`), x.docId).toBe(!isExpiredDocId(x.docId, now))
    // 訂正は話題と同じ日に消える（境の外の話題の訂正は消え、境の内の話題の訂正は話題と一緒に残る）
    expect(left.has(`records/corrections:${s.expiredFix.id}`)).toBe(false)
    expect(left.has(`records/topics:${s.expiredFix.topicId}`)).toBe(false)
    expect(left.has(`records/corrections:${s.keptFix.id}`)).toBe(true)
    expect(left.has(`records/topics:${s.keptFix.topicId}`)).toBe(true)
    // 辞書の束（境の外の版の物も）・知ってるは消さない
    expect(left.has(`records/termPacks:${s.expiredEd.termPack.id}`)).toBe(true)
    expect(left.has(`records/knownTerms:${pressLaw.termId}`)).toBe(true)
    await expectNoTombstones(a)

    // 2台目は0件を見つけるだけ。同じ端末の2回目は今日はしない
    expect(await b.engine!.maintain()).toMatchObject({ skipped: null, total: 0 })
    expect(await a.engine!.maintain()).toMatchObject({ skipped: 'done-today', total: 0 })
    expect(await a.p.getMeta('lastMaintainDay')).toBe(jstDateOf(Date.now()))

    // 端末の中: 日付が変わると（端末の時計を1日進める）、境の内だった版の話題と、その訂正が同じ日に消える。送信待ちは積まない
    expect(await a.p.topicsOfEdition(s.keptEd.edition.id)).toHaveLength(20)
    expect((await a.userRecords()).reads[s.keptEd.edition.id]).toBeDefined()
    a.clock.offset = DAY
    await a.engine!.expireLocal(true)
    expect((await a.p.listEditions()).some((e) => e.id === s.keptEd.edition.id)).toBe(false)
    expect(await a.p.topicsOfEdition(s.keptEd.edition.id)).toEqual([])
    expect((await a.userRecords()).reads[s.keptEd.edition.id]).toBeUndefined()
    expect(await a.p.correctionsOfTopic(s.keptFix.topicId)).toEqual([])
    expect(await a.p.outboxCount()).toBe(0)
    // 端末の中で消してもクラウドには何もしない（クラウドは次の日の手入れで消える）
    expect(await adminHas(uid, 'records', `corrections:${s.keptFix.id}`)).toBe(true)
    await expectNoTombstones(a)
  }, 150_000)

  it('時計の進んだ端末は、サーバーの時刻の見積もりで消すので、30日の内の物を早く消さない（ルールでも消せない）', async () => {
    await awayFromJstMidnight()
    const { sub, uid } = await ownerAccount()
    const s = await seedAroundBoundary(uid)
    const fast = await makeDevice('fast', sub, { clockOffset: 3 * DAY })
    await fast.online()
    await downloaded(fast)
    await nearServerTime(fast)
    const now = Date.now()
    const expired = s.docIds.filter((x) => isExpiredDocId(x.docId, now))
    // 端末の時計（3日進んでいる）では、境の内の3日分も30日を過ぎている
    const early = s.docIds.filter((x) => !isExpiredDocId(x.docId, now) && isExpiredDocId(x.docId, fast.now()))
    expect(early.filter((x) => x.docId.startsWith('editions:')).length).toBeGreaterThanOrEqual(6)
    const r = await fast.engine!.maintain()
    expect(r).toMatchObject({ skipped: null, total: expired.length })
    const left = new Set(await adminDocIds(uid, 'records'))
    for (const x of early.filter((y) => y.place === 'records')) expect(left.has(x.docId), x.docId).toBe(true)
    expect(left.has(`editions:${editionIdOf(s.firstKeptDate, '12')}`)).toBe(true)
  }, 150_000)

  it('電波の無い間に読んだ既読が、端末の 0時をまたいで30日を過ぎても送信が止まらず（ほかの送信待ちは送る）、削除の印も書かない', async () => {
    await awayFromJstMidnight()
    const { sub, uid } = await ownerAccount()
    const s = await seedAroundBoundary(uid)
    const a = await makeDevice('a', sub)
    await a.online()
    await downloaded(a)
    await nearServerTime(a)
    const edge = editionIdOf(s.firstKeptDate, '20')
    const ed = s.month.editions.find((e) => e.edition.id === edge)!
    a.offline()
    await a.markRead(edge, ed.topics[0].id, { seen: true })
    await a.know({ ...press, asOf: '2026-11' })
    expect(await a.p.outboxCount()).toBe(2)
    // 端末の時計が次の日の 0:05（日本時間）になってからつながる
    a.clock.offset = jstStartOfDayMs(addDaysToDate(jstDateOf(Date.now()), 1)) + 5 * MIN - Date.now()
    await a.online()
    await waitFor(async () => (await a.p.outboxCount()) === 0, '送信待ちが空になる')
    expect(await adminHas(uid, 'records', `knownTerms:${press.termId}`)).toBe(true)
    expect(await adminHas(uid, 'private', `reads:${edge}`)).toBe(false)
    expect((await a.userRecords()).reads[edge]).toBeUndefined()
    expect(await a.p.topicsOfEdition(edge)).toEqual([])
    await expectNoTombstones(a)
    expect(a.engine!.status.errorCode ?? null).toBeNull()
  }, 150_000)

  it('既読の送信待ちがある端末で、別の端末が30日の削除をした → 送信待ち 0件・作り直さない（開き直した端末の時計が遅れ、見積もりも古い）', async () => {
    await awayFromJstMidnight()
    const { sub, uid } = await ownerAccount()
    const { lastExpiredDate } = retentionBoundary(Date.now())
    const yesterday = addDaysToDate(jstDateOf(Date.now()), -1)
    // 境の外（今日 − 30日）の版と、きのうの 20:00版（いちばん新しい記録。今日の 0時より前に書かれた）
    const old = makeFakeEdition({ date: lastExpiredDate, slot: '20', seed: 'emu-gone-old' })
    const latest = makeFakeEdition({ date: yesterday, slot: '20', seed: 'emu-gone-latest' })
    await connectorAdds(uid, [...fakeRecordsOf(old), ...fakeRecordsOf(latest)])
    const dbName = uniqueDb()
    // A の時計は1日遅れている（A の時計では、境の外の版がまだ30日の内）
    const a = await makeDevice('a', sub, { dbName, clockOffset: -DAY })
    const b = await makeDevice('b', sub)
    await a.online()
    await b.online()
    await Promise.all([downloaded(a), downloaded(b)])
    const id = old.edition.id
    await a.markRead(id, old.topics[0].id)
    await settle(a)
    expect(await adminHas(uid, 'private', `reads:${id}`)).toBe(true)
    await a.close()
    // A は閉じている間に、もう1本読んだ（送信待ちが残る）
    const p = createPersistence(dbName)
    const prev = await p.loadUserRecords()
    const r = prev.reads[id] as ReadMark
    const more: ReadMark = { ...r, topicIds: [...r.topicIds, old.topics[1].id], updatedAt: Date.now() - DAY }
    await p.save(prev, { ...prev, reads: { ...prev.reads, [id]: more } })
    expect(await p.outboxCount()).toBe(1)
    p.close()
    // B が30日の手入れで既読を消した（B は A の既読の知らせで、サーバーの時刻の見積もりができている）
    await waitFor(() => Math.abs((b.engine?.serverNow() ?? 0) - Date.now()) < MIN, 'B の見積もりが今に近づく')
    expect((await b.engine!.maintain()).deleted.reads).toBe(1)
    expect(await adminHas(uid, 'private', `reads:${id}`)).toBe(false)
    // 開き直した A は、新しい文書を受け取らないので、サーバーの時刻の見積もりが古い文書から（きのうの 20:00版）。端末の時計も遅れて
    // いるので、送る前の守りでは捨てられず、送るトランザクションでクラウドに無いと分かる（作り直さずに送り終わり）
    const a2 = await makeDevice('a', sub, { dbName, clockOffset: -DAY })
    await a2.online()
    await downloaded(a2)
    await waitFor(async () => (await a2.p.outboxCount()) === 0, '送信待ちが空になる')
    expect(a2.engine!.serverNow()).toBeLessThan(jstStartOfDayMs(jstDateOf(Date.now())))
    expect(await adminHas(uid, 'private', `reads:${id}`)).toBe(false)
    await expectNoTombstones(a2)
  }, 150_000)
})

describe('持ち主・データの形の版（エミュレーター・本番のルール。docs/SPEC.md の 7.8 の「持ち主・データの形の版・同期の表示」）', () => {
  it('持ち主の記録が無い → 同期しない（送らない・受け取らない・データの形の版も書かない）。同期の状態に理由を出す', async () => {
    const sub = account()
    const uid = await adminGoogleUser(sub)
    await connectorAdds(
      uid,
      fakeRecordsOf(makeFakeEdition({ date: jstDateOf(Date.now()), slot: '12', seed: 'emu-no-owner' })),
      () => Date.now() - HOUR,
    )
    const a = await makeDevice('a', sub)
    await a.know({ ...pressLaw })
    await a.online()
    await waitFor(() => a.engine?.status.phase === 'error', '同期を始めない')
    expect(a.engine!.status).toMatchObject({ errorCode: 'owner-missing', error: OWNER_MISSING_MESSAGE })
    await new Promise((r) => setTimeout(r, 1000))
    expect(await a.p.outboxCount()).toBe(1)
    expect(await a.p.listEditions()).toEqual([])
    expect((await adminDocIds(uid, 'records')).some((x) => x.startsWith('knownTerms:'))).toBe(false)
    expect(await adminExists(`users/${uid}/meta/app`)).toBe(false)
    expect(await adminExists(`users/${uid}/${SENT_MARKS}/a`)).toBe(false)
    expect(await a.p.getMeta('ownerSeen')).toBeUndefined()
    expect(await a.p.getMeta('uid')).toBeUndefined()
    // 読んだのは持ち主の記録の1回だけ
    expect(a.reads()).toBe(1)
  })

  it('ほかのアカウントの持ち主の記録 → 同期せず、この端末の持ち主の印を消す', async () => {
    const other = await ownerAccount()
    const sub = account()
    const a = await makeDevice('a', sub)
    await a.p.setMeta('ownerSeen', a.uid)
    await a.online()
    await waitFor(() => a.engine?.status.errorCode === 'owner-mismatch', 'ほかのアカウントの記録と分かる')
    expect(await a.p.getMeta('ownerSeen')).toBeNull()
    expect(await adminDocIds(other.uid, 'records')).toEqual([])
  })

  it('データの形の版が高い → 受け取りは続け、送らない（送信待ちに残る）。クラウドの版は下げない', async () => {
    const { sub, uid } = await ownerAccount()
    await emulatorRequest('PATCH', `/v1/projects/${EMU_PROJECT}/databases/(default)/documents/users/${uid}/meta/app`, {
      fields: {
        model: { integerValue: String(DATA_MODEL + 1) },
        appVersion: { stringValue: '9.9' },
        updatedAt: { timestampValue: new Date().toISOString() },
      },
    })
    const a = await makeDevice('a', sub)
    await a.online()
    await waitFor(() => a.engine?.status.outdated?.model === DATA_MODEL + 1, '新しい版のアプリで書かれていると気付く')
    await downloaded(a)
    await a.know({ ...pressLaw })
    await new Promise((r) => setTimeout(r, 1500))
    await a.engine!.idle()
    expect(await a.p.outboxCount()).toBe(1)
    expect(await adminHas(uid, 'records', `knownTerms:${pressLaw.termId}`)).toBe(false)
    const fake = makeFakeEdition({ date: jstDateOf(Date.now()), slot: '20', seed: 'emu-outdated' })
    await connectorAddsNow(uid, fakeRecordsOf(fake))
    await waitFor(async () => (await shown(a, fake.edition.id)).kind === 'ready', '受け取りは続く')
    expect((await getDoc(appModelRef(a.fs, uid))).data()?.model).toBe(DATA_MODEL + 1)
  })
})
