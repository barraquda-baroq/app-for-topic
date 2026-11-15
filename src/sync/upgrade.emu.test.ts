// 段階0でログインしたままの作者の端末が、段階1の版に上がった時の流れ（docs/SPEC.md の 16.3 の「上がり」・7.8 の「端末の表（Dexie v2）」・
// 14.4）を、Firebase エミュレーターと本番のアクセスルール（firestore.rules）で確かめる。実行: npm run test:sync
// DS の src/sync/upgrade.emu.test.ts から。段階0の版は、端末の中に v1 の _meta（持ち主だと確かめた ownerSeen）だけを持ち、クラウドには
// 何も書かない（ログインの状態は Firebase が端末に覚えている）。段階1の版を開くと、Dexie が v2 の表を足し（ownerSeen は残る）、ログインし
// 直さずに、覚えていた ownerSeen でトップの画面を出し、同期を始める。
// 本物の司令塔（src/sync/controller.ts）・保存先（src/db/persistence.ts。fake-indexeddb）・同期のエンジン（src/sync/engine.ts）を動かし、
// Firebase の部品（src/sync/firebase.ts・firestore.ts）だけを、エミュレーターにつないだ物に差し替える（src/sync/owner.emu.test.ts と同じ）。
// usingEmulator は false にして、公開した版と同じく持ち主を確かめさせる。
// 司令塔がエンジンを動かすのは段階1の 6（16.2）なので、ここでは司令塔で「ログインし直さずにトップを出す」所までを確かめ、エンジンは、
// 司令塔が使うのと同じログイン済みの Firebase と同じ保存先で、このテストが動かす（司令塔がエンジンを動かすようになったら、司令塔の道に替える）。
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
import { initStore, resetStoreForTests } from '../store/appStore'
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
import { APP_VERSION, DATA_MODEL } from './appModel'
import { encodeRecord, type Rec } from './codec'
import { canShowData, initSync, resetSyncForTests, useSync, whenAuthKnown } from './controller'
import { createSyncEngine, OWNER_MISSING_MESSAGE, SENT_MARKS, type SyncEngine } from './engine'

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
const engines: SyncEngine[] = []

afterEach(async () => {
  for (const e of engines.splice(0)) e.stop()
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

/** 段階1の版のアプリを開く（端末の中の保存先を開き、ログインの状態を確かめ始める。src/main.tsx と同じ順）。最初のログインの状態も返す */
async function openApp(name: string): Promise<{ p: Persistence; firstSignedIn: boolean | null }> {
  let firstSignedIn: boolean | null = null
  const off = useSync.subscribe((s) => {
    if (s.auth === 'signedIn' && firstSignedIn === null) firstSignedIn = canShowData(s)
  })
  const p = createPersistence(name)
  stores.push(p)
  await initStore(p)
  await initSync()
  await whenAuthKnown()
  off()
  return { p, firstSignedIn }
}

/** 同期を始める（司令塔が使うのと同じログイン済みの Firebase と保存先で。ログインし直さない） */
async function startEngine(p: Persistence, uid: string): Promise<SyncEngine> {
  if (!fb.fs) throw new Error('テストの Firestore がまだありません')
  const engine = createSyncEngine({
    firestore: fb.fs,
    uid,
    deviceId: 'stage0-pc',
    target: p,
    uploadDelay: 10,
    uploadMaxWait: 50,
    ownerLock: true,
    appModel: { model: DATA_MODEL, appVersion: APP_VERSION },
  })
  engines.push(engine)
  await engine.start()
  return engine
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
    const { p, firstSignedIn } = await openApp(name)
    // 覚えていた ownerSeen で、ログインの状態と一緒にすぐトップを出す（ネットで確かめる前に）
    expect(firstSignedIn).toBe(true)
    expect(useSync.getState()).toMatchObject({ auth: 'signedIn', ownerSeen: true, user: { uid: author.uid } })
    expect(author.auth.currentUser).toBe(signedInAs)
    // 端末の DB は v2 になり、v1 の ownerSeen は残る（足した表は空）
    expect(await dbVersion(name)).toBe(2)
    expect(await p.getMeta('ownerSeen')).toBe(author.uid)
    expect(await p.listEditions()).toEqual([])
    expect(Object.keys(V2_ADDED)).toContain('_outbox')

    // 同期を始める: 持ち主を確かめ、初めての受け取りで版と「知ってる」が届く
    const engine = await startEngine(p, author.uid)
    await waitFor(() => engine.status.downloaded && engine.status.phase === 'synced', 'クラウドとそろう')
    expect(await p.getMeta('ownerSeen')).toBe(author.uid)
    expect(await p.getMeta('uid')).toBe(author.uid)
    expect((await p.listEditions()).map((e) => e.id)).toEqual([fake.edition.id])
    expect(await p.topicsOfEdition(fake.edition.id)).toHaveLength(fake.topics.length)
    expect((await p.loadUserRecords()).knownTerms[known.id]).toEqual(known)
    await waitFor(() => adminExists(`users/${author.uid}/meta/app`), 'データの形の版を書く')

    // この端末で押した「知ってる」がクラウドに届く
    const prev = await p.loadUserRecords()
    const mine = pressKnownTerm(null, pressLaw, Date.now())
    await p.save(prev, { ...prev, knownTerms: { ...prev.knownTerms, [mine.id]: mine } })
    engine.requestUpload(true)
    await waitFor(
      async () => (await adminDocIds(author.uid, 'records')).includes(`knownTerms:${mine.id}`),
      '押した「知ってる」が届く',
    )
    await waitFor(async () => (await p.outboxCount()) === 0, '送信待ちが空になる')
    expect(canShowData(useSync.getState())).toBe(true)
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
    // 司令塔は裏でクラウドの記録と照らし合わせ、記録が無いと分かってもトップのまま（14.8 の 4）
    await waitFor(() => useSync.getState().owner === 'missing', '記録が無いと分かる')
    expect(canShowData(useSync.getState())).toBe(true)

    // 同期だけを止める（何も書かず、受け取らない）。ownerSeen は消さない（ほかのアカウントの記録の時だけ消す）
    const prev = await p.loadUserRecords()
    const mine = pressKnownTerm(null, pressLaw, Date.now())
    await p.save(prev, { ...prev, knownTerms: { ...prev.knownTerms, [mine.id]: mine } })
    const stopped = await startEngine(p, author.uid)
    await waitFor(() => stopped.status.errorCode === 'owner-missing', '同期だけを止める')
    expect(stopped.status).toMatchObject({ phase: 'error', error: OWNER_MISSING_MESSAGE })
    expect(await p.outboxCount()).toBe(1)
    expect(await adminDocIds(author.uid, 'records')).toEqual([])
    expect(await adminExists(`users/${author.uid}/meta/app`)).toBe(false)
    expect(await adminExists(`users/${author.uid}/${SENT_MARKS}/stage0-pc`)).toBe(false)
    expect(await p.getMeta('ownerSeen')).toBe(author.uid)
    stopped.stop()

    // 作者が Firebase の画面で持ち主の記録を作り直す（docs/DEPLOY.md の 3）。同期を始め直すと、残っていた送信待ちを送る
    await adminCreateOwner(author.uid)
    const engine = await startEngine(p, author.uid)
    await waitFor(() => engine.status.downloaded && engine.status.phase === 'synced', 'クラウドとそろう')
    await waitFor(
      async () => (await adminDocIds(author.uid, 'records')).includes(`knownTerms:${mine.id}`),
      '残っていた「知ってる」が届く',
    )
    expect(await p.outboxCount()).toBe(0)
  })
})
