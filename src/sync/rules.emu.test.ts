// 本番のアクセスルール（firestore.rules）を、Firebase エミュレーターで確かめる（docs/SPEC.md の 7.7 の「ルールのテスト（段階1）」・
// 16.3 と、段階3の設計の 2.4）。実行: npm run test:sync。段階0の src/sync/owner.emu.test.ts の「段階0のルール」を、段階1の
// ルールに合わせて書き直して移し、段階3で Claude 用のコネクタの部分（記録された匿名のアカウント・連携の記録 config/connector）を足した
// 物（持ち主の関所のテストは owner.emu.test.ts に残した）。NS の src/claude/rules.emu.test.ts と DS の src/sync/sync.emu.test.ts の
// 「持ち主とアクセスルール」から。
// アプリ（持ち主）は Firebase の SDK（Google のアカウント）で読み書きする。コネクタは、コネクタと同じ Firestore の REST の口
// （batchGet・runQuery・runAggregationQuery・commit。connector/src/vault/firestore.ts）と匿名のアカウント（accounts:signUp）で読み書き
// する。連携の記録は、持ち主の SDK（アプリの連携の画面と同じ NS の v2 の形）か、管理者の権限（src/test/emulatorAdmin.ts の
// adminWriteConnector）で置く。アプリから作れないコネクタの記録（版・話題・訂正・辞書の束・作れなかった印）を前もって置く時は、
// 管理者の権限（ルールを通さない。src/test/emulatorAdmin.ts）でコネクタと同じ外側の形で置く。
// 30日の境は、本番のルールそのままで今の時刻の前後（29日目と30日目）を確かめ、日本時間の 0時ちょうどの前後は、ルールの expiredDay の
// request.time だけを決まった時刻に替えた写しで確かめる（エミュレーターの時刻は動かせないため）。
// アカウントと記録はすべて作り物（公開のリポジトリ。docs/SPEC.md の 3.）。
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { GoogleAuthProvider, connectAuthEmulator, getAuth, signInAnonymously, signInWithCredential } from 'firebase/auth'
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  deleteField,
  doc,
  documentId,
  getDoc,
  getDocs,
  initializeFirestore,
  limit,
  memoryLocalCache,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  terminate,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore'
import emuRules from '../../firestore.emu.rules?raw'
import indexesJson from '../../firestore.indexes.json?raw'
import prodRules from '../../firestore.rules?raw'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CONNECTOR_DOC_VERSION, MAX_CONNECTIONS } from '../claude/pairing'
import { stableStringify } from '../domain/equal'
import { hashJson } from '../domain/hash'
import { editionIdOf, isExpiredDocId, isRecordIdFor, termIdOf } from '../domain/ids'
import { addDaysToDate, expiresAtMs, expiryDocIdBefore, firstSyncSinceMs, jstDateOf, jstStartOfDayMs } from '../domain/jst'
import { pressKnownTerm } from '../domain/known'
import { RECORD_LIMITS } from '../domain/limits'
import {
  CLAUDE_READ_TABLES,
  CONNECTOR_DEVICE,
  CONNECTOR_TABLES,
  TABLE_PLACE,
  type ConnectorTableName,
  type Place,
  type ReadMark,
} from '../domain/types'
import {
  CONNECTOR_QUERIES,
  connectorQueryShapeOf,
  findConnectorQuery,
  type ConnectorQueryMethod,
  type ListedConnectorQuery,
} from '../test/connectorQueries'
import {
  adminCreateOwner,
  adminDeleteConnector,
  adminDeleteOwner,
  adminDocIds,
  adminExists,
  adminStringField,
  adminWriteConnector,
  adminWriteRecord,
  clearFirestore,
  EMU_PROJECT,
  useRules,
} from '../test/emulatorAdmin'
import { FAKE_CHECK_MODEL, FAKE_MODEL, fakeRecordsOf, makeFakeEdition } from '../test/fixtures/fakeEditions'
import { EXPIRE_BATCH_DOCS } from './batch'
import { decodeDoc, docPathOf, encodeDoc, encodeRecord, placeOf } from './codec'
import { RECORDS_SUBSCRIBED_TABLES } from './syncPlan'

// ---------- アカウント ----------

interface Who {
  /** テストの言葉に出す名前（持ち主・ほかのアカウント・匿名のアカウント・ログインしていない） */
  name: string
  /** ログインしていない時は '' */
  uid: string
  fs: Firestore
}

let seq = 0
const apps: FirebaseApp[] = []
const stores: Firestore[] = []

function newApp(label: string): FirebaseApp {
  const app = initializeApp(
    { projectId: EMU_PROJECT, apiKey: 'fake-api-key', authDomain: 'localhost' },
    `rules-${label}-${++seq}`,
  )
  apps.push(app)
  return app
}

function firestoreOf(app: FirebaseApp): Firestore {
  const fs = initializeFirestore(app, { localCache: memoryLocalCache() })
  connectFirestoreEmulator(fs, '127.0.0.1', 8080)
  stores.push(fs)
  return fs
}

const account = (name: string) => `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** エミュレーターの仮の Google アカウントでログインする（作り物の sub。owner.emu.test.ts と同じ作り方） */
async function googleUser(name: string): Promise<Who> {
  const app = newApp(name)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const sub = account(name)
  const cred = GoogleAuthProvider.credential(JSON.stringify({ sub, email: `${sub}@example.com`, email_verified: true }))
  const { user } = await signInWithCredential(auth, cred)
  return { name, uid: user.uid, fs: firestoreOf(app) }
}

/** 匿名のアカウント（コネクタと同じ種類のアカウント。連携の記録に書かれていなければ、どの置き場も読めない・書けない） */
async function anonymousUser(): Promise<Who> {
  const app = newApp('anon')
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const { user } = await signInAnonymously(auth)
  return { name: '匿名のアカウント', uid: user.uid, fs: firestoreOf(app) }
}

/** ログインしていないアプリ */
function nobody(): Who {
  return { name: 'ログインしていない', uid: '', fs: firestoreOf(newApp('nobody')) }
}

// ---------- 記録の文書 ----------

/** 外側の文書（8つの欄。docs/SPEC.md の 7.7 の「1件の文書の形」）。json は記録をキーの順にそろえた JSON、hash はその指紋 */
function recordDoc(table: string, id: string, rec: object = {}, device = 'device-a'): DocumentData {
  const json = stableStringify({ id, ...rec })
  return { table, id, json, chunks: 0, deleted: false, hash: hashJson(json), updated: serverTimestamp(), device }
}

/** json の長さがちょうど size の外側の文書（上限の境目を確かめる） */
function recordDocOfSize(table: string, id: string, rec: object, size: number): DocumentData {
  const bare = stableStringify({ id, ...rec, pad: '' })
  const json = stableStringify({ id, ...rec, pad: 'あ'.repeat(size - bare.length) })
  expect(json.length).toBe(size)
  return { ...recordDoc(table, id, rec), json, hash: hashJson(json) }
}

const userBase = () => ({ v: 1, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, by: 'user', ai: null })

/** 「知ってる」（docs/SPEC.md の 7.4）。語は作り物 */
function knownTerm(term: string, on = true) {
  const id = termIdOf(term)
  return { id, rec: { ...userBase(), term, asOf: '2026-11', on } }
}

/** 既読・見た版（docs/SPEC.md の 7.4） */
function readMark(editionId: string, topicIds: string[] = [], seen = true) {
  return { id: editionId, rec: { ...userBase(), editionId, topicIds, seen } }
}

/** コネクタの記録の中身（ルールは json の中を読まないので、共通の欄だけ。docs/SPEC.md の 7.7 の「記録に共通の欄」。モデルは作り物） */
const connectorBase = { v: 1, createdAt: 1_700_000_000_000, by: 'connector', ai: 'claude', model: FAKE_MODEL, runId: 'r-test' }

/** 版の日付 date の、表ごとの形の id（docs/SPEC.md の 7.7 の「名札」。指紋は作り物の8字） */
function idsOn(date: string) {
  const e12 = editionIdOf(date, '12')
  const e20 = editionIdOf(date, '20')
  return {
    editions: [e12, e20],
    topics: [`${e12}-k3f9a2bq`, `${e20}-m2n8c4d1`],
    corrections: [`${e12}-k3f9a2bq-c1a2b3c4`],
    editionFails: [`${e20}-f8d1k2s9`],
    termPacks: [`${e12}-p0m4x7c2`],
    reads: [e12, e20],
  }
}

/** 管理者の権限で、コネクタと同じ形の記録を置く（アプリからは作れない） */
async function adminPut(uid: string, place: Place, table: string, id: string, docId?: string): Promise<void> {
  const json = stableStringify({ id, ...connectorBase })
  await adminWriteRecord(uid, place, { table, id, json, hash: hashJson(json), docId })
}

/** 管理者の権限で、置き場の文書があるか（文書の id のコロンは %3A にする。REST の「名前:動作」と取り違えないように） */
const adminHas = (uid: string, place: Place, docId: string) => adminExists(`users/${uid}/${place}/${encodeURIComponent(docId)}`)

/**
 * 日本時間の 0時の直前には、30日の境が途中で動かないよう、0時を過ぎるまで待つ（本番のルールそのままで今の時刻の前後を確かめる時。
 * エミュレーターの request.time はこの機械の時計）。待つのは長くて31秒（テストの時間切れ 60秒の内に収める）
 */
async function awayFromJstMidnight(marginMs = 30_000): Promise<void> {
  const now = Date.now()
  const next = jstStartOfDayMs(addDaysToDate(jstDateOf(now), 1))
  if (next - now < marginMs) await new Promise((r) => setTimeout(r, next - now + 1_000))
}

/**
 * 本番のルールの expiredDay の request.time だけを、決まった時刻（ミリ秒）に替えた写し。日本時間の 0時ちょうどの前後を確かめる
 * （エミュレーターの時刻は動かせない）。替える所が1つだけある事も確かめる
 */
function prodRulesAt(ms: number): string {
  const re = /(function expiredDay\(id\) \{[^}]*?)<= request\.time;/
  expect(prodRules.match(new RegExp(re.source, 'g'))?.length).toBe(1)
  const out = prodRules.replace(re, `$1<= timestamp.value(${ms});`)
  expect(out).not.toBe(prodRules)
  return out
}

// ---------- コネクタ（REST・匿名のアカウント。connector/src/vault/firestore.ts と同じ口） ----------

const FS_REST = `http://127.0.0.1:8080/v1/projects/${EMU_PROJECT}/databases/(default)/documents`
/** documents の下の道（例 'config/connector'）の、REST の文書の名前 */
const docName = (path: string) => `projects/${EMU_PROJECT}/databases/(default)/documents/${path}`
/** 持ち主の置き場の文書の道 */
const placePath = (uid: string, place: Place, docId: string) => `users/${uid}/${place}/${docId}`

interface Connector {
  /** テストの言葉に出す名前 */
  name: string
  uid: string
  /** Auth エミュレーターの ID トークン（1時間。テストの間は足りる） */
  token: string
}

/** Auth エミュレーターの REST で匿名のアカウントを作る（コネクタと同じ accounts:signUp） */
async function connectorAccount(name = 'コネクタ'): Promise<Connector> {
  const res = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  })
  const j = (await res.json()) as { idToken?: string; localId?: string }
  if (!res.ok || !j.idToken || !j.localId) throw new Error(`匿名のアカウントを作れません: ${res.status}`)
  return { name, uid: j.localId, token: j.idToken }
}

/** そのアカウントの権限で REST を呼ぶ（HTTP の状態と返事の JSON） */
async function restAs(c: Connector, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${FS_REST}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

type Value =
  | { stringValue: string }
  | { integerValue: string }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }

const val = (x: string | number | boolean | null): Value =>
  x === null
    ? { nullValue: null }
    : typeof x === 'string'
      ? { stringValue: x }
      : typeof x === 'number'
        ? { integerValue: String(x) }
        : { booleanValue: x }

/** コネクタが作る記録（外側の文書の材料と、ルールを確かめるための崩し方） */
interface ConnectorWrite {
  table: string
  id: string
  json: string
  hash: string
  /** 置き場（既定 records） */
  place?: Place
  /** 文書の id（既定 '{table}:{id}'） */
  docId?: string
  /** 欄を足す・替える */
  extra?: Record<string, Value>
  /** 欄を外す */
  omit?: string[]
  /** updated をサーバー時刻にしない（端末の時刻を書く） */
  clientUpdated?: boolean
  /** exists: false を付けない（直す形で送る） */
  noPrecondition?: boolean
}

/** コネクタの記録の材料（中身は共通の欄だけ。json はキーの順にそろえた JSON、hash はその指紋） */
function connectorRecord(table: string, id: string, rec: object = connectorBase): ConnectorWrite {
  const json = stableStringify({ id, ...rec })
  return { table, id, json, hash: hashJson(json) }
}

/** json の長さがちょうど size のコネクタの記録の材料（上限の境目を確かめる） */
function connectorRecordOfSize(table: string, id: string, size: number): ConnectorWrite {
  const bare = stableStringify({ id, ...connectorBase, pad: '' })
  const json = stableStringify({ id, ...connectorBase, pad: 'あ'.repeat(size - bare.length) })
  expect(json.length).toBe(size)
  return { table, id, json, hash: hashJson(json) }
}

/** commit の1つの書き込み（コネクタと同じ: exists: false・updated はサーバー時刻の REQUEST_TIME） */
function connectorWriteOf(ownerUid: string, w: ConnectorWrite): unknown {
  const fields: Record<string, Value> = {
    table: val(w.table),
    id: val(w.id),
    json: val(w.json),
    chunks: val(0),
    deleted: val(false),
    hash: val(w.hash),
    device: val(CONNECTOR_DEVICE),
  }
  if (w.clientUpdated) fields.updated = { timestampValue: new Date(Date.now() - 60_000).toISOString() }
  for (const [k, x] of Object.entries(w.extra ?? {})) fields[k] = x
  for (const k of w.omit ?? []) delete fields[k]
  return {
    update: { name: docName(placePath(ownerUid, w.place ?? 'records', w.docId ?? `${w.table}:${w.id}`)), fields },
    ...(w.clientUpdated || w.omit?.includes('updated')
      ? {}
      : { updateTransforms: [{ fieldPath: 'updated', setToServerValue: 'REQUEST_TIME' }] }),
    ...(w.noPrecondition ? {} : { currentDocument: { exists: false } }),
  }
}

/** コネクタが作る（まとめて1回の commit）。HTTP の状態を返す（200 で全部、ほかは1件も書かれない） */
async function connectorCommit(c: Connector, ownerUid: string, writes: ConnectorWrite[]): Promise<number> {
  return (await restAs(c, 'POST', ':commit', { writes: writes.map((w) => connectorWriteOf(ownerUid, w)) })).status
}

/** コネクタが文書を消す（commit の delete）。HTTP の状態 */
async function connectorDelete(c: Connector, path: string): Promise<number> {
  return (await restAs(c, 'POST', ':commit', { writes: [{ delete: docName(path) }] })).status
}

/** コネクタが名前で読む（batchGet）: 'found'（読めた）・'missing'（無い事が分かった）・'denied'（ルールが断った） */
async function connectorGet(c: Connector, path: string): Promise<'found' | 'missing' | 'denied'> {
  const r = await restAs(c, 'POST', ':batchGet', { documents: [docName(path)] })
  if (r.status !== 200) return 'denied'
  const first = (r.json as { found?: unknown; missing?: string }[])[0]
  return first?.found ? 'found' : 'missing'
}

/**
 * コネクタの問い合わせ（runQuery。親は users/{ownerUid}。'' なら documents の直下）。読めた文書の id か、断られたら HTTP の状態
 * （負の数）
 */
async function connectorRunQuery(c: Connector, ownerUid: string, structuredQuery: unknown): Promise<string[] | number> {
  const r = await restAs(c, 'POST', `${ownerUid ? `/users/${ownerUid}` : ''}:runQuery`, { structuredQuery })
  if (r.status !== 200) return -r.status
  return (r.json as { document?: { name: string } }[])
    .filter((x) => x.document)
    .map((x) => decodeURIComponent(x.document!.name.split('/').pop() ?? ''))
}

/** コネクタの数（runAggregationQuery の COUNT）。数か、断られたら HTTP の状態（負の数） */
async function connectorCount(c: Connector, ownerUid: string, structuredQuery: unknown): Promise<number> {
  const r = await restAs(c, 'POST', `/users/${ownerUid}:runAggregationQuery`, {
    structuredAggregationQuery: { structuredQuery, aggregations: [{ alias: 'n', count: {} }] },
  })
  if (r.status !== 200) return -r.status
  const n = (r.json as { result?: { aggregateFields?: { n?: { integerValue?: string } } } }[])[0]?.result?.aggregateFields?.n
  return Number(n?.integerValue ?? 0)
}

/** 問い合わせ（REST の structuredQuery）の部品 */
const fromRecords = [{ collectionId: 'records' }]
const tableEq = (table: string) => ({
  fieldFilter: { field: { fieldPath: 'table' }, op: 'EQUAL', value: { stringValue: table } },
})
const tableIn = (tables: readonly string[]) => ({
  fieldFilter: {
    field: { fieldPath: 'table' },
    op: 'IN',
    value: { arrayValue: { values: tables.map((t) => ({ stringValue: t })) } },
  },
})
const ascending = (...fields: string[]) => fields.map((f) => ({ field: { fieldPath: f }, direction: 'ASCENDING' }))

/** 写しの差分（コネクタの mirror の形。位置は最後に読んだ文書の updated と名前） */
function mirrorQuery(after?: { updated: string; name: string }, tables: readonly string[] = CLAUDE_READ_TABLES): unknown {
  return {
    from: fromRecords,
    where: tableIn(tables),
    orderBy: ascending('updated', '__name__'),
    ...(after ? { startAt: { values: [{ timestampValue: after.updated }, { referenceValue: after.name }], before: false } } : {}),
    limit: 300,
  }
}

/** 消えないはずの表を名前で読み直す（位置は最後に読んだ文書の名前） */
function rereadQuery(table: string, afterName?: string): unknown {
  return {
    from: fromRecords,
    where: tableEq(table),
    orderBy: ascending('__name__'),
    select: { fields: [{ fieldPath: '__name__' }] },
    ...(afterName ? { startAt: { values: [{ referenceValue: afterName }], before: false } } : {}),
    limit: 300,
  }
}

// ---------- 連携の記録（config/connector。NS の v2 の形。src/claude/pairing.ts） ----------

/** 作り物の指紋（SHA-256 の16進 64字の形） */
const H = (c: string) => c.repeat(64)
/** 最後に許可した接続の id（src/claude/pairing.ts の CONNECTION_ID の形） */
const MAIN_CID = 'cmain0000001'
/** 接続ごとの記録（名前・指紋・許可した時刻・連携した端末の呼び名） */
const connection = (name: string, hash: string, pairedAt: unknown = serverTimestamp(), approvedOn = 'テストの端末') => ({
  name,
  pairing: hash,
  pairedAt,
  approvedOn,
})
/** アプリの連携の画面が［許可する］で書く記録（接続1つ。over で上の欄を、more で接続を足す・替える） */
const pairingDoc = (uid: string, over: Record<string, unknown> = {}, more: Record<string, unknown> = {}) => ({
  uid,
  pairing: H('a'),
  pairedAt: serverTimestamp(),
  approvedOn: 'テストの端末',
  writes: true,
  v: CONNECTOR_DOC_VERSION,
  pairingCid: MAIN_CID,
  connections: { [MAIN_CID]: connection('接続1', H('a')), ...more },
  ...over,
})

// ---------- 用意 ----------

let owner: Who
let stranger: Who
let anon: Who
let none: Who
/** コネクタ（REST の匿名のアカウント）。連携の記録に書くかはテストごと（beforeEach で文書を全部消す） */
let conn: Connector

const ownerRecords = () => collection(owner.fs, 'users', owner.uid, 'records')
const ownerPrivate = () => collection(owner.fs, 'users', owner.uid, 'private')
const own = (place: Place, docId: string) => doc(owner.fs, 'users', owner.uid, place, docId)

beforeAll(async () => {
  await useRules(prodRules)
  owner = await googleUser('owner')
  stranger = await googleUser('stranger')
  anon = await anonymousUser()
  none = nobody()
  conn = await connectorAccount()
})

beforeEach(async () => {
  await useRules(prodRules)
  await clearFirestore()
  await adminCreateOwner(owner.uid)
})

afterAll(async () => {
  for (const fs of stores.splice(0)) await terminate(fs)
  for (const app of apps.splice(0)) await deleteApp(app)
  // 次のテストファイルを本番のルールのまま流さない
  await useRules(emuRules)
})

describe('本番のアクセスルール: 持ち主の記録・連携の記録（docs/SPEC.md の 7.7）', () => {
  it('ログインしたアカウントは config/owner を get できるだけ。作る・書き換える・消すのは持ち主もできず、一覧は読めない', async () => {
    // 記録が無い時も、アプリからは作れない（持ち主になるはずのアカウントでも。形1）
    await adminDeleteOwner()
    await expect(setDoc(doc(owner.fs, 'config', 'owner'), { uid: owner.uid, createdAt: serverTimestamp() })).rejects.toThrow()
    expect(await adminExists('config/owner')).toBe(false)

    await adminCreateOwner(owner.uid)
    // 読める（持ち主もほかのアカウントも。持ち主かを確かめるため）
    expect((await getDoc(doc(owner.fs, 'config', 'owner'))).data()?.uid).toBe(owner.uid)
    expect((await getDoc(doc(stranger.fs, 'config', 'owner'))).data()?.uid).toBe(owner.uid)
    // 一覧は読めない
    await expect(getDocs(collection(owner.fs, 'config'))).rejects.toThrow()
    await expect(getDocs(collection(stranger.fs, 'config'))).rejects.toThrow()
    // 書き換える・消すのは、持ち主もほかのアカウントもできない
    for (const who of [owner, stranger, anon]) {
      await expect(updateDoc(doc(who.fs, 'config', 'owner'), { uid: who.uid })).rejects.toThrow()
      await expect(setDoc(doc(who.fs, 'config', 'owner'), { uid: who.uid, createdAt: serverTimestamp() })).rejects.toThrow()
      await expect(deleteDoc(doc(who.fs, 'config', 'owner'))).rejects.toThrow()
    }
    expect((await getDoc(doc(owner.fs, 'config', 'owner'))).data()?.uid).toBe(owner.uid)
    // config のほかの文書は誰も読み書きできない
    await expect(getDoc(doc(owner.fs, 'config', 'other'))).rejects.toThrow()
    await expect(setDoc(doc(owner.fs, 'config', 'other'), { a: 1 })).rejects.toThrow()
  })

  it('ログインしていない時は config/owner も読めない', async () => {
    await expect(getDoc(doc(none.fs, 'config', 'owner'))).rejects.toThrow()
  })

  it('config/connector: 持ち主が NS の v2 の形で作れる（最後に許可した接続の指紋・時刻がサーバー時刻でそろう時だけ。接続は2まで）。形の違う物は断る', async () => {
    const ref = doc(owner.fs, 'config', 'connector')
    // 無ければ連携していない（持ち主は無い事を読める）
    expect((await getDoc(ref)).exists()).toBe(false)
    const others = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`cx${i}`, connection(`接続${i + 2}`, H('z'), Timestamp.now())]))
    const denied: [string, Record<string, unknown>][] = [
      [
        'NS の v1 の形（接続の一覧が無い）',
        { uid: conn.uid, pairing: H('a'), pairedAt: serverTimestamp(), approvedOn: 'x', writes: true, v: 1 },
      ],
      ['v が 1', pairingDoc(conn.uid, { v: 1 })],
      ['v が 3', pairingDoc(conn.uid, { v: 3 })],
      ['接続の時刻がサーバー時刻でない', pairingDoc(conn.uid, {}, { [MAIN_CID]: connection('接続1', H('a'), Timestamp.now()) })],
      ['上の時刻がサーバー時刻でない', pairingDoc(conn.uid, { pairedAt: Timestamp.now() })],
      ['上の時刻が数', pairingDoc(conn.uid, { pairedAt: 12345 })],
      ['接続の指紋が上と違う', pairingDoc(conn.uid, {}, { [MAIN_CID]: connection('接続1', H('b')) })],
      ['最後の接続が一覧に無い', pairingDoc(conn.uid, { pairingCid: 'cother000001' })],
      ['接続の id に大文字', { ...pairingDoc(conn.uid, { pairingCid: 'C1' }), connections: { C1: connection('接続1', H('a')) } }],
      [
        '接続の id に記号',
        { ...pairingDoc(conn.uid, { pairingCid: 'c-1' }), connections: { 'c-1': connection('接続1', H('a')) } },
      ],
      ['接続の id が c だけ', { ...pairingDoc(conn.uid, { pairingCid: 'c' }), connections: { c: connection('接続1', H('a')) } }],
      ['接続の欄が多い', pairingDoc(conn.uid, {}, { [MAIN_CID]: { ...connection('接続1', H('a')), extra: 1 } })],
      [
        '接続の欄が足りない',
        pairingDoc(conn.uid, {}, { [MAIN_CID]: { name: '接続1', pairing: H('a'), pairedAt: serverTimestamp() } }),
      ],
      ['名前が空', pairingDoc(conn.uid, {}, { [MAIN_CID]: connection('', H('a')) })],
      ['名前が 41字', pairingDoc(conn.uid, {}, { [MAIN_CID]: connection('あ'.repeat(41), H('a')) })],
      [`接続が ${MAX_CONNECTIONS + 1}`, pairingDoc(conn.uid, {}, others(MAX_CONNECTIONS))],
      ['一覧が空', { ...pairingDoc(conn.uid), connections: {} }],
      ['一覧が並び（map でない）', { ...pairingDoc(conn.uid), connections: [] }],
      ['一覧が無い', Object.fromEntries(Object.entries(pairingDoc(conn.uid)).filter(([k]) => k !== 'connections'))],
      ['書き込みの許可が文字', pairingDoc(conn.uid, { writes: 'yes' })],
      ['知らない欄', pairingDoc(conn.uid, { extra: 1 })],
      ['持ち主自身の uid', pairingDoc(owner.uid)],
      ['uid が空', pairingDoc('')],
    ]
    for (const [what, d] of denied) await expect(setDoc(ref, d), what).rejects.toThrow()
    // 持ち主でない Google のアカウント・匿名のアカウント（コネクタ自身も）・ログインしていない時は作れない
    for (const who of [stranger, anon, none]) {
      await expect(setDoc(doc(who.fs, 'config', 'connector'), pairingDoc(conn.uid)), who.name).rejects.toThrow()
    }
    const self = await restAs(conn, 'PATCH', '/config/connector', {
      fields: { uid: val(conn.uid), writes: val(true), v: val(CONNECTOR_DOC_VERSION) },
    })
    expect(self.status).toBe(403)
    expect(await adminExists('config/connector')).toBe(false)
    // 2つまでは作れる（ほかの接続の形・時刻はルールでは見ない。アプリとコネクタが用心して読む）
    await setDoc(ref, pairingDoc(conn.uid, {}, others(MAX_CONNECTIONS - 1)))
    const d = (await getDoc(ref)).data() as { pairedAt: Timestamp; connections: Record<string, { pairedAt: Timestamp }> }
    expect(Object.keys(d.connections)).toHaveLength(MAX_CONNECTIONS)
    // 接続の中のサーバー時刻も、ルールの request.time と同じ
    expect(d.connections[MAIN_CID].pairedAt.toMillis()).toBe(d.pairedAt.toMillis())
  })

  it('config/connector: 持ち主は3通りに直せる（書き込みの許可だけ・新しい許可・一覧の編集）。ほかの直し方は断る。持ち主だけが消せる', async () => {
    const ref = doc(owner.fs, 'config', 'connector')
    const read = async () =>
      (await getDoc(ref)).data() as Record<string, unknown> & {
        pairing: string
        pairedAt: Timestamp
        pairingCid: string
        connections: Record<string, { name: string; pairing: string; pairedAt: Timestamp; approvedOn: string }>
      }
    await setDoc(ref, pairingDoc(conn.uid))
    // (i) 「書き込みを許可」だけ
    await updateDoc(ref, { writes: false })
    expect((await read()).writes).toBe(false)
    await expect(updateDoc(ref, { writes: 'yes' })).rejects.toThrow()
    await updateDoc(ref, { writes: true })
    // 書き込みの許可と一緒に、身元・指紋・知らない欄を変えるのは断る（(i) は writes だけの直し）
    await expect(updateDoc(ref, { writes: false, uid: 'someoneElse0001' })).rejects.toThrow()
    await expect(updateDoc(ref, { writes: false, pairing: H('b') })).rejects.toThrow()
    await expect(updateDoc(ref, { writes: false, junk: 1 })).rejects.toThrow()
    expect((await read()).writes).toBe(true)
    // 指紋・時刻だけの書き換えは断る（その接続の指紋・時刻もそろえる）
    await expect(updateDoc(ref, { pairing: H('b') })).rejects.toThrow()
    await expect(updateDoc(ref, { pairedAt: Timestamp.now() })).rejects.toThrow()
    await expect(updateDoc(ref, { pairing: H('b'), pairedAt: serverTimestamp() })).rejects.toThrow()
    // (ii) 新しい許可（同じ接続の許可し直し・2つ目の接続を足す）。指紋と時刻を、その接続と上の両方で新しくする
    await updateDoc(ref, {
      pairing: H('b'),
      pairedAt: serverTimestamp(),
      [`connections.${MAIN_CID}`]: connection('接続1', H('b')),
    })
    expect((await read()).pairing).toBe(H('b'))
    const second = 'csecond00001'
    await updateDoc(ref, {
      pairing: H('c'),
      pairedAt: serverTimestamp(),
      approvedOn: 'テストの別の端末',
      pairingCid: second,
      [`connections.${second}`]: connection('接続2', H('c'), serverTimestamp(), 'テストの別の端末'),
    })
    let d = await read()
    expect(Object.keys(d.connections).sort()).toEqual([MAIN_CID, second].sort())
    expect(d.connections[second].pairedAt.toMillis()).toBe(d.pairedAt.toMillis())
    // 3つ目は足せない（接続は2まで。入れ替えるなら、1つを外して足す）
    await expect(
      updateDoc(ref, {
        pairing: H('d'),
        pairedAt: serverTimestamp(),
        pairingCid: 'cthird000001',
        'connections.cthird000001': connection('接続3', H('d')),
      }),
    ).rejects.toThrow()
    // 身元（コネクタの uid）は変えられない（変わった時は消して作り直す）
    await expect(updateDoc(ref, { uid: 'someoneElse0001' })).rejects.toThrow()
    await expect(
      updateDoc(ref, {
        uid: 'someoneElse0001',
        pairing: H('e'),
        pairedAt: serverTimestamp(),
        [`connections.${second}`]: connection('接続2', H('e')),
      }),
    ).rejects.toThrow()
    // (iii) 一覧の編集（名前を変える・1つ解除する）。上の指紋・時刻・最後の接続はそのまま
    const before = await read()
    await updateDoc(ref, { [`connections.${MAIN_CID}.name`]: '仕事用' })
    d = await read()
    expect(d.connections[MAIN_CID].name).toBe('仕事用')
    expect([d.pairing, d.pairedAt.toMillis(), d.pairingCid]).toEqual([before.pairing, before.pairedAt.toMillis(), second])
    // 名前を変えるついでに、指紋・時刻・最後の接続を変えるのは断る
    await expect(updateDoc(ref, { pairing: H('f'), [`connections.${MAIN_CID}.name`]: '別' })).rejects.toThrow()
    await expect(updateDoc(ref, { pairedAt: Timestamp.now(), [`connections.${MAIN_CID}.name`]: '別' })).rejects.toThrow()
    await expect(updateDoc(ref, { pairingCid: MAIN_CID, [`connections.${MAIN_CID}.name`]: '別' })).rejects.toThrow()
    await expect(updateDoc(ref, { [`connections.${MAIN_CID}.name`]: 'あ'.repeat(41), junk: 1 })).rejects.toThrow()
    // 最後に許可した接続を外しても、pairingCid はそのまま（アプリとコネクタが一覧で確かめる）
    await updateDoc(ref, { [`connections.${second}`]: deleteField() })
    d = await read()
    expect(Object.keys(d.connections)).toEqual([MAIN_CID])
    expect(d.pairingCid).toBe(second)
    // 一覧を空にはできない（最後の1つは、記録ごと消す）
    await expect(updateDoc(ref, { [`connections.${MAIN_CID}`]: deleteField() })).rejects.toThrow()
    // 持ち主でない・匿名のアカウント（コネクタ自身も）は直せない・消せない
    for (const who of [stranger, anon, none]) {
      await expect(updateDoc(doc(who.fs, 'config', 'connector'), { writes: false }), who.name).rejects.toThrow()
      await expect(deleteDoc(doc(who.fs, 'config', 'connector')), who.name).rejects.toThrow()
    }
    const patch = await restAs(conn, 'PATCH', '/config/connector?updateMask.fieldPaths=writes', {
      fields: { writes: val(false) },
    })
    expect(patch.status).toBe(403)
    expect(await connectorDelete(conn, 'config/connector')).toBe(403)
    expect((await read()).writes).toBe(true)
    // ［連携をすべて解除］（持ち主が消す）
    await deleteDoc(ref)
    expect(await adminExists('config/connector')).toBe(false)
  })

  it('config/connector: 持ち主と、記録されたコネクタは get できる。ほかのアカウント・記録されていない匿名のアカウント・ログインしていない時は読めない', async () => {
    await adminWriteConnector(conn.uid)
    expect((await getDoc(doc(owner.fs, 'config', 'connector'))).data()?.uid).toBe(conn.uid)
    expect(await connectorGet(conn, 'config/connector')).toBe('found')
    const other = await connectorAccount('記録されていない匿名のアカウント')
    expect(await connectorGet(other, 'config/connector')).toBe('denied')
    for (const who of [stranger, anon, none]) {
      await expect(getDoc(doc(who.fs, 'config', 'connector')), who.name).rejects.toThrow()
    }
    // コネクタも config の一覧は読めない。持ち主の記録は get できる（持ち主かを確かめるため。段階1のまま）
    expect(await connectorRunQuery(conn, '', { from: [{ collectionId: 'config' }] })).toBeLessThan(0)
    expect(await connectorGet(conn, 'config/owner')).toBe('found')
    // 管理者の道具（adminWriteConnector）が書く形は、アプリの連携の画面と同じ v2 の形（持ち主が同じ中身で書き直せる）
    const d = (await getDoc(doc(owner.fs, 'config', 'connector'))).data()!
    expect(d.v).toBe(CONNECTOR_DOC_VERSION)
    expect(Object.keys(d.connections)).toEqual([d.pairingCid])
    await expect(updateDoc(doc(owner.fs, 'config', 'connector'), { writes: false })).resolves.toBeUndefined()
    await expect(
      updateDoc(doc(owner.fs, 'config', 'connector'), { [`connections.${d.pairingCid}.name`]: '開発用' }),
    ).resolves.toBeUndefined()
  })
})

describe('本番のアクセスルール: アプリの記録（知ってる・既読。docs/SPEC.md の 7.7）', () => {
  it('持ち主は「知ってる」（records）を作る・直す（on の切り替え）・読める', async () => {
    const t = knownTerm('〇〇法')
    const docId = `knownTerms:${t.id}`
    await setDoc(own('records', docId), recordDoc('knownTerms', t.id, t.rec))
    const got = await getDoc(own('records', docId))
    expect(got.data()?.json).toBe(stableStringify({ id: t.id, ...t.rec }))
    // 外す（記録は消さない）・付け直す
    const off = knownTerm('〇〇法', false)
    await setDoc(own('records', docId), recordDoc('knownTerms', t.id, off.rec, 'device-b'))
    expect((await getDoc(own('records', docId))).data()?.device).toBe('device-b')
    const on = stableStringify({ id: t.id, ...t.rec, updatedAt: 1_700_000_100_000 })
    await updateDoc(own('records', docId), { json: on, hash: hashJson(on), updated: serverTimestamp() })
    expect((await getDoc(own('records', docId))).data()?.json).toBe(on)
    // 直す時も updated はサーバー時刻（購読が「以上」で受け取れるように。7.8）。updated を新しくしない書き換えは断る
    await expect(updateDoc(own('records', docId), { device: 'device-c' })).rejects.toThrow()
    // 一覧（アプリの初めての受け取り: knownTerms を全部。7.8）
    const all = await getDocs(query(ownerRecords(), where('table', '==', 'knownTerms')))
    expect(all.docs.map((d) => d.id)).toEqual([docId])
  })

  it('持ち主は既読（private）を作る・直す・読める', async () => {
    const date = jstDateOf(Date.now())
    const r = readMark(editionIdOf(date, '12'))
    const docId = `reads:${r.id}`
    await setDoc(own('private', docId), recordDoc('reads', r.id, r.rec))
    const more = readMark(r.id, [`${r.id}-k3f9a2bq`], true)
    await setDoc(own('private', docId), recordDoc('reads', r.id, more.rec))
    expect((await getDoc(own('private', docId))).data()?.json).toBe(stableStringify({ id: r.id, ...more.rec }))
    const all = await getDocs(query(ownerPrivate(), orderBy('updated')))
    expect(all.docs.map((d) => d.id)).toEqual([docId])
  })

  it('json の上限は境目の長さで通り、1字多いと断る（知ってる 2,000・既読 5,000。RECORD_LIMITS.json と同じ値）', async () => {
    expect(RECORD_LIMITS.json.knownTerms).toBe(2_000)
    expect(RECORD_LIMITS.json.reads).toBe(5_000)
    const t = knownTerm('□□条約')
    const tMax = RECORD_LIMITS.json.knownTerms
    await expect(
      setDoc(own('records', `knownTerms:${t.id}`), recordDocOfSize('knownTerms', t.id, t.rec, tMax)),
    ).resolves.toBeUndefined()
    await expect(
      setDoc(own('records', `knownTerms:${t.id}`), recordDocOfSize('knownTerms', t.id, t.rec, tMax + 1)),
    ).rejects.toThrow()
    const r = readMark(editionIdOf(jstDateOf(Date.now()), '20'))
    const rMax = RECORD_LIMITS.json.reads
    await expect(setDoc(own('private', `reads:${r.id}`), recordDocOfSize('reads', r.id, r.rec, rMax))).resolves.toBeUndefined()
    await expect(setDoc(own('private', `reads:${r.id}`), recordDocOfSize('reads', r.id, r.rec, rMax + 1))).rejects.toThrow()
    expect((await getDoc(own('private', `reads:${r.id}`))).data()?.json.length).toBe(rMax)
  })

  it('外側の欄が8つでない・deleted: true・chunks: 1・id の形が違う・device がコネクタ・updated がサーバー時刻でない、は断る', async () => {
    const t = knownTerm('△△制度')
    const r = readMark(editionIdOf(jstDateOf(Date.now()), '12'))
    const cases: { place: Place; table: string; id: string; rec: object }[] = [
      { place: 'records', table: 'knownTerms', id: t.id, rec: t.rec },
      { place: 'private', table: 'reads', id: r.id, rec: r.rec },
    ]
    for (const c of cases) {
      const docId = `${c.table}:${c.id}`
      const good = recordDoc(c.table, c.id, c.rec)
      const bad: [string, DocumentData][] = [
        // 欄が足りない（8つのどれか1つでも）・多い（DS の分けた文書・復元の印・知らない欄）
        ...Object.keys(good).map((k): [string, DocumentData] => {
          const d = { ...good }
          delete d[k]
          return [`${k} が無い`, d]
        }),
        ['parent がある', { ...good, parent: 'x' }],
        ['parentTable がある', { ...good, parentTable: c.table }],
        ['index がある', { ...good, index: 0 }],
        ['reset がある', { ...good, reset: false }],
        ['知らない欄がある', { ...good, junk: 1 }],
        // 削除の印・分けた文書を書かない
        ['deleted: true', { ...good, deleted: true }],
        ["deleted: 'false'", { ...good, deleted: 'false' }],
        ['chunks: 1', { ...good, chunks: 1 }],
        ["chunks: '0'", { ...good, chunks: '0' }],
        ['json: null', { ...good, json: null, hash: '' }],
        ['json が文字でない', { ...good, json: { a: 1 } }],
        ['hash が文字でない', { ...good, hash: 1 }],
        ['hash が 65字', { ...good, hash: 'h'.repeat(65) }],
        // Claude のふりをしない
        ['device がコネクタ', { ...good, device: CONNECTOR_DEVICE }],
        ['device が空', { ...good, device: '' }],
        ['device が 65字', { ...good, device: 'd'.repeat(65) }],
        ['device が null', { ...good, device: null }],
        // updated はサーバー時刻だけ
        ['updated が端末の時刻', { ...good, updated: Timestamp.fromMillis(Date.now() - 60_000) }],
        ['updated が数', { ...good, updated: Date.now() }],
        // 文書の id と中身が合わない
        ['table が違う', { ...good, table: c.table === 'reads' ? 'knownTerms' : 'reads' }],
        ['id が違う', { ...good, id: c.table === 'reads' ? editionIdOf('2026-01-01', '20') : termIdOf('別の語') }],
        ['id が数', { ...good, id: 1 }],
      ]
      for (const [label, d] of bad) {
        await expect(setDoc(own(c.place, docId), d), `${c.table}: ${label}`).rejects.toThrow()
      }
      expect(await adminHas(owner.uid, c.place, docId)).toBe(false)
      await expect(setDoc(own(c.place, docId), good)).resolves.toBeUndefined()
      // 直す時も同じ形の決まり
      for (const [label, d] of bad) {
        await expect(setDoc(own(c.place, docId), d), `${c.table}（直す）: ${label}`).rejects.toThrow()
      }
    }
  })

  it('id の形が違う「知ってる」・既読は書けない（語の id は t＋12字、既読は版の id。src/domain/ids.ts と同じ形）', async () => {
    const t = knownTerm('〇〇法')
    const badTermIds = [
      `T${t.id.slice(1)}`,
      t.id.slice(0, 12),
      `${t.id}0`,
      `x${t.id.slice(1)}`,
      `t${'A'.repeat(12)}`,
      `t${'a'.repeat(11)}-`,
    ]
    for (const id of badTermIds) {
      expect(isRecordIdFor('knownTerms', id), id).toBe(false)
      await expect(setDoc(own('records', `knownTerms:${id}`), recordDoc('knownTerms', id, t.rec)), id).rejects.toThrow()
    }
    const date = jstDateOf(Date.now())
    const badReadIds = [
      date,
      `${date}-08`,
      `${date}-12-abcdefgh`,
      `${date}-12.1`,
      `1999-01-01-12`,
      `${date.slice(0, 4)}-1-1-12`,
      `${date}-12 `,
    ]
    for (const id of badReadIds) {
      expect(isRecordIdFor('reads', id), id).toBe(false)
      await expect(setDoc(own('private', `reads:${id}`), recordDoc('reads', id, readMark(id).rec)), id).rejects.toThrow()
    }
    // 形の合う物は通る（ルールと src/domain/ids.ts の形が同じ）
    expect(isRecordIdFor('knownTerms', t.id)).toBe(true)
    await expect(setDoc(own('records', `knownTerms:${t.id}`), recordDoc('knownTerms', t.id, t.rec))).resolves.toBeUndefined()
    const okRead = editionIdOf(date, '20')
    expect(isRecordIdFor('reads', okRead)).toBe(true)
    await expect(
      setDoc(own('private', `reads:${okRead}`), recordDoc('reads', okRead, readMark(okRead).rec)),
    ).resolves.toBeUndefined()
  })

  it('private に reads 以外の表（例 saves）は書けない。reads は records に書けない（置き場は表ごとに1つ。D21）', async () => {
    const date = jstDateOf(Date.now())
    const e = editionIdOf(date, '12')
    const t = knownTerm('〇〇法')
    // private には、既読のほかは何も書けない（保存の表は作らない。D10）
    const privateBad: [string, string][] = [
      ['saves', `${e}-k3f9a2bq`],
      ['saves', e],
      ['knownTerms', t.id],
      ...CONNECTOR_TABLES.map((table): [string, string] => [table, table === 'editions' ? e : `${e}-k3f9a2bq`]),
    ]
    for (const [table, id] of privateBad) {
      await expect(setDoc(own('private', `${table}:${id}`), recordDoc(table, id, { v: 1 })), `private/${table}`).rejects.toThrow()
    }
    // 既読は Claude が読める records に書けない（codec の placeOf と同じ割り当て。TABLE_PLACE）
    expect(TABLE_PLACE.reads).toBe('private')
    await expect(setDoc(own('records', `reads:${e}`), recordDoc('reads', e, readMark(e).rec))).rejects.toThrow()
    // 知らない表も records に書けない
    await expect(setDoc(own('records', `saves:${e}`), recordDoc('saves', e, { v: 1 }))).rejects.toThrow()
    expect(await adminDocIds(owner.uid, 'private')).toEqual([])
    expect(await adminDocIds(owner.uid, 'records')).toEqual([])
  })
})

describe('本番のアクセスルール: Claude の記録（版・話題・訂正・辞書の束・作れなかった印。docs/SPEC.md の 7.7）', () => {
  it('持ち主は作れない（コネクタの名前でも、アプリの端末の名前でも。D21・足すだけ）', async () => {
    const ids = idsOn(jstDateOf(Date.now()))
    for (const table of CONNECTOR_TABLES) {
      const id = ids[table][0]
      const docId = `${table}:${id}`
      for (const device of [CONNECTOR_DEVICE, 'device-a']) {
        await expect(
          setDoc(own('records', docId), recordDoc(table, id, connectorBase, device)),
          `${table}（${device}）`,
        ).rejects.toThrow()
      }
      // 「知ってる」の形の文書も、Claude の記録の名札の上には書けない（文書の id と中身が合わない）
      const t = knownTerm('〇〇法')
      await expect(setDoc(own('records', docId), recordDoc('knownTerms', t.id, t.rec)), table).rejects.toThrow()
      // 語の id の形（t＋12字）を付けても、Claude の表には書けない（表で止める。id の形の確かめだけに頼らない）
      await expect(setDoc(own('records', `${table}:${t.id}`), recordDoc(table, t.id, connectorBase)), table).rejects.toThrow()
    }
    expect(await adminDocIds(owner.uid, 'records')).toEqual([])
  })

  it('持ち主は読めるが、直せない（コネクタが置いた記録を書き換えられない）', async () => {
    const ids = idsOn(jstDateOf(Date.now()))
    const docIds: string[] = []
    for (const table of CONNECTOR_TABLES) {
      const id = ids[table][0]
      await adminPut(owner.uid, 'records', table, id)
      docIds.push(`${table}:${id}`)
    }
    for (const table of CONNECTOR_TABLES) {
      const id = ids[table][0]
      const docId = `${table}:${id}`
      const before = await getDoc(own('records', docId))
      expect(before.data()?.device).toBe(CONNECTOR_DEVICE)
      const changed = { ...connectorBase, model: FAKE_CHECK_MODEL }
      for (const device of [CONNECTOR_DEVICE, 'device-a']) {
        await expect(setDoc(own('records', docId), recordDoc(table, id, changed, device)), table).rejects.toThrow()
      }
      const json = stableStringify({ id, ...changed })
      await expect(
        updateDoc(own('records', docId), { json, hash: hashJson(json), updated: serverTimestamp() }),
        table,
      ).rejects.toThrow()
      await expect(updateDoc(own('records', docId), { deleted: true, updated: serverTimestamp() }), table).rejects.toThrow()
      // 30日の内の物は消せない（下の「30日」で確かめる）
      await expect(deleteDoc(own('records', docId)), table).rejects.toThrow()
      expect(await adminStringField(`users/${owner.uid}/records/${encodeURIComponent(docId)}`, 'json')).toBe(before.data()?.json)
    }
    // アプリの購読の形で読める（7.8 の「版と話題を受け取る」。辞書の束は購読しないが、持ち主は読める）
    const sub = await getDocs(
      query(
        ownerRecords(),
        where('table', 'in', [...RECORDS_SUBSCRIBED_TABLES]),
        where('updated', '>=', Timestamp.fromMillis(Date.now() - 32 * 86_400_000)),
        orderBy('updated'),
      ),
    )
    expect(sub.docs.map((d) => d.id).sort()).toEqual(docIds.filter((d) => !d.startsWith('termPacks:')).sort())
    expect((await getDoc(own('records', `termPacks:${ids.termPacks[0]}`))).exists()).toBe(true)
  })
})

describe('本番のアクセスルール: 30日で消す（docs/SPEC.md の 7.7・7.8 の「30日で消す」）', () => {
  afterEach(() => useRules(prodRules))

  it('版・話題・訂正・作れなかった印・既読は、30日を過ぎた物だけ消せる（29日目は消せない・30日目は消せる。訂正は話題と同じ日）', async () => {
    await awayFromJstMidnight()
    const now = Date.now()
    const today = jstDateOf(now)
    const day30 = idsOn(addDaysToDate(today, -30))
    const day29 = idsOn(addDaysToDate(today, -29))
    const expiring = ['editions', 'topics', 'corrections', 'editionFails'] as const
    for (const ids of [day30, day29]) {
      for (const table of expiring) for (const id of ids[table]) await adminPut(owner.uid, 'records', table, id)
      for (const id of ids.reads) await adminPut(owner.uid, 'private', 'reads', id, `reads:${id}`)
    }
    // 29日目（今日 − 29日）の物は、まだ30日の内なので消せない（12 の版も 20 の版も）
    for (const table of expiring) {
      for (const id of day29[table]) {
        expect(isExpiredDocId(`${table}:${id}`, now)).toBe(false)
        await expect(deleteDoc(own('records', `${table}:${id}`)), `${table}:${id}`).rejects.toThrow()
        expect(await adminHas(owner.uid, 'records', `${table}:${id}`)).toBe(true)
      }
    }
    for (const id of day29.reads) {
      await expect(deleteDoc(own('private', `reads:${id}`)), `reads:${id}`).rejects.toThrow()
      expect(await adminHas(owner.uid, 'private', `reads:${id}`)).toBe(true)
    }
    // 30日目（今日 − 30日）の物は消せる。訂正の id は話題の id で始まるので、話題と同じ日に消える
    for (const table of expiring) {
      for (const id of day30[table]) {
        expect(isExpiredDocId(`${table}:${id}`, now)).toBe(true)
        await expect(deleteDoc(own('records', `${table}:${id}`)), `${table}:${id}`).resolves.toBeUndefined()
        expect(await adminHas(owner.uid, 'records', `${table}:${id}`)).toBe(false)
      }
    }
    for (const id of day30.reads) {
      await expect(deleteDoc(own('private', `reads:${id}`)), `reads:${id}`).resolves.toBeUndefined()
      expect(await adminHas(owner.uid, 'private', `reads:${id}`)).toBe(false)
    }
    // 文書がもう無くても通る（ほかの端末が先に消していても、まとめての削除が落ちない。resource を見ない）
    await expect(deleteDoc(own('records', `topics:${day30.topics[0]}`))).resolves.toBeUndefined()
    await expect(deleteDoc(own('private', `reads:${day30.reads[0]}`))).resolves.toBeUndefined()
  })

  it('まとめての削除は、30日の内の物が1つでも混ざると全部が断られる（境の計算を誤っても、30日の内の版を消さない）', async () => {
    await awayFromJstMidnight()
    const today = jstDateOf(Date.now())
    const old = idsOn(addDaysToDate(today, -31))
    const kept = idsOn(addDaysToDate(today, -29))
    for (const id of [...old.topics, ...kept.topics]) await adminPut(owner.uid, 'records', 'topics', id)
    const mixed = writeBatch(owner.fs)
    for (const id of [...old.topics, kept.topics[0]]) mixed.delete(own('records', `topics:${id}`))
    await expect(mixed.commit()).rejects.toThrow()
    expect((await adminDocIds(owner.uid, 'records')).length).toBe(4)
    // 30日の外だけなら通る。アプリの30日の手入れと同じ、文書の id の範囲の問い合わせで引いた物（7.8。境は expiryDocIdBefore）
    await adminPut(owner.uid, 'records', 'editions', old.editions[0])
    await adminPut(owner.uid, 'records', 'corrections', old.corrections[0])
    const batch = writeBatch(owner.fs)
    for (const table of ['editions', 'topics', 'corrections', 'editionFails']) {
      const found = await getDocs(
        query(
          ownerRecords(),
          where(documentId(), '>=', `${table}:`),
          where(documentId(), '<', expiryDocIdBefore(table, Date.now())),
          orderBy(documentId()),
          limit(EXPIRE_BATCH_DOCS),
        ),
      )
      for (const d of found.docs) batch.delete(d.ref)
    }
    await expect(batch.commit()).resolves.toBeUndefined()
    expect((await adminDocIds(owner.uid, 'records')).sort()).toEqual(kept.topics.map((id) => `topics:${id}`).sort())
  })

  it('境は日本時間の 0時: その時刻の 1ミリ秒前は消せず、ちょうどからは消せる（月・年・うるう年をまたいでも）', async () => {
    // 版の日付 → 消せるようになる時刻（日本時間の D＋30日 0時 = UTC の D＋29日 15時。src/domain/jst.ts の expiresAtMs と同じ）
    const dates = ['2026-10-16', '2026-01-08', '2026-12-20', '2028-02-01', '2027-02-09']
    expect(new Date(expiresAtMs('2026-10-16')).toISOString()).toBe('2026-11-14T15:00:00.000Z')
    expect(new Date(expiresAtMs('2028-02-01')).toISOString()).toBe('2028-03-01T15:00:00.000Z')
    for (const date of dates) {
      const at = expiresAtMs(date)
      const ids = idsOn(date)
      const next = idsOn(addDaysToDate(date, 1))
      for (const [ms, ok] of [
        [at - 1, false],
        [at, true],
      ] as const) {
        await useRules(prodRulesAt(ms))
        const label = `${date}（${new Date(ms).toISOString()}）`
        const tryDelete = async (place: Place, docId: string, expected: boolean) => {
          const p = deleteDoc(own(place, docId))
          if (expected) await expect(p, `${label} ${docId}`).resolves.toBeUndefined()
          else await expect(p, `${label} ${docId}`).rejects.toThrow()
          expect(isExpiredDocId(docId, ms), docId).toBe(expected)
        }
        await tryDelete('records', `editions:${ids.editions[1]}`, ok)
        await tryDelete('records', `topics:${ids.topics[0]}`, ok)
        await tryDelete('records', `corrections:${ids.corrections[0]}`, ok)
        await tryDelete('records', `editionFails:${ids.editionFails[0]}`, ok)
        await tryDelete('private', `reads:${ids.reads[0]}`, ok)
        // 次の日の版は、どちらの時刻でもまだ消せない
        await tryDelete('records', `editions:${next.editions[0]}`, false)
        await tryDelete('private', `reads:${next.reads[1]}`, false)
      }
    }
  })

  it('表ごとの id の形に当たらない物は、30日を過ぎていても消せない。辞書の束・知ってるは消せない', async () => {
    await awayFromJstMidnight()
    const now = Date.now()
    const old = editionIdOf(addDaysToDate(jstDateOf(now), -45), '12')
    const t = knownTerm('〇〇法')
    const denied: [Place, string][] = [
      // 7.7 の「ルールのテスト」の例（表を取り違えた形・指紋の数が違う・指紋が短い）
      ['records', `editions:${old}-abcdefgh`],
      ['records', `topics:${old}`],
      ['records', `topics:${old}-aaaaaaaa-bbbbbbbb`],
      ['records', `editionFails:${old}-aaaaaaaa-bbbbbbbb`],
      ['records', `corrections:${old}-abcdefgh`],
      ['records', `topics:${old}-abc`],
      // ほかの形の違い（枠が 12・20 でない・大文字・版の作り直しの番号・日付の形）
      ['records', `editions:${old.slice(0, -2)}08`],
      ['records', `topics:${old}-ABCDEFGH`],
      ['records', `editions:${old}.1`],
      ['records', `editions:${old.slice(0, 10)}`],
      ['records', `corrections:${old}-abcdefgh-abcdefg`],
      ['records', `editions:2026-19-39-12`],
      // 消さない表・知らない表
      ['records', `termPacks:${old}-p0m4x7c2`],
      ['records', `knownTerms:${t.id}`],
      ['records', `saves:${old}`],
      // 既読は private だけ、private は既読だけ
      ['records', `reads:${old}`],
      ['private', `editions:${old}`],
      ['private', `topics:${old}-k3f9a2bq`],
      ['private', `reads:${old}-abcdefgh`],
      ['private', `saves:${old}`],
    ]
    for (const [place, docId] of denied) {
      const i = docId.indexOf(':')
      await adminPut(owner.uid, place, docId.slice(0, i), docId.slice(i + 1), docId)
    }
    for (const [place, docId] of denied) {
      await expect(deleteDoc(own(place, docId)), `${place}/${docId}`).rejects.toThrow()
      expect(await adminHas(owner.uid, place, docId), `${place}/${docId}`).toBe(true)
      // src/domain/ids.ts の isExpiredDocId（端末の中で消す・送る前の守り）も、records の物は同じ答え
      if (place === 'records' && !docId.startsWith('reads:')) expect(isExpiredDocId(docId, now), docId).toBe(false)
    }
    // 比べ: 同じ日付で表ごとの形の物は消せる
    const allowed: [Place, string][] = [
      ['records', `editions:${old}`],
      ['records', `topics:${old}-abcdefgh`],
      ['records', `editionFails:${old}-abcdefgh`],
      ['records', `corrections:${old}-abcdefgh-abcdefgh`],
      ['private', `reads:${old}`],
    ]
    for (const [place, docId] of allowed) {
      expect(isExpiredDocId(docId, now), docId).toBe(true)
      await expect(deleteDoc(own(place, docId)), `${place}/${docId}`).resolves.toBeUndefined()
    }
  })
})

describe('本番のアクセスルール: ほかのアカウント・匿名のアカウント（docs/SPEC.md の 7.7）', () => {
  it('ほかのアカウント・匿名のアカウント・ログインしていない時は、持ち主のどの置き場も読めない・書けない・消せない', async () => {
    const date = jstDateOf(Date.now())
    const oldDate = addDaysToDate(date, -45)
    const ids = idsOn(date)
    const t = knownTerm('〇〇法')
    await adminPut(owner.uid, 'records', 'topics', ids.topics[0])
    await adminPut(owner.uid, 'records', 'topics', idsOn(oldDate).topics[0])
    await setDoc(own('records', `knownTerms:${t.id}`), recordDoc('knownTerms', t.id, t.rec))
    await setDoc(own('private', `reads:${ids.reads[0]}`), recordDoc('reads', ids.reads[0], readMark(ids.reads[0]).rec))
    await setDoc(doc(owner.fs, 'users', owner.uid, 'meta', 'app'), {
      model: 1,
      appVersion: '0.1.0',
      updatedAt: serverTimestamp(),
    })
    await setDoc(doc(owner.fs, 'users', owner.uid, 'sync', 'device-a'), { tx: 't-1' })

    for (const who of [stranger, anon, none]) {
      const fs = who.fs
      const at = (...path: string[]) => doc(fs, 'users', owner.uid, ...path)
      // 読めない（1件も・一覧も）
      await expect(getDoc(at('records', `topics:${ids.topics[0]}`)), who.name).rejects.toThrow()
      await expect(getDoc(at('records', `knownTerms:${t.id}`)), who.name).rejects.toThrow()
      await expect(getDoc(at('private', `reads:${ids.reads[0]}`)), who.name).rejects.toThrow()
      await expect(getDoc(at('meta', 'app')), who.name).rejects.toThrow()
      await expect(getDoc(at('sync', 'device-a')), who.name).rejects.toThrow()
      await expect(getDocs(collection(fs, 'users', owner.uid, 'records')), who.name).rejects.toThrow()
      await expect(
        getDocs(query(collection(fs, 'users', owner.uid, 'records'), where('table', '==', 'topics'))),
        who.name,
      ).rejects.toThrow()
      await expect(getDocs(collection(fs, 'users', owner.uid, 'private')), who.name).rejects.toThrow()
      // 書けない・消せない（30日を過ぎた物も）
      await expect(setDoc(at('records', `knownTerms:${t.id}`), recordDoc('knownTerms', t.id, t.rec)), who.name).rejects.toThrow()
      await expect(
        setDoc(at('private', `reads:${ids.reads[1]}`), recordDoc('reads', ids.reads[1], readMark(ids.reads[1]).rec)),
        who.name,
      ).rejects.toThrow()
      await expect(deleteDoc(at('records', `topics:${idsOn(oldDate).topics[0]}`)), who.name).rejects.toThrow()
      await expect(deleteDoc(at('private', `reads:${ids.reads[0]}`)), who.name).rejects.toThrow()
      await expect(
        setDoc(at('meta', 'app'), { model: 9, appVersion: '9', updatedAt: serverTimestamp() }),
        who.name,
      ).rejects.toThrow()
      await expect(setDoc(at('sync', 'device-x'), { tx: 't-x' }), who.name).rejects.toThrow()
      // 自分の uid の場所にも書けない（持ち主ではないので）
      if (who.uid) {
        const mine = (...path: string[]) => doc(fs, 'users', who.uid, ...path)
        await expect(
          setDoc(mine('records', `knownTerms:${t.id}`), recordDoc('knownTerms', t.id, t.rec)),
          who.name,
        ).rejects.toThrow()
        await expect(
          setDoc(mine('private', `reads:${ids.reads[0]}`), recordDoc('reads', ids.reads[0], readMark(ids.reads[0]).rec)),
          who.name,
        ).rejects.toThrow()
        await expect(getDocs(collection(fs, 'users', who.uid, 'records')), who.name).rejects.toThrow()
        await expect(
          setDoc(mine('meta', 'app'), { model: 1, appVersion: '0.1.0', updatedAt: serverTimestamp() }),
          who.name,
        ).rejects.toThrow()
        await expect(setDoc(mine('sync', 'device-x'), { tx: 't-x' }), who.name).rejects.toThrow()
      }
    }
    // 持ち主の記録は変わっていない
    expect((await adminDocIds(owner.uid, 'records')).length).toBe(3)
    expect(await adminDocIds(owner.uid, 'private')).toEqual([`reads:${ids.reads[0]}`])
    expect(await adminStringField(`users/${owner.uid}/sync/device-a`, 'tx')).toBe('t-1')
  })

  it('持ち主の記録が無い時は、持ち主になるはずのアカウントも読めない・書けない（config/owner をアプリから作れない。形1）', async () => {
    await adminDeleteOwner()
    const t = knownTerm('〇〇法')
    await expect(setDoc(own('records', `knownTerms:${t.id}`), recordDoc('knownTerms', t.id, t.rec))).rejects.toThrow()
    await expect(getDocs(ownerRecords())).rejects.toThrow()
    await expect(getDoc(doc(owner.fs, 'config', 'connector'))).rejects.toThrow()
  })
})

describe('本番のアクセスルール: Claude 用のコネクタ（記録された匿名のアカウント。docs/SPEC.md の 7.7・段階3の設計の 2.4）', () => {
  beforeEach(async () => {
    await adminWriteConnector(conn.uid)
  })

  /** 読ませる6つの表に1件ずつ置く（Claude の記録は管理者の権限で、「知ってる」は持ち主がアプリと同じ形で） */
  async function putReadable(date = jstDateOf(Date.now())): Promise<string[]> {
    const ids = idsOn(date)
    const docIds: string[] = []
    for (const table of CONNECTOR_TABLES) {
      await adminPut(owner.uid, 'records', table, ids[table][0])
      docIds.push(`${table}:${ids[table][0]}`)
    }
    const t = knownTerm('〇〇法')
    await setDoc(own('records', `knownTerms:${t.id}`), recordDoc('knownTerms', t.id, t.rec))
    docIds.push(`knownTerms:${t.id}`)
    return docIds
  }

  it('読ませる6つの表は、get・写しの差分（table in）・表ごとの一覧（table ==）・数（count）で読める。無い文書は「無い」と分かる', async () => {
    const docIds = await putReadable()
    expect(docIds.map((d) => d.split(':')[0]).sort()).toEqual([...CLAUDE_READ_TABLES].sort())
    for (const docId of docIds) expect(await connectorGet(conn, placePath(owner.uid, 'records', docId)), docId).toBe('found')
    // 写しの差分: 初め（位置なし）は全部、位置から続けると残りだけ（updated・__name__ の順）
    const all = await connectorRunQuery(conn, owner.uid, mirrorQuery())
    expect(Array.isArray(all) && [...all].sort()).toEqual([...docIds].sort())
    const r = await restAs(conn, 'POST', `/users/${owner.uid}:runQuery`, { structuredQuery: mirrorQuery() })
    const docs = (r.json as { document?: { name: string; fields: { updated: { timestampValue: string } } } }[])
      .map((x) => x.document)
      .filter((x) => x !== undefined)
    const mid = docs[2]
    const rest = await connectorRunQuery(
      conn,
      owner.uid,
      mirrorQuery({ updated: mid.fields.updated.timestampValue, name: mid.name }),
    )
    expect(rest).toEqual(docs.slice(3).map((x) => decodeURIComponent(x.name.split('/').pop() ?? '')))
    // 表を絞った写し（一部の表だけ）も読める
    expect(await connectorRunQuery(conn, owner.uid, mirrorQuery(undefined, ['topics', 'editions']))).toHaveLength(2)
    // 表ごとの一覧・数（消えないはずの表の数を写しと比べる・名前で読み直す）
    for (const table of CLAUDE_READ_TABLES) {
      expect(await connectorRunQuery(conn, owner.uid, { from: fromRecords, where: tableEq(table) }), table).toHaveLength(1)
      expect(await connectorRunQuery(conn, owner.uid, rereadQuery(table)), table).toHaveLength(1)
      expect(await connectorCount(conn, owner.uid, { from: fromRecords, where: tableEq(table) }), table).toBe(1)
    }
    expect(await connectorCount(conn, owner.uid, { from: fromRecords, where: tableIn(CLAUDE_READ_TABLES) })).toBe(6)
    // 無い文書の get は「無い」（作る前に確かめられる）
    const missing = idsOn(addDaysToDate(jstDateOf(Date.now()), -1))
    expect(await connectorGet(conn, placePath(owner.uid, 'records', `topics:${missing.topics[0]}`))).toBe('missing')
  })

  it('表の絞りの無い一覧・数、読ませない表を混ぜた一覧は断られる。records に紛れた読ませない表の文書も読めない', async () => {
    await putReadable()
    const denied: [string, unknown][] = [
      ['絞り無し', { from: fromRecords }],
      ['絞り無しで updated の順', { from: fromRecords, orderBy: ascending('updated', '__name__') }],
      [
        '文書の id の範囲だけ',
        {
          from: fromRecords,
          where: {
            fieldFilter: {
              field: { fieldPath: '__name__' },
              op: 'GREATER_THAN_OR_EQUAL',
              value: { referenceValue: docName(placePath(owner.uid, 'records', 'topics:')) },
            },
          },
        },
      ],
      ['table in に既読を混ぜる', { from: fromRecords, where: tableIn([...CLAUDE_READ_TABLES, 'reads']) }],
      ['table in に知らない表を混ぜる', { from: fromRecords, where: tableIn(['topics', 'saves']) }],
      ['table == 既読', { from: fromRecords, where: tableEq('reads') }],
      ['table == 知らない表', { from: fromRecords, where: tableEq('saves') }],
      [
        'table != 既読',
        {
          from: fromRecords,
          where: { fieldFilter: { field: { fieldPath: 'table' }, op: 'NOT_EQUAL', value: { stringValue: 'reads' } } },
        },
      ],
    ]
    for (const [what, q] of denied) {
      expect(await connectorRunQuery(conn, owner.uid, q), what).toBeLessThan(0)
      expect(await connectorCount(conn, owner.uid, q), what).toBeLessThan(0)
    }
    // ルールの並びに無い表の文書は、records にあっても get できない（並びは src/domain/types.ts の CLAUDE_READ_TABLES と同じ。
    // records に後から足した表は、ここに足さない限り読めない）。アプリは既読を records に書けないが、管理者が紛れ込ませた場合も読めない
    const e = editionIdOf(jstDateOf(Date.now()), '12')
    await adminPut(owner.uid, 'records', 'reads', e, `reads:${e}`)
    await adminPut(owner.uid, 'records', 'saves', e, `saves:${e}`)
    expect(await connectorGet(conn, placePath(owner.uid, 'records', `reads:${e}`))).toBe('denied')
    expect(await connectorGet(conn, placePath(owner.uid, 'records', `saves:${e}`))).toBe('denied')
    // 持ち主は読める（並びはコネクタだけに効く）
    expect((await getDoc(own('records', `reads:${e}`))).exists()).toBe(true)
  })

  it('private（既読）は get も一覧も数も読めない（D21。ルールの private と sync にはコネクタの文字が無い）', async () => {
    const r = readMark(editionIdOf(jstDateOf(Date.now()), '12'))
    await setDoc(own('private', `reads:${r.id}`), recordDoc('reads', r.id, r.rec))
    expect(await connectorGet(conn, placePath(owner.uid, 'private', `reads:${r.id}`))).toBe('denied')
    // 無い文書の get も断る（records の「無い文書は通す」は private には無い）
    expect(await connectorGet(conn, placePath(owner.uid, 'private', `reads:${editionIdOf('2026-01-01', '20')}`))).toBe('denied')
    const fromPrivate = [{ collectionId: 'private' }]
    for (const q of [
      { from: fromPrivate },
      { from: fromPrivate, where: tableEq('reads') },
      { from: fromPrivate, where: tableIn(['reads']) },
      { from: fromPrivate, orderBy: ascending('updated') },
    ]) {
      expect(await connectorRunQuery(conn, owner.uid, q)).toBeLessThan(0)
      expect(await connectorCount(conn, owner.uid, q)).toBeLessThan(0)
    }
    // 文: private・sync の match の中に、コネクタの文字（isConnector・connector）を書いていない
    for (const path of ['private/{docId}', 'sync/{deviceId}']) {
      const block = new RegExp(`match /users/\\{uid\\}/${path.replace(/[{}/]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\n    \\}`).exec(
        prodRules,
      )?.[1]
      expect(block, path).toBeDefined()
      expect(block!.replace(/\/\/.*$/gm, ''), path).not.toMatch(/connector/i)
    }
  })

  it('Claude の5つの表に、決まった形の新しい記録を作れる（作るだけ）。もうある記録は作れず、直せない・消せない', async () => {
    // ルールの connectorCreate の表の並びは CONNECTOR_TABLES と同じ（文を読む。後から表を足した時に片方だけ直さない）
    const listed = /function connectorCreate\([^)]*\) \{[\s\S]*?d\.table in \[([^\]]*)\]/.exec(prodRules)?.[1]
    expect(listed?.split(',').map((s) => s.trim().replace(/^'|'$/g, ''))).toEqual([...CONNECTOR_TABLES])
    const ids = idsOn(jstDateOf(Date.now()))
    for (const table of CONNECTOR_TABLES) {
      const w = connectorRecord(table, ids[table][0])
      // 持ち主は、連携して書き込みを許可している間も、Claude の記録を作れない（コネクタと同じ形・名前でも。D21）
      await expect(
        setDoc(own('records', `${table}:${w.id}`), recordDoc(table, w.id, connectorBase, CONNECTOR_DEVICE)),
        table,
      ).rejects.toThrow()
      expect(await connectorCommit(conn, owner.uid, [w]), table).toBe(200)
      // 持ち主の端末では、ほかの端末の記録と同じように読める（device はコネクタ・updated はサーバー時刻）
      const snap = await getDoc(own('records', `${table}:${w.id}`))
      expect(snap.data()?.device, table).toBe(CONNECTOR_DEVICE)
      expect(snap.data()?.json, table).toBe(w.json)
      expect(Math.abs((snap.data()?.updated as Timestamp).toMillis() - Date.now()), table).toBeLessThan(60_000)
      // もうあれば作れない（exists: false）。直す（exists: false を付けない）・消すのは断る
      expect(await connectorCommit(conn, owner.uid, [w]), table).not.toBe(200)
      const changed = connectorRecord(table, w.id, { ...connectorBase, model: FAKE_CHECK_MODEL })
      expect(await connectorCommit(conn, owner.uid, [{ ...changed, noPrecondition: true }]), table).toBe(403)
      expect(await connectorDelete(conn, placePath(owner.uid, 'records', `${table}:${w.id}`)), table).toBe(403)
      expect((await getDoc(own('records', `${table}:${w.id}`))).data()?.json, table).toBe(w.json)
    }
    // 30日を過ぎた物も、コネクタは消せない（消すのはアプリだけ）
    const old = idsOn(addDaysToDate(jstDateOf(Date.now()), -45))
    await adminPut(owner.uid, 'records', 'topics', old.topics[0])
    expect(await connectorDelete(conn, placePath(owner.uid, 'records', `topics:${old.topics[0]}`))).toBe(403)
    expect(await adminHas(owner.uid, 'records', `topics:${old.topics[0]}`)).toBe(true)
  })

  it('「知ってる」・既読は作れない。持ち主の「知ってる」も、データの形の版・送る書き込みの印も、直せない・消せない', async () => {
    const t = knownTerm('〇〇法')
    const e = editionIdOf(jstDateOf(Date.now()), '12')
    const denied: [string, ConnectorWrite][] = [
      ['知ってる（records）', connectorRecord('knownTerms', t.id, t.rec)],
      ['知ってる（端末の名前がアプリ）', { ...connectorRecord('knownTerms', t.id, t.rec), extra: { device: val('device-a') } }],
      ['既読（private）', { ...connectorRecord('reads', e, readMark(e).rec), place: 'private' }],
      ['既読（records）', connectorRecord('reads', e, readMark(e).rec)],
      ['Claude の表を private に', { ...connectorRecord('topics', `${e}-k3f9a2bq`), place: 'private' }],
      ['知らない表', connectorRecord('saves', `${e}-k3f9a2bq`)],
    ]
    for (const [what, w] of denied) expect([what, await connectorCommit(conn, owner.uid, [w])]).toEqual([what, 403])
    expect(await adminDocIds(owner.uid, 'records')).toEqual([])
    expect(await adminDocIds(owner.uid, 'private')).toEqual([])
    // 持ち主の「知ってる」・既読を、コネクタは直せない・消せない
    await setDoc(own('records', `knownTerms:${t.id}`), recordDoc('knownTerms', t.id, t.rec))
    await setDoc(own('private', `reads:${e}`), recordDoc('reads', e, readMark(e).rec))
    const off = knownTerm('〇〇法', false)
    expect(
      await connectorCommit(conn, owner.uid, [{ ...connectorRecord('knownTerms', t.id, off.rec), noPrecondition: true }]),
    ).toBe(403)
    expect(
      await connectorCommit(conn, owner.uid, [
        { ...connectorRecord('knownTerms', t.id, off.rec), extra: { device: val('device-a') }, noPrecondition: true },
      ]),
    ).toBe(403)
    expect(await connectorDelete(conn, placePath(owner.uid, 'records', `knownTerms:${t.id}`))).toBe(403)
    expect(await connectorDelete(conn, placePath(owner.uid, 'private', `reads:${e}`))).toBe(403)
    expect(await adminStringField(`users/${owner.uid}/records/${encodeURIComponent(`knownTerms:${t.id}`)}`, 'json')).toBe(
      stableStringify({ id: t.id, ...t.rec }),
    )
    // データの形の版は get できるが書けない（無い時に作る・ある時に直す。形はアプリと同じで、updatedAt はサーバー時刻。ルールの
    // validAppModel は通る形なので、断るのはコネクタだから）。送る書き込みの印は読めない・書けない
    const writeModel = async (exists: boolean) =>
      (
        await restAs(conn, 'POST', ':commit', {
          writes: [
            {
              update: { name: docName(`users/${owner.uid}/meta/app`), fields: { model: val(9), appVersion: val('9.0.0') } },
              updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
              currentDocument: { exists },
            },
          ],
        })
      ).status
    expect(await connectorGet(conn, `users/${owner.uid}/meta/app`)).toBe('missing')
    expect(await writeModel(false)).toBe(403)
    expect(await adminExists(`users/${owner.uid}/meta/app`)).toBe(false)
    await setDoc(doc(owner.fs, 'users', owner.uid, 'meta', 'app'), {
      model: 1,
      appVersion: '0.1.0',
      updatedAt: serverTimestamp(),
    })
    await setDoc(doc(owner.fs, 'users', owner.uid, 'sync', 'device-a'), { tx: 't-1' })
    expect(await connectorGet(conn, `users/${owner.uid}/meta/app`)).toBe('found')
    expect(await writeModel(true)).toBe(403)
    expect((await getDoc(doc(owner.fs, 'users', owner.uid, 'meta', 'app'))).data()?.model).toBe(1)
    expect(await connectorDelete(conn, `users/${owner.uid}/meta/app`)).toBe(403)
    expect(await connectorGet(conn, `users/${owner.uid}/sync/device-a`)).toBe('denied')
    expect((await restAs(conn, 'PATCH', `/users/${owner.uid}/sync/device-x`, { fields: { tx: val('t-x') } })).status).toBe(403)
    // 持ち主の場所のほかの所（users/{uid} そのもの・知らない置き場）も読めない
    expect(await connectorGet(conn, `users/${owner.uid}`)).toBe('denied')
    expect(await connectorRunQuery(conn, owner.uid, { from: [{ collectionId: 'saves' }] })).toBeLessThan(0)
  })

  it('表ごとの id の形・json の上限の境目（境目の長さで通り、1字多いと断る。RECORD_LIMITS.json と同じ値）', async () => {
    const e = editionIdOf(addDaysToDate(jstDateOf(Date.now()), -2), '12')
    const badIds: Record<ConnectorTableName, string[]> = {
      editions: [`${e}-abcdefgh`, e.slice(0, 10), `${e.slice(0, -2)}08`, `${e}.1`, `${e}X`, `1999-01-01-12`],
      topics: [e, `${e}-aaaaaaaa-bbbbbbbb`, `${e}-abc`, `${e}-ABCDEFGH`, `${e}-abcdefgh `, `t${'a'.repeat(12)}`],
      corrections: [`${e}-abcdefgh`, `${e}-abcdefgh-abcdefg`, `${e}-abcdefgh-abcdefgh-abcdefgh`, e],
      termPacks: [e, `${e}-aaaaaaaa-bbbbbbbb`, `${e}-abc`],
      editionFails: [e, `${e}-aaaaaaaa-bbbbbbbb`, `${e}-abc`],
    }
    const goodIds: Record<ConnectorTableName, string> = {
      editions: e,
      topics: `${e}-k3f9a2bq`,
      corrections: `${e}-k3f9a2bq-c1a2b3c4`,
      termPacks: `${e}-p0m4x7c2`,
      editionFails: `${e}-f8d1k2s9`,
    }
    expect(RECORD_LIMITS.json).toMatchObject({
      editions: 20_000,
      topics: 100_000,
      corrections: 2_000,
      termPacks: 200_000,
      editionFails: 2_000,
    })
    for (const table of CONNECTOR_TABLES) {
      for (const id of badIds[table]) {
        expect(isRecordIdFor(table, id), `${table}:${id}`).toBe(false)
        expect([`${table}:${id}`, await connectorCommit(conn, owner.uid, [connectorRecord(table, id)])]).toEqual([
          `${table}:${id}`,
          403,
        ])
      }
      const id = goodIds[table]
      expect(isRecordIdFor(table, id), `${table}:${id}`).toBe(true)
      const max = RECORD_LIMITS.json[table]
      expect(await connectorCommit(conn, owner.uid, [connectorRecordOfSize(table, id, max + 1)]), `${table} ${max + 1}字`).toBe(
        403,
      )
      expect(await connectorCommit(conn, owner.uid, [connectorRecordOfSize(table, id, max)]), `${table} ${max}字`).toBe(200)
      expect((await getDoc(own('records', `${table}:${id}`))).data()?.json.length).toBe(max)
    }
    // id の長さ（64字まで。どの形も 40字以内だが、外側の決まりも NS と同じに持つ）
    expect(await connectorCommit(conn, owner.uid, [connectorRecord('topics', `${e}-${'a'.repeat(60)}`)])).toBe(403)
  })

  it('外側の欄の決まり: 8つの欄がそろう・device がコネクタ・updated がサーバー時刻・deleted: false・chunks: 0・文書の名前が {表名}:{id}', async () => {
    const e = editionIdOf(jstDateOf(Date.now()), '20')
    let n = 0
    // 断られた書き込みは何も残さないので、毎回別の id にする（同じ id だと、2回目は「もうある」で断られたのか分からない）
    const ok = () => connectorRecord('topics', `${e}-${(n++).toString(36).padStart(8, 'a')}`)
    const denied: [string, ConnectorWrite][] = [
      ...['table', 'id', 'json', 'chunks', 'deleted', 'hash', 'device'].map((k): [string, ConnectorWrite] => [
        `${k} が無い`,
        { ...ok(), omit: [k] },
      ]),
      ['updated が無い', { ...ok(), omit: ['updated'] }],
      ['updated が端末の時刻', { ...ok(), clientUpdated: true }],
      ['deleted: true', { ...ok(), extra: { deleted: val(true) } }],
      ["deleted: 'false'", { ...ok(), extra: { deleted: val('false') } }],
      ['chunks: 1', { ...ok(), extra: { chunks: val(1) } }],
      ["chunks: '0'", { ...ok(), extra: { chunks: val('0') } }],
      ['device がアプリの端末', { ...ok(), extra: { device: val('device-a') } }],
      ['device が空', { ...ok(), extra: { device: val('') } }],
      ['json が null', { ...ok(), extra: { json: val(null) } }],
      ['json が数', { ...ok(), extra: { json: val(1) } }],
      ['hash が数', { ...ok(), extra: { hash: val(1) } }],
      ['hash が 65字', { ...ok(), extra: { hash: val('h'.repeat(65)) } }],
      ['id が数', { ...ok(), extra: { id: val(1) } }],
      ['parent がある（分けた文書）', { ...ok(), extra: { parent: val('x') } }],
      ['index がある', { ...ok(), extra: { index: val(0) } }],
      ['reset がある（復元の印）', { ...ok(), extra: { reset: val(false) } }],
      ['知らない欄', { ...ok(), extra: { note: val('x') } }],
      ['文書の名前の id が違う', { ...ok(), docId: `topics:${e}-zzzzzzzz` }],
      ['文書の名前の表が違う', { ...ok(), docId: `editionFails:${e}-zzzzzzzz` }],
    ]
    for (const [what, w] of denied) expect([what, await connectorCommit(conn, owner.uid, [w])]).toEqual([what, 403])
    expect(await adminDocIds(owner.uid, 'records')).toEqual([])
    // 比べ: 決まった形なら通る
    expect(await connectorCommit(conn, owner.uid, [ok()])).toBe(200)
  })

  it('100件を1回の書き込みで作れる（ルールの読み取りは同じ文書なので数が増えない）。1件でも形が違えば全部断る', async () => {
    const date = jstDateOf(Date.now())
    const e = editionIdOf(date, '12')
    const writes = Array.from({ length: 100 }, (_, i) => connectorRecord('topics', `${e}-${i.toString(36).padStart(8, '0')}`))
    expect(await connectorCommit(conn, owner.uid, writes)).toBe(200)
    expect(await adminDocIds(owner.uid, 'records')).toHaveLength(100)
    const mixed = [connectorRecord('editions', e), connectorRecord('knownTerms', knownTerm('〇〇法').id, knownTerm('〇〇法').rec)]
    expect(await connectorCommit(conn, owner.uid, mixed)).toBe(403)
    expect(await connectorGet(conn, placePath(owner.uid, 'records', `editions:${e}`))).toBe('missing')
  })

  it('「書き込みを許可」が false の間は作れない（読むのは続く）。持ち主が許可し直すと作れる', async () => {
    const ids = idsOn(jstDateOf(Date.now()))
    await adminPut(owner.uid, 'records', 'topics', ids.topics[0])
    await adminWriteConnector(conn.uid, { writes: false })
    // 無い文書の id で（話題は置いた物の隣）
    const fresh: Record<ConnectorTableName, string> = {
      editions: ids.editions[0],
      topics: ids.topics[1],
      corrections: ids.corrections[0],
      termPacks: ids.termPacks[0],
      editionFails: ids.editionFails[0],
    }
    for (const table of CONNECTOR_TABLES) {
      expect(await connectorCommit(conn, owner.uid, [connectorRecord(table, fresh[table])]), table).toBe(403)
    }
    expect(await connectorRunQuery(conn, owner.uid, mirrorQuery())).toHaveLength(1)
    expect(await connectorGet(conn, `users/${owner.uid}/meta/app`)).toBe('missing')
    await updateDoc(doc(owner.fs, 'config', 'connector'), { writes: true })
    expect(await connectorCommit(conn, owner.uid, [connectorRecord('topics', ids.topics[1])])).toBe(200)
  })

  it('作り物の版を、コネクタの形（REST の commit）で作ると、持ち主の購読の形で届き、decodeDoc で同じ記録になる', async () => {
    const fake = makeFakeEdition({ date: jstDateOf(Date.now()), slot: '20', seed: 'rules-connector' })
    const fakes = fakeRecordsOf(fake)
    const writes = fakes.map(({ table, record }) => {
      const enc = encodeRecord(record)
      return { table, id: record.id, json: enc.json, hash: enc.hash }
    })
    expect(await connectorCommit(conn, owner.uid, writes)).toBe(200)
    const since = Timestamp.fromMillis(firstSyncSinceMs(Date.now()))
    const snap = await getDocs(
      query(
        ownerRecords(),
        where('table', 'in', [...RECORDS_SUBSCRIBED_TABLES]),
        where('updated', '>=', since),
        orderBy('updated'),
      ),
    )
    const got = new Map<string, unknown>()
    for (const d of snap.docs) {
      const r = decodeDoc(d.data(), { docId: d.id, place: 'records' })
      expect(r.ok, d.id).toBe(true)
      if (r.ok) got.set(`${r.table}:${r.id}`, r.record)
    }
    const want = fakes.filter((f) => f.table !== 'termPacks')
    expect(got.size).toBe(want.length)
    for (const { table, record } of want) expect(got.get(`${table}:${record.id}`), `${table}:${record.id}`).toEqual(record)
  })

  it('記録されていない匿名のアカウント・匿名でないアカウント・持ち主自身はコネクタになれない。持ち主の記録が無い・連携を解除した時は、コネクタも何もできない', async () => {
    const ids = idsOn(jstDateOf(Date.now()))
    await adminPut(owner.uid, 'records', 'topics', ids.topics[0])
    await setDoc(doc(owner.fs, 'users', owner.uid, 'meta', 'app'), {
      model: 1,
      appVersion: '0.1.0',
      updatedAt: serverTimestamp(),
    })
    const topicPath = placePath(owner.uid, 'records', `topics:${ids.topics[0]}`)
    /** そのアカウントが、コネクタのどの道でも読めない・作れない事 */
    const nothing = async (c: Connector) => {
      expect(await connectorGet(c, topicPath), c.name).toBe('denied')
      expect(await connectorRunQuery(c, owner.uid, mirrorQuery()), c.name).toBeLessThan(0)
      expect(await connectorCount(c, owner.uid, { from: fromRecords, where: tableEq('topics') }), c.name).toBeLessThan(0)
      expect(await connectorGet(c, `users/${owner.uid}/meta/app`), c.name).toBe('denied')
      expect(await connectorCommit(c, owner.uid, [connectorRecord('topics', ids.topics[1])]), c.name).toBe(403)
    }
    // 記録されていない匿名のアカウント（コネクタと同じ種類のアカウントでも）
    await nothing(await connectorAccount('記録されていない匿名のアカウント'))
    // 匿名でない（Google の）アカウントを連携の記録に書いても、コネクタにならない（管理者が書いた場合も）
    await adminWriteConnector(stranger.uid)
    expect((await getDoc(own('records', `topics:${ids.topics[0]}`))).exists()).toBe(true)
    const strangerAt = (...path: string[]) => doc(stranger.fs, 'users', owner.uid, ...path)
    await expect(getDoc(strangerAt('records', `topics:${ids.topics[0]}`))).rejects.toThrow()
    await expect(
      getDocs(query(collection(stranger.fs, 'users', owner.uid, 'records'), where('table', 'in', [...CLAUDE_READ_TABLES]))),
    ).rejects.toThrow()
    await expect(getDoc(strangerAt('meta', 'app'))).rejects.toThrow()
    await expect(
      setDoc(
        strangerAt('records', `topics:${ids.topics[1]}`),
        recordDoc('topics', ids.topics[1], connectorBase, CONNECTOR_DEVICE),
      ),
    ).rejects.toThrow()
    // 持ち主自身の uid を連携の記録に書いても（アプリからは書けない）、持ち主は Claude の記録を作れない
    await adminWriteConnector(owner.uid)
    await expect(
      setDoc(own('records', `topics:${ids.topics[1]}`), recordDoc('topics', ids.topics[1], connectorBase, CONNECTOR_DEVICE)),
    ).rejects.toThrow()
    // 匿名のアカウントが持ち主の記録と連携の記録の両方に書かれていても、自分の場所に Claude の記録は作れない（ルールの
    // isConnector の request.auth.uid != uid。持ち主の読み書きはできる）
    const selfConn = await connectorAccount('持ち主でもある匿名のアカウント')
    await adminCreateOwner(selfConn.uid)
    await adminWriteConnector(selfConn.uid)
    expect(await connectorCommit(selfConn, selfConn.uid, [connectorRecord('topics', ids.topics[1])])).toBe(403)
    expect(await connectorRunQuery(selfConn, selfConn.uid, mirrorQuery())).toEqual([])
    await adminCreateOwner(owner.uid)
    // 記録されたコネクタは、ほかのアカウント（持ち主でない）の場所は読めない・書けない
    await adminWriteConnector(conn.uid)
    expect(await connectorGet(conn, topicPath)).toBe('found')
    expect(await connectorRunQuery(conn, stranger.uid, mirrorQuery())).toBeLessThan(0)
    expect(await connectorCommit(conn, stranger.uid, [connectorRecord('topics', ids.topics[1])])).toBe(403)
    // 持ち主の記録が無い時は、記録されたコネクタも読めない・作れない（ルールの isConnector は ownerUid() == uid を見る）。
    // 連携の記録（自分が記録された物）だけは読める（NS と同じ。持ち主の記録が戻れば続けられる）
    await adminDeleteOwner()
    await nothing(conn)
    expect(await connectorGet(conn, 'config/connector')).toBe('found')
    await adminCreateOwner(owner.uid)
    expect(await connectorGet(conn, topicPath)).toBe('found')
    // ［連携をすべて解除］（連携の記録を消す）と、その場で読めない・作れない
    await adminDeleteConnector()
    await nothing(conn)
    expect(await connectorGet(conn, 'config/connector')).toBe('denied')
  })
})

describe('本番のアクセスルール: データの形の版・送る書き込みの印（DS と同じ。docs/SPEC.md の 7.7）', () => {
  it('データの形の版（meta/app）は持ち主だけが書け、下げられない', async () => {
    const ref = doc(owner.fs, 'users', owner.uid, 'meta', 'app')
    await expect(getDoc(ref)).resolves.toBeDefined()
    await expect(
      setDoc(ref, { model: 1, appVersion: '0.1.0', updatedAt: Timestamp.fromMillis(Date.now() - 60_000) }),
    ).rejects.toThrow()
    await expect(setDoc(ref, { model: 0, appVersion: '0.1.0', updatedAt: serverTimestamp() })).rejects.toThrow()
    await expect(setDoc(ref, { model: 1, appVersion: '0.1.0', updatedAt: serverTimestamp(), junk: 1 })).rejects.toThrow()
    await expect(setDoc(ref, { model: 1, appVersion: 'v'.repeat(33), updatedAt: serverTimestamp() })).rejects.toThrow()
    await expect(setDoc(ref, { model: 1, appVersion: '0.1.0', updatedAt: serverTimestamp() })).resolves.toBeUndefined()
    await expect(setDoc(ref, { model: 2, appVersion: '0.2.0', updatedAt: serverTimestamp() })).resolves.toBeUndefined()
    await expect(setDoc(ref, { model: 1, appVersion: '0.1.0', updatedAt: serverTimestamp() })).rejects.toThrow()
    expect((await getDoc(ref)).data()?.model).toBe(2)
    // 消せない（戻したい時は Firebase の画面で消す）
    await expect(deleteDoc(ref)).rejects.toThrow()
    // meta のほかの文書は誰も読み書きできない
    await expect(setDoc(doc(owner.fs, 'users', owner.uid, 'meta', 'other'), { a: 1 })).rejects.toThrow()
  })

  it('送る書き込みの印（sync/{端末の ID}）は持ち主だけが書け、形は { tx } だけ', async () => {
    const mark = (data: object, device = 'device-a') => setDoc(doc(owner.fs, 'users', owner.uid, 'sync', device), data)
    await expect(mark({ tx: 't-1' })).resolves.toBeUndefined()
    expect((await getDoc(doc(owner.fs, 'users', owner.uid, 'sync', 'device-a'))).data()?.tx).toBe('t-1')
    await expect(mark({ tx: 't-1', junk: 1 })).rejects.toThrow()
    await expect(mark({ tx: 1 })).rejects.toThrow()
    await expect(mark({ tx: '' })).rejects.toThrow()
    await expect(mark({ tx: 'x'.repeat(65) })).rejects.toThrow()
    await expect(mark({ tx: 't-1' }, 'd'.repeat(65))).rejects.toThrow()
    await expect(deleteDoc(doc(owner.fs, 'users', owner.uid, 'sync', 'device-a'))).rejects.toThrow()
    // 一覧は読めない（get だけ）
    await expect(getDocs(collection(owner.fs, 'users', owner.uid, 'sync'))).rejects.toThrow()
  })

  it('持ち主の場所でも、決まった置き場のほかは読み書きできない', async () => {
    await expect(setDoc(doc(owner.fs, 'users', owner.uid), { a: 1 })).rejects.toThrow()
    await expect(getDoc(doc(owner.fs, 'users', owner.uid))).rejects.toThrow()
    await expect(setDoc(doc(owner.fs, 'users', owner.uid, 'saves', 'x'), { a: 1 })).rejects.toThrow()
    await expect(getDocs(collection(owner.fs, 'users', owner.uid, 'inbox'))).rejects.toThrow()
    await expect(setDoc(doc(owner.fs, 'users', owner.uid, 'records', 'knownTerms:x', 'sub', 'y'), { a: 1 })).rejects.toThrow()
  })
})

describe('codec の文書と本番のルール（段階1の部品のつなぎ。docs/SPEC.md の 7.7・16.2 の 2・4）', () => {
  it('codec（encodeDoc・docPathOf）で作った「知ってる」・既読の文書は、本番のルールで持ち主が書け、decodeDoc で同じ記録に戻る', async () => {
    const now = Date.now()
    const editionId = editionIdOf(jstDateOf(now), '12')
    const known = pressKnownTerm(null, { termId: termIdOf('〇〇法'), term: '〇〇法', asOf: '2026-11' }, now)
    const read: ReadMark = {
      id: editionId,
      v: 1,
      createdAt: now,
      updatedAt: now,
      by: 'user',
      ai: null,
      editionId,
      topicIds: [`${editionId}-k3f9a2bq`],
      seen: true,
    }
    for (const [table, rec] of [
      ['knownTerms', known],
      ['reads', read],
    ] as const) {
      const path = docPathOf(owner.uid, table, rec.id)
      await setDoc(doc(owner.fs, ...path), encodeDoc(table, rec, { device: 'device-a', updated: serverTimestamp() }))
      const snap = await getDoc(doc(owner.fs, ...path))
      const back = decodeDoc(snap.data(), { docId: snap.id, place: path[2] })
      expect(back.ok && back.record, table).toEqual(rec)
    }
    // 置き場の割り当て（placeOf）を通らない道（既読を records に）は、ルールが断る
    await expect(
      setDoc(own('records', `reads:${editionId}`), encodeDoc('reads', read, { device: 'device-a', updated: serverTimestamp() })),
    ).rejects.toThrow()
  })

  it('管理者の権限で置いた作り物の版（コネクタと同じ外側の形）は、records の購読の形で読め、decodeDoc で同じ記録になる', async () => {
    const fake = makeFakeEdition({ date: jstDateOf(Date.now()), slot: '12', seed: 'rules-wiring' })
    const fakes = fakeRecordsOf(fake)
    for (const { table, record } of fakes) {
      const enc = encodeRecord(record)
      await adminWriteRecord(owner.uid, placeOf(table), { table, id: record.id, json: enc.json, hash: enc.hash })
    }
    const tables = [...RECORDS_SUBSCRIBED_TABLES]
    const since = Timestamp.fromMillis(firstSyncSinceMs(Date.now()))
    const snap = await getDocs(
      query(ownerRecords(), where('table', 'in', tables), where('updated', '>=', since), orderBy('updated')),
    )
    const got = new Map<string, unknown>()
    for (const d of snap.docs) {
      const r = decodeDoc(d.data(), { docId: d.id, place: 'records' })
      expect(r.ok, d.id).toBe(true)
      if (r.ok) {
        expect(r.device).toBe(CONNECTOR_DEVICE)
        got.set(`${r.table}:${r.id}`, r.record)
      }
    }
    // 辞書の束は購読しない（アプリは受け取らない。7. の要点の 7）。ほかは置いたまま届く
    const want = fakes.filter((f) => f.table !== 'termPacks')
    expect(got.size).toBe(want.length)
    for (const { table, record } of want) expect(got.get(`${table}:${record.id}`), `${table}:${record.id}`).toEqual(record)
  })
})

describe('索引（firestore.indexes.json。docs/SPEC.md の 7.7 の「索引」）', () => {
  // エミュレーターは索引を確かめないので、本番で落ちないよう、アプリの問い合わせの形をここに並べて索引と照らす（DS と同じ注意）。
  // 問い合わせの形は docs/SPEC.md の 7.8（「版と話題を受け取る」・「30日で消す」）。形を足した・変えた時はここにも足す
  interface QueryShape {
    label: string
    collection: Place
    /** 等しい（== か in）で絞る欄 */
    equality: string[]
    /** 範囲（>=・<）と並び（orderBy）の欄。null は無し。__name__ は文書の id */
    range: string | null
  }
  /**
   * コネクタの問い合わせの形（src/test/connectorQueries.ts の CONNECTOR_QUERIES。コネクタの単体のテストも同じ一覧を読む）を、
   * アプリの形と同じ見方（等しい欄・範囲と並びの欄）にする。範囲・並びの欄は、等しくない絞りの欄か、並びの頭の欄（__name__ は
   * どの索引にも後ろに付くので、並びの頭が __name__ の時だけ文書の id の範囲として扱う）
   */
  const shapeOfConnector = (q: ListedConnectorQuery): QueryShape => {
    const equality = q.filters.filter((f) => f.op === 'EQUAL' || f.op === 'IN').map((f) => f.field)
    const ranged = q.filters.find((f) => f.op !== 'EQUAL' && f.op !== 'IN')?.field
    return { label: `コネクタ: ${q.label}`, collection: q.collection, equality, range: ranged ?? q.orderBy[0] ?? null }
  }
  /** 一覧の形ごとの、コネクタの組み方の例（写しの差分・数・名前で読み直す。値は作り物の版の表） */
  const exampleOf = (q: ListedConnectorQuery): unknown => {
    const i = CONNECTOR_QUERIES.indexOf(q)
    if (i === 0) return mirrorQuery()
    if (i === 1) return { from: fromRecords, where: tableEq('termPacks') }
    if (i === 2) return rereadQuery('knownTerms')
    throw new Error(`組み方の例がありません: ${q.label}`)
  }
  const APP_QUERIES: QueryShape[] = [
    {
      label: 'records の購読（table in [...]・updated >= 位置・orderBy updated）',
      collection: 'records',
      equality: ['table'],
      range: 'updated',
    },
    { label: 'private の購読（updated >= 位置・orderBy updated）', collection: 'private', equality: [], range: 'updated' },
    { label: '初めての受け取りの「知ってる」（位置が無い時）', collection: 'records', equality: ['table'], range: null },
    {
      label: '初めての受け取りの「知ってる」（位置がある時。updated >= 位置）',
      collection: 'records',
      equality: ['table'],
      range: 'updated',
    },
    { label: '30日の手入れ（文書の id の範囲）', collection: 'records', equality: [], range: '__name__' },
    { label: '30日の手入れ（既読。文書の id の範囲）', collection: 'private', equality: [], range: '__name__' },
  ]
  interface IndexFile {
    indexes: { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order: string }[] }[]
    fieldOverrides: { collectionGroup: string; fieldPath: string; indexes: unknown[] }[]
  }
  const file = JSON.parse(indexesJson) as IndexFile

  it('アプリとコネクタの問い合わせの形に、要る索引がそろっている（等しい欄と範囲の欄を組み合わせる物は複合の索引）', () => {
    for (const q of [...APP_QUERIES, ...CONNECTOR_QUERIES.map(shapeOfConnector)]) {
      // 等しい欄が無い・範囲が無い・範囲が文書の id の物は、自動の1つの欄の索引で引ける
      if (q.equality.length === 0 || q.range === null || q.range === '__name__') continue
      const want = [...q.equality, q.range]
      const found = file.indexes.some(
        (ix) =>
          ix.collectionGroup === q.collection &&
          ix.queryScope === 'COLLECTION' &&
          ix.fields.length === want.length &&
          ix.fields.every((f, i) => f.fieldPath === want[i] && f.order === 'ASCENDING'),
      )
      expect(found, q.label).toBe(true)
    }
    // 問い合わせに使う欄の1つの欄の索引を外していない
    const used = new Set(
      [...APP_QUERIES, ...CONNECTOR_QUERIES.map(shapeOfConnector)].flatMap((q) => [...q.equality, ...(q.range ? [q.range] : [])]),
    )
    for (const o of file.fieldOverrides) expect(used.has(o.fieldPath), `${o.collectionGroup}.${o.fieldPath}`).toBe(false)
  })

  it('大きな欄（json・hash・device）は、両方の置き場で索引を作らない（書き込みの量と索引の上限のため）', () => {
    for (const group of ['records', 'private']) {
      for (const field of ['json', 'hash', 'device']) {
        const o = file.fieldOverrides.find((x) => x.collectionGroup === group && x.fieldPath === field)
        expect(o?.indexes, `${group}.${field}`).toEqual([])
      }
    }
    // DS の deleted＋updated（削除の印の片付け）は要らない（TS は削除の印を書かない）
    expect(file.indexes.some((ix) => ix.fields.some((f) => f.fieldPath === 'deleted'))).toBe(false)
  })

  it('コネクタの問い合わせの形は、どれも records の表の絞り（table == か table in）を持ち、並びは別の名前の形どうしで重ならない', () => {
    // ルールは絞り込みの代わりにならないので、コネクタの一覧は表の絞りを必ず付ける（docs/SPEC.md の 7.7）
    for (const q of CONNECTOR_QUERIES) {
      expect(q.collection, q.label).toBe('records')
      expect(
        q.filters.some((f) => f.field === 'table' && (f.op === 'EQUAL' || f.op === 'IN')),
        q.label,
      ).toBe(true)
    }
    const keys = CONNECTOR_QUERIES.map((q) => JSON.stringify(connectorQueryShapeOf(q.method, exampleOf(q))))
    expect(new Set(keys).size).toBe(CONNECTOR_QUERIES.length)
  })

  it('組んだ structuredQuery を形にして一覧から探せる（connectorQueryShapeOf・findConnectorQuery。コネクタの単体のテストと同じ読み方）', () => {
    for (const q of CONNECTOR_QUERIES) expect(findConnectorQuery(q.method, exampleOf(q)), q.label).toBe(q)
    // 値・位置・件数・取り出す欄は形に入らない
    expect(findConnectorQuery('runQuery', mirrorQuery({ updated: new Date().toISOString(), name: 'x' }, ['topics']))).toBe(
      CONNECTOR_QUERIES[0],
    )
    // 一覧に無い・読めない形は見つからない（コネクタの組む関数がこれを作れば、コネクタの単体のテストが落ちる）
    const unlisted: [string, ConnectorQueryMethod, unknown][] = [
      ['表の絞りが無い', 'runQuery', { from: fromRecords, orderBy: ascending('updated', '__name__') }],
      ['数の表の絞りが無い', 'count', { from: fromRecords }],
      [
        '写しを table == で',
        'runQuery',
        { from: fromRecords, where: tableEq('topics'), orderBy: ascending('updated', '__name__') },
      ],
      ['数を table in で', 'count', { from: fromRecords, where: tableIn(CLAUDE_READ_TABLES) }],
      [
        '並びが逆',
        'runQuery',
        {
          from: fromRecords,
          where: tableIn(CLAUDE_READ_TABLES),
          orderBy: [{ field: { fieldPath: 'updated' }, direction: 'DESCENDING' }],
        },
      ],
      [
        'updated の範囲を足す',
        'runQuery',
        {
          from: fromRecords,
          where: {
            compositeFilter: {
              op: 'AND',
              filters: [
                tableIn(CLAUDE_READ_TABLES),
                {
                  fieldFilter: {
                    field: { fieldPath: 'updated' },
                    op: 'GREATER_THAN',
                    value: { timestampValue: new Date().toISOString() },
                  },
                },
              ],
            },
          },
          orderBy: ascending('updated', '__name__'),
        },
      ],
      [
        'OR',
        'runQuery',
        { from: fromRecords, where: { compositeFilter: { op: 'OR', filters: [tableEq('topics'), tableEq('editions')] } } },
      ],
      ['private', 'runQuery', { from: [{ collectionId: 'private' }], where: tableEq('reads') }],
      ['collection group', 'runQuery', { from: [{ collectionId: 'records', allDescendants: true }], where: tableEq('topics') }],
      ['unaryFilter', 'runQuery', { from: fromRecords, where: { unaryFilter: { field: { fieldPath: 'json' }, op: 'IS_NULL' } } }],
      ['知らない鍵', 'runQuery', { from: fromRecords, where: tableEq('topics'), findNearest: {} }],
      ['形でない', 'runQuery', null],
    ]
    for (const [what, method, q] of unlisted) expect(findConnectorQuery(method, q), what).toBeNull()
  })

  it('コネクタの問い合わせは、どの形も本番のルールで記録されたコネクタが引ける（エミュレーター）', async () => {
    await adminWriteConnector(conn.uid)
    const ids = idsOn(jstDateOf(Date.now()))
    for (const table of CONNECTOR_TABLES) await adminPut(owner.uid, 'records', table, ids[table][0])
    const t = knownTerm('〇〇法')
    await setDoc(own('records', `knownTerms:${t.id}`), recordDoc('knownTerms', t.id, t.rec))
    for (const q of CONNECTOR_QUERIES) {
      const got =
        q.method === 'count'
          ? await connectorCount(conn, owner.uid, exampleOf(q))
          : await connectorRunQuery(conn, owner.uid, exampleOf(q))
      expect(typeof got === 'number' ? got : got.length, q.label).toBeGreaterThan(0)
    }
  })

  it('アプリの問い合わせは、本番のルールで持ち主が引ける（エミュレーター）', async () => {
    // 初めての受け取りの位置（端末の時計 − 32日。src/domain/jst.ts の firstSyncSinceMs）
    const since = Timestamp.fromMillis(firstSyncSinceMs(Date.now()))
    const t = knownTerm('〇〇法')
    await setDoc(own('records', `knownTerms:${t.id}`), recordDoc('knownTerms', t.id, t.rec))
    const r = readMark(editionIdOf(jstDateOf(Date.now()), '12'))
    await setDoc(own('private', `reads:${r.id}`), recordDoc('reads', r.id, r.rec))
    const tables = [...RECORDS_SUBSCRIBED_TABLES]
    const results = [
      await getDocs(query(ownerRecords(), where('table', 'in', tables), where('updated', '>=', since), orderBy('updated'))),
      await getDocs(query(ownerPrivate(), where('updated', '>=', since), orderBy('updated'))),
      await getDocs(query(ownerRecords(), where('table', '==', 'knownTerms'))),
      await getDocs(query(ownerRecords(), where('table', '==', 'knownTerms'), where('updated', '>=', since))),
      await getDocs(
        query(
          ownerRecords(),
          where(documentId(), '>=', 'topics:'),
          where(documentId(), '<', expiryDocIdBefore('topics', Date.now())),
          limit(EXPIRE_BATCH_DOCS),
        ),
      ),
      await getDocs(
        query(
          ownerPrivate(),
          where(documentId(), '>=', 'reads:'),
          where(documentId(), '<', expiryDocIdBefore('reads', Date.now())),
          limit(EXPIRE_BATCH_DOCS),
        ),
      ),
    ]
    expect(results.map((x) => x.size)).toEqual([1, 1, 1, 1, 0, 0])
  })
})

describe('エミュレーター用のルール（firestore.emu.rules）', () => {
  /** コメントと空の行を外し、行の前後の空白をそろえる */
  const body = (rules: string) =>
    rules
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter((l) => l !== '')

  /** 文の中の from を1つだけ to に替える（1つでない時はテストを落とす。替える所を決まった所に限る） */
  const replaceOnce = (text: string, from: string, to: string): string => {
    expect(text.split(from).length - 1, from).toBe(1)
    return text.replace(from, to)
  }

  it('本番から持ち主の制限だけを外した物（isOwner を isSelf に、config/connector の get を signedIn() に。docs/SPEC.md の 7.7・設計の 2.2）', () => {
    const prod = body(prodRules).join('\n')
    // 替えるのは、isOwner の定義と呼び出し、config/connector の get の1行だけ
    let fromProd = replaceOnce(
      prod,
      'function isOwner(uid) {\nreturn signedIn() && request.auth.uid == uid && ownerUid() == uid;\n}',
      'function isSelf(uid) {\nreturn signedIn() && request.auth.uid == uid;\n}',
    )
    fromProd = replaceOnce(
      fromProd,
      'allow get: if signedIn() && (ownerUid() == request.auth.uid || resource.data.uid == request.auth.uid);',
      'allow get: if signedIn();',
    )
    expect(fromProd.split('isOwner(uid)').length - 1).toBeGreaterThan(0)
    fromProd = fromProd.replaceAll('isOwner(uid)', 'isSelf(uid)')
    expect(fromProd).not.toContain('isOwner')
    expect(body(emuRules).join('\n')).toBe(fromProd)
  })

  it('コネクタの部分（isConnector・connectorCreate・config/connector の書き込み）は、本番と同じ文で持ち主の記録を見る（NS と同じ）', () => {
    const emu = body(emuRules).join('\n')
    const fn = (text: string, name: string) => new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(text)?.[0]
    const prod = body(prodRules).join('\n')
    for (const name of ['isConnector', 'connectorCreate', 'validConnection', 'validConnector', 'newApproval', 'ownerUid']) {
      expect(fn(emu, name), name).toBeDefined()
      expect(fn(emu, name), name).toBe(fn(prod, name))
    }
    expect(fn(emu, 'isConnector')).toContain('ownerUid() == uid')
    for (const line of [
      'allow create: if signedIn() && request.auth.uid == ownerUid() && validConnector() && newApproval();',
      'allow update: if signedIn() && request.auth.uid == ownerUid() && (',
      'allow delete: if signedIn() && request.auth.uid == ownerUid();',
    ]) {
      expect(emu, line).toContain(line)
      expect(prod, line).toContain(line)
    }
  })

  it('エミュレーター用のルールでも、形の決まり・Claude の記録・30日の削除は本番と同じ（持ち主の記録が無くても自分の場所に書ける）', async () => {
    await useRules(emuRules)
    try {
      await adminDeleteOwner()
      const t = knownTerm('〇〇法')
      await expect(setDoc(own('records', `knownTerms:${t.id}`), recordDoc('knownTerms', t.id, t.rec))).resolves.toBeUndefined()
      await expect(
        setDoc(own('records', `knownTerms:${t.id}`), { ...recordDoc('knownTerms', t.id, t.rec), deleted: true }),
      ).rejects.toThrow()
      const ids = idsOn(jstDateOf(Date.now()))
      await expect(
        setDoc(own('records', `topics:${ids.topics[0]}`), recordDoc('topics', ids.topics[0], connectorBase)),
      ).rejects.toThrow()
      await expect(setDoc(own('private', `saves:${ids.reads[0]}`), recordDoc('saves', ids.reads[0], {}))).rejects.toThrow()
      const old = idsOn(addDaysToDate(jstDateOf(Date.now()), -45))
      await expect(deleteDoc(own('records', `topics:${old.topics[0]}`))).resolves.toBeUndefined()
      await expect(deleteDoc(own('records', `topics:${ids.topics[0]}`))).rejects.toThrow()
      await expect(deleteDoc(own('records', `termPacks:${old.termPacks[0]}`))).rejects.toThrow()
      // ほかのアカウントの場所は読めない
      await expect(getDocs(collection(stranger.fs, 'users', owner.uid, 'records'))).rejects.toThrow()
      // 開発サーバーは持ち主を確かめないので、config/connector もログインしていれば読める（無い）
      expect((await getDoc(doc(stranger.fs, 'config', 'connector'))).exists()).toBe(false)
    } finally {
      await useRules(prodRules)
    }
  })

  it('エミュレーター用のルールでも、コネクタは持ち主の記録と連携の記録がある時だけ読み書きできる（npm run seed:emu -- --owner --connector UID と同じ用意）', async () => {
    await useRules(emuRules)
    try {
      const ids = idsOn(jstDateOf(Date.now()))
      await adminPut(owner.uid, 'records', 'topics', ids.topics[0])
      // 連携の記録だけ（持ち主の記録が無い）では、コネクタは何もできない
      await adminDeleteOwner()
      await adminWriteConnector(conn.uid)
      expect(await connectorRunQuery(conn, owner.uid, mirrorQuery())).toBeLessThan(0)
      expect(await connectorCommit(conn, owner.uid, [connectorRecord('topics', ids.topics[1])])).toBe(403)
      // 連携の記録は、ログインしていれば誰でも読める（開発サーバーは持ち主を確かめない）。書くのは本番と同じく持ち主だけ
      expect((await getDoc(doc(stranger.fs, 'config', 'connector'))).data()?.uid).toBe(conn.uid)
      await expect(updateDoc(doc(stranger.fs, 'config', 'connector'), { writes: false })).rejects.toThrow()
      // 持ち主の記録も書く（seed:emu の --owner）と、本番と同じに読める・作れる。private は読めない
      await adminCreateOwner(owner.uid)
      expect(await connectorRunQuery(conn, owner.uid, mirrorQuery())).toHaveLength(1)
      expect(await connectorCommit(conn, owner.uid, [connectorRecord('topics', ids.topics[1])])).toBe(200)
      expect(await connectorGet(conn, placePath(owner.uid, 'private', `reads:${ids.reads[0]}`))).toBe('denied')
      await expect(updateDoc(doc(owner.fs, 'config', 'connector'), { writes: false })).resolves.toBeUndefined()
      expect(await connectorCommit(conn, owner.uid, [connectorRecord('editions', ids.editions[0])])).toBe(403)
    } finally {
      await useRules(prodRules)
    }
  })
})
