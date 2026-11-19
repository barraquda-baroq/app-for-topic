// クラウド（Firestore）との送受信（docs/SPEC.md の 7.8）。DS の src/sync/engine.ts（DS は NS の物から）を手本にし、TS の形（7.7・7.8）に直した。
// - 受け取る: 2つの置き場（Claude が読める records と、読めない private）を、置き場ごとの「前回受け取った時刻以上に書かれた物」でリアルタイムに
//   購読し、届いた変更を反映する（自分の書いた古い版の知らせは捨て、removed は無視する。DS と同じ）。records は表を並べて購読する
//   （辞書の束を受け取らない）。受け取った位置は置き場ごとに、反映と同じ端末のトランザクションで書く（_meta の cursor）
// - 初めての受け取りは2段（7.8 の「版と話題を受け取る」）: 1.「知ってる」を全部（位置があればその位置から）読む → 2. records を端末の時計
//   − 32日から購読する（30日より前の版・話題を読まない）。入るかは最後にクラウドとそろった時刻（caughtUpAt）で決め、1. を終えた印
//   （_meta の firstSync）があれば、2. を再試行する時に 1. を読み直さない。private も位置が無ければ − 32日から
// - 送る: 端末の送信待ち（_outbox。アプリの記録 = 知ってる・既読だけ）を、クラウドが前にそろえた時から変わっていない事を確かめながら
//   （トランザクション）書く。変わっていたら書かずに、受け取りで base が新しくなる（3者マージされる）のを待ってから送り直す。返事を
//   受け取れなかった書き込みは、送る書き込みの印（users/{uid}/sync/{端末の ID}）で確かめる（DS と同じ）。削除の印は決して書かない
//   （local が null の行・30日の外の既読は書かずに送り終わり。クラウドで消えていた既読は作り直さない）
// - 30日の手入れ（7.8 の「30日で消す」）: 1日1回、文書の id の範囲で30日の外の版・話題・訂正・作れなかった印・既読を引き、まとめて消す
//   （450件ずつ・1台1日 2,000件まで）。境はサーバーの時刻の見積もり（時計の進んだ端末が早く消さない）。削除の印は書かない
// - 端末の中で消す（7.8 の「端末の中で消す」）: 始めた時と日付が変わった時に、端末の時計で30日の外の行を persistence の expireBefore で消す
//   （送信待ちの行も一緒に消し、送信待ちには積まない）。受け取った物のうち端末の時計で30日の外の物は、反映の前に落とす
// - 持ち主（7.8 の「持ち主」）: config/owner が無い → owner-missing、違う → owner-mismatch で同期しない（SyncError）
// - データの形の版（src/sync/appModel.ts）: クラウドの版が高ければ、受け取りは続け、送るのを止める（status.outdated）
// 送受信は exclusive で1つずつ行い、送った結果を記録する前に自分の書いた変更を受け取ることがないようにする（DS と同じ）。
// DS から外した物（docs/SPEC.md の 16.5）: 分けた文書・月の束・受け取り箱・ゴミ箱・削除の印の片付け・85日の受け取り直し・復元・
// Claude との連携の記録の読み取り（連携の記録 config/connector は、画面の部品が読む。src/features/claude/connectorDoc.ts）。
// 受け取りと送るの細かい決まり（購読する表・始める位置・30日の境・送る前の守り）は src/sync/syncPlan.ts にあり、偽のクラウド
// （src/test/fakeCloud.ts）も同じ物を使う。
// エンジンは画面・ストアに頼らずに単体で動く（端末の口は SyncTarget。src/db/persistence.ts の Persistence をそのまま渡せる）。
// 起動・タブの受け持ち・1日1回の手入れの呼び出しは src/sync/controller.ts（16.2 の 6）がする。
import {
  Timestamp,
  collection,
  doc,
  documentId,
  getDoc,
  getDocFromServer,
  getDocsFromServer,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
  type Unsubscribe,
} from 'firebase/firestore'
import {
  outboxKey,
  type AnyRecord,
  type Change,
  type ExpireOutcome,
  type MetaPatch,
  type OutboxItem,
  type RemoteApplyOptions,
  type SentRow,
  type StoredCursors,
  type SyncCursor,
} from '../db/persistence'
import { estimateServerNow, expiryDocIdBefore, jstDateOf, nextClockSkew } from '../domain/jst'
import type { ExpiringTableName, Place, RecordDoc, TableName } from '../domain/types'
import { appModelRef, asModel, watchAppModel, type AppModel } from './appModel'
import {
  EXPIRE_BATCH_DOCS,
  EXPIRE_DAILY_DOCS,
  SEND_LIMITS,
  decideBatch,
  nothingToSend,
  sameAsBase,
  selectBatch,
  type BatchEntry,
  type CloudState,
} from './batch'
import { PLACES, docIdOf, hashRecord, placeOf, placePath, recordDocOf } from './codec'
import { checkOwner } from './owner'
import {
  CAUGHT_UP_SAVE_MS,
  EXPIRE_ORDER,
  MAX_TOPIC_FETCH,
  RECORDS_SUBSCRIBED_TABLES,
  SYNC_SCHEMA,
  asCursor,
  asFirstSync,
  expirableIds,
  expireRangeStart,
  firstSyncSince,
  goneFromCloud,
  laterCursor,
  localExpiryDate,
  msOfCursor,
  needsFirstSync,
  needsKnownRead,
  privateStart,
  remoteChangeOf,
  sendGuardTime,
  snapshotAdvance,
} from './syncPlan'
import { ACCOUNT_MISMATCH_MESSAGE, OWNER_MISMATCH_MESSAGE, OWNER_MISSING_MESSAGE } from './syncView'

export { RECORDS_SUBSCRIBED_TABLES, SYNC_SCHEMA, ACCOUNT_MISMATCH_MESSAGE, OWNER_MISMATCH_MESSAGE, OWNER_MISSING_MESSAGE }

/**
 * エンジンが端末の中のデータを読み書きする口（docs/SPEC.md の 7.8 の「部品」）。src/db/persistence.ts の Persistence がそのまま当てはまる。
 * アプリではストア（16.2 の 7）が包み、反映・期限で消した物をメモリの3層にも当てる
 */
export interface SyncTarget {
  readOutbox(limit: number): Promise<OutboxItem[]>
  completeUpload(sent: readonly Change[]): Promise<void>
  /**
   * 送るトランザクションで書く送信待ちに、書き込みを送る前に「返事を受け取るまで、クラウドが base のままか分からない」と印を付ける
   * （書き込みが届いたのに返事を受け取れないことがある）。tx = そのトランザクションの id、record = 送る内容
   */
  markUnconfirmed(rows: readonly SentRow[], tx: string): Promise<void>
  /** 印の付いた送信待ちのうち、keys の物のトランザクションの id */
  unconfirmedTx(keys: readonly string[]): Promise<Set<string>>
  /** トランザクション tx の書き込みは届いていた: その印の付いた送信待ちを、送った返事を受け取った時と同じにする */
  confirmLanded(tx: string): Promise<void>
  /** クラウドの変更を反映する。位置（置き場ごと）と _meta は同じトランザクションで書く */
  applyRemote(changes: readonly Change[], opts?: RemoteApplyOptions): Promise<Change[]>
  outboxCount(): Promise<number>
  outboxKeys(): Promise<Set<string>>
  /** 別のアカウントで使っていた端末・初めて同期する端末: アプリの記録を共通の履歴が無い送信待ちにし、Claude の記録の写しと位置を消す */
  markAllDirty(): Promise<void>
  /** 端末の時計で30日の外の行と、同じ鍵の送信待ちを消す（送信待ちに積まない。7.8 の「端末の中で消す」） */
  expireBefore(firstKeptDate: string): Promise<ExpireOutcome>
  getMeta<T>(key: string): Promise<T | undefined>
  setMeta(key: string, value: unknown): Promise<void>
  /** 端末にまだ書いていない変更を書く（送る前に呼ぶ。ストアが持つ） */
  flush?(): Promise<unknown>
}

export type SyncPhase = 'starting' | 'downloading' | 'uploading' | 'synced' | 'offline' | 'error'

/** 同期の状態（画面の同期の表示は src/sync/syncView.ts が、この状態から8つの表示を決める。16.2 の 6） */
export interface SyncStatus {
  phase: SyncPhase
  /** 送信待ちの件数 */
  pending: number
  /** 最後にクラウドとそろった時刻（端末の時計） */
  lastSyncedAt: number | null
  error: string | null
  /**
   * 止まっている理由の種類（SyncError の code: owner-missing・owner-mismatch、Firestore の code、offline、quota = 無料枠を使い切った）
   */
  errorCode?: string | null
  /**
   * クラウドのデータが、このアプリより新しい版のアプリで書かれている（データの形の版。src/sync/appModel.ts）。
   * 受け取りは続け、送るのは止めている（この端末の変更は送信待ちに残る）
   */
  outdated?: AppModel | null
  /** 最初の受け取り（2つの置き場とも、初めての受け取りなら 2. まで）が終わった */
  downloaded?: boolean
}

export interface EngineOptions {
  firestore: Firestore
  uid: string
  deviceId: string
  target: SyncTarget
  onStatus?: (s: SyncStatus) => void
  /** 変更があってから送るまでの待ち時間（ms。既定 2秒）。続けて変更しても uploadMaxWait（既定 10秒）以内には送る */
  uploadDelay?: number
  uploadMaxWait?: number
  /** テスト用: 1回のトランザクションで書く量の上限（文字数・文書の数。既定は src/sync/batch.ts の SEND_LIMITS） */
  batchChars?: number
  batchDocs?: number
  /**
   * クラウドの持ち主（config/owner）がこのアカウントであることを確かめ、無い・違う時は同期しない（既定 true）。
   * アプリは持ち主の記録を作らない（作者が Firebase の画面で作る。形1）。アクセスルールも持ち主だけに読み書きを許す（firestore.rules）
   */
  ownerLock?: boolean
  /**
   * 前に別のアカウントで同期していた端末（_meta の uid が「あって、違う」）を、このアカウントと同期してよいと確かめた（ログインの画面の
   * ［このアカウントで同期する］）。無い時にそういう端末で始めると、markAllDirty せずに SyncError('account-mismatch') で止まる
   * （司令塔の確かめが読めずに開いた時の二重の守り。docs/SPEC.md の 7.8 の「既読・知ってるを送る・受け取る」）。uid の無い端末
   * （新しい端末・段階0からの上がり）は確かめずに始める
   */
  allowAccountSwitch?: boolean
  /**
   * このアプリのデータの形の版。クラウドに記録し（無い・低ければ上げる）、クラウドの版の方が高ければ送らない。
   * 渡さなければ確かめない（テスト用）
   */
  appModel?: AppModel
  /** テスト用: データの形の版を確かめるまで、送るのを待つ長さの上限（ms） */
  modelWait?: number
  /** テスト用: 端末の時計（初めての受け取りの位置・caughtUpAt・30日の境・サーバーの時刻の見積もり） */
  now?: () => number
}

/** 30日の手入れの結果（docs/SPEC.md の 7.8 の「30日で消す」） */
export interface MaintainResult {
  /** 消した文書の数（表 → 数） */
  deleted: Partial<Record<ExpiringTableName, number>>
  /** 消した文書の数の合計 */
  total: number
  /** 1台1日の上限（2,000件）に届いて、途中でやめた（続きは次の日） */
  capped: boolean
  /** しなかった理由: not-ready = 最初の受け取りの前・データの形の版を確かめる前、no-server-time = サーバーの時刻の見積もりが無い、done-today = 今日はもうした */
  skipped: 'not-ready' | 'no-server-time' | 'done-today' | null
}

/** 版の order の欠けた話題を直接読んだ結果 */
export interface TopicFetchResult {
  /** クラウドにあって、端末に入れた話題 */
  found: string[]
  /** クラウドにも無い話題（コネクタの不具合。画面はそろっている話題だけで版を出す。7.8 の「版を出す条件」） */
  missing: string[]
}

export interface SyncEngine {
  start(): Promise<void>
  stop(): void
  /** 送信待ちを送る（immediate なら待たずに） */
  requestUpload(immediate?: boolean): void
  /** いますぐ送る（送り終わるか失敗するまで待つ） */
  flush(): Promise<void>
  /**
   * 画面がしばらく裏にあった後などに、記録した位置から購読し直す（読み取りの量を抑える）。最後にクラウドとそろってから31日を過ぎて
   * いれば、初めての受け取りからやり直す
   */
  reanchor(): void
  /** 受信と送信がひと段落するまで待つ（テスト用） */
  idle(): Promise<void>
  /** 1日1回の30日の手入れ（クラウドから消す）。最初の受け取りの後だけ動く。now はテスト用（端末の時計を進める） */
  maintain(now?: number): Promise<MaintainResult>
  /** 端末の中の30日の外の行を消す（日付が変わった時に画面から呼ぶ。同じ日に2回目は何もしない。force なら必ず） */
  expireLocal(force?: boolean): Promise<ExpireOutcome | null>
  /**
   * 版の order の話題のうち端末に無い物を、クラウドから直接読んで端末に入れる（最初の受け取りが終わっても欠けている時。多くて30件。
   * 7.8 の「版を出す条件」）
   */
  fetchTopics(ids: readonly string[]): Promise<TopicFetchResult>
  /**
   * サーバーの時刻の見積もり（ms。端末の時計から、届いた文書の更新時刻との差のいちばん小さい値を引いた時刻。本当のサーバーの時刻より
   * 後にならない）。まだ文書が届いていなければ null
   */
  serverNow(): number | null
  readonly status: SyncStatus
}

/** クラウドの持ち主を記録する文書（src/sync/owner.ts。作者が Firebase の画面で作る。アプリは読むだけ。形1） */
export { OWNER_DOC } from './owner'

/**
 * 送る書き込みの印（users/{uid}/sync/{端末の ID}。`{ tx }`）: その端末の送るトランザクションが毎回読み、記録を書く時は、そのトランザクションの
 * id を書く。返事を受け取れなかった時に、書き込みが届いたかをこれで確かめる（DS と同じ。ルールは firestore.rules の sync/{deviceId}）
 */
export const SENT_MARKS = 'sync'

/** 1回に読む送信待ちの数 */
const BATCH_RECORDS = 100
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000]
/** データの形の版を確かめるまで、送るのを待つ長さの上限（いますぐ同期・ログアウトの前の送信） */
const MODEL_WAIT_MS = 10_000
const OFFLINE_MESSAGE = 'オフラインです。つながると自動で同期します。'
/** 送る途中で、データの形の版を確かめられなくなった・新しい版で書かれていると分かった（何も書かない） */
const MODEL_PAUSED = new Error('データの形の版を確かめるまで送りません')
/** この端末が送った版の指紋を、文書ごとにいくつまで覚えておくか */
const SENT_MEMORY = 20

const noop = () => undefined

/** 文書の更新時刻（サーバーの時刻。まだ付いていなければ null） */
const timeOf = (data: { updated?: unknown }): SyncCursor | null =>
  data.updated instanceof Timestamp ? { s: data.updated.seconds, n: data.updated.nanoseconds } : null

const timestampOf = (c: SyncCursor): Timestamp => new Timestamp(c.s, c.n)

/** 送るトランザクションの id（送る書き込みの印に書く。ルールで 1〜64字） */
function newTxId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

export class SyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

function errorCode(e: unknown): string {
  return typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
}

function describeError(e: unknown): { offline: boolean; message: string; code: string } {
  const code = errorCode(e)
  if (e instanceof SyncError) return { offline: false, message: e.message, code: e.code }
  if (code === 'unavailable' || code === 'deadline-exceeded' || (typeof navigator !== 'undefined' && navigator.onLine === false))
    return { offline: true, message: OFFLINE_MESSAGE, code: 'offline' }
  if (code === 'permission-denied')
    return {
      offline: false,
      code,
      message:
        'クラウドへのアクセスが拒否されました。アクセスルールを公開したか（docs/DEPLOY.md）、持ち主のアカウントでログインしているかを確かめてください。',
    }
  if (code === 'failed-precondition')
    return {
      offline: false,
      code,
      message: 'クラウドの索引がまだありません。索引を公開したか（docs/DEPLOY.md）を確かめてください。',
    }
  if (code === 'resource-exhausted')
    return { offline: false, code: 'quota', message: 'クラウドの今日の無料枠を使い切りました。無料枠が戻ると同期を再開します。' }
  if (code === 'unauthenticated')
    return { offline: false, code, message: 'ログインの期限が切れました。ログインし直してください。' }
  return { offline: false, code, message: e instanceof Error ? e.message : String(e) }
}

/** 置き場ごとの購読の状態 */
interface Listener {
  readonly place: Place
  readonly col: CollectionReference
  /** 受け取った位置（_meta の cursor のこの置き場） */
  cursor: SyncCursor | null
  /** いまの購読を始めた位置（購読し直すと、それまでに届いた分を読み直さずに済む） */
  subscribedFrom: SyncCursor | null
  unsub: Unsubscribe | null
  /** 購読の世代（購読し直したら、前の購読の通知は使わない） */
  gen: number
  retryTimer: ReturnType<typeof setTimeout> | null
  retryCount: number
  /** この置き場の購読で、サーバーからの知らせを受け取った */
  synced: boolean
  /**
   * 購読が誤りで止まった時の状態。購読がサーバーからの通知を受け取り直すまで、送る物の無い送信が終わっても「同期済み」に
   * 戻さない（購読が止まっている間に、同期済みと出さないように。DS の listenFailure）
   */
  failure: Pick<SyncStatus, 'phase' | 'error' | 'errorCode'> | null
}

export function createSyncEngine(opts: EngineOptions): SyncEngine {
  const { firestore: fs, uid, deviceId, target } = opts
  const uploadDelay = opts.uploadDelay ?? 2000
  const uploadMaxWait = opts.uploadMaxWait ?? 10_000
  const modelWait = opts.modelWait ?? MODEL_WAIT_MS
  const limits = { maxChars: opts.batchChars ?? SEND_LIMITS.maxChars, maxDocs: opts.batchDocs ?? SEND_LIMITS.maxDocs }
  const clock = opts.now ?? (() => Date.now())
  const markRef = doc(fs, 'users', uid, SENT_MARKS, deviceId)
  const listenerOf = (place: Place): Listener => ({
    place,
    col: collection(fs, ...placePath(uid, place)),
    cursor: null,
    subscribedFrom: null,
    unsub: null,
    gen: 0,
    retryTimer: null,
    retryCount: 0,
    synced: false,
    failure: null,
  })
  const listeners: Readonly<Record<Place, Listener>> = { records: listenerOf('records'), private: listenerOf('private') }
  const all = () => PLACES.map((p) => listeners[p])
  /** 記録の文書の道（置き場は表で決める。既読は必ず private。src/sync/codec.ts の placeOf） */
  const docRefOf = (table: TableName, id: string): DocumentReference => doc(listeners[placeOf(table)].col, docIdOf(table, id))

  let stopped = false
  let begun = false
  /** 最初の受け取りが終わった（2つの置き場とも。初めての受け取りなら 2. まで） */
  let downloaded = false
  /**
   * 初めての受け取りの途中（1. を始めてから、2. の records の購読の最初のサーバーの知らせを反映するまで）。firstSince = 2. の購読を
   * 始めた位置（端末の時計 − 32日）
   */
  let firstPending = false
  let firstSince: SyncCursor | null = null
  /**
   * この端末が最後にクラウドとそろった時刻（records の購読でサーバーからの通知を受け取った時の、端末の時計。_meta の caughtUpAt）。
   * 初めての受け取りに入るかはこれで決める（src/sync/syncPlan.ts の needsFirstSync）
   */
  let caughtUpAt: number | null = null
  /** _meta に書いた caughtUpAt（書くのは 1時間に1回まで） */
  let caughtUpSaved: number | null = null
  /** 端末の中で最後に30日の外を消した日（日本時間。端末の時計） */
  let localExpiredDay: string | null = null
  let status: SyncStatus = { phase: 'starting', pending: 0, lastSyncedAt: null, error: null }
  /**
   * この端末の時計（clock）と、サーバーの時刻の差の見積もり（ms。端末の時計 − 届いた文書の更新時刻 の最小。まだ届いていなければ null）。
   * 30日の手入れの境・送る前の守りに使う（src/domain/jst.ts の nextClockSkew・estimateServerNow）
   */
  let clockSkew: number | null = null
  function noteServerTime(at: SyncCursor, now: number): void {
    clockSkew = nextClockSkew(clockSkew, now, msOfCursor(at))
  }
  const serverNow = () => estimateServerNow(clock(), clockSkew)
  /** この端末が送った版の指紋（文書ごと、古い順。鍵は '{置き場}/{文書の id}'） */
  const sent = new Map<string, string[]>()
  /**
   * 送る書き込みの印（markRef）で最後に確かめた値（その id の書き込みの送信待ちは、もう送り終わりにした）。違う値を読んだら、
   * 返事を受け取れなかった書き込みが届いていた（confirmLanded）
   */
  let lastLanded: string | null = null
  /** 持ち主の確認が済んだ（ownerLock の時） */
  let ownerOk = opts.ownerLock === false
  /**
   * データの形の版: unknown = まだサーバーから確かめていない（オフラインになって、確かめ直すまでも）、
   * newer = 新しい版のアプリで書かれている（どちらも送らない）
   */
  let modelState: 'unknown' | 'ok' | 'newer' = opts.appModel ? 'unknown' : 'ok'
  /**
   * 一度サーバーで確かめた後にオフラインになり、記録の見張りがまだサーバーと揃い直していない（unknown の間）。
   * その間は待たずに、送るトランザクションの中で記録を読んで確かめる
   */
  let modelRecheck = false
  /** 同期をやめた・新しい版のアプリで書かれたデータに気付いた（送るのをやめる） */
  const sendPaused = () => stopped || modelState === 'newer'
  let modelUnsub: Unsubscribe | null = null
  /** データの形の版を確かめた（または同期をやめた）。オフラインになると、確かめ直すまでの新しい約束にする */
  let modelKnown: () => void = () => undefined
  let modelReady = new Promise<void>((resolve) => (modelKnown = resolve))

  // 送受信を1つずつ行うための鎖
  let lock: Promise<unknown> = Promise.resolve()
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn)
    lock = run.catch(() => undefined)
    return run
  }

  function setStatus(patch: Partial<SyncStatus>): void {
    status = { ...status, ...patch }
    opts.onStatus?.(status)
  }

  async function refreshPending(): Promise<number> {
    const pending = await target.outboxCount()
    setStatus({ pending })
    return pending
  }

  function fail(e: unknown): void {
    if (stopped) return
    const d = describeError(e)
    if (!d.offline) console.warn('同期できませんでした', e)
    setStatus({ phase: d.offline ? 'offline' : 'error', error: d.message, errorCode: d.code })
  }

  function listenFail(l: Listener, e: unknown): void {
    if (stopped) return
    fail(e)
    l.failure = { phase: status.phase, error: status.error, errorCode: status.errorCode }
  }

  /** 購読の止まっている置き場の誤り（無ければ null） */
  const listenFailure = () => all().find((l) => l.failure)?.failure ?? null

  function rememberSent(key: string, hash: string): void {
    const list = sent.get(key) ?? []
    list.push(hash)
    if (list.length > SENT_MEMORY) list.splice(0, list.length - SENT_MEMORY)
    sent.set(key, list)
  }

  /**
   * この端末が書いて置き換えたクラウドの版（文書ごと、その版の更新時刻）。購読の通知は、書く前のクラウドの内容のまま、書いた後に
   * 届くことがある。その古い版で、送ったばかりの内容を戻さないように（時刻で見分ける。DS と同じ）
   */
  const replaced = new Map<string, SyncCursor>()

  /** 送る前のクラウドの版の通知か（この端末が書いて置き換えた版か、それより前の版） */
  function isSuperseded(key: string, data: { updated?: unknown }): boolean {
    const old = replaced.get(key)
    if (!old) return false
    const at = timeOf(data)
    if (at && !laterCursor(at, old)) return true
    replaced.delete(key)
    return false
  }

  /** この端末が先に送った古い版の通知か（その後にもっと新しい版を送っている。DS と同じ） */
  function isStaleEcho(key: string, data: { device?: unknown; hash?: unknown }): boolean {
    if (data.device !== deviceId || typeof data.hash !== 'string') return false
    const list = sent.get(key)
    if (!list || !list.includes(data.hash)) return false
    if (list[list.length - 1] === data.hash) {
      sent.set(key, [data.hash])
      return false
    }
    // 届いた版より前に送った指紋は、もう届かない
    sent.set(key, list.slice(list.lastIndexOf(data.hash) + 1))
    return true
  }

  // ---------- 端末の中で消す（docs/SPEC.md の 7.8 の「端末の中で消す」） ----------

  /** 端末の時計で30日の外の行を消す（日本時間の日付が変わった時だけ。force なら必ず）。消せなくても同期は止めない */
  async function expireLocalNow(force = false): Promise<ExpireOutcome | null> {
    const now = clock()
    const day = jstDateOf(now)
    if (!force && day === localExpiredDay) return null
    try {
      const out = await target.expireBefore(localExpiryDate(now))
      localExpiredDay = day
      return out
    } catch (e) {
      console.warn('端末の中の30日を過ぎた記録を消せませんでした', e)
      return null
    }
  }

  // ---------- 受信 ----------

  let remoteWaiters: (() => void)[] = []
  function waitForRemote(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms)
      function done() {
        clearTimeout(t)
        remoteWaiters = remoteWaiters.filter((f) => f !== done)
        resolve()
      }
      remoteWaiters.push(done)
    })
  }

  /** 購読をやめ、少し待ってから購読し直す（records は、初めての受け取りの途中なら 2. から） */
  function resubscribeLater(l: Listener): void {
    l.gen += 1
    l.unsub?.()
    l.unsub = null
    if (stopped || l.retryTimer) return
    const delay = RETRY_DELAYS_MS[Math.min(l.retryCount, RETRY_DELAYS_MS.length - 1)]
    l.retryCount += 1
    l.retryTimer = setTimeout(() => {
      l.retryTimer = null
      resubscribe(l)
    }, delay)
  }

  /**
   * from 以上に書かれた物を購読する。records は表を並べる（辞書の束を受け取らない。7.8 の「購読」）。「以上」で購読する: 別々の書き込みが
   * 同じ時刻になることがあり、「より後」だと、記録した位置と同じ時刻のまだ受け取っていない変更を取りこぼすため（DS と同じ）。
   * 問い合わせの形は firestore.indexes.json の table＋updated と、src/sync/rules.emu.test.ts の APP_QUERIES に合わせる
   */
  function subscribe(l: Listener, from: SyncCursor): void {
    if (stopped) return
    l.unsub?.()
    const gen = ++l.gen
    l.subscribedFrom = from
    const since = where('updated', '>=', timestampOf(from))
    const q =
      l.place === 'records'
        ? query(l.col, where('table', 'in', [...RECORDS_SUBSCRIBED_TABLES]), since, orderBy('updated'))
        : query(l.col, since, orderBy('updated'))
    /** この購読で、まだサーバーと揃っていない（最初のサーバーからの通知を受け取っていない） */
    let first = true
    l.unsub = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => {
        const fromCache = snap.metadata.fromCache
        if (first && fromCache) return
        const full = first
        const changed = first
          ? snap.docs
          : snap
              .docChanges()
              .filter((c) => c.type !== 'removed')
              .map((c) => c.doc)
        first = false
        void exclusive(async () => {
          if (gen !== l.gen) return
          await handleSnapshot(l, changed, fromCache, full, gen)
          // 反映している間に購読が誤りで止まっていたら、待つ長さは戻さない
          if (gen === l.gen) l.retryCount = 0
        }).catch((e) => {
          listenFail(l, e)
          if (gen === l.gen) resubscribeLater(l)
        })
      },
      (err) => {
        listenFail(l, err)
        if (gen === l.gen) resubscribeLater(l)
      },
    )
  }

  /**
   * 初めての受け取りの 1.（「知ってる」を読む。docs/SPEC.md の 7.8）。位置が無ければ knownTerms を全部、位置があればその位置から
   * （索引 table＋updated で引ける）。サーバーから読む（オフラインの時に端末の控えの0件で「終えた」としないように）。終えたら
   * _meta の firstSync を、反映と同じトランザクションで書く。firstSync があれば読み直さない（2. の再試行の時。needsKnownRead）
   */
  async function readKnownTerms(): Promise<void> {
    const now = clock()
    if (!needsKnownRead(asFirstSync(await target.getMeta('firstSync')), now)) return
    const r = listeners.records
    const known = where('table', '==', 'knownTerms')
    const q = r.cursor ? query(r.col, known, where('updated', '>=', timestampOf(r.cursor))) : query(r.col, known)
    const snap = await getDocsFromServer(q)
    if (stopped) return
    const changes: Change[] = []
    for (const d of snap.docs) {
      const data = d.data({ serverTimestamps: 'none' })
      const at = timeOf(data)
      if (at) noteServerTime(at, now)
      const c = remoteChangeOf(data, { docId: d.id, place: 'records', deviceId, deviceNow: now })
      if (c.ok) changes.push(c.change)
      else console.warn('クラウドの「知ってる」を読み取れませんでした', d.id, c.reason)
    }
    await confirmLandedFor(changes)
    await target.applyRemote(changes, { meta: { firstSync: { knownAt: clock() } } })
  }

  /**
   * records の購読を始める（exclusive の中で呼ぶ）。初めての受け取りに入るなら 1. の後に、端末の時計 − 32日から（2.）。
   * ふつうは記録した位置から
   */
  async function beginRecords(): Promise<void> {
    if (stopped) return
    const r = listeners.records
    if (firstPending || needsFirstSync({ recordsCursor: r.cursor, caughtUpAt }, clock())) {
      firstPending = true
      if (downloaded) {
        downloaded = false
        setStatus({ downloaded: false, phase: 'downloading' })
      }
      await readKnownTerms()
      if (stopped) return
      firstSince = firstSyncSince(clock())
      subscribe(r, firstSince)
      return
    }
    subscribe(r, r.cursor ?? firstSyncSince(clock()))
  }

  /** 購読し直す（records は、初めての受け取りに入るかを確かめてから） */
  function resubscribe(l: Listener): void {
    void exclusive(async () => {
      if (stopped) return
      if (l.place === 'records') await beginRecords()
      else subscribe(l, privateStart(l.cursor, clock()))
    }).catch((e) => {
      listenFail(l, e)
      resubscribeLater(l)
    })
  }

  /**
   * 記録した位置が購読を始めた位置より進んでいれば、そこから購読し直す（読み取りの量と、購読が抱える文書を減らす）。最後にクラウドと
   * そろってから31日を過ぎていれば、records は初めての受け取りからやり直す
   */
  function reanchorPlace(l: Listener): void {
    if (stopped || !l.unsub || l.retryTimer) return
    void exclusive(async () => {
      if (stopped || !l.unsub) return
      if (l.place === 'records') {
        if (firstPending) return
        if (needsFirstSync({ recordsCursor: l.cursor, caughtUpAt }, clock())) {
          await beginRecords()
          return
        }
      }
      if (l.cursor && laterCursor(l.cursor, l.subscribedFrom)) subscribe(l, l.cursor)
    }).catch((e) => {
      listenFail(l, e)
      resubscribeLater(l)
    })
  }

  function reanchor(): void {
    for (const l of all()) reanchorPlace(l)
  }

  /** クラウドと揃った（records の購読でサーバーからの通知を受け取った）時刻を覚える（_meta に書くのは 1時間に1回まで） */
  async function noteCaughtUp(now: number): Promise<void> {
    caughtUpAt = now
    if (caughtUpSaved !== null && Math.abs(now - caughtUpSaved) < CAUGHT_UP_SAVE_MS) return
    caughtUpSaved = now
    await target.setMeta('caughtUpAt', now)
  }

  async function handleSnapshot(
    l: Listener,
    changed: QueryDocumentSnapshot<DocumentData>[],
    fromCache: boolean,
    full: boolean,
    /** 通知を届けた購読の世代（反映している間に、その購読が誤りで止まったかを見る） */
    gen: number,
  ): Promise<void> {
    if (stopped) return
    if (!changed.length && fromCache) return
    const now = clock()
    // 日付が変わっていたら、先に端末の中の30日の外を消す（その後に届いた物は、反映の前に端末の時計で落とす）
    await expireLocalNow()
    const changes: Change[] = []
    let newest: SyncCursor | null = null
    for (const d of changed) {
      const data = d.data({ serverTimestamps: 'none' })
      const at = timeOf(data)
      if (at) noteServerTime(at, now)
      if (at && laterCursor(at, newest)) newest = at
      const key = `${l.place}/${d.id}`
      if (isStaleEcho(key, data) || isSuperseded(key, data)) continue
      const c = remoteChangeOf(data, { docId: d.id, place: l.place, deviceId, deviceNow: now })
      if (c.ok) changes.push(c.change)
      else if (c.reason !== 'expired' && c.reason !== 'not-subscribed')
        console.warn('クラウドの記録を読み取れませんでした', d.id, c.reason)
    }
    // 初めての受け取りの 2. の最初のサーバーの知らせ: 届いた記録が0件でも位置を購読を始めた位置まで進め、caughtUpAt を書き、
    // firstSync を消す（反映と同じトランザクション。7.8 の 2.）
    const finishing = l.place === 'records' && firstPending && full && !fromCache && firstSince !== null
    const advance = fromCache ? null : snapshotAdvance(l.cursor, newest, finishing ? firstSince : null)
    const meta: MetaPatch | undefined = finishing ? { caughtUpAt: now, firstSync: null } : undefined
    if (changes.length || advance || meta) {
      if (!fromCache) await confirmLandedFor(changes)
      await target.applyRemote(changes, {
        ...(advance ? { cursor: { place: l.place, at: advance } } : {}),
        ...(meta ? { meta } : {}),
      })
    }
    if (advance) l.cursor = advance
    if (finishing) {
      firstPending = false
      firstSince = null
      caughtUpAt = now
      caughtUpSaved = now
    }
    if (!fromCache) {
      if (l.place === 'records' && !finishing && !firstPending) await noteCaughtUp(now)
      // 反映している間にこの購読が誤りで止まっていたら（listenFail）、その誤りのままにする（購読が無いまま「同期済み」と出さない）
      if (gen === l.gen) l.failure = null
      l.synced = true
      if (!downloaded && !firstPending && all().every((x) => x.synced)) {
        downloaded = true
        setStatus({ downloaded: true })
      }
    }
    for (const f of [...remoteWaiters]) f()
    if (!fromCache && downloaded) {
      const pending = await refreshPending()
      if (!uploading) {
        setStatus(
          pending === 0
            ? (listenFailure() ?? { phase: 'synced', lastSyncedAt: clock(), error: null, errorCode: null })
            : { phase: status.phase === 'error' || status.phase === 'offline' ? status.phase : 'uploading' },
        )
        if (pending > 0) requestUpload()
      }
    }
    // 初めての受け取りの 2. を終えた: 32日分を抱えたままにしないよう、記録した位置から購読し直す（DS の全件の購読の後と同じ。
    // 読むのは位置と同じ時刻の文書だけ）
    if (finishing) reanchorPlace(l)
  }

  // ---------- 送信 ----------

  let uploadTimer: ReturnType<typeof setTimeout> | null = null
  let uploadSince: number | null = null
  let uploading: Promise<void> | null = null
  let uploadAgain = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryCount = 0

  function requestUpload(immediate = false): void {
    if (stopped) return
    if (uploading) {
      uploadAgain = true
      return
    }
    const now = Date.now()
    if (uploadSince === null) uploadSince = now
    if (uploadTimer) clearTimeout(uploadTimer)
    const delay = immediate ? 0 : Math.max(0, Math.min(uploadDelay, uploadSince + uploadMaxWait - now))
    uploadTimer = setTimeout(() => {
      uploadTimer = null
      uploadSince = null
      void uploadAll()
    }, delay)
  }

  function scheduleRetry(): void {
    if (retryTimer || stopped) return
    const delay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)]
    retryCount += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      void uploadAll()
    }, delay)
  }

  interface BatchResult {
    done: boolean
    progressed: number
    conflicts: OutboxItem[]
  }

  /** 送る書き込みの印の値（無い・形が違えば null） */
  function landedOf(snap: DocumentSnapshot<DocumentData>): string | null {
    const v = snap.exists() ? (snap.data() as { tx?: unknown }).tx : null
    return typeof v === 'string' && v ? v : null
  }

  /** 書き込みが届いていた送信待ち: その時に送った内容（sent）を base にした物（送った返事を受け取った時と同じ） */
  function landedEntry(b: BatchEntry<OutboxItem>, sentRecord: AnyRecord | null): BatchEntry<OutboxItem> {
    const it: OutboxItem = { ...b.it, base: sentRecord, noHistory: false }
    delete it.unconfirmed
    delete it.tx
    delete it.sent
    return { ...b, it, baseHash: hashRecord(sentRecord) }
  }

  /**
   * 届いた変化が、返事を受け取れなかった書き込みの送信待ちに当たる時: 送る書き込みの印をサーバーから読み、その書き込みが届いていたら、
   * 送った内容を base にしてから反映する（ほかの端末がその書き込みの後に書いた版を、古い base で 3者マージして、ほかの端末の変更を
   * 戻さないように。DS と同じ）
   */
  async function confirmLandedFor(changes: readonly Change[]): Promise<void> {
    const keys = changes.map((c) => outboxKey(c.table, c.id))
    if (!keys.length) return
    const txs = await target.unconfirmedTx(keys)
    if (!txs.size) return
    const landed = landedOf(await getDocFromServer(markRef))
    if (landed && txs.has(landed)) {
      await target.confirmLanded(landed)
      lastLanded = landed
    }
  }

  async function uploadBatch(): Promise<BatchResult> {
    // 日付が変わっていたら、先に端末の中の30日の外を消す（電波の無い間に読んだ既読が、0時をまたいで30日を過ぎた時。送信待ちの行も消える）
    await expireLocalNow()
    const items = await target.readOutbox(BATCH_RECORDS)
    if (!items.length) return { done: true, progressed: 0, conflicts: [] }
    // 送る必要の無い行（local が null・30日の外の既読・base と同じ）は、書かずに送り終わりにする。30日の守りは、どの行を選ぶかより先に
    // 当てる（書けずに止まった既読が、30日を過ぎても送信待ちに残らないように）
    const guardNow = sendGuardTime(serverNow(), clock())
    const idle = items.filter((it) => nothingToSend(it, guardNow))
    if (idle.length) await target.completeUpload(idle.map((it) => ({ table: it.table, id: it.id, record: it.local })))
    const given = selectBatch(items, { ...limits, serverNow: guardNow })
    if (!given.length || sendPaused()) return { done: false, progressed: idle.length, conflicts: [] }

    let attempt = ''
    /** この送信の前の試みで付けた印（SDK がトランザクションをやり直した時。送信待ち → その試みの id と送った内容） */
    const tried = new Map<string, { tx: string; sent: AnyRecord | null }>()
    /** この送信の中で、届いていたと分かった書き込みの送った内容（送信待ち → 新しい base。やり直した試みでも使う） */
    const resolved = new Map<string, AnyRecord | null>()
    const result = await runTransaction(fs, async (tx) => {
      // このトランザクション（の1回の試み）の id。送る書き込みの印に書く
      attempt = newTxId()
      const recheck = modelState !== 'ok' && Boolean(opts.appModel)
      const [snaps, marker, markSnap] = await Promise.all([
        Promise.all(given.map((b) => tx.get(docRefOf(b.it.table, b.it.id)))),
        recheck ? tx.get(appModelRef(fs, uid)) : Promise.resolve(null),
        tx.get(markRef),
      ])
      if (recheck) {
        if (marker && newerModel(marker.exists() ? asModel(marker.data()) : null)) throw MODEL_PAUSED
        if (modelState === 'newer') throw MODEL_PAUSED
      } else if (modelState !== 'ok') throw MODEL_PAUSED
      // 前に返事を受け取れなかった書き込みが届いていた（印がその書き込みの id）: その時に送った内容を base にしてから決める。
      // この端末の送るトランザクションはどれも印を読む（読んだ後に印が変われば届かない）ので、印は、この端末の最後に届いた書き込みを指す
      const landed = landedOf(markSnap)
      if (landed && landed !== lastLanded) {
        await target.confirmLanded(landed)
        lastLanded = landed
      }
      const batch = given.map((b) => {
        const m = tried.get(b.it.k) ?? (b.it.tx ? { tx: b.it.tx, sent: b.it.sent ?? null } : null)
        if (landed && m?.tx === landed) resolved.set(b.it.k, m.sent)
        const base = resolved.get(b.it.k)
        return base !== undefined ? landedEntry(b, base) : b
      })
      const clouds = snaps.map((snap) => (snap.exists() ? (snap.data() as Partial<RecordDoc>) : null))
      const states: CloudState[] = clouds.map((c) => ({
        exists: c !== null,
        hash: c && typeof c.hash === 'string' ? c.hash : '',
      }))
      const decision = decideBatch(batch, states)
      // クラウドで消えていた既読（ほかの端末が30日で消した）: 作り直さずに送り終わりにする（src/sync/syncPlan.ts の goneFromCloud）
      const gone = batch.filter((b, i) => !decision.write[i] && goneFromCloud(b.it, states[i].exists))
      const goneKeys = new Set(gone.map((b) => b.it.k))
      // 書く送信待ちに、書き込みを送る前に「返事を受け取るまで分からない」とこの試みの id・送る内容を覚える（届いたのに返事が無かった時に、
      // 次の送信や受信で、印を読んで確かめる）
      const marks: SentRow[] = batch
        .filter((b, i) => decision.write[i] && !sameAsBase(b.it))
        .map((b) => ({ key: b.it.k, record: b.it.local }))
      if (marks.length) await target.markUnconfirmed(marks, attempt)
      for (const m of marks) tried.set(m.key, { tx: attempt, sent: m.record })
      const written: { change: Change; key: string; hash: string; replaced: SyncCursor | null }[] = []
      const settled: Change[] = []
      batch.forEach((b, i) => {
        if (!decision.write[i]) return
        if (sameAsBase(b.it)) {
          settled.push({ table: b.it.table, id: b.it.id, record: b.it.local })
          return
        }
        const ref = docRefOf(b.it.table, b.it.id)
        // 外側の8つの欄（chunks: 0・deleted: false・updated はサーバー時刻・device はこの端末。ルールの appDoc。7.7）
        tx.set(ref, recordDocOf(b.it.table, b.it.id, b.enc, { device: deviceId, updated: serverTimestamp() }))
        const cloud = clouds[i]
        written.push({
          change: { table: b.it.table, id: b.it.id, record: b.it.local },
          key: `${placeOf(b.it.table)}/${ref.id}`,
          hash: b.enc.hash,
          replaced: cloud ? timeOf(cloud) : null,
        })
      })
      // 印は、記録を書く試みだけが書く（書かない試みも印を読んでいるので、その間に印が変われば、この試みは届かない）
      if (marks.length) tx.set(markRef, { tx: attempt })
      return {
        written,
        settled,
        gone: gone.map((b): Change => ({ table: b.it.table, id: b.it.id, record: b.it.local })),
        conflicts: decision.conflicts.filter((it) => !goneKeys.has(it.k)),
        marked: marks.length > 0,
      }
    }).catch((e: unknown) => {
      if (e === MODEL_PAUSED) return null
      throw e
    })
    if (!result) return { done: false, progressed: idle.length, conflicts: [] }
    if (result.marked) lastLanded = attempt
    for (const w of result.written) {
      rememberSent(w.key, w.hash)
      if (w.replaced) replaced.set(w.key, w.replaced)
      else replaced.delete(w.key)
    }
    await target.completeUpload([...result.written.map((w) => w.change), ...result.settled, ...result.gone])
    return {
      done: false,
      progressed: idle.length + result.written.length + result.settled.length + result.gone.length,
      conflicts: result.conflicts,
    }
  }

  /** 受信を待っても base が新しくならない時は、クラウドの内容を直接読んで反映する（DS と同じ） */
  async function pullDirectly(items: readonly OutboxItem[]): Promise<void> {
    const now = clock()
    const changes: Change[] = []
    for (const it of items) {
      const ref = docRefOf(it.table, it.id)
      const snap = await getDoc(ref)
      if (!snap.exists()) {
        changes.push({ table: it.table, id: it.id, record: null })
        continue
      }
      const data = snap.data({ serverTimestamps: 'none' })
      if (isStaleEcho(`${placeOf(it.table)}/${ref.id}`, data)) continue
      const c = remoteChangeOf(data, { docId: ref.id, place: placeOf(it.table), deviceId, deviceNow: now })
      if (c.ok) changes.push(c.change)
    }
    if (changes.length) {
      await confirmLandedFor(changes)
      await target.applyRemote(changes)
    }
  }

  /** クラウドの記録がこのアプリより新しい版なら、送るのを止める（要更新の表示）。止めたら true */
  function newerModel(cur: AppModel | null): boolean {
    if (!opts.appModel || !cur || cur.model <= opts.appModel.model) return false
    modelState = 'newer'
    setStatus({ outdated: cur })
    return true
  }

  function uploadAll(): Promise<void> {
    if (uploading) {
      uploadAgain = true
      return uploading
    }
    if (stopped) return Promise.resolve()
    if (uploadTimer) {
      clearTimeout(uploadTimer)
      uploadTimer = null
      uploadSince = null
    }
    const recount = () => (stopped ? Promise.resolve() : refreshPending().then(noop, noop))
    if (modelState === 'unknown' && !modelRecheck) {
      void recount()
      return new Promise<void>((resolve) => {
        const giveUp = () => void recount().then(resolve)
        const t = setTimeout(giveUp, modelWait)
        void modelReady.then(async () => {
          clearTimeout(t)
          if (modelState === 'ok' && !stopped) {
            await uploadAll()
            resolve()
          } else giveUp()
        })
      })
    }
    if (modelState === 'newer') return recount()
    uploading = (async () => {
      try {
        await target.flush?.()
        await refreshPending()
        if (!ownerOk) {
          await claimOwner()
          ownerOk = true
        }
        let stuck = 0
        for (;;) {
          if (sendPaused()) return
          const r = await exclusive(uploadBatch)
          if (r.done) break
          if (sendPaused()) return
          if (status.phase !== 'uploading') setStatus({ phase: 'uploading', error: null, errorCode: null })
          await refreshPending()
          if (r.conflicts.length && r.progressed === 0) {
            stuck += 1
            if (stuck >= 3) await exclusive(() => pullDirectly(r.conflicts))
            else await waitForRemote(3000)
            if (stuck > 6) throw new Error('クラウドとの差を解消できませんでした。しばらくしてからもう一度お試しください。')
          } else stuck = 0
        }
        retryCount = 0
        const pending = await refreshPending()
        if (pending === 0)
          setStatus(
            listenFailure() ??
              (downloaded
                ? { phase: 'synced', lastSyncedAt: clock(), error: null, errorCode: null }
                : { phase: 'downloading', error: null, errorCode: null }),
          )
        else if (!downloaded) setStatus(listenFailure() ?? { phase: 'downloading', error: null, errorCode: null })
      } catch (e) {
        if (e === MODEL_PAUSED) {
          await recount()
          return
        }
        fail(e)
        if (e instanceof SyncError) return
        scheduleRetry()
      }
    })().finally(() => {
      uploading = null
      if (uploadAgain && !stopped) {
        uploadAgain = false
        requestUpload()
      }
    })
    return uploading
  }

  /** 持ち主を確かめる（記録は作らない。形1）。記録が無い・別のアカウントなら SyncError（docs/SPEC.md の 7.8 の「持ち主」） */
  async function claimOwner(): Promise<void> {
    const state = await checkOwner(fs, uid)
    if (state === 'missing') throw new SyncError('owner-missing', OWNER_MISSING_MESSAGE)
    if (state === 'mismatch') {
      if ((await target.getMeta<string>('ownerSeen')) === uid) await target.setMeta('ownerSeen', null)
      throw new SyncError('owner-mismatch', OWNER_MISMATCH_MESSAGE)
    }
    await target.setMeta('ownerSeen', uid)
  }

  let beginRetry: ReturnType<typeof setTimeout> | null = null
  /** 端末の準備に失敗してやり直した回数（待つ長さを延ばす） */
  let beginRetryCount = 0

  function retryBegin(delay: number): void {
    if (beginRetry || stopped) return
    beginRetry = setTimeout(() => {
      beginRetry = null
      void begin()
    }, delay)
  }

  /**
   * 端末の準備（begin の中。端末の DB を読み書きする）。このアカウントと同期するのが初めてなら、アプリの記録は共通の履歴が無い前提で
   * 突き合わせ、Claude の記録の写しと位置を消して、初めての受け取りから（persistence の markAllDirty が位置・caughtUpAt・firstSync も
   * 消す）。前に別のアカウントで同期していた端末は、確かめた印（allowAccountSwitch）が無ければ止める（docs/SPEC.md の 7.8）
   */
  async function prepareDevice(): Promise<void> {
    const previous = await target.getMeta<string>('uid')
    if (previous !== uid) {
      if (typeof previous === 'string' && previous && !opts.allowAccountSwitch)
        throw new SyncError('account-mismatch', ACCOUNT_MISMATCH_MESSAGE)
      await target.markAllDirty()
      await target.setMeta('uid', uid)
    }
    if ((await target.getMeta<number>('syncSchema')) !== SYNC_SCHEMA) {
      await target.setMeta('cursor', null)
      await target.setMeta('caughtUpAt', null)
      await target.setMeta('firstSync', null)
      await target.setMeta('syncSchema', SYNC_SCHEMA)
    }
    if (stopped) return
    const cursors = ((await target.getMeta<StoredCursors | null>('cursor')) ?? {}) as Record<string, unknown>
    for (const l of all()) l.cursor = asCursor(cursors[l.place])
    const savedCaughtUp = await target.getMeta<unknown>('caughtUpAt')
    caughtUpAt = typeof savedCaughtUp === 'number' && Number.isFinite(savedCaughtUp) ? savedCaughtUp : null
    caughtUpSaved = caughtUpAt
    await expireLocalNow(true)
    if (stopped) return
    setStatus({ phase: 'downloading', error: null, errorCode: null })
    await refreshPending()
  }

  /**
   * 同期を始める。持ち主を確かめてから（ownerLock の時）、端末を準備し（prepareDevice）、購読と送信を始める。通信できずに持ち主を
   * 確かめられない時は、つながってからやり直す。端末の DB を読み書きできなかった時は「同期できません（理由）」を出してやり直す
   * （受け取り中…のまま止まらないように。docs/SPEC.md の 7.8 の8つ）
   */
  async function begin(): Promise<void> {
    if (stopped || begun) return
    if (!ownerOk) {
      try {
        await claimOwner()
        ownerOk = true
      } catch (e) {
        fail(e)
        if (e instanceof SyncError) {
          // 持ち主の記録が無い・別のアカウントのクラウド: 何も送らず、受け取らない
          stopped = true
          return
        }
        retryBegin(RETRY_DELAYS_MS[1])
        return
      }
    }
    if (stopped || begun) return
    begun = true
    try {
      await prepareDevice()
    } catch (e) {
      begun = false
      fail(e)
      if (e instanceof SyncError) {
        // 前に別のアカウントで同期していた端末: 何も送らず、受け取らない（司令塔が確かめを出す）
        stopped = true
        return
      }
      retryBegin(RETRY_DELAYS_MS[Math.min(beginRetryCount, RETRY_DELAYS_MS.length - 1)])
      beginRetryCount += 1
      return
    }
    if (stopped) return
    beginRetryCount = 0
    watchModel()
    subscribe(listeners.private, privateStart(listeners.private.cursor, clock()))
    void exclusive(beginRecords).catch((e) => {
      listenFail(listeners.records, e)
      resubscribeLater(listeners.records)
    })
    requestUpload(true)
  }

  let modelRetry: ReturnType<typeof setTimeout> | null = null
  let modelRetryCount = 0
  /** データの形の版の見張りの世代（見張り直したら、前の見張りの知らせは使わない） */
  let modelGen = 0

  /**
   * データの形の版（meta/app）を見張る。見張りが誤りで止まった時（Firestore は誤りの後に見張りを閉じる。無料枠を使い切った時など）は、
   * 確かめていない扱いにして（送る時はトランザクションの中で meta/app を読む）、少し後で見張り直す（DS と同じ）
   */
  function watchModel(): void {
    if (!opts.appModel || stopped || modelUnsub) return
    const gen = ++modelGen
    modelUnsub = watchAppModel(fs, uid, opts.appModel, (s) => {
      if (stopped || gen !== modelGen) return
      if (s.state === 'error') {
        modelGen += 1
        modelUnsub?.()
        modelUnsub = null
        modelState = 'unknown'
        modelRecheck = true
        // 待っている送信は、トランザクションの中で確かめて送る（オフラインの表示にはしない）
        modelKnown()
        requestUpload(true)
        if (!modelRetry) {
          const delay = RETRY_DELAYS_MS[Math.min(modelRetryCount, RETRY_DELAYS_MS.length - 1)]
          modelRetryCount += 1
          modelRetry = setTimeout(() => {
            modelRetry = null
            watchModel()
          }, delay)
        }
        return
      }
      if (s.state === 'unknown') {
        if (modelState === 'ok') {
          modelState = 'unknown'
          modelRecheck = true
          modelReady = new Promise<void>((resolve) => (modelKnown = resolve))
          setStatus({ phase: 'offline', error: OFFLINE_MESSAGE, errorCode: 'offline' })
        }
        return
      }
      modelRetryCount = 0
      const was = modelState
      modelState = s.state
      modelRecheck = false
      modelKnown()
      if (s.state === 'newer') setStatus({ outdated: s.cloud })
      else if (status.outdated) setStatus({ outdated: null })
      if (s.state === 'ok' && was !== 'ok') requestUpload(true)
    })
  }

  const onOnline = () => {
    if (stopped) return
    if (!begun) {
      void begin()
      return
    }
    for (const l of all()) if (!l.unsub && !l.retryTimer) resubscribe(l)
    reanchor()
    requestUpload(true)
  }

  // ---------- 30日の手入れ（docs/SPEC.md の 7.8 の「30日で消す」） ----------

  /**
   * クラウドの30日の外の文書を消す（1日1回。どの端末でもよく、先にした端末が消し、後の端末は0件を見つけるだけ）。文書の id の範囲
   * （'{表名}:' 以上 '{表名}:{境の日付}' 未満。自動の索引）で 450件ずつ引き、表ごとの id の形でサーバーの時刻の見積もりで30日を過ぎた物だけを
   * まとめて消す。1台1日 2,000件まで（引いた数で数える。消す物を見つける読み取りも同じ数だけかかる）。削除の印は書かない
   */
  async function maintain(now = clock()): Promise<MaintainResult> {
    const result: MaintainResult = { deleted: {}, total: 0, capped: false, skipped: null }
    if (stopped || !begun || !downloaded || modelState !== 'ok') return { ...result, skipped: 'not-ready' }
    return exclusive(async () => {
      if (stopped) return { ...result, skipped: 'not-ready' as const }
      // サーバーの時刻の見積もり（時計の進んだ端末が早く消さない。まだ文書が届いていなければ消さない）
      const server = estimateServerNow(now, clockSkew)
      if (server === null) return { ...result, skipped: 'no-server-time' as const }
      const day = jstDateOf(now)
      if ((await target.getMeta<string>('lastMaintainDay')) === day) return { ...result, skipped: 'done-today' as const }
      let budget = EXPIRE_DAILY_DOCS
      for (const table of EXPIRE_ORDER) {
        const col = listeners[placeOf(table)].col
        const end = expiryDocIdBefore(table, server)
        let after: string | null = null
        while (budget > 0 && !stopped) {
          const n = Math.min(EXPIRE_BATCH_DOCS, budget)
          const from = after === null ? where(documentId(), '>=', expireRangeStart(table)) : where(documentId(), '>', after)
          const q: Query = query(col, from, where(documentId(), '<', end), orderBy(documentId()), limit(n))
          const snap: QuerySnapshot = await getDocsFromServer(q)
          budget -= snap.size
          const ids = expirableIds(
            snap.docs.map((d) => d.id),
            server,
          )
          if (ids.length) {
            const batch = writeBatch(fs)
            for (const id of ids) batch.delete(doc(col, id))
            await batch.commit()
            result.deleted[table] = (result.deleted[table] ?? 0) + ids.length
            result.total += ids.length
          }
          if (snap.size < n) break
          after = snap.docs[snap.docs.length - 1].id
        }
        if (budget <= 0) {
          result.capped = true
          break
        }
      }
      // 上限で途中までの時も、今日の分はした（長くどの端末も開かなかった時は、次の日に続ける）
      if (!stopped) await target.setMeta('lastMaintainDay', day)
      return result
    })
  }

  // ---------- 欠けた話題を直接読む（docs/SPEC.md の 7.8 の「版を出す条件」） ----------

  async function fetchTopics(ids: readonly string[]): Promise<TopicFetchResult> {
    const out: TopicFetchResult = { found: [], missing: [] }
    const list = [...new Set(ids)].slice(0, MAX_TOPIC_FETCH)
    if (stopped || !begun || !list.length) return out
    return exclusive(async () => {
      const now = clock()
      const changes: Change[] = []
      for (const id of list) {
        const ref = docRefOf('topics', id)
        const snap = await getDocFromServer(ref)
        const data = snap.exists() ? snap.data({ serverTimestamps: 'none' }) : null
        const at = data ? timeOf(data) : null
        if (at) noteServerTime(at, now)
        const c = data ? remoteChangeOf(data, { docId: ref.id, place: 'records', deviceId, deviceNow: now }) : null
        if (c?.ok) {
          changes.push(c.change)
          out.found.push(id)
        } else out.missing.push(id)
      }
      if (changes.length) await target.applyRemote(changes)
      return out
    })
  }

  return {
    get status() {
      return status
    },

    async start() {
      if (typeof window !== 'undefined') window.addEventListener('online', onOnline)
      await begin()
    },

    stop() {
      stopped = true
      for (const l of all()) {
        l.gen += 1
        l.unsub?.()
        l.unsub = null
        if (l.retryTimer) clearTimeout(l.retryTimer)
        l.retryTimer = null
      }
      modelUnsub?.()
      modelUnsub = null
      modelKnown()
      for (const t of [uploadTimer, retryTimer, beginRetry, modelRetry]) if (t) clearTimeout(t)
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline)
    },

    requestUpload: (immediate?: boolean) => {
      if (begun) requestUpload(immediate)
    },

    flush: () => (begun ? uploadAll() : Promise.resolve()),

    reanchor,

    maintain,

    expireLocal: (force?: boolean) => (begun && !stopped ? exclusive(() => expireLocalNow(force)) : Promise.resolve(null)),

    fetchTopics,

    serverNow,

    async idle() {
      for (;;) {
        const u = uploading
        if (u) await u
        await lock
        if (!uploading && !uploadTimer) return
        if (uploadTimer) {
          clearTimeout(uploadTimer)
          uploadTimer = null
          uploadSince = null
          void uploadAll()
        }
      }
    },
  }
}
