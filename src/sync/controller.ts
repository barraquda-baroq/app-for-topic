// ログインと持ち主の関所と同期の司令塔（docs/SPEC.md の 14.4・7.8 の「部品」の controller.ts）: ログインの状態を見て持ち主を確かめ、
// 同期のエンジンを動かし、状態を画面に知らせる。段階0の司令塔（DS の src/sync/controller.ts から持ち主の確かめに要る所だけを写した物）に、
// 段階1で DS の残り（エンジンの起動・タブの受け持ち・別のアカウントの確かめ・1日1回の手入れ）を TS の形にして足した。
// - TS も最初にログインの画面を出すので、起動のたびに Firebase（ログイン）を読み込んで状態を確かめる
// - 持ち主（形1）: config/owner はアプリから作らない。この端末で持ち主だと確かめたアカウント（_meta の ownerSeen）の時だけ、トップの
//   画面を出す。まだ確かめていないアカウントは、ネットで確かめてから（記録が無い・ほかのアカウントの記録なら、ログインの画面に文と
//   ［ログアウト］）。記録が無い・ほかのアカウントの記録だった時は、画面が表に戻った・窓を選んだ・つながった時に確かめ直す（作者が
//   Firebase の画面で持ち主の記録を作ってからアプリに戻ると、読み込み直さなくてもトップの画面が出る。recheckOwner）
// - この端末で確かめたアカウントは、すぐにトップの画面を出し（電波が無くても開ける）、裏でクラウドの記録と照らし合わせる（段階0の
//   confirmSeenOwner をそのまま生かす）。ほかのアカウントの記録になっていたら、覚えた印を消してログインの画面に戻す。同期のエンジンも
//   始める時に持ち主を確かめ（claimOwner）、記録が無い時は同期だけを止めて、ヘッダーに「同期できません（持ち主の記録がまだありません）」
//   （docs/SPEC.md の 7.8 の「持ち主」・14.8 の 4）。記録が戻ったと分かったら、同期を始め直す
// - この端末で前に別のアカウントと同期していた時は、同期を始める前に確かめる（DS の accountMismatch。ログインの画面に文と
//   ［このアカウントで同期する］［ログアウト］。7.8 の「既読・知ってるを送る・受け取る」）
// - 同じ端末で複数の画面（タブ・ウィンドウ）を開いている時は、1つの画面だけが同期を受け持つ（Web Locks の topic-studio-sync）。
//   画面どうしの知らせ（BroadcastChannel の topic-studio-sync-status）にデータの形の版（DATA_MODEL）を載せ、受け持つ画面が自分より新しい版の
//   画面に気付いたら、同期をやめて受け持ちを譲る。受け持たない画面も、クラウドのデータの形の版が自分より低ければ上げる（DS と同じ）
// - 受け持つ画面は、20分より長く裏にあった後に購読し直し（reanchor）、裏に回る時にすぐ送り、日付（日本時間）が変わった時に端末の中の
//   30日の外を消し（expireLocal）、その日の最初の受け取りの後、操作の無い 30秒の後に30日の手入れ（maintain）をする（7.8 の「30日で消す」）
import { create } from 'zustand'
import { addDaysToDate, jstDateOf, jstStartOfDayMs } from '../domain/jst'
import type { Persistence } from '../db/persistence'
import {
  applyRemoteChanges,
  expireLocalRecords,
  flushNow,
  getPersistence,
  noteSyncDownloaded,
  onExternalSave,
  onLocalSave,
  reloadFromDisk,
  setTopicFetcher,
} from '../store/appStore'
import { notify } from '../store/uiStore'
import { DATA_MODEL } from './appVersion'
import type { SyncEngine, SyncStatus, SyncTarget } from './engine'
import { syncViewOf, useSyncView, type OwnerState } from './syncView'

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
  /** 同期のエンジンの状態（同期を受け持たない画面は、受け持つ画面から届いた物） */
  status: SyncStatus | null
  /** この画面が同期を受け持っている */
  leader: boolean
  /** ログイン・ログアウトの途中 */
  busy: boolean
  /** ログインの画面に出す失敗の言葉 */
  error: string | null
  /**
   * この端末は以前、別のアカウント（previousEmail）と同期していた。確かめるまで同期を始めない・データを出さない（間違えて別のアカウントを
   * 選んだ時に、端末の既読・知ってるがそのアカウントへ写らないように。DS の accountMismatch）
   */
  accountMismatch: { previousEmail: string } | null
}

const initial: SyncState = {
  auth: 'idle',
  user: null,
  owner: 'unknown',
  ownerSeen: false,
  status: null,
  leader: false,
  busy: false,
  error: null,
  accountMismatch: null,
}

export const useSync = create<SyncState>(() => ({ ...initial }))

// ヘッダーの同期の表示を、司令塔の状態から決めて入れる（持ち主だと確かめた後だけ。docs/SPEC.md の 7.8 の8つ）
useSync.subscribe((s) => {
  const view = s.auth === 'signedIn' && s.ownerSeen ? syncViewOf(s) : null
  const cur = useSyncView.getState().view
  if (JSON.stringify(cur) !== JSON.stringify(view)) useSyncView.setState({ view })
})

/**
 * トップ・設定の画面を出してよいか（この端末で持ち主だと確かめたアカウントで、ほかのアカウントの記録になっておらず、別のアカウントの
 * 確かめも済んでいる。DS の canShowData）
 */
export function canShowData(
  s: Pick<SyncState, 'auth' | 'owner' | 'ownerSeen'> & Partial<Pick<SyncState, 'accountMismatch'>>,
): boolean {
  return s.auth === 'signedIn' && s.ownerSeen && s.owner !== 'mismatch' && !s.accountMismatch
}

let booted: Promise<void> | null = null
let hooksInstalled = false
/** 画面のテスト用に、Firebase を使わずにログインした状態にしている（fakeSignInForTest。同期は始めない） */
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
const engineModule = loadOnce(() => import('./engine'))
const appModelModule = loadOnce(() => import('./appModel'))

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

// ---------- 同期のエンジン（docs/SPEC.md の 7.8 の「部品」） ----------

/** 同期を受け持つ画面が、ほかの画面（タブ・ウィンドウ）に状態を知らせる */
const STATUS_CHANNEL = 'topic-studio-sync-status'
/** 同期を受け持つ画面を1つにする Web Locks の名前 */
const LEADER_LOCK = 'topic-studio-sync'
/** 画面がこれより長く裏にあったら、戻った時に購読し直す（長く切れていた購読は、抱えた文書を読み直すため。DS と同じ） */
export const REANCHOR_AFTER_MS = 20 * 60 * 1000
/** その日の最初の受け取りの後、操作の無いこの時間の後に30日の手入れをする（DS の scheduleMaintain と同じ） */
export const MAINTAIN_IDLE_MS = 30_000

let engine: SyncEngine | null = null
/** エンジンの世代（止めた・始め直したら、前のエンジンの知らせは使わない） */
let generation = 0
let releaseLeader: (() => void) | null = null
let statusChannel: BroadcastChannel | null = null
let maintainTimer: ReturnType<typeof setTimeout> | null = null
/** 30日の手入れを済ませた日（日本時間。その日はもう手入れを頼まない。エンジンの中でも _meta の lastMaintainDay で1日1回にする） */
let maintainedDay: string | null = null
/** 次の日本時間の 0時に、端末の中の30日の外を消すタイマー */
let dayTimer: ReturnType<typeof setTimeout> | null = null

/**
 * エンジンが端末の中のデータを読み書きする口（src/sync/engine.ts の SyncTarget）。保存先（src/db/persistence.ts）をそのまま使い、
 * 反映・期限で消す・写しを消す時だけ、ストア（src/store/appStore.ts）を通してメモリの3層と版の一覧にも当てる
 */
function storeTarget(p: Persistence): SyncTarget {
  return {
    readOutbox: (n) => p.readOutbox(n),
    completeUpload: (sent) => p.completeUpload(sent),
    markUnconfirmed: (rows, tx) => p.markUnconfirmed(rows, tx),
    unconfirmedTx: (keys) => p.unconfirmedTx(keys),
    confirmLanded: (tx) => p.confirmLanded(tx),
    applyRemote: (changes, opts) => applyRemoteChanges(changes, opts),
    outboxCount: () => p.outboxCount(),
    outboxKeys: () => p.outboxKeys(),
    markAllDirty: async () => {
      await p.markAllDirty()
      // Claude の記録の写しを消したので、版の一覧を読み直す
      await reloadFromDisk()
    },
    expireBefore: (firstKeptDate) => expireLocalRecords(firstKeptDate),
    getMeta: (k) => p.getMeta(k),
    setMeta: (k, v) => p.setMeta(k, v),
    flush: () => flushNow(),
  }
}

/** 送るトランザクションの印に使う端末の ID（_meta の deviceId。無ければ作る） */
async function deviceId(p: Persistence): Promise<string> {
  const stored = await p.getMeta<string>('deviceId')
  if (typeof stored === 'string' && stored) return stored
  const c = globalThis.crypto
  const id =
    c && typeof c.randomUUID === 'function'
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  await p.setMeta('deviceId', id)
  return id
}

/** 画面どうしの知らせ（topic-studio-sync-status）。model はその画面のデータの形の版 */
export interface TabMessage {
  status?: SyncStatus
  request?: boolean
  model?: number
}

/** ほかの画面からの知らせ（同期の状態・状態を知らせてほしい・データの形の版） */
export function onTabMessage(data: TabMessage | null | undefined): void {
  // 新しいデータの形の版の画面が開かれた: 受け持ちを譲る（この画面は古い版のまま送らない）
  if (typeof data?.model === 'number' && data.model > DATA_MODEL) {
    yieldToNewerTab()
    return
  }
  const { leader, status } = useSync.getState()
  if (data?.request) {
    if (leader && status) publishStatus(status)
    return
  }
  if (!leader && data?.status) useSync.setState({ status: data.status })
}

function publishStatus(status: SyncStatus): void {
  try {
    statusChannel?.postMessage({ status, model: DATA_MODEL } satisfies TabMessage)
  } catch {
    /* noop */
  }
}

/** 新しいデータの形の版の画面に、同期の受け持ちを譲った（この画面では、読み込み直すまで同期を始めない） */
let yieldedToNewer = false

/** 新しいデータの形の版の画面が開かれた時（その画面の知らせで気付く） */
function yieldToNewerTab(): void {
  if (yieldedToNewer) return
  yieldedToNewer = true
  stopEngine()
  // 「版」だけだと 12:00版・20:00版と紛れるので「アプリの」を付ける（14.6）
  notify('アプリの新しい版が別の画面で開かれました。この画面を読み込み直してください。')
}

/** 受け持ちを待っている間の、データの形の版の見張り（クラウドの版が低ければ上げる） */
let modelWatch: (() => void) | null = null

function stopModelWatch(): void {
  modelWatch?.()
  modelWatch = null
}

/**
 * 同期を受け持っていない画面も、クラウドのデータの形の版が自分より低ければ上げる（受け持つ画面が古い版のままでも、そのエンジンが
 * 新しい版のデータに気付いて送るのをやめるように）。受け持ちを得たら、エンジンが見張りを引き継ぐ（DS と同じ）
 */
async function startModelWatch(uid: string, token: number): Promise<void> {
  const [model, store] = await Promise.all([appModelModule(), firestoreModule()])
  if (token !== generation || engine || modelWatch) return
  modelWatch = model.watchAppModel(store.firestore(), uid, { model: model.DATA_MODEL, appVersion: model.APP_VERSION }, () => {
    /* 受け持たない画面は送らないので、状態は使わない */
  })
}

function clearTimers(): void {
  if (maintainTimer) clearTimeout(maintainTimer)
  maintainTimer = null
  if (dayTimer) clearTimeout(dayTimer)
  dayTimer = null
}

function stopEngine(): void {
  generation += 1
  stopModelWatch()
  engine?.stop()
  engine = null
  clearTimers()
  setTopicFetcher(null)
  noteSyncDownloaded(false)
  releaseLeader?.()
  releaseLeader = null
  const s = useSync.getState()
  if (s.leader || s.status) useSync.setState({ leader: false, status: null })
}

/** 1日1回の30日の手入れを、操作の無い 30秒の後に頼む（その日にもう済ませていれば頼まない） */
function scheduleMaintain(): void {
  if (maintainTimer) clearTimeout(maintainTimer)
  maintainTimer = null
  if (!engine || !useSync.getState().leader || maintainedDay === jstDateOf(Date.now())) return
  maintainTimer = setTimeout(() => {
    maintainTimer = null
    void runMaintain()
  }, MAINTAIN_IDLE_MS)
}

async function runMaintain(): Promise<void> {
  const e = engine
  if (!e || e.status.phase !== 'synced') return
  try {
    const r = await e.maintain()
    // 消した・今日はもう済んでいた: 今日は頼まない（最初の受け取りの前・サーバーの時刻の見積もりが無い時は、次にそろった時に頼み直す）
    if (r.skipped === null || r.skipped === 'done-today') maintainedDay = jstDateOf(Date.now())
  } catch (err) {
    console.warn('30日を過ぎた記録をクラウドから消せませんでした', err)
  }
}

/** 次の日本時間の 0時（の1秒後）までの長さ */
function msUntilNextJstDay(now: number): number {
  return jstStartOfDayMs(addDaysToDate(jstDateOf(now), 1)) - now + 1000
}

/**
 * 日付（日本時間）が変わった時に、端末の中の30日の外を消し、その日の30日の手入れを頼む（docs/SPEC.md の 7.8 の「端末の中で消す」）。
 * 裏にある間はタイマーが遅れるので、表に戻った時にも確かめる（noteAppVisible）
 */
function scheduleDayChange(): void {
  if (dayTimer) clearTimeout(dayTimer)
  dayTimer = setTimeout(() => {
    dayTimer = null
    onDayMaybeChanged()
    if (engine) scheduleDayChange()
  }, msUntilNextJstDay(Date.now()))
}

function onDayMaybeChanged(): void {
  const e = engine
  if (!e) return
  // エンジンが同じ日の2回目は何もしない
  void e.expireLocal().catch((err: unknown) => console.warn('端末の中の30日を過ぎた記録を消せませんでした', err))
  if (e.status.phase === 'synced' && !maintainTimer) scheduleMaintain()
}

/** エンジンの状態が変わった時 */
function onEngineStatus(e: SyncEngine, status: SyncStatus): void {
  if (engine !== e) return
  useSync.setState({ status })
  publishStatus(status)
  noteSyncDownloaded(status.downloaded === true)
  if (status.errorCode === 'owner-mismatch') {
    // 使っている間に、ほかのアカウントが持ち主だと分かった: 同期を止め、データを見えなくする（エンジンが ownerSeen を消している）
    useSync.setState({ owner: 'mismatch', ownerSeen: false })
    stopEngine()
    return
  }
  if (status.errorCode === 'owner-missing') useSync.setState({ owner: 'missing' })
  else if (
    !status.errorCode &&
    (status.phase === 'downloading' || status.phase === 'uploading' || status.phase === 'synced') &&
    useSync.getState().owner === 'missing'
  ) {
    // 同期を始め直して、エンジンが持ち主を確かめられた（記録が作られた）: 同期の表示の「持ち主の記録がまだありません」を消す
    useSync.setState({ owner: 'ok' })
  }
  if (status.phase === 'synced' && !maintainTimer) scheduleMaintain()
}

/** 同期のエンジンを始める（同期を受け持つ画面だけ。ほかの画面が受け持っている間は、受け持ちが空くのを待つ） */
function startEngine(uid: string): void {
  stopEngine()
  if (yieldedToNewer || faked) return
  const token = generation
  const run = async () => {
    if (token !== generation) return
    stopModelWatch()
    const [{ createSyncEngine }, fb, store, model] = await Promise.all([
      engineModule(),
      firebaseModule(),
      firestoreModule(),
      appModelModule(),
    ])
    if (token !== generation) return
    const p = getPersistence()
    if (!p) throw new Error('保存先が初期化されていません')
    const id = await deviceId(p)
    if (token !== generation) return
    const e: SyncEngine = createSyncEngine({
      firestore: store.firestore(),
      uid,
      deviceId: id,
      target: storeTarget(p),
      // エミュレーターにつないだ開発サーバーでは、持ち主の記録を確かめない（エミュレーターには config/owner が無い。
      // E2E の持ち主の関所の確かめの時は確かめる。skipsOwnerCheck）
      ownerLock: !skipsOwnerCheck(fb),
      appModel: { model: model.DATA_MODEL, appVersion: model.APP_VERSION },
      onStatus: (status) => onEngineStatus(e, status),
    })
    engine = e
    // 最初の受け取りが終わっても話題の欠けた版は、欠けた話題を直接読む（ストアが頼む。docs/SPEC.md の 7.8 の「版を出す条件」）
    setTopicFetcher((ids) => e.fetchTopics(ids))
    useSync.setState({ leader: true, status: e.status })
    scheduleDayChange()
    await e.start()
  }
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (locks?.request) {
    const released = new Promise<void>((resolve) => {
      releaseLeader = resolve
    })
    // 受け持ちを待っている間も、データの形の版だけは見張る（上の startModelWatch）
    void startModelWatch(uid, token).catch((e: unknown) => console.warn('データの形の版を見張れませんでした', e))
    void locks
      .request(LEADER_LOCK, async () => {
        await run().catch(reportError)
        await released
      })
      .catch(reportError)
  } else {
    void run().catch(reportError)
  }
}

/** 持ち主の記録が無くて止まった同期を、記録が戻ったと分かった時に始め直す（エンジンがもう一度確かめる） */
function restartIfOwnerStopped(user: SyncUser): void {
  const s = useSync.getState()
  if (s.leader && s.status?.errorCode === 'owner-missing' && !s.accountMismatch) startEngine(user.uid)
}

// ---------- 持ち主の関所（docs/SPEC.md の 14.4。段階0のまま） ----------

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

/** この端末で前に別のアカウントと同期していた時の、そのアカウント（_meta の uid・uidEmail。同じアカウント・初めての端末なら null） */
async function previousAccount(uid: string): Promise<{ previousEmail: string } | null> {
  try {
    const p = getPersistence()
    const previous = await p?.getMeta<string>('uid')
    if (typeof previous !== 'string' || !previous || previous === uid) return null
    const email = await p?.getMeta<string>('uidEmail')
    return { previousEmail: typeof email === 'string' ? email : '' }
  } catch (e) {
    console.warn('この端末で前に同期したアカウントを読めませんでした', e)
    return null
  }
}

/** 同期を始める（前に別のアカウントと同期していないと分かった後。最後に同期したアカウントのメールのアドレスを覚える） */
async function beginSync(user: SyncUser, token: number): Promise<void> {
  try {
    await getPersistence()?.setMeta('uidEmail', user.email)
  } catch (e) {
    console.warn('同期するアカウントを覚えられませんでした', e)
  }
  if (token !== ownerToken) return
  startEngine(user.uid)
}

/**
 * 持ち主だと分かった後: 前に別のアカウントで使っていたら確かめ（同期を始めず、ログインの画面に確かめの文）、そうでなければ同期を始める。
 * トップの画面を出してよいことは、前に別のアカウントで使っていたかを読んでから1回で入れる（確かめる前に、トップが一瞬出ないように）
 */
async function ownerConfirmed(user: SyncUser, token: number): Promise<void> {
  const mismatch = await previousAccount(user.uid)
  if (token !== ownerToken) return
  useSync.setState({ owner: 'ok', ownerSeen: true, accountMismatch: mismatch })
  if (mismatch) stopEngine()
  else await beginSync(user, token)
}

/** ストアの知らせの受け取りを外す関数（ストアを作り直すテストでは、起動のたびに付け直す） */
let storeHooks: (() => void)[] | null = null

function installStoreHooks(): void {
  if (storeHooks) return
  storeHooks = [
    onLocalSave(() => {
      engine?.requestUpload()
      // 操作があった: 手入れは操作の無い 30秒の後に
      if (maintainTimer) scheduleMaintain()
    }),
    // 別のタブが端末に書いた（送信待ちに積んだ）: 受け持つ画面が送る
    onExternalSave(() => engine?.requestUpload()),
  ]
}

function installHooks(): void {
  installStoreHooks()
  if (hooksInstalled) return
  hooksInstalled = true
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') noteAppHidden()
      else noteAppVisible()
    })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => retryOwnerCheck())
    // PC で Firebase の画面とアプリを別の窓で並べている時は、画面が裏に回らないので、窓を選んだ時にも確かめ直す
    window.addEventListener('focus', () => void recheckOwner())
  }
  try {
    statusChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(STATUS_CHANNEL)
    if (statusChannel) {
      statusChannel.onmessage = (ev: MessageEvent<TabMessage>) => onTabMessage(ev.data)
      statusChannel.postMessage({ request: true, model: DATA_MODEL } satisfies TabMessage)
    }
  } catch {
    statusChannel = null
  }
}

/** 画面が裏に回った時刻（表に戻ったら 0） */
let hiddenAt = 0

/** 画面を閉じる・裏に回る時。待たずに送る */
export function noteAppHidden(): void {
  if (!hiddenAt) hiddenAt = Date.now()
  engine?.requestUpload(true)
}

/**
 * 画面が表に戻った時。長く裏にあったら購読し直し、日付が変わっていたら端末の中の30日の外を消す。持ち主の記録が無かった時などは
 * 確かめ直す
 */
export function noteAppVisible(): void {
  const since = hiddenAt
  hiddenAt = 0
  if (since && Date.now() - since > REANCHOR_AFTER_MS) engine?.reanchor()
  onDayMaybeChanged()
  void recheckOwner()
}

/** 待たずに送る（画面を離れる前の保存の後。src/store/lifecycle.ts の saveBeforeLeave） */
export function uploadNow(): void {
  engine?.requestUpload(true)
}

/** いますぐ送る（送り終わるか失敗するまで待つ。同期を受け持たない画面では何もしない） */
export function syncNow(): Promise<void> {
  return engine ? engine.flush() : Promise.resolve()
}

/** 持ち主を確かめ直す（通信できなかった時・つながった時） */
function retryOwnerCheck(): void {
  const { auth, user, owner } = useSync.getState()
  if (faked || auth !== 'signedIn' || !user) return
  if (owner === 'checking' || owner === 'unknown') void verifyOwner(user)
  else void recheckOwner()
}

/**
 * この端末で確かめたアカウント: トップの画面は出したまま、クラウドの記録と照らし合わせる（段階0のまま。エンジンも始める時に確かめる）。
 * ほかのアカウントの記録になっていたら、同期を止め、覚えた印を消してログインの画面に戻す。記録が無い（消された）時は、トップの画面の
 * まま（同期はエンジンが止める）。記録が戻っていたら、止まっていた同期を始め直す。通信できない時は、次に表に戻った・窓を選んだ・
 * つながった時に照らし合わせる
 */
async function confirmSeenOwner(user: SyncUser, token: number): Promise<void> {
  try {
    const state = await checkNow(user.uid)
    if (token !== ownerToken) return
    seenUnconfirmed = false
    if (state === 'mismatch') {
      stopEngine()
      await rememberOwner(null)
      if (token === ownerToken) useSync.setState({ owner: 'mismatch', ownerSeen: false })
      return
    }
    if (state !== useSync.getState().owner) useSync.setState({ owner: state })
    if (state === 'ok') restartIfOwnerStopped(user)
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
      await ownerConfirmed(user, token)
    } else if (state !== useSync.getState().owner) useSync.setState({ owner: state })
  } catch (e) {
    // 通信できない: 今の文のまま（次に表に戻った・つながった時に確かめ直す）
    console.warn('持ち主を確かめ直せませんでした', e)
  } finally {
    rechecking = false
  }
}

/**
 * ログインしたアカウントが持ち主か確かめてから、同期を始める。この端末で前に持ち主だと確かめたアカウントなら、すぐにトップの画面を出して
 * 同期を始め、裏でクラウドの記録と照らし合わせる
 */
async function verifyOwner(user: SyncUser): Promise<void> {
  const token = ++ownerToken
  clearOwnerRetry()
  const fb = await firebaseModule()
  if (token !== ownerToken) return
  if (skipsOwnerCheck(fb)) {
    // エミュレーターにつないだ開発サーバー: 確かめず、印も覚えない
    await ownerConfirmed(user, token)
    return
  }
  const seen = await readSeen(user.uid)
  if (token !== ownerToken) return
  if (seen) {
    seenUnconfirmed = true
    await ownerConfirmed(user, token)
    if (token !== ownerToken) return
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
      await ownerConfirmed(user, token)
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
  console.warn('同期を始められませんでした', e)
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
            // 一緒に入れる）。前に別のアカウントで使っていた端末なら、その確かめも一緒に入れる（トップが一瞬出ないように）
            const seen = skipsOwnerCheck(fb) || (await readSeen(u.uid))
            const mismatch = seen ? await previousAccount(u.uid) : null
            if (token !== ownerToken || faked) return
            useSync.setState({
              auth: 'signedIn',
              user: u,
              error: null,
              owner: seen ? 'ok' : 'checking',
              ownerSeen: seen,
              accountMismatch: mismatch,
            })
            await verifyOwner(u)
          })().catch(reportError)
        } else {
          ownerToken += 1
          clearOwnerRetry()
          seenUnconfirmed = false
          stopEngine()
          useSync.setState({ auth: 'signedOut', user: null, owner: 'unknown', ownerSeen: false, accountMismatch: null })
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

/**
 * この端末を、いまログインしているアカウントと同期するようにする（以前は別のアカウントと同期していた時。ログインの画面の
 * ［このアカウントで同期する］）。エンジンが、アプリの記録を共通の履歴が無い送信待ちにし、Claude の記録の写しを消して受け取り直す
 * （persistence の markAllDirty。docs/SPEC.md の 7.8）
 */
export async function confirmAccountSwitch(): Promise<void> {
  const user = useSync.getState().user
  const p = getPersistence()
  if (!user || !p) return
  await p.setMeta('uidEmail', user.email)
  useSync.setState({ accountMismatch: null })
  startEngine(user.uid)
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

/** ［ログアウト］（ログインの画面に戻る。この端末で確かめた持ち主の印と、端末の中のデータは消さない。同じアカウントで入り直せばすぐにトップ） */
export async function signOut(): Promise<void> {
  useSync.setState({ busy: true, error: null })
  try {
    if (faked) {
      faked = false
      useSync.setState({ auth: 'signedOut', user: null, owner: 'unknown', ownerSeen: false, accountMismatch: null })
      return
    }
    // 送れるものは送ってからログアウトする（送れなくても端末の中には残り、次にログインした時に送る）
    await engine?.flush().catch(() => undefined)
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
 * （エミュレーターの無い E2E で、トップ画面・設定の画面を開くため。持ち主も確かめた扱い。同期は始めない）
 */
export function fakeSignInForTest(user: SyncUser = { uid: 'test-user', name: 'テスト', email: 'test@example.com' }): void {
  if (!import.meta.env.DEV) throw new Error('開発サーバーだけで使えます')
  faked = true
  ownerToken += 1
  clearOwnerRetry()
  stopEngine()
  useSync.setState({ auth: 'signedIn', user, owner: 'ok', ownerSeen: true, accountMismatch: null, error: null })
}

/** テスト用 */
export function resetSyncForTests(): void {
  stopEngine()
  for (const off of storeHooks ?? []) off()
  storeHooks = null
  booted = null
  faked = false
  yieldedToNewer = false
  hiddenAt = 0
  maintainedDay = null
  ownerToken += 1
  clearOwnerRetry()
  rechecking = false
  seenUnconfirmed = false
  useSync.setState({ ...initial })
}
