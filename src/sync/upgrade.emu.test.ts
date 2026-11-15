// 段階0でログインしたままの作者の端末が、段階1の版に上がった時の流れ（docs/SPEC.md の 16.3 の「上がり」・7.8 の「端末の表（Dexie v2）」・
// 14.4）を、Firebase エミュレーターと本番のアクセスルール（firestore.rules）で確かめる。実行: npm run test:sync
// DS の src/sync/upgrade.emu.test.ts から。段階0の版は、端末の中に v1 の _meta（持ち主だと確かめた ownerSeen）だけを持ち、クラウドには
// 何も書かない（ログインの状態は Firebase が端末に覚えている）。段階1の版を開くと、Dexie が v2 の表を足し（ownerSeen は残る）、ログインし
// 直さずに、覚えていた ownerSeen でトップの画面を出し、同期を始める。
// 本物の司令塔（src/sync/controller.ts）・保存先（src/db/persistence.ts。fake-indexeddb）・同期のエンジン（src/sync/engine.ts）を動かし、
// Firebase の部品（src/sync/firebase.ts・firestore.ts）だけを、エミュレーターにつないだ物に差し替える（src/sync/owner.emu.test.ts と同じ）。
// usingEmulator は false にして、公開した版と同じく持ち主を確かめさせる。
// 同期は司令塔が始めるエンジン（ownerSeen → ownerConfirmed → beginSync → startEngine。持ち主の記録が戻った時は表に戻って始め直す）で
// 確かめる。テストはエンジンを作らない（同じ端末にエンジンが2つにならない。アプリでは Web Locks で1つ）。同期の状態は司令塔の状態
// （useSync の status）とヘッダーの同期の表示（useSyncView）で見て、「知ってる」はストアの know で押す。
// アカウントと記録はすべて作り物（公開のリポジトリ。docs/SPEC.md の 3.）
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { GoogleAuthProvider, connectAuthEmulator, getAuth, signInWithCredential, type Auth } from 'firebase/auth'
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache, terminate, type Firestore } from 'firebase/firestore'
import Dexie from 'dexie'
import emuRules from '../../firestore.emu.rules?raw'
import prodRules from '../../firestore.rules?raw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPersistence, V1_SCHEMA, V2_ADDED, type Persistence } from '../db/persistence'
import { termIdOf } from '../domain/ids'
import { jstDateOf } from '../domain/jst'
import { pressKnownTerm } from '../domain/known'
import { flushNow, initStore, know, resetStoreForTests } from '../store/appStore'
import {
  adminCreateOwner,
  adminDocIds,
  adminExists,
  adminWriteRecords,
  clearFirestore,
  EMU_PROJECT,
  useRules,
  type AdminRecordDoc,
} from '../test/emulatorAdmin'
import { fakeRecordsOf, makeFakeEdition } from '../test/fixtures/fakeEditions'
import { encodeRecord, type Rec } from './codec'
import { canShowData, initSync, noteAppVisible, resetSyncForTests, syncNow, useSync, whenAuthKnown } from './controller'
import { OWNER_MISSING_MESSAGE, SENT_MARKS } from './engine'
import { useSyncView } from './syncView'

/** 司令塔が使う Firebase（ログインとクラウドの保存先）。テストごとに、エミュレーターにつないだアプリを入れる */
const fb = vi.hoisted(() => ({
  services: null as { app: FirebaseApp; auth: Auth } | null,
  fs: null as Firestore | null,
}))

vi.mock('./firebase', async () => {
  const a = await import('firebase/auth')
  const services = () => {
    if (!fb.services) throw new Error('テストの Firebase がまだありません')
    return fb.services
  }
  return {
    // 公開した版と同じく、持ち主を確かめる
    usingEmulator: false,
    emulatorHost: undefined,
    REDIRECT_MARK: 'topic-studio:auth-redirect',
    firebase: services,
    completeRedirect: async () => undefined,
    watchUser: (fn: (u: unknown) => void) => a.onAuthStateChanged(services().auth, fn as never),
    signInWithGoogle: async () => undefined,
    signOutUser: () => a.signOut(services().auth),
    signInForTest: async () => undefined,
    describeAuthError: () => null,
  }
})

// クラウドの保存先（src/sync/firestore.ts と同じ作り方。テストごとにアプリを作り直すので、作った物を覚えずにテストの物を返す）
vi.mock('./firestore', () => ({
  firestore: () => {
    if (!fb.fs) throw new Error('テストの Firestore がまだありません')
    return fb.fs
  },
}))

/** 段階0の版のアプリの端末の DB（v1 の _meta だけを知る。src/db/persistence.test.ts の StageZeroDB と同じ） */
class StageZeroDB extends Dexie {
  constructor(name: string) {
    super(name)
    this.version(1).stores(V1_SCHEMA)
  }
}

let seq = 0
const apps: FirebaseApp[] = []
const stores: Persistence[] = []

afterEach(async () => {
  resetSyncForTests()
  resetStoreForTests()
  for (const p of stores.splice(0)) p.close()
  if (fb.fs) await terminate(fb.fs)
  fb.fs = null
  fb.services = null
  for (const app of apps.splice(0)) await deleteApp(app)
  await useRules(emuRules)
})

const account = () => `author-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const dbName = () => `upgrade-${++seq}-${Math.random().toString(36).slice(2)}`

/** エミュレーターのアカウントでログインしたアプリ（段階0でログインしたまま = Firebase が端末にログインの状態を覚えている） */
async function signedInApp(sub: string): Promise<{ app: FirebaseApp; auth: Auth; uid: string }> {
  const app = initializeApp({ projectId: EMU_PROJECT, apiKey: 'fake-api-key', authDomain: 'localhost' }, `upgrade-${++seq}`)
  apps.push(app)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const cred = GoogleAuthProvider.credential(JSON.stringify({ sub, email: `${sub}@example.com`, email_verified: true }))
  const { user } = await signInWithCredential(auth, cred)
  return { app, auth, uid: user.uid }
}

/** 司令塔に、作者のアカウントでログインしたアプリを使わせる */
function useAuthor(author: { app: FirebaseApp; auth: Auth }): void {
  fb.services = { app: author.app, auth: author.auth }
  fb.fs = initializeFirestore(author.app, { localCache: memoryLocalCache() })
  connectFirestoreEmulator(fb.fs, '127.0.0.1', 8080)
}

/** 段階0の版で使っていた端末: v1 の DB に、持ち主だと確かめた uid（ownerSeen）だけがある */
async function stageZeroDevice(name: string, ownerSeen: string): Promise<void> {
  const v1 = new StageZeroDB(name)
  await v1.table('_meta').put({ key: 'ownerSeen', value: ownerSeen })
  expect(v1.verno).toBe(1)
  v1.close()
}

/**
 * 段階1の版のアプリを開く（端末の中の保存先を開き、ログインの状態を確かめ始める。src/main.tsx と同じ順）。最初のログインの状態も返す。
 * beforeSync は、保存先とストアを開いた後、司令塔を始める前に呼ぶ（同期で届く前の端末を確かめる）
 */
async function openApp(
  name: string,
  beforeSync?: (p: Persistence) => Promise<void>,
): Promise<{ p: Persistence; firstSignedIn: boolean | null }> {
  let firstSignedIn: boolean | null = null
  const off = useSync.subscribe((s) => {
    if (s.auth === 'signedIn' && firstSignedIn === null) firstSignedIn = canShowData(s)
  })
  const p = createPersistence(name)
  stores.push(p)
  await initStore(p)
  await beforeSync?.(p)
  await initSync()
  await whenAuthKnown()
  off()
  return { p, firstSignedIn }
}

/** 司令塔のエンジンがクラウドとそろった（最初の受け取りが終わり、同期済み。ヘッダーの同期の表示も「同期済み」） */
const synced = () => {
  const st = useSync.getState().status
  return st?.downloaded === true && st.phase === 'synced' && useSyncView.getState().view?.kind === 'synced'
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

/** 管理者の権限で記録の文書を置く（コネクタの版・ほかの端末の「知ってる」。外側の形はコネクタ・アプリと同じ） */
function adminDoc(table: string, record: Rec, device?: string): AdminRecordDoc {
  const enc = encodeRecord(record)
  return { table, id: record.id, json: enc.json, hash: enc.hash, updated: new Date(Date.now() - 60_000), device }
}

/** Dexie の DB の版（開いて閉じる） */
async function dbVersion(name: string): Promise<number> {
  const db = new Dexie(name)
  await db.open()
  const v = db.verno
  db.close()
  return v
}

const pressLaw = { termId: termIdOf('〇〇法'), term: '〇〇法', asOf: null }

describe('段階0から段階1の版に上がった作者の端末（エミュレーター・本番のアクセスルール。docs/SPEC.md の 16.3 の「上がり」）', () => {
  it('v1 の _meta.ownerSeen だけの端末が v2 に上がっても ownerSeen が残り、ログインし直さずにトップを出して同期を始める', async () => {
    await useRules(prodRules)
    await clearFirestore()
    const author = await signedInApp(account())
    await adminCreateOwner(author.uid)
    const name = dbName()
    await stageZeroDevice(name, author.uid)
    // クラウドには、コネクタが足した版と、ほかの端末が押した「知ってる」がある
    const fake = makeFakeEdition({ date: jstDateOf(Date.now()), slot: '12', seed: 'emu-upgrade' })
    await adminWriteRecords(
      author.uid,
      'records',
      fakeRecordsOf(fake).map((r) => adminDoc(r.table, r.record)),
    )
    const known = pressKnownTerm(null, { termId: termIdOf('与党（日本）'), term: '与党', asOf: '2026-11' }, Date.now() - 60_000)
    await adminWriteRecords(author.uid, 'records', [adminDoc('knownTerms', known, 'other-phone')])

    // 段階1の版を開く（Firebase はログインの状態を覚えたまま。ログインの画面のボタンを押さない）
    useAuthor(author)
    const signedInAs = author.auth.currentUser
    const { p, firstSignedIn } = await openApp(name, async (q) => {
      // 端末の DB は v2 になり、v1 の ownerSeen は残る（足した表は空。司令塔が同期を始める前）
      expect(await dbVersion(name)).toBe(2)
      expect(await q.getMeta('ownerSeen')).toBe(author.uid)
      expect(await q.listEditions()).toEqual([])
      expect(Object.keys(V2_ADDED)).toContain('_outbox')
    })
    // 覚えていた ownerSeen で、ログインの状態と一緒にすぐトップを出す（ネットで確かめる前に）
    expect(firstSignedIn).toBe(true)
    expect(useSync.getState()).toMatchObject({ auth: 'signedIn', ownerSeen: true, user: { uid: author.uid } })
    expect(author.auth.currentUser).toBe(signedInAs)

    // 司令塔が同期を始める（ログインし直さない）: エンジンが持ち主を確かめ、初めての受け取りで版と「知ってる」が届く
    await waitFor(synced, 'クラウドとそろう')
    expect(useSync.getState()).toMatchObject({ leader: true, owner: 'ok' })
    expect(await p.getMeta('ownerSeen')).toBe(author.uid)
    expect(await p.getMeta('uid')).toBe(author.uid)
    expect((await p.listEditions()).map((e) => e.id)).toEqual([fake.edition.id])
    expect(await p.topicsOfEdition(fake.edition.id)).toHaveLength(fake.topics.length)
    expect((await p.loadUserRecords()).knownTerms[known.id]).toEqual(known)
    await waitFor(() => adminExists(`users/${author.uid}/meta/app`), 'データの形の版を書く')

    // この端末で押した「知ってる」がクラウドに届く（ストアが端末に書き、司令塔のエンジンが送る）
    const mine = know(pressLaw)
    expect(mine).toMatchObject({ ok: true, changed: true })
    expect(await flushNow()).toBe(true)
    await syncNow()
    await waitFor(
      async () => (await adminDocIds(author.uid, 'records')).includes(`knownTerms:${pressLaw.termId}`),
      '押した「知ってる」が届く',
    )
    await waitFor(async () => (await p.outboxCount()) === 0, '送信待ちが空になる')
    await waitFor(synced, '同期済みに戻る')
    expect(canShowData(useSync.getState())).toBe(true)
    // 送ったのは司令塔のエンジンだけ（端末の ID は司令塔が作って覚えた物。同じ端末でエンジンが2つにならない）
    const deviceId = await p.getMeta<string>('deviceId')
    expect(deviceId).toBeTruthy()
    expect(await adminExists(`users/${author.uid}/${SENT_MARKS}/${deviceId}`)).toBe(true)
    expect(await adminExists(`users/${author.uid}/${SENT_MARKS}/stage0-pc`)).toBe(false)
  })

  it('段階0で確かめた端末でも、上がった時に持ち主の記録が消えていたら、トップは出したまま同期だけを止める。記録が戻ると同期を始める', async () => {
    await useRules(prodRules)
    await clearFirestore()
    const author = await signedInApp(account())
    const name = dbName()
    await stageZeroDevice(name, author.uid)

    useAuthor(author)
    const { p, firstSignedIn } = await openApp(name)
    expect(firstSignedIn).toBe(true)
    // 司令塔のエンジンが持ち主を確かめ（claimOwner）、記録が無いと分かってもトップのまま（14.8 の 4）。同期の表示に理由を出す
    await waitFor(() => useSync.getState().owner === 'missing', '記録が無いと分かる')
    expect(canShowData(useSync.getState())).toBe(true)
    expect(useSync.getState().status).toMatchObject({ phase: 'error', errorCode: 'owner-missing', error: OWNER_MISSING_MESSAGE })
    expect(useSyncView.getState().view).toEqual({ kind: 'error', reason: '持ち主の記録がまだありません' })

    // 同期だけを止める（何も書かず、受け取らない）。ownerSeen は消さない（ほかのアカウントの記録の時だけ消す）
    expect(know(pressLaw)).toMatchObject({ ok: true, changed: true })
    expect(await flushNow()).toBe(true)
    await syncNow()
    expect(await p.outboxCount()).toBe(1)
    expect(await adminDocIds(author.uid, 'records')).toEqual([])
    expect(await adminExists(`users/${author.uid}/meta/app`)).toBe(false)
    expect(await adminExists(`users/${author.uid}/${SENT_MARKS}/${await p.getMeta<string>('deviceId')}`)).toBe(false)
    expect(await p.getMeta('ownerSeen')).toBe(author.uid)

    // 作者が Firebase の画面で持ち主の記録を作り直す（docs/DEPLOY.md の 3）。アプリに戻ると司令塔が同期を始め直し、残っていた送信待ちを送る
    await adminCreateOwner(author.uid)
    noteAppVisible()
    await waitFor(synced, 'クラウドとそろう')
    expect(useSync.getState().owner).toBe('ok')
    await waitFor(
      async () => (await adminDocIds(author.uid, 'records')).includes(`knownTerms:${pressLaw.termId}`),
      '残っていた「知ってる」が届く',
    )
    await waitFor(async () => (await p.outboxCount()) === 0, '送信待ちが空になる')
  })
})
