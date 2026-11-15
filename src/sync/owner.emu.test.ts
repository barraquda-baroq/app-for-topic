// 持ち主の関所（docs/SPEC.md の 14.4。形1）を、Firebase エミュレーターと本番のアクセスルール（firestore.rules）で確かめる。
// 実行: npm run test:sync（DS の src/sync/upgrade.emu.test.ts と sync.emu.test.ts の「持ち主とアクセスルール」から）。
// アクセスルールの決まり（段階0の「ほかの場所は誰も読み書きできない」を段階1のルールに合わせて書き直した物）は
// src/sync/rules.emu.test.ts（docs/SPEC.md の 7.7 の「ルールのテスト」）。
// 本物の司令塔（src/sync/controller.ts）・持ち主の確かめ（src/sync/owner.ts）・保存先（Dexie。fake-indexeddb）を動かし、Firebase の部品
// （src/sync/firebase.ts・firestore.ts）だけを、エミュレーターにつないだ物に差し替える。usingEmulator は false にして、公開した版と
// 同じく持ち主を確かめさせる（開発サーバーをエミュレーターにつないだ時は確かめないため）。アカウントは作り物だけ
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { GoogleAuthProvider, connectAuthEmulator, getAuth, signInWithCredential, type Auth } from 'firebase/auth'
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache, terminate, type Firestore } from 'firebase/firestore'
import emuRules from '../../firestore.emu.rules?raw'
import prodRules from '../../firestore.rules?raw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPersistence, type Persistence } from '../db/persistence'
import { initStore, resetStoreForTests } from '../store/appStore'
import { adminCreateOwner, adminDeleteOwner, adminExists, clearFirestore, EMU_PROJECT, useRules } from '../test/emulatorAdmin'
import { canShowData, initSync, noteAppVisible, resetSyncForTests, useSync, whenAuthKnown } from './controller'

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

/** エミュレーターのアカウントでログインしたアプリ（Firebase が端末にログインの状態を覚えている） */
async function signedInApp(sub: string): Promise<{ app: FirebaseApp; auth: Auth; uid: string }> {
  const app = initializeApp({ projectId: EMU_PROJECT, apiKey: 'fake-api-key', authDomain: 'localhost' }, `owner-${++seq}`)
  apps.push(app)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const cred = GoogleAuthProvider.credential(JSON.stringify({ sub, email: `${sub}@example.com`, email_verified: true }))
  const { user } = await signInWithCredential(auth, cred)
  return { app, auth, uid: user.uid }
}

/** そのアプリの Firestore（エミュレーター） */
function firestoreOf(app: FirebaseApp): Firestore {
  const fs = initializeFirestore(app, { localCache: memoryLocalCache() })
  connectFirestoreEmulator(fs, '127.0.0.1', 8080)
  return fs
}

/** 司令塔に、作者のアカウントでログインしたアプリを使わせる */
function useAuthor(author: { app: FirebaseApp; auth: Auth }): void {
  fb.services = { app: author.app, auth: author.auth }
  fb.fs = firestoreOf(author.app)
}

/** アプリを開く（端末の中の保存先を開き、ログインの状態を確かめ始める。src/main.tsx と同じ順） */
async function openApp(dbName: string): Promise<Persistence> {
  const p = createPersistence(dbName)
  stores.push(p)
  await initStore(p)
  await initSync()
  await whenAuthKnown()
  return p
}

/** アプリを閉じる（同じ端末の DB は残る） */
function closeApp(): void {
  resetSyncForTests()
  resetStoreForTests()
  for (const p of stores.splice(0)) p.close()
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
    if (Date.now() > until) {
      const s = useSync.getState()
      const state = JSON.stringify({ auth: s.auth, owner: s.owner, ownerSeen: s.ownerSeen, error: s.error })
      throw new Error(`待ちきれませんでした: ${label}${last ? ` (${String(last)})` : ''} ${state}`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

const dbName = () => `owner-${seq}-${Math.random().toString(36).slice(2)}`

describe('持ち主の関所（エミュレーター・本番のアクセスルール。形1）', () => {
  it('持ち主の記録が無い間はトップを出さず、記録も作らない。管理者が記録を作ってアプリに戻るとトップを出し、この端末に覚える', async () => {
    await useRules(prodRules)
    await clearFirestore()
    const author = await signedInApp(account())
    useAuthor(author)

    const p = await openApp(dbName())
    expect(useSync.getState()).toMatchObject({ auth: 'signedIn', ownerSeen: false })
    await waitFor(() => useSync.getState().owner === 'missing', '持ち主の記録が無いと分かる')
    expect(canShowData(useSync.getState())).toBe(false)
    // アプリは記録を作らない・この端末をこのアカウントの物と覚えない
    await new Promise((r) => setTimeout(r, 500))
    expect(await adminExists('config/owner')).toBe(false)
    expect(await p.getMeta('ownerSeen')).toBeUndefined()

    // 作者が Firebase の画面で持ち主の記録を作る（docs/DEPLOY.md の 3）。アプリに戻る（画面が表に戻る）と確かめ直す
    await adminCreateOwner(author.uid)
    noteAppVisible()
    await waitFor(() => canShowData(useSync.getState()), 'トップを出せる')
    expect(useSync.getState().owner).toBe('ok')
    expect(await p.getMeta('ownerSeen')).toBe(author.uid)
  })

  it('記録を作った後にアプリを開き直しても進み、次からはネットで確かめる前にトップを出す', async () => {
    await useRules(prodRules)
    await clearFirestore()
    const author = await signedInApp(account())
    useAuthor(author)
    const name = dbName()

    await openApp(name)
    await waitFor(() => useSync.getState().owner === 'missing', '持ち主の記録が無いと分かる')
    closeApp()

    await adminCreateOwner(author.uid)
    // 開き直す: まだこの端末で確かめていないので、「確かめています…」の後に進む
    await openApp(name)
    expect(useSync.getState()).toMatchObject({ auth: 'signedIn', ownerSeen: false })
    await waitFor(() => canShowData(useSync.getState()), 'トップを出せる')
    closeApp()

    // 次に開いた時は、この端末で持ち主だと確かめたアカウントなので、ログインの状態と一緒にすぐトップを出す
    const seen: boolean[] = []
    const off = useSync.subscribe((s) => {
      if (s.auth === 'signedIn') seen.push(canShowData(s))
    })
    await openApp(name)
    off()
    expect(seen[0]).toBe(true)
  })

  it('確かめたアカウントでも、記録が消えた時はトップのまま（DS は同期だけを止める）。作り直して表に戻ると ok', async () => {
    await useRules(prodRules)
    await clearFirestore()
    const author = await signedInApp(account())
    useAuthor(author)
    await adminCreateOwner(author.uid)
    const name = dbName()
    await openApp(name)
    await waitFor(() => canShowData(useSync.getState()), 'トップを出せる')
    closeApp()

    await adminDeleteOwner()
    const p = await openApp(name)
    // この端末の印ですぐトップを出し、裏でクラウドの記録と照らし合わせる。記録が無いと分かっても、トップのまま
    await waitFor(() => useSync.getState().owner === 'missing', '記録が無いと分かる')
    expect(canShowData(useSync.getState())).toBe(true)
    expect(await p.getMeta('ownerSeen')).toBe(author.uid)

    await adminCreateOwner(author.uid)
    noteAppVisible()
    await waitFor(() => useSync.getState().owner === 'ok', '記録が戻ったと分かる')
    expect(canShowData(useSync.getState())).toBe(true)
  })

  it('確かめたアカウントでも、記録がほかのアカウントになっていたら、印を消してログインの画面に戻す', async () => {
    await useRules(prodRules)
    await clearFirestore()
    const author = await signedInApp(account())
    const other = await signedInApp(account())
    useAuthor(author)
    await adminCreateOwner(author.uid)
    const name = dbName()
    const p = await openApp(name)
    await waitFor(() => canShowData(useSync.getState()), 'トップを出せる')
    expect(await p.getMeta('ownerSeen')).toBe(author.uid)
    closeApp()

    // 作者が持ち主を別のアカウントに移した（docs/DEPLOY.md の 3「持ち主を変えたい時」）
    await adminCreateOwner(other.uid)
    const q = await openApp(name)
    // 開いた時はこの端末の印でトップを出すが、裏でクラウドの記録と照らし合わせて戻す
    await waitFor(() => useSync.getState().owner === 'mismatch', 'ほかのアカウントの記録と分かる')
    expect(canShowData(useSync.getState())).toBe(false)
    expect(await q.getMeta('ownerSeen')).toBeNull()
  })
})
