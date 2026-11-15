// 本番のアクセスルール（firestore.rules。段階1。持ち主だけ）を、Firebase エミュレーターで確かめる（docs/SPEC.md の 7.7 の
// 「ルールのテスト（段階1）」・16.3）。実行: npm run test:sync。段階0の src/sync/owner.emu.test.ts の「段階0のルール」を、段階1の
// ルールに合わせて書き直して移した物（持ち主の関所のテストは owner.emu.test.ts に残した）。NS の src/claude/rules.emu.test.ts と
// DS の src/sync/sync.emu.test.ts の「持ち主とアクセスルール」から。
// アプリ（持ち主）は Firebase の SDK（Google のアカウント）で読み書きする。アプリから作れないコネクタの記録（版・話題・訂正・辞書の束・
// 作れなかった印）は、管理者の権限（ルールを通さない。src/test/emulatorAdmin.ts）でコネクタと同じ外側の形で置く。
// 30日の境は、本番のルールそのままで今の時刻の前後（29日目と30日目）を確かめ、日本時間の 0時ちょうどの前後は、ルールの expiredDay の
// request.time だけを決まった時刻に替えた写しで確かめる（エミュレーターの時刻は動かせないため）。
// アカウントと記録はすべて作り物（公開のリポジトリ。docs/SPEC.md の 3.）。
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { GoogleAuthProvider, connectAuthEmulator, getAuth, signInAnonymously, signInWithCredential } from 'firebase/auth'
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
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
import { stableStringify } from '../domain/equal'
import { hashJson } from '../domain/hash'
import { editionIdOf, isExpiredDocId, isRecordIdFor, termIdOf } from '../domain/ids'
import { addDaysToDate, expiresAtMs, expiryDocIdBefore, firstSyncSinceMs, jstDateOf, jstStartOfDayMs } from '../domain/jst'
import { pressKnownTerm } from '../domain/known'
import { RECORD_LIMITS } from '../domain/limits'
import { CONNECTOR_DEVICE, CONNECTOR_TABLES, TABLE_PLACE, type Place, type ReadMark } from '../domain/types'
import { fakeRecordsOf, makeFakeEdition } from '../test/fixtures/fakeEditions'
import {
  adminCreateOwner,
  adminDeleteOwner,
  adminDocIds,
  adminExists,
  adminStringField,
  adminWriteRecord,
  clearFirestore,
  emulatorRequest,
  EMU_PROJECT,
  useRules,
} from '../test/emulatorAdmin'
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

/** 匿名のアカウント（段階3のコネクタと同じ種類のアカウント。段階1のルールでは、どの置き場も読めない・書けない） */
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

/** コネクタの記録の中身（ルールは json の中を読まないので、共通の欄だけ。docs/SPEC.md の 7.7 の「記録に共通の欄」） */
const connectorBase = { v: 1, createdAt: 1_700_000_000_000, by: 'connector', ai: 'claude', model: 'claude-test', runId: 'r-test' }

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

// ---------- 用意 ----------

let owner: Who
let stranger: Who
let anon: Who
let none: Who

const ownerRecords = () => collection(owner.fs, 'users', owner.uid, 'records')
const ownerPrivate = () => collection(owner.fs, 'users', owner.uid, 'private')
const own = (place: Place, docId: string) => doc(owner.fs, 'users', owner.uid, place, docId)

beforeAll(async () => {
  await useRules(prodRules)
  owner = await googleUser('owner')
  stranger = await googleUser('stranger')
  anon = await anonymousUser()
  none = nobody()
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

  it('config/connector は持ち主の get だけ。作る・書き換える・消すのは持ち主もできない（段階3で連携の画面が作る）', async () => {
    // 無ければ連携していない（持ち主は無い事を読める）
    expect((await getDoc(doc(owner.fs, 'config', 'connector'))).exists()).toBe(false)
    // NS の v2 の形（7.7 の「コネクタの認証のしかた」）。段階1は持ち主も作れない
    const connector = {
      uid: anon.uid,
      pairing: 'p',
      pairedAt: serverTimestamp(),
      approvedOn: 'PC',
      writes: true,
      v: 2,
      pairingCid: 'c',
      connections: [],
    }
    await expect(setDoc(doc(owner.fs, 'config', 'connector'), connector)).rejects.toThrow()
    await emulatorRequest('PATCH', `/v1/projects/${EMU_PROJECT}/databases/(default)/documents/config/connector`, {
      fields: { uid: { stringValue: anon.uid }, writes: { booleanValue: true }, v: { integerValue: '2' } },
    })
    expect((await getDoc(doc(owner.fs, 'config', 'connector'))).data()?.uid).toBe(anon.uid)
    await expect(updateDoc(doc(owner.fs, 'config', 'connector'), { writes: false })).rejects.toThrow()
    await expect(deleteDoc(doc(owner.fs, 'config', 'connector'))).rejects.toThrow()
    // ほかのアカウント・匿名のアカウント（記録に書かれたコネクタのアカウントでも）・ログインしていない時は読めない
    for (const who of [stranger, anon, none]) {
      await expect(getDoc(doc(who.fs, 'config', 'connector')), who.name).rejects.toThrow()
      await expect(setDoc(doc(who.fs, 'config', 'connector'), connector), who.name).rejects.toThrow()
    }
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
      const changed = { ...connectorBase, model: 'claude-other' }
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

  it('アプリの問い合わせの形に、要る索引がそろっている（等しい欄と範囲の欄を組み合わせる物は複合の索引）', () => {
    for (const q of APP_QUERIES) {
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
    const used = new Set(APP_QUERIES.flatMap((q) => [...q.equality, ...(q.range ? [q.range] : [])]))
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

  it('本番から持ち主の制限だけを外した物（isOwner を isSelf に、config/connector の get を signedIn() に。docs/SPEC.md の 7.7）', () => {
    const prod = body(prodRules).join('\n')
    const fromProd = prod
      .replace(
        'function ownerUid() {\nreturn get(/databases/$(database)/documents/config/owner).data.uid;\n}\nfunction isOwner(uid) {\nreturn signedIn() && request.auth.uid == uid && ownerUid() == uid;\n}',
        'function isSelf(uid) {\nreturn signedIn() && request.auth.uid == uid;\n}',
      )
      .replace('allow get: if signedIn() && ownerUid() == request.auth.uid;', 'allow get: if signedIn();')
      .replaceAll('isOwner(uid)', 'isSelf(uid)')
    expect(fromProd).not.toContain('ownerUid')
    expect(fromProd).not.toContain('isOwner')
    expect(body(emuRules).join('\n')).toBe(fromProd)
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
})
