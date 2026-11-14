// ログインと持ち主の関所の司令塔（docs/SPEC.md の 14.4）: ログインの状態を見て持ち主を確かめ、状態を画面に知らせる。
// DS の src/sync/controller.ts から、持ち主の確かめ（形1）に要る所だけを写した物（同期のエンジン・送信待ち・画面どうしの受け渡し・
// 別のアカウントの確かめ・Claude との連携は、段階1から後で足す）。
// - TS も最初にログインの画面を出すので、起動のたびに Firebase（ログイン）を読み込んで状態を確かめる
// - 持ち主（形1）: config/owner はアプリから作らない。この端末で持ち主だと確かめたアカウント（_meta の ownerSeen）の時だけ、トップの
//   画面を出す。まだ確かめていないアカウントは、ネットで確かめてから（記録が無い・ほかのアカウントの記録なら、ログインの画面に文と
//   ［ログアウト］）。記録が無い・ほかのアカウントの記録だった時は、画面が表に戻った・窓を選んだ・つながった時に確かめ直す（作者が
//   Firebase の画面で持ち主の記録を作ってからアプリに戻ると、読み込み直さなくてもトップの画面が出る。recheckOwner）
// - この端末で確かめたアカウントは、すぐにトップの画面を出し（電波が無くても開ける）、裏でクラウドの記録と照らし合わせる（DS では同期の
//   エンジンが毎回確かめる所。段階0にはエンジンが無いので、ここで確かめる。confirmSeenOwner）。ほかのアカウントの記録になっていたら、
//   覚えた印を消してログインの画面に戻す
import { create } from 'zustand'
import { getPersistence } from '../store/appStore'
import type { OwnerState } from './syncView'

export interface SyncUser {
  uid: string
  name: string
  email: string
}

export interface SyncState {
  /** idle = まだ確かめていない、checking = 確かめている（Firebase を読み込んでいる） */
  auth: 'idle' | 'checking' | 'signedOut' | 'signedIn'
  user: SyncUser | null
  /** 持ち主の確かめ。ok = このアカウントが持ち主、missing = 記録が無い、mismatch = ほかのアカウントの記録 */
  owner: OwnerState
  /** この端末で、このアカウントを持ち主だと確かめたことがある（_meta の ownerSeen。トップの画面を出してよい） */
  ownerSeen: boolean
  /** ログイン・ログアウトの途中 */
  busy: boolean
  /** ログインの画面に出す失敗の言葉 */
  error: string | null
}

const initial: SyncState = {
  auth: 'idle',
  user: null,
  owner: 'unknown',
  ownerSeen: false,
  busy: false,
  error: null,
}

export const useSync = create<SyncState>(() => ({ ...initial }))

/**
 * トップ・設定の画面を出してよいか（この端末で持ち主だと確かめたアカウントで、ほかのアカウントの記録になっていない）。
 * DS の canShowData から、別のアカウントの確かめ（段階1で足す）を除いた物
 */
export function canShowData(s: Pick<SyncState, 'auth' | 'owner' | 'ownerSeen'>): boolean {
  return s.auth === 'signedIn' && s.ownerSeen && s.owner !== 'mismatch'
}

let booted: Promise<void> | null = null
let hooksInstalled = false
/** 画面のテスト用に、Firebase を使わずにログインした状態にしている（fakeSignInForTest） */
let faked = false

/**
 * 後から読み込む部品は、読み込みを1つにまとめる（読み込めなかった時は、次に呼んだ時に読み込み直す）。DS の段階1で、同じ部品を同時に
 * 読み込むと2つできることがあったので、初めからこの形にしておく（テストで部品を差し替える vi.mock でも、差し替えた物が使われる）
 */
function loadOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | null = null
  return () =>
    (loading ??= load().catch((e: unknown) => {
      loading = null
      throw e
    }))
}

const firebaseModule = loadOnce(() => import('./firebase'))
const firestoreModule = loadOnce(() => import('./firestore'))
const ownerModule = loadOnce(() => import('./owner'))

/**
 * E2E の持ち主の関所の確かめ用（開発サーバーだけ）: VITE_E2E_OWNER_LOCK=1 で開いた開発サーバーは、エミュレーターにつないでいても
 * 本番と同じに持ち主を確かめる（config/owner はテストが管理者の権限で作る。playwright.sync.config.ts・e2e/owner-gate.sync.spec.ts）。
 * 公開するビルドでは import.meta.env.DEV が false なので false に決まり、この分岐はビルドで消える（本番の動きは変わらない）
 */
const e2eOwnerLock = import.meta.env.DEV && import.meta.env.VITE_E2E_OWNER_LOCK === '1'

/**
 * 持ち主を確かめずに進める（エミュレーターにつないだ開発サーバー。エミュレーターには config/owner が無いため。
 * E2E の持ち主の関所の確かめの時は確かめる）。公開するビルドではエミュレーターを使わないので、いつも確かめる
 */
function skipsOwnerCheck(fb: { usingEmulator: boolean }): boolean {
  return fb.usingEmulator && !e2eOwnerLock
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 持ち主を確かめられなかった（通信できなかった）時に、確かめ直すまでの時間 */
const OWNER_RETRY_MS = 15_000

let ownerRetry: ReturnType<typeof setTimeout> | null = null
let ownerToken = 0
/** 確かめ直している途中（画面が表に戻った時と窓を選んだ時が重なっても、1回だけ読む） */
let rechecking = false
/** この端末で確かめたアカウントを、今回の起動ではまだクラウドの記録と照らし合わせられていない（通信できなかった） */
let seenUnconfirmed = false

function clearOwnerRetry(): void {
  if (ownerRetry) clearTimeout(ownerRetry)
  ownerRetry = null
}

/** クラウドの持ち主の記録と照らし合わせる（通信できなければ投げる） */
async function checkNow(uid: string): Promise<'ok' | 'missing' | 'mismatch'> {
  const [{ checkOwner }, store] = await Promise.all([ownerModule(), firestoreModule()])
  return checkOwner(store.firestore(), uid)
}

/** この端末で、このアカウントを持ち主だと確かめたことがあるか（読めない時は「まだ」。読み込み中…のまま止まらないように） */
async function readSeen(uid: string): Promise<boolean> {
  try {
    return (await getPersistence()?.getMeta<string>('ownerSeen')) === uid
  } catch (e) {
    console.warn('この端末の持ち主の印を読めませんでした', e)
    return false
  }
}

/** この端末で持ち主だと確かめたアカウントを覚える（null で消す。書けなくても、今の画面はそのまま進める） */
async function rememberOwner(uid: string | null): Promise<void> {
  try {
    await getPersistence()?.setMeta('ownerSeen', uid)
  } catch (e) {
    console.warn('この端末の持ち主の印を書けませんでした', e)
  }
}

function installHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') noteAppVisible()
    })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => retryOwnerCheck())
    // PC で Firebase の画面とアプリを別の窓で並べている時は、画面が裏に回らないので、窓を選んだ時にも確かめ直す
    window.addEventListener('focus', () => void recheckOwner())
  }
}

/** 画面が表に戻った時。持ち主の記録が無かった時などは確かめ直す */
export function noteAppVisible(): void {
  void recheckOwner()
}

/** 持ち主を確かめ直す（通信できなかった時・つながった時） */
function retryOwnerCheck(): void {
  const { auth, user, owner } = useSync.getState()
  if (faked || auth !== 'signedIn' || !user) return
  if (owner === 'checking' || owner === 'unknown') void verifyOwner(user)
  else void recheckOwner()
}

/**
 * この端末で確かめたアカウント: トップの画面は出したまま、クラウドの記録と照らし合わせる（DS では同期のエンジンの claimOwner がする所）。
 * ほかのアカウントの記録になっていたら、覚えた印を消してログインの画面に戻す。記録が無い（消された）時は、トップの画面のまま
 * （DS は同期だけを止める。段階0には止める同期が無い）。通信できない時は、次に表に戻った・窓を選んだ・つながった時に照らし合わせる
 */
async function confirmSeenOwner(user: SyncUser, token: number): Promise<void> {
  try {
    const state = await checkNow(user.uid)
    if (token !== ownerToken) return
    seenUnconfirmed = false
    if (state === 'mismatch') {
      await rememberOwner(null)
      if (token === ownerToken) useSync.setState({ owner: 'mismatch', ownerSeen: false })
    } else if (state !== useSync.getState().owner) useSync.setState({ owner: state })
  } catch (e) {
    console.warn('持ち主を確かめられませんでした', e)
  }
}

/**
 * 持ち主を確かめ直す（画面が表に戻った・窓を選んだ・つながった時）。持ち主の記録が無い・ほかのアカウントの記録だった時は、
 * 作者が Firebase の画面で持ち主の記録を作ってからアプリに戻ると、読み込み直さなくてもトップの画面が出る。確かめている間も、
 * ログインの画面の今の文は出したまま（「確かめています…」に替えない）。この端末で確かめたアカウントは、まだクラウドと照らし合わせられて
 * いない時と、記録が無かった時に照らし合わせる
 */
export async function recheckOwner(): Promise<void> {
  const s = useSync.getState()
  const user = s.user
  if (faked || rechecking || s.auth !== 'signedIn' || !user) return
  const token = ownerToken
  if (s.ownerSeen) {
    if (!seenUnconfirmed && s.owner !== 'missing') return
    rechecking = true
    try {
      await confirmSeenOwner(user, token)
    } finally {
      rechecking = false
    }
    return
  }
  if (s.owner !== 'missing' && s.owner !== 'mismatch') return
  rechecking = true
  try {
    const state = await checkNow(user.uid)
    if (token !== ownerToken) return
    if (state === 'ok') {
      await rememberOwner(user.uid)
      if (token !== ownerToken) return
      useSync.setState({ owner: 'ok', ownerSeen: true })
    } else if (state !== useSync.getState().owner) useSync.setState({ owner: state })
  } catch (e) {
    // 通信できない: 今の文のまま（次に表に戻った・つながった時に確かめ直す）
    console.warn('持ち主を確かめ直せませんでした', e)
  } finally {
    rechecking = false
  }
}

/**
 * ログインしたアカウントが持ち主か確かめる。この端末で前に持ち主だと確かめたアカウントなら、すぐにトップの画面を出して、
 * 裏でクラウドの記録と照らし合わせる
 */
async function verifyOwner(user: SyncUser): Promise<void> {
  const token = ++ownerToken
  clearOwnerRetry()
  const fb = await firebaseModule()
  if (token !== ownerToken) return
  if (skipsOwnerCheck(fb)) {
    // エミュレーターにつないだ開発サーバー: 確かめず、印も覚えない
    useSync.setState({ owner: 'ok', ownerSeen: true })
    return
  }
  const seen = await readSeen(user.uid)
  if (token !== ownerToken) return
  if (seen) {
    useSync.setState({ owner: 'ok', ownerSeen: true })
    seenUnconfirmed = true
    await confirmSeenOwner(user, token)
    return
  }
  useSync.setState({ owner: 'checking', ownerSeen: false })
  try {
    const state = await checkNow(user.uid)
    if (token !== ownerToken) return
    if (state === 'ok') {
      await rememberOwner(user.uid)
      if (token !== ownerToken) return
      seenUnconfirmed = false
      useSync.setState({ owner: 'ok', ownerSeen: true })
    } else useSync.setState({ owner: state, ownerSeen: false })
  } catch (e) {
    // 通信できない: 「確かめています…」のまま、つながったら・少し後で確かめ直す
    console.warn('持ち主を確かめられませんでした', e)
    if (token !== ownerToken) return
    ownerRetry = setTimeout(() => {
      ownerRetry = null
      retryOwnerCheck()
    }, OWNER_RETRY_MS)
  }
}

function reportError(e: unknown): void {
  console.warn('ログインの状態を確かめられませんでした', e)
  useSync.setState({ error: message(e) })
}

function boot(): Promise<void> {
  booted ??= (async () => {
    installHooks()
    // 画面のテスト用にもうログインした状態にしてあれば、その状態を上書きしない（確かめている間も 'signedIn' のまま）
    if (!faked) useSync.setState({ auth: 'checking' })
    try {
      const fb = await firebaseModule()
      fb.firebase()
      // リダイレクトでログインして戻ってきた時は、その結果を受け取る
      await fb.completeRedirect().catch((e) => {
        const text = fb.describeAuthError(e)
        if (text) useSync.setState({ error: text })
      })
      fb.watchUser((user) => {
        if (faked) return
        if (user) {
          const u: SyncUser = { uid: user.uid, name: user.displayName ?? '', email: user.email ?? '' }
          const token = ++ownerToken
          void (async () => {
            // この端末で持ち主だと確かめたアカウントかを先に読む（起動のたびにログインの画面が一瞬出ないように、ログインした状態と
            // 一緒に入れる）
            const seen = skipsOwnerCheck(fb) || (await readSeen(u.uid))
            if (token !== ownerToken || faked) return
            useSync.setState({ auth: 'signedIn', user: u, error: null, owner: seen ? 'ok' : 'checking', ownerSeen: seen })
            await verifyOwner(u)
          })().catch(reportError)
        } else {
          ownerToken += 1
          clearOwnerRetry()
          seenUnconfirmed = false
          useSync.setState({ auth: 'signedOut', user: null, owner: 'unknown', ownerSeen: false })
        }
      })
    } catch (e) {
      // Firebase を読み込めない（初めて開いた時に電波が無い など）: ログインの画面を出す
      console.warn('ログインの状態を確かめられませんでした', e)
      if (!faked) useSync.setState({ auth: 'signedOut', user: null, error: message(e) })
    }
  })()
  return booted
}

/** 起動時に呼ぶ（端末の中の保存先を開いてから。src/main.tsx）。ログインの状態を確かめ始める */
export function initSync(): Promise<void> {
  return boot()
}

/** ログインの状態が分かった（ログインの画面かトップ画面のどちらを出すか決まった）時に終わる */
export function whenAuthKnown(): Promise<void> {
  const known = (s: SyncState) => s.auth === 'signedIn' || s.auth === 'signedOut'
  if (known(useSync.getState())) return Promise.resolve()
  return new Promise((resolve) => {
    const off = useSync.subscribe((s) => {
      if (!known(s)) return
      off()
      resolve()
    })
  })
}

/** ［Google でログイン］ */
export async function signIn(): Promise<void> {
  useSync.setState({ busy: true, error: null })
  try {
    await boot()
    const fb = await firebaseModule()
    if (fb.firebase().auth.currentUser) return
    await fb.signInWithGoogle()
  } catch (e) {
    const fb = await firebaseModule().catch(() => null)
    const text = fb ? fb.describeAuthError(e) : message(e)
    if (text) useSync.setState({ error: text })
  } finally {
    useSync.setState({ busy: false })
  }
}

/** ［ログアウト］（ログインの画面に戻る。この端末で確かめた持ち主の印は消さない。同じアカウントで入り直せばすぐにトップ） */
export async function signOut(): Promise<void> {
  useSync.setState({ busy: true, error: null })
  try {
    if (faked) {
      faked = false
      useSync.setState({ auth: 'signedOut', user: null, owner: 'unknown', ownerSeen: false })
      return
    }
    const fb = await firebaseModule()
    await fb.signOutUser()
  } catch (e) {
    useSync.setState({ error: message(e) })
  } finally {
    useSync.setState({ busy: false })
  }
}

/** テスト用: エミュレーターの仮のアカウントでログインする（開発サーバーだけ。公開するビルドでは中身がビルドで消える） */
export async function signInForTest(sub: string): Promise<void> {
  if (!import.meta.env.DEV) throw new Error('開発サーバーだけで使えます')
  await boot()
  const fb = await firebaseModule()
  await fb.signInForTest(sub)
}

/**
 * 画面のテスト用（開発サーバーだけ。src/main.tsx の window.__ts）: Firebase を使わずに、ログインした状態にする
 * （エミュレーターの無い E2E で、トップ画面・設定の画面を開くため。持ち主も確かめた扱い）
 */
export function fakeSignInForTest(user: SyncUser = { uid: 'test-user', name: 'テスト', email: 'test@example.com' }): void {
  if (!import.meta.env.DEV) throw new Error('開発サーバーだけで使えます')
  faked = true
  ownerToken += 1
  clearOwnerRetry()
  useSync.setState({ auth: 'signedIn', user, owner: 'ok', ownerSeen: true, error: null })
}

/** テスト用 */
export function resetSyncForTests(): void {
  booted = null
  faked = false
  ownerToken += 1
  clearOwnerRetry()
  rechecking = false
  seenUnconfirmed = false
  useSync.setState({ ...initial })
}
