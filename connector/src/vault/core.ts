// Vault の中身（Durable Object の外でも動く。テストでは node:sqlite と作り物の Firebase で動かす）。NS の connector/src/vault/core.ts を元にした。
// 持ち主ごとに1つ（idFromName('owner')）。TS は初めから接続の一覧の形（v2）だけを読む（NS の 2.8 までの v1 の記録・接続 c0 は無い）。
// - B0（NS の写し）: 連携の状態・身元・連携の確かめ（verifyPairing）・許可の確かめ（checkGrant）・接続の一覧（config/connector）の読み直し・
//   「書き込みを許可」とデータの形の版の確かめ・数の記録（日枠）・接続の要求の回数
// - B3: 写し（mirror.ts。読ませる6つの表の軽い行と辞書の今の形）と、その新しくし方（#fresh。NS と同じ）・ツールの振り分け（TOOL_HANDLERS）・
//   topic_status（連携していない時にも答えるので、callTool の始めで別に扱う。NS の novel_status と同じ）・回（runs.ts）・
//   足す時の書き込み（ctx.add。NS の #write・#commitPrepared の形）・alarm のやる事の表・夜の仕事（cron）
// - 取りに行く中身（B4）は FetchWork（vault/tools/fetch.ts の FETCH_WORK）、下書き・足す道具の中身（B5）は vault/tools/{drafts,write}.ts
import { connectionsOf, isPairingHash, MAX_CONNECTIONS, PAIRING_TTL_MS, type ConnectionInfo } from '../../../src/claude/pairing'
import { jstDateOf } from '../../../src/domain/jst'
import { DEFAULT_OUTLETS, type OutletDirectory } from '../../../src/domain/outlets'
import type { VaultConfig } from '../config'
import { log, logError } from '../log'
import { CONNECTOR_DEVICE, CONNECTOR_MODEL, CONNECTOR_VERSION } from '../version'
import { Dictionary } from './dictionary'
import { ConnectorError, isAuthProblem, MESSAGES, modelMismatchMessage } from './errors'
import { FirestoreError, FirestoreRest } from './firestore'
import { Identity } from './identity'
import { Mirror, type SyncOutcome } from './mirror'
import { Mutex } from './mutex'
import { firestoreQuotaMessage, freshQuota, nextPacificMidnight, resetLabel, WRITE_RESERVE, type QuotaCounts } from './quota'
import { claimConsent, takeRate, type RateKind, type RateResult } from './ratelimit'
import {
  expireRuns,
  JMA_WATCH_EVERY_MS,
  randomRunSuffix,
  TOOL_RUN_KINDS,
  topicBeginRun,
  useRun,
  type FetchWork,
  type TaskStep,
} from './runs'
import { MirrorStore, nextUtcMidnight, type RunRow, type SqlRunner } from './store'
import { REQUEST_TIMEOUT_MS, withTimeout } from './timeout'
import { fail, headLine, withHead, type RunDeadlines, type ToolResult } from './tools/common'
import { topicCheckDraft, topicGetDraft, topicGetGuide, topicListDrafts, topicSaveDraft } from './tools/drafts'
import { FETCH_WORK, topicListCandidates, topicReadArticle } from './tools/fetch'
import { statusDetails, topicListRecent, topicLookupTerms } from './tools/read'
import { topicAddCorrection, topicAddEdition, topicAddEditionFail, topicAddTopics, topicFindTopics } from './tools/write'
import { fromFields, timestampMillis, type Timestamp } from './values'
import { EncodeError, groups, prepareWrite, type PreparedWrite, type WritableRecord } from './writer'

export interface VaultDeps {
  sql: SqlRunner
  /** Google の API（Firestore・トークン）への fetch */
  fetch: typeof fetch
  config: VaultConfig
  /** TOKEN_ENC_KEY */
  secret: string | undefined
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 続きの仕事を予約する（Durable Object の alarm）。null で取り消す */
  schedule?: (at: number | null) => void
  /** Google の API（Firestore・トークン）への1回の要求を待つ上限（ms。既定 REQUEST_TIMEOUT_MS = 15 秒。テストでは短く） */
  timeoutMs?: number
  /** 読むツールの前に写しを新しくしない間（ms。既定 FRESH_MS = 15 秒） */
  freshMs?: number
  /** 社の一覧（既定 DEFAULT_OUTLETS。テストは作り物の FAKE_OUTLETS） */
  outlets?: OutletDirectory
  /** 出どころ（府省・庁など）へ取りに行く fetch（既定は fetch と同じ。テストは作り物の出どころ。B4 が使う） */
  sourceFetch?: typeof fetch
  /** 取りに行く中身（既定 vault/tools/fetch.ts の FETCH_WORK。テストは作り物） */
  fetchWork?: FetchWork
  /** 回の id の乱数4字（[0-9a-z]。既定は crypto.getRandomValues。テストは決めた値） */
  random?: () => string
}

export interface PairingMeta {
  state: 'paired' | 'unpaired'
  ownerUid: string | null
  /** 連携した時刻（ms） */
  pairedAt: number | null
  /** 解除した理由（ログ・状態の表示用） */
  reason?: string
  /**
   * 連携の代（確かめた時の config/connector の作られた時刻 createTime）。［連携をすべて解除］で消して作り直すと変わる
   * （「書き込みを許可」の切り替え・接続を足す・入れ替える・名前を変える・1つ解除する、では変わらない）
   */
  gen?: string | null
  /** 最後に読んだ config/connector の接続（cid）。クラウドを読めない時の、許可の接続の確かめに使う（断るのは5秒以内に読み直した一覧に無い時だけ） */
  cids?: string[]
}

/** OAuth の許可に入れた値（props）。連携した持ち主と、連携の代と、接続 */
export interface GrantProps {
  ownerUid?: string
  gen?: string
  /** 許可した接続（config/connector の connections の鍵）。TS の許可にはいつもある（無い許可は断る） */
  cid?: string
}

export type PairingCheck =
  | { ok: true; ownerUid: string; gen: string; cid: string }
  | { ok: false; reason: 'not_found' | 'uid' | 'hash' | 'expired' | 'used' | 'owner' | 'error'; message: string }

export type HealthState = 'ready' | 'unpaired' | 'no_identity' | 'anonymous_disabled' | 'key_missing' | 'unavailable'

export interface CallOptions {
  /** クライアントの名前（MCP の clientInfo か User-Agent） */
  client?: string
  /** 呼び出しの OAuth の許可の props（渡せば、いまの連携の許可かを確かめる。/mcp からはいつも渡す） */
  grant?: GrantProps
}

/** 読むツールの前に写しを新しくしない間（この時間の内に最後まで読んでいればそのまま。NS と同じ） */
export const FRESH_MS = 15_000
/** config/connector・meta/app を読み直す間隔（どのツールの前・トークンの更新の前も） */
export const RECHECK_MS = 60_000
/** 許可の接続が一覧に無い時、断る前に読み直す（この時間より前に読んだ一覧では断らない。古い写しで許可を取り消さない） */
export const CONNECTION_FRESH_MS = 5_000
/** 書き込みの日枠の残し（quota.ts に置いた。道具のファイルは core.ts を値で読み込まないので、そちらを読む） */
export { WRITE_RESERVE }

/** config/connector から読んだ、すべての接続に効く「書き込みを許可」と接続の一覧 */
export interface ConnectorState {
  writes: boolean
  /** 一覧の接続の cid（許可した時刻の順） */
  cids: string[]
  /** cid ごとの名前（topic_status の「この接続」） */
  names: Record<string, string>
  /** cid ごとの許可した時刻（ms） */
  pairedAt: Record<string, number | null>
}

/** 足す書き込みの組み立て（ctx.add の build が返す。試し直すたびに写しを読み直して呼ぶ） */
export type AddBuild = { ok: true; records: WritableRecord[] } | { ok: false; result: ToolResult }

/** 足す書き込みの結果。created は書けた記録（{表名}:{id}）。failed は、分けて書いた時に後の組が書けなかった訳 */
export type AddOutcome = { ok: true; created: Set<string>; failed?: string } | { ok: false; result: ToolResult }

export interface AddOptions {
  /** 書き込みの日枠のうち、この呼び出しが使わずに残しておく数（話題・版・辞書の束は WRITE_RESERVE。作れなかった印・訂正は 0） */
  reserve?: number
}

/**
 * ツールの中身に渡す物。deadlines は回の締め切り（useRun が入れる。答えの頭の1行に「書く係の締め切りまで n分・照合の打ち切りまで m分」）
 */
export interface ToolCallContext {
  /** 呼ばれたツールの名前（回の種類の表を引く） */
  tool: string
  grant?: GrantProps
  client?: string
  /** 呼び出しを受けた時刻（ms） */
  now: number
  deadlines?: RunDeadlines | null
  /**
   * その回（runId を必ず受ける道具だけ。vault/runs.ts の TOOL_RUN_KINDS が種類を持つ道具）。callTool が中身を呼ぶ前に、形・期限・
   * 終わった回・種類を確かめて入れる（中身の無い道具でも、種類で使えない回は断る）
   */
  run?: RunRow
  /** 回を使う: 形・期限・終わった回・種類を確かめ（違えば ConnectorError）、最後の呼び出しの時刻を進め、締め切りを答えの頭に入れる */
  useRun: (runId: unknown) => RunRow
  /** 写しを新しくする（forWrite = 書く前。最後まで読む）。note は答えに添える一文（前に取り込んだ内容で答える時など） */
  fresh: (forWrite: boolean) => Promise<{ note?: string }>
  /** 書き込みの前: 「書き込みを許可」とデータの形の版を確かめる（違えば ConnectorError） */
  requireWrites: () => Promise<void>
  /**
   * 足す: 書き込みの順番の中で、許可とデータの形の版を確かめ、写しを最後まで読み、build で記録を決めて書く（作るだけ。100件ずつの組）。
   * 同時に同じ記録が作られた（「もうある」）時は、写しを読み直して build をもう一度呼ぶ（3回まで）。書けた記録は写しにも入れる
   */
  add: (build: (attempt: number) => AddBuild | Promise<AddBuild>, opts?: AddOptions) => Promise<AddOutcome>
  /** 書き込みの順番（すべての接続で1つ）。待った後に許可をもう一度確かめる（stillGranted）こと */
  serialize: <T>(fn: () => Promise<T>) => Promise<T>
  /** 書き込みの順番を待った後・書く前に、呼び出しの許可をもう一度確かめる（クラウドは読まない） */
  stillGranted: () => void
  /** 日枠の読み取り・書き込みを数える（負の数で戻す）。上限を超えるなら数えずに false */
  takeReads: (n: number) => boolean
  takeWrites: (n: number) => boolean
  /** Firestore の失敗を、日本語の説明つきの失敗にする（403 は連携が解除されたかを確かめる） */
  firestoreFailure: (e: unknown) => Promise<never>
}

/** ツールの中身（名前ごと）。args は MCP の層で入力の形を確かめた後の物 */
export type ToolHandler = (core: VaultCore, args: Record<string, unknown>, ctx: ToolCallContext) => Promise<ToolResult>

/**
 * ツールの振り分け（名前 → 中身。設計の 1.2 の表の 16 の道具）。topic_status は連携していない時にも答えるので、callTool の始めで
 * 別に扱う（ここには入れない。NS の novel_status と同じ）。中身の置き場: 回を始める（runs.ts）・読む道具（tools/read.ts）・取りに行く
 * 道具（tools/fetch.ts。B4）・下書きと決まりの文（tools/drafts.ts。B5）・足す道具と訂正する話題を探す（tools/write.ts。B5）
 */
export const TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = {
  topic_get_guide: topicGetGuide,
  topic_list_candidates: topicListCandidates,
  topic_read_article: topicReadArticle,
  topic_list_recent: topicListRecent,
  topic_lookup_terms: topicLookupTerms,
  topic_find_topics: topicFindTopics,
  topic_list_drafts: topicListDrafts,
  topic_get_draft: topicGetDraft,
  topic_begin_run: topicBeginRun,
  topic_save_draft: topicSaveDraft,
  topic_check_draft: topicCheckDraft,
  topic_add_topics: topicAddTopics,
  topic_add_edition: topicAddEdition,
  topic_add_edition_fail: topicAddEditionFail,
  topic_add_correction: topicAddCorrection,
}

/** 連携していない時にも答えるツール（callTool の始めで別に扱う） */
export const STATUS_TOOL = 'topic_status'

const PAIRING_MESSAGES: Record<Exclude<PairingCheck, { ok: true }>['reason'], string> = {
  not_found:
    'アプリで許可された記録（config/connector）が見つからないか、別のコネクタのものです。アプリの連携の画面で［許可する］を押してから戻るか、claude.ai でもう一度「接続」からやり直してください。',
  uid: 'アプリで許可されたコネクタが、このコネクタではありません。claude.ai でもう一度「接続」からやり直してください。',
  hash: '連携の確かめが合いません（別の画面・別のブラウザで始めた接続の可能性）。claude.ai でもう一度「接続」からやり直してください。',
  expired: '連携の確かめの期限（15分）が過ぎました。claude.ai でもう一度「接続」からやり直してください。',
  used: 'この連携の確かめはもう使われています。claude.ai でもう一度「接続」からやり直してください。',
  owner: 'Topic Studio の持ち主（config/owner）が見つかりません。先にアプリで一度ログインして同期を始めてください。',
  error: '連携を確かめられませんでした。少し待ってから、claude.ai でもう一度「接続」からやり直してください。',
}

/** 日本時間の 時:分:秒 */
const jstClock = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(11, 19)

export class VaultCore {
  readonly store: MirrorStore
  readonly identity: Identity
  readonly fs: FirestoreRest
  readonly dictionary: Dictionary
  readonly mirror: Mirror
  readonly config: VaultConfig
  readonly outlets: OutletDirectory
  /** 出どころへ取りに行く fetch（B4） */
  readonly sourceFetch: typeof fetch
  /** 取りに行く中身（B4） */
  readonly fetchWork: FetchWork
  /** 待つ（取りに行く間・候補集めを待つ間。CPU を使わない） */
  readonly sleep: (ms: number) => Promise<void>
  readonly #d: VaultDeps
  readonly #now: () => number
  /** 書き込みの順番（すべての接続で1つ） */
  readonly #mutex = new Mutex()
  /**
   * 最後に読めた config/connector（at は読み始めた時刻、seq は読み始めた順の番号）。Durable Object は Firestore の答えを待つ間に
   * ほかの呼び出しも進めるので、遅く届いた古い一覧で、後から読み始めた一覧（足したばかりの接続を含む）を上書きしない
   */
  #connCheck: (ConnectorState & { at: number; seq: number }) | null = null
  /** config/connector を読み始めた数（#readConnector と verifyPairing。読み始めた順の番号に使う） */
  #connSeq = 0
  #modelCheck: { model: number | null; at: number } | null = null
  /** 動いている写しの取り込み（同時に1つだけ） */
  #sync: { seq: number; promise: Promise<SyncOutcome> } | null = null
  #syncSeq = 0
  /** 最後に最後まで読んだ時刻 */
  #lastSync = 0
  /** 写しが途中（最後まで読めていない1歩がある） */
  #behind = false
  /** 動いているやる事（同じやる事を alarm と道具の呼び出しで重ねない） */
  readonly #running = new Set<string>()

  constructor(deps: VaultDeps) {
    this.#d = deps
    this.#now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    this.config = deps.config
    this.outlets = deps.outlets ?? DEFAULT_OUTLETS
    this.fetchWork = deps.fetchWork ?? FETCH_WORK
    this.sourceFetch = deps.sourceFetch ?? deps.fetch
    this.store = new MirrorStore(deps.sql, this.#now)
    // Google の API への要求は、1回ごとに待つ上限を付ける（答えの来ない要求で、書き込みの順番を持ったまま止まらないように）
    const fetch = withTimeout(deps.fetch, deps.timeoutMs ?? REQUEST_TIMEOUT_MS)
    this.identity = new Identity({
      fetch,
      identityUrl: deps.config.identityUrl,
      tokenUrl: deps.config.tokenUrl,
      apiKey: deps.config.apiKey,
      secret: deps.secret,
      store: this.store,
      now: this.#now,
      sleep: this.sleep,
      onLost: () => this.#setUnpaired('identity_lost'),
    })
    this.fs = new FirestoreRest({
      fetch,
      baseUrl: deps.config.firestoreUrl,
      projectId: deps.config.projectId,
      token: (force) => this.identity.idToken(force),
      sleep: this.sleep,
    })
    this.dictionary = new Dictionary(this.store)
    this.mirror = new Mirror(this.store, this.dictionary, this.fs, () => this.pairing().ownerUid ?? '', this.#now)
  }

  /** 今の時刻（ms） */
  now(): number {
    return this.#now()
  }

  /** 回の id の乱数4字 */
  randomSuffix(): string {
    return this.#d.random?.() ?? randomRunSuffix()
  }

  // ---------- 連携の状態 ----------

  pairing(): PairingMeta {
    return this.store.getMeta<PairingMeta>('pairing') ?? { state: 'unpaired', ownerUid: null, pairedAt: null }
  }

  pairingState(): 'paired' | 'unpaired' {
    return this.pairing().state === 'paired' && this.identity.uid() ? 'paired' : 'unpaired'
  }

  /**
   * OAuth の許可が、いまの連携（同じ持ち主・同じ代）のものか（覚えた連携の状態だけで見る。クラウドは読まない）。［連携をすべて解除］の
   * 後に連携し直した・持ち主が変わった後は、前の許可は使えない（解除した Claude のアカウントが、別の連携で読めるようにならないように）
   */
  #grantMatchesPairing(p: GrantProps | null | undefined): boolean {
    if (this.pairingState() !== 'paired' || !p) return false
    const m = this.pairing()
    return !!m.ownerUid && !!m.gen && p.ownerUid === m.ownerUid && p.gen === m.gen
  }

  /**
   * トークンの更新の前（index.ts の tokenExchangeCallback）: 許可が、いまの連携の、一覧にある接続のものか。
   * 一覧は RECHECK_MS ごとに読み直し、無い接続は5秒以内に読み直してから断る。つながらない・Firebase の無料枠などの一時的な失敗では
   * 切らない（true）。解除された・一覧から外された接続・接続の無い許可は false（ライブラリがその許可だけを取り消す）
   */
  async checkGrant(p: GrantProps | null | undefined): Promise<boolean> {
    if (!p || !p.cid || !this.#grantMatchesPairing(p)) return false
    try {
      await this.#requireConnection(p)
      return true
    } catch (e) {
      if (e instanceof ConnectorError && isAuthProblem(e.code)) return false
      if (!(e instanceof ConnectorError)) logError('grant_check_failed', e)
      return true
    }
  }

  #setUnpaired(reason: string): void {
    const cur = this.pairing()
    if (cur.state !== 'unpaired') log('pairing_lost', { reason })
    // 持ち主は覚えておく（同じ持ち主と連携し直せば、写しをそのまま使える）
    this.store.setMeta('pairing', { ...cur, state: 'unpaired', reason } satisfies PairingMeta)
    this.#connCheck = null
    this.#modelCheck = null
    // 連携していない間も、回の期限の片付け（回の覚え書き・資料の控えを消す）だけは続ける（D21 の守り 7。クラウド・出どころへは出ない）
    this.#d.schedule?.(this.store.task('expire')?.at ?? null)
  }

  // ---------- /connect/identity・GET / ----------

  /** アプリの連携の画面に渡すコネクタの身元（無ければ作る） */
  async connectIdentity(): Promise<{ uid: string; version: string; model: number }> {
    try {
      let uid = await this.identity.ensure()
      // 身元がまだ使えるか確かめる（使えなければ新しい身元を作る。アプリが古い uid で許可しないように）
      try {
        await this.identity.idToken()
      } catch (e) {
        if (!(e instanceof ConnectorError && e.code === 'identity_lost')) throw e
        uid = await this.identity.ensure()
      }
      this.store.deleteMeta('lastIdentityError')
      return { uid, version: CONNECTOR_VERSION, model: CONNECTOR_MODEL }
    } catch (e) {
      if (e instanceof ConnectorError) this.store.setMeta('lastIdentityError', e.code)
      throw e
    }
  }

  health(): HealthState {
    const err = this.store.getMeta<string>('lastIdentityError')
    if (!this.identity.uid()) {
      if (err === 'anonymous_disabled' || err === 'key_missing' || err === 'unavailable') return err
      return 'no_identity'
    }
    return this.pairingState() === 'paired' ? 'ready' : 'unpaired'
  }

  // ---------- 連携の確かめ（/pair/callback） ----------

  /**
   * アプリが書いた config/connector を、コネクタの身元で読んで確かめる: uid がこのコネクタ・指紋が同じ・15分以内・まだ使っていない。
   * 指紋は接続ごと（15分の間に2つ許可しても、それぞれの指紋で確かめられる）。指紋の合う接続がちょうど1つの時だけ、その接続（cid）の
   * 許可にする（NS の 2.9 と同じ）。持ち主が変わった時は写しを消して取り込み直す。連携の後、写しの取り込みを alarm で始める
   */
  async verifyPairing(hash: string): Promise<PairingCheck> {
    const bad = (reason: Exclude<PairingCheck, { ok: true }>['reason']): PairingCheck => {
      log('pairing_refused', { reason })
      return { ok: false, reason, message: PAIRING_MESSAGES[reason] }
    }
    if (!isPairingHash(hash)) return bad('hash')
    const used = this.store.getMeta<string[]>('usedPairings') ?? []
    if (used.includes(hash)) return bad('used')
    let uid: string
    try {
      uid = await this.identity.ensure()
    } catch (e) {
      logError('pairing_identity_failed', e)
      return bad('error')
    }
    let ownerUid: string | null = null
    try {
      const owner = (await this.fs.batchGet(['config/owner'])).get('config/owner')
      const v = owner ? fromFields(owner.fields).uid : null
      ownerUid = typeof v === 'string' && v ? v : null
    } catch (e) {
      logError('pairing_owner_failed', e)
      return bad('error')
    }
    if (!ownerUid) return bad('owner')
    let conn: Record<string, unknown> | null = null
    let gen = ''
    const seq = ++this.#connSeq
    const startedAt = this.#now()
    try {
      const d = (await this.fs.batchGet(['config/connector'])).get('config/connector')
      conn = d ? fromFields(d.fields) : null
      gen = d?.createTime ?? ''
    } catch (e) {
      // 無い記録・自分の uid でない記録は、アクセスルールで読めない（403。どちらかは分からない）
      if (e instanceof FirestoreError && e.status === 403) return bad('not_found')
      logError('pairing_connector_failed', e)
      return bad('error')
    }
    if (!conn || !gen) return bad('not_found')
    if (conn.uid !== uid) return bad('uid')
    // 正しい接続が1つも無ければ、解除と同じ
    const list = connectionsOf(conn, plainMillis)
    if (!list) return bad('not_found')
    const hits = list.filter((c) => c.pairing === hash)
    if (hits.length !== 1) return bad('hash')
    const entry = hits[0]
    // 期限は、その接続の許可の時刻から（ほかの接続・最後の許可の時刻ではなく）
    const pairedAt = entry.pairedAt
    const now = this.#now()
    if (pairedAt === null || now - pairedAt > PAIRING_TTL_MS || pairedAt - now > 2 * 60_000) return bad('expired')
    this.store.setMeta('usedPairings', [...used, hash].slice(-50))
    const prev = this.pairing()
    if (prev.ownerUid && prev.ownerUid !== ownerUid) {
      // 持ち主が変わった: 前の持ち主の写し・辞書・回の物を消して、最初から取り込み直す
      log('mirror_owner_changed')
      this.mirror.reset()
      for (const r of this.store.runs()) this.store.deleteRun(r.runId)
      this.#lastSync = 0
      this.#behind = false
    }
    // 確かめている間に、後から読み始めた同じ記録の一覧が届いていれば、そちらを覚えたままにする（新しい）
    const cached = this.#connCheck
    const state =
      cached && cached.seq > seq && prev.gen === gen ? cached : { ...connectorStateOf(conn, list), at: startedAt, seq }
    this.store.setMeta('pairing', { state: 'paired', ownerUid, pairedAt, gen, cids: state.cids } satisfies PairingMeta)
    this.#connCheck = state
    this.#modelCheck = null
    log('paired', { writes: state.writes, connections: state.cids.length })
    // 写しの取り込みを alarm で始める（NS の now + 500）。気象庁の見張りは data が 'ok' の時だけ
    this.store.putTask('mirror', now + 500)
    this.#ensureJmaTask(now)
    this.#reschedule()
    this.store.flushRows()
    return { ok: true, ownerUid, gen, cid: entry.cid }
  }

  // ---------- 数の記録（太平洋時間の日ごと） ----------

  #quota(): QuotaCounts {
    return freshQuota(this.#now(), this.store.getMeta<QuotaCounts>('quota'))
  }

  /** 読み取りを数える（負の数で戻す）。上限を超えるなら数えずに false */
  #takeReads(n: number): boolean {
    const q = this.#quota()
    if (n > 0 && q.reads + n > this.#d.config.dailyReadBudget) return false
    this.store.setMeta('quota', { ...q, reads: Math.max(0, q.reads + n) } satisfies QuotaCounts)
    return true
  }

  /** 止めずに数えるだけ（連携の記録・データの形の版など、無いと何もできない読み取り） */
  #countReads(n: number): void {
    const q = this.#quota()
    this.store.setMeta('quota', { ...q, reads: q.reads + n } satisfies QuotaCounts)
  }

  /** 書き込みを数える（負の数で戻す。書けなかった分）。上限を超えるなら数えずに false */
  #takeWrites(n: number, reserve = 0): boolean {
    const q = this.#quota()
    if (n > 0 && q.writes + n + reserve > this.#d.config.dailyWriteBudget) return false
    this.store.setMeta('quota', { ...q, writes: Math.max(0, q.writes + n) } satisfies QuotaCounts)
    return true
  }

  /** 今日（太平洋時間）の読み取り・書き込みの数（topic_status の「足りる／残りが少ない」に使う。数は答えに出さない） */
  quota(): QuotaCounts {
    return this.#quota()
  }

  /**
   * 書き込みの日枠に、この呼び出しの分が入らなければ、全体を断る（一部だけは書かない）。断る文に数は出さない（D21。どの回が何件
   * 書いたかが数の差で分からないように）
   */
  #needWrites(prepared: readonly PreparedWrite[], reserve: number): void {
    if (this.#takeWrites(prepared.length, reserve)) return
    throw new ConnectorError(
      'write_budget',
      `今日のコネクタ用の書き込み枠が足りません（アプリの同期を守るため。すべての接続を合わせて数えます）。何も書いていません。${resetLabel(this.#now())}に回復します。`,
    )
  }

  /** 読み取りの枠が足りずに取り込めなかった（書き込みの前なら、最新の変更を確かめられないので書かない。数は出さない） */
  #readBudgetError(forWrite: boolean): ConnectorError {
    const tail = forWrite ? '書く前に端末からの最新の変更を確かめられないため、何も書いていません。' : ''
    return new ConnectorError(
      'read_budget',
      `今日のコネクタ用の読み取り枠が足りません（アプリの同期を守るため。すべての接続を合わせて数えます）。${tail}${resetLabel(this.#now())}に回復します。`,
    )
  }

  // ---------- クラウドの記録 ----------

  /** Firestore の失敗を、日本語の説明つきの失敗にする（403 は連携が解除されたかを確かめる） */
  async #firestoreFailure(e: unknown): Promise<never> {
    if (e instanceof ConnectorError) throw e
    if (e instanceof FirestoreError) {
      if (e.code === 'RESOURCE_EXHAUSTED' || e.status === 429)
        throw new ConnectorError('firestore_quota', firestoreQuotaMessage(this.#now()))
      if (e.status === 403) {
        if ((await this.#readConnector()) === null) throw new ConnectorError('unpaired', MESSAGES.unpaired)
        throw new ConnectorError('permission', MESSAGES.permission)
      }
      logError('firestore_failed', e, { status: e.status, code: e.code })
      throw new ConnectorError('unavailable', MESSAGES.unavailable)
    }
    logError('vault_failed', e)
    throw new ConnectorError('unavailable', MESSAGES.unavailable)
  }

  /**
   * config/connector を読む。「書き込みを許可」と接続の一覧を返す（読めない・このコネクタのものでない・確かめた連携の後に作り直された・
   * 正しい接続が1つも無い = null。作り直された記録は、連携の画面で許可しただけでまだ確かめていない（/pair/callback を通っていない）
   * ので、前の許可では使わない）。読めた内容は #connCheck に覚え、接続の一覧が変わった時だけ連携の状態にも残す。null の時は連携を外す。
   * 読み始めた順で覚える: 後から読み始めた読み取り・確かめ（verifyPairing）の一覧がもう届いていれば、この答えは捨ててそちらを返す。
   * null の答えも、後から読み取り・確かめを始めていれば連携は外さない（連携し直した後に届いた古い答えで、新しい連携を外さない）
   */
  async #readConnector(): Promise<ConnectorState | null> {
    const seq = ++this.#connSeq
    const at = this.#now()
    let state: ConnectorState | null = null
    try {
      this.#countReads(3)
      const d = (await this.fs.batchGet(['config/connector'])).get('config/connector')
      if (d && (d.createTime ?? '') === (this.pairing().gen ?? '')) {
        const f = fromFields(d.fields)
        const list = f.uid === this.identity.uid() ? connectionsOf(f, plainMillis) : null
        if (list) state = connectorStateOf(f, list)
      }
    } catch (e) {
      if (!(e instanceof FirestoreError && e.status === 403)) {
        if (e instanceof ConnectorError) throw e
        logError('connector_read_failed', e)
        throw new ConnectorError('unavailable', MESSAGES.unavailable)
      }
    }
    if (!state) {
      if (seq < this.#connSeq) log('connector_gone_superseded')
      else this.#setUnpaired('connector_gone')
      return null
    }
    const cached = this.#connCheck
    if (cached && cached.seq > seq) return cached
    this.#connCheck = { ...state, at, seq }
    const m = this.pairing()
    const before = m.cids ?? []
    if (m.state === 'paired' && (before.length !== state.cids.length || before.some((c) => !state.cids.includes(c))))
      this.store.setMeta('pairing', { ...m, cids: state.cids } satisfies PairingMeta)
    return state
  }

  #requirePaired(): void {
    if (this.pairingState() !== 'paired') throw new ConnectorError('unpaired', MESSAGES.unpaired)
  }

  /** users/{owner}/meta/app の model（無い = null） */
  async #readModel(): Promise<number | null> {
    const owner = this.pairing().ownerUid
    if (!owner) throw new ConnectorError('unpaired', MESSAGES.unpaired)
    try {
      this.#countReads(3)
      const d = (await this.fs.batchGet([`users/${owner}/meta/app`])).get(`users/${owner}/meta/app`)
      const m = d ? fromFields(d.fields).model : null
      const model = typeof m === 'number' ? m : null
      this.#modelCheck = { model, at: this.#now() }
      return model
    } catch (e) {
      return this.#firestoreFailure(e)
    }
  }

  /**
   * どのツールの前も・トークンの更新の前も: config/connector を前に読んでから RECHECK_MS 経っていれば読み直す（記録が消された・
   * 作り直された・正しい接続が無いなら連携を外す。つながらない時は前に読んだ内容のまま）。許可（p）の接続が一覧に無ければ、
   * 5秒より前に読んだ一覧なら1回読み直し、それでも無ければこの許可だけを断る（Vault の連携は外さない。ほかの接続はそのまま使える。
   * 古い一覧では断らないので、足したばかりの接続の許可を取り消さない）
   */
  async #requireConnection(p?: GrantProps): Promise<void> {
    if (!this.#connCheck || this.#now() - this.#connCheck.at >= RECHECK_MS) {
      try {
        await this.#readConnectorOrUnpair()
      } catch (e) {
        // つながらない時は、前に読んだ内容（無ければ連携の状態に残した一覧）で続ける
        if (!(e instanceof ConnectorError && e.code === 'unavailable')) throw e
      }
    }
    if (!p) return
    this.#requireGrantCurrent(p)
    if (this.#listed(p.cid)) return
    if (!this.#connCheck || this.#now() - this.#connCheck.at >= CONNECTION_FRESH_MS) {
      // 読めなければ断らずに失敗にする（つながらない時の答え。許可は取り消さない）
      await this.#readConnectorOrUnpair()
      this.#requireGrantCurrent(p)
      if (this.#listed(p.cid)) return
    }
    log('grant_removed')
    throw new ConnectorError('unpaired', MESSAGES.unpaired)
  }

  /**
   * 読んでいる間に、すべて解除して連携し直した（代が変わった）・連携が外れた時は、前の連携の許可を断る（呼び出しの始めに
   * 確かめた代は、読み取りを待つ間に古くなることがある。一覧に同じ cid があっても、前の代の許可は使わない）
   */
  #requireGrantCurrent(p: GrantProps): void {
    if (this.#grantMatchesPairing(p)) return
    log('grant_stale')
    throw new ConnectorError('unpaired', MESSAGES.unpaired)
  }

  /** 許可の接続が一覧にあるか（最後に読めた一覧。まだ読んでいなければ連携の状態に残した一覧。接続の無い許可は false） */
  #listed(cid: string | undefined): boolean {
    if (!cid) return false
    return (this.#connCheck?.cids ?? this.pairing().cids ?? []).includes(cid)
  }

  /** config/connector を読む。消された・作り直された・正しい接続が無い時は unpaired（連携を外すのは #readConnector） */
  async #readConnectorOrUnpair(): Promise<ConnectorState> {
    const conn = await this.#readConnector()
    if (conn === null) throw new ConnectorError('unpaired', MESSAGES.unpaired)
    return conn
  }

  /**
   * 書き込みの前: 「書き込みを許可」とデータの形の版を確かめる。前に読んだ内容は1分（RECHECK_MS）使うが、断る内容（停止中・版が
   * 違う）は5秒（CONNECTION_FRESH_MS）まで: それより前に読んだ内容なら、断る前に1回読み直す（作者が「書き込みを許可」をオンに
   * 戻した・アプリを更新した後に、どの接続も1分ほど断られ続けないように）
   */
  async #requireWrites(): Promise<void> {
    const now = this.#now()
    const c = this.#connCheck
    const writes =
      c && now - c.at < (c.writes ? RECHECK_MS : CONNECTION_FRESH_MS) ? c.writes : (await this.#readConnectorOrUnpair()).writes
    if (!writes) throw new ConnectorError('writes_off', MESSAGES.writesOff)
    const m = this.#modelCheck
    const model =
      m && now - m.at < (m.model === CONNECTOR_MODEL ? RECHECK_MS : CONNECTION_FRESH_MS) ? m.model : await this.#readModel()
    if (model !== CONNECTOR_MODEL) throw new ConnectorError('model_mismatch', modelMismatchMessage(model, CONNECTOR_MODEL))
  }

  /**
   * 書き込みの順番を待った後・書く前に、呼び出しの許可をもう一度確かめる（クラウドは読まない。最後に読めた一覧で見る）。
   * ほかの接続の書き込みを待つ間に、この接続が一覧から外された・すべて解除して連携し直された時は書かない（アクセスルールは
   * 接続を見分けられない）。足したばかりの接続は、後から読んだ一覧にもあるので断らない
   */
  #stillGranted(p: GrantProps | undefined): void {
    if (!p) return
    this.#requireGrantCurrent(p)
    if (this.#listed(p.cid)) return
    log('grant_removed', { waited: true })
    throw new ConnectorError('unpaired', MESSAGES.unpaired)
  }

  /** 最後に読めた接続の一覧（topic_status の「この接続」。まだ読んでいなければ null） */
  connectorState(): ConnectorState | null {
    return this.#connCheck
  }

  // ---------- 写し ----------

  /**
   * 写しを1歩新しくする。同時に動く取り込みは1つだけ（重ねると同じページを何回も読み、遅れて届いた古いページが写しを戻す。NS と同じ）。
   * 動いている1歩があれば: own = false（読むツール・alarm）はその1歩に相乗りし、own = true（書き込みの前・書き込みの試し直し・夜の
   * 確かめ）は呼ばれる前に始まった1歩の終わりを待ってから、自分の1歩を始める。取り込みは書き込みの順番（#mutex）を待たない
   */
  async #syncStep(maxPages: number, own = false): Promise<SyncOutcome> {
    const arrived = this.#syncSeq
    for (let cur = this.#sync; cur; cur = this.#sync) {
      if (!own || cur.seq > arrived) return cur.promise
      await cur.promise
    }
    const seq = ++this.#syncSeq
    const promise = this.#runSync(maxPages).finally(() => {
      if (this.#sync?.seq === seq) this.#sync = null
    })
    this.#sync = { seq, promise }
    return promise
  }

  async #runSync(maxPages: number): Promise<SyncOutcome> {
    // 1ページ目を入れた後に失敗しても途中のまま（下ろすのは最後まで読めた時だけ）
    this.#behind = true
    try {
      const out = await this.mirror.sync({
        maxPages,
        workBudget: this.#d.config.workBudgetChars,
        takeReads: (n) => this.#takeReads(n),
      })
      if (out.done) {
        this.#lastSync = this.#now()
        this.#behind = false
      }
      return out
    } catch (e) {
      return this.#firestoreFailure(e)
    }
  }

  #warmingMessage(): string {
    const w = this.mirror.warm()
    const progress = w.total
      ? `（${w.seen.toLocaleString('ja-JP')}/${w.total.toLocaleString('ja-JP')}件）`
      : `（${w.seen.toLocaleString('ja-JP')}件）`
    return `初回の取り込み中${progress}。少し待ってから、もう一度試してください。`
  }

  /** 1日の行の予算を使い切って取り込みを止めている（UTC の 0時 = 日本時間 9時に戻る） */
  #rowsSpentMessage(): string {
    return 'コネクタの今日の保存の枠（行の書き込み）を使い切ったため、写しの取り込みを止めています。日本時間 9時の後に続けます。'
  }

  /** 写しの続きを alarm に置く */
  #continueMirror(at: number): void {
    this.store.putTask('mirror', at)
    this.#reschedule()
  }

  /**
   * ツールの前に写しを新しくする。初回の取り込みが終わっていなければ1歩進めて「取り込み中」を返す。
   * 書き込みの前は最後まで読む（「もうある」を見分けるため）。5歩で読み終わらなければ書かない（catching_up）。
   * 読むツールの前は、30日を過ぎた行を写しから消す（日本時間の日が変わった時だけ）
   */
  async #fresh(forWrite: boolean): Promise<{ note?: string }> {
    this.mirror.expire(this.#now())
    if (!this.mirror.warm().done) {
      const out = await this.#syncStep(8, forWrite)
      if (out.outOfReads) throw this.#readBudgetError(forWrite)
      if (out.outOfRows) throw new ConnectorError('warming', this.#rowsSpentMessage())
      if (!out.done) {
        this.#continueMirror(this.#now() + 1_000)
        throw new ConnectorError('warming', this.#warmingMessage())
      }
      return {}
    }
    if (forWrite) {
      let docs = 0
      for (let i = 0; i < 5; i++) {
        const out = await this.#syncStep(8, true)
        docs += out.docs
        if (out.done) return {}
        if (out.outOfReads) throw this.#readBudgetError(true)
        if (out.outOfRows) throw new ConnectorError('catching_up', this.#rowsSpentMessage())
      }
      this.#continueMirror(this.#now() + 1_000)
      log('write_catching_up', { docs })
      throw new ConnectorError(
        'catching_up',
        `端末からの変更を取り込んでいる途中です（この呼び出しで ${docs.toLocaleString('ja-JP')}件を取り込みました）。何も書いていません。少し待ってから、もう一度試してください。`,
      )
    }
    const out = await this.#freshRead()
    // 待っている間に写しを消して取り込み直すことになった（持ち主が変わった）
    if (!this.mirror.warm().done) {
      this.#continueMirror(this.#now() + 1_000)
      throw new ConnectorError('warming', this.#warmingMessage())
    }
    return out
  }

  /**
   * 読むツールの前: 動いている取り込みがあれば、その終わりを待つ。終わっていれば（最後まで読んだ・15秒以内に最後まで読んで、その後の
   * 1歩が途中で終わっていない）そのまま、まだなら1歩進める（それでも途中なら「取り込みの途中の内容です」と添える）
   */
  async #freshRead(): Promise<{ note?: string }> {
    const reset = () => resetLabel(this.#now())
    try {
      const running = this.#sync
      if (running) {
        const out = await running.promise
        if (out.done) return {}
        if (out.outOfReads)
          return { note: `（今日の読み取り枠が足りないため、最新の変更を取り込めていません。${reset()}に回復します）` }
      } else if (!this.#behind && this.#now() - this.#lastSync < (this.#d.freshMs ?? FRESH_MS)) return {}
      const out = await this.#syncStep(8)
      if (out.done) return {}
      if (out.outOfReads)
        return { note: `（今日の読み取り枠が足りないため、最新の変更を取り込めていません。${reset()}に回復します）` }
      if (out.outOfRows) return { note: `（${this.#rowsSpentMessage()}前に取り込んだ内容です）` }
    } catch (e) {
      // つながらない時・Firebase の無料枠を使い切った時は前に取り込んだ内容で答える（連携の解除・権限の問題はそのまま返す）
      if (e instanceof ConnectorError && e.code === 'unavailable')
        return { note: '（いまクラウドに接続できないため、前に取り込んだ内容です）' }
      if (e instanceof ConnectorError && e.code === 'firestore_quota')
        return { note: `（Firebase の今日の無料枠を使い切ったため、前に取り込んだ内容です。${reset()}に回復します）` }
      throw e
    }
    this.#continueMirror(this.#now() + 1_000)
    return { note: '（端末からの変更が多いため、取り込みの途中の内容です）' }
  }

  // ---------- 足す（書き込み） ----------

  /** ctx.add の中身（NS の #write の形） */
  #add(
    grant: GrantProps | undefined,
    build: (attempt: number) => AddBuild | Promise<AddBuild>,
    opts: AddOptions = {},
  ): Promise<AddOutcome> {
    return this.#mutex.run(async () => {
      await this.#requireWrites()
      await this.#fresh(true)
      const owner = this.pairing().ownerUid!
      const created = new Set<string>()
      for (let attempt = 0; ; attempt++) {
        this.#stillGranted(grant)
        const built = await build(attempt)
        if (!built.ok) return built
        let prepared: PreparedWrite[]
        try {
          prepared = built.records.map((r) => prepareWrite(this.fs, owner, r))
        } catch (e) {
          if (e instanceof EncodeError) return { ok: false, result: fail(e.message) }
          throw e
        }
        if (!prepared.length) return { ok: true, created }
        this.#needWrites(prepared, opts.reserve ?? 0)
        let done: 'done' | 'retry'
        try {
          done = await this.#commitPrepared(prepared, created, attempt)
        } catch (e) {
          // 分けて書いた時に、前の組だけ書けた: 書けた分を返し、残りは書けなかったことを添える（何も書いていないように見せない）
          if (!created.size || !(e instanceof ConnectorError)) throw e
          log('records_partly_created', { count: created.size, code: e.code })
          return { ok: true, created, failed: e.message }
        }
        if (done === 'retry') continue
        log('records_created', { count: created.size })
        return { ok: true, created }
      }
    })
  }

  /**
   * 作る記録を書き、書けた記録を写しにも入れる（created に {表名}:{id} を足す）。同時に同じ記録が作られた時は読み直して 'retry'
   * （3回目まで。呼び出し側で組み立て直す）。ほかの失敗は日本語の説明つきの失敗にする。書き込みの数は書く前に prepared の分を数え、
   * 書けなかった組の分は戻す（NS の #commitPrepared と同じ決まり: 書けたか分からない組は戻さない・前の試しの答えが届かずに
   * 試し直して「もうある」になった時は、写しのこのコネクタの同じ内容の記録なら、この呼び出しで書けた物にする）
   */
  async #commitPrepared(prepared: PreparedWrite[], created: Set<string>, attempt: number): Promise<'done' | 'retry'> {
    let committed = 0
    let sent: PreparedWrite[] = []
    try {
      for (const g of groups(prepared)) {
        sent = g
        const res = await this.fs.commit(g.map((p) => p.write))
        committed += g.length
        this.mirror.putOwn(g, res)
        for (const p of g) created.add(`${p.table}:${p.id}`)
      }
      return 'done'
    } catch (e) {
      // 送っていない後の組は書いていない
      this.#takeWrites(committed + sent.length - prepared.length)
      if (
        e instanceof FirestoreError &&
        (e.code === 'ALREADY_EXISTS' || e.code === 'FAILED_PRECONDITION' || e.code === 'ABORTED' || e.status === 409) &&
        attempt < 3
      ) {
        log('write_retry', { code: e.code, attempt })
        let unwritten = e.afterUnsure ? 0 : sent.length
        try {
          await this.sleep(100 + Math.floor(Math.random() * 200) * (attempt + 1))
          // 断られた後のクラウドを読む（先に始まった取り込みに相乗りしない）
          const out = await this.#syncStep(8, true)
          if (out.outOfReads) throw this.#readBudgetError(true)
          // 差分の読み取りで見えない（写しが知らない）文書は、名前を指定して確かめる（NS と同じ）
          const left = prepared.filter((p) => !created.has(`${p.table}:${p.id}`)).map((p) => `${p.table}:${p.id}`)
          if (left.length && this.#takeReads(left.length + 2)) {
            try {
              await this.mirror.fetchNames(left)
            } catch (err) {
              return this.#firestoreFailure(err)
            }
          }
          // 前の試しで書けていた（答えが届かずに試し直して「もうある」になった）この組の記録
          if (e.afterUnsure) for (const p of sent) if (this.#isOwnRecord(p)) created.add(`${p.table}:${p.id}`)
          unwritten = sent.filter((p) => !created.has(`${p.table}:${p.id}`)).length
        } finally {
          this.#takeWrites(-unwritten)
        }
        return 'retry'
      }
      if (e instanceof FirestoreError && (e.status === 0 || e.status >= 500 || e.afterUnsure))
        log('write_outcome_unknown', { count: sent.length, status: e.status })
      else this.#takeWrites(-sent.length)
      if (e instanceof FirestoreError && e.status === 403) {
        const conn = await this.#readConnectorOrUnpair()
        if (!conn.writes) throw new ConnectorError('writes_off', MESSAGES.writesOff)
      }
      return this.#firestoreFailure(e)
    }
  }

  /** 写しに、このコネクタが書いた同じ内容の記録がある */
  #isOwnRecord(p: PreparedWrite): boolean {
    const row = this.store.getMirror(`${p.table}:${p.id}`)
    return Boolean(row && row.device === CONNECTOR_DEVICE && row.hash === p.hash)
  }

  // ---------- ツール ----------

  /**
   * ツールを呼ぶ（/mcp の tools/call から RPC で）。前の連携の許可・連携していない・一覧から外された接続は断り（auth: HTTP 401）、
   * ツールの中身（TOOL_HANDLERS）へ振り分ける。topic_status は連携していない時にも答える。答えの頭に今の時刻の1行を付ける
   * （回の締め切りは中身が ctx.useRun で回を読んだ時だけ）
   */
  async callTool(name: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<ToolResult> {
    const ctx: ToolCallContext = {
      tool: name,
      grant: opts.grant,
      client: opts.client,
      now: this.#now(),
      deadlines: null,
      useRun: (runId) => useRun(this.store, ctx, runId),
      fresh: (forWrite) => this.#fresh(forWrite),
      requireWrites: () => this.#requireWrites(),
      add: (build, o) => this.#add(opts.grant, build, o),
      serialize: (fn) => this.#mutex.run(fn),
      stillGranted: () => this.#stillGranted(opts.grant),
      takeReads: (n) => this.#takeReads(n),
      takeWrites: (n) => this.#takeWrites(n),
      firestoreFailure: (e) => this.#firestoreFailure(e),
    }
    const head = () => headLine(this.#now(), ctx.deadlines)
    try {
      // 前の連携の許可（解除した後・持ち主が変わった後）は、状態のツールも含めて使わない（覚えた連携の状態だけで見る）
      if (opts.grant && !this.#grantMatchesPairing(opts.grant)) {
        log('grant_stale', { tool: name })
        throw new ConnectorError('unpaired', MESSAGES.unpaired)
      }
      if (name === STATUS_TOOL) return withHead(await this.#status(args, ctx), head())
      this.#requirePaired()
      // 連携の記録を1分ごとに確かめる（どのツールも。解除・作り直し・一覧から外された接続に気付く）
      await this.#requireConnection(opts.grant)
      const handler = Object.hasOwn(TOOL_HANDLERS, name) ? TOOL_HANDLERS[name] : undefined
      if (!handler) return withHead(fail(`知らないツールです（${name}）。ツールの一覧を読み直してください。`), head())
      // 回を必ず受ける道具は、中身の前に回を確かめる（種類の表は vault/runs.ts の TOOL_RUN_KINDS）
      if (Object.hasOwn(TOOL_RUN_KINDS, name) && TOOL_RUN_KINDS[name]) ctx.run = ctx.useRun(args.runId)
      return withHead(await handler(this, args, ctx), head())
    } catch (e) {
      if (e instanceof ConnectorError) {
        log('tool_refused', { tool: name, code: e.code })
        return { ...withHead({ text: e.message, isError: true }, head()), auth: isAuthProblem(e.code) || undefined }
      }
      logError('tool_failed', e, { tool: name })
      return withHead({ text: MESSAGES.unavailable, isError: true }, head())
    } finally {
      this.store.flushRows()
    }
  }

  /**
   * topic_status（設計の 1.2 の 1）: 連携・書き込みの許可・データの形の版（毎回クラウドを読む。NS の novel_status と同じ形）と、
   * 写しの新しさ・今日の枠・版・枠・出どころの状態（tools/read.ts の statusDetails）。連携していない時は、連携していないことだけを返す
   */
  async #status(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    const p = this.pairing()
    const paired = this.pairingState() === 'paired'
    const lines = [`Topic Studio コネクタ ${CONNECTOR_VERSION}（データの形 ${CONNECTOR_MODEL}）`]
    if (!paired) {
      lines.push('連携: していません（claude.ai でコネクタに接続し、アプリで許可してください）')
      return { text: lines.join('\n'), auth: this.identity.uid() ? true : undefined, isError: true }
    }
    // 「連携: 済み（…）」の時刻は、記録を読んだ後に決める（呼び出した接続の許可の時刻）
    lines.push('')
    let writes: boolean | null = this.#connCheck?.writes ?? null
    let model: number | null = this.#modelCheck?.model ?? null
    const grant = ctx.grant
    try {
      const conn = await this.#readConnector()
      if (conn === null) return { text: MESSAGES.unpaired, isError: true, auth: true }
      // 読んでいる間にすべて解除して連携し直された（前の代の許可）: 一覧に同じ cid があっても断る
      if (grant && !this.#grantMatchesPairing(grant)) {
        log('grant_stale', { tool: STATUS_TOOL })
        return { text: MESSAGES.unpaired, isError: true, auth: true }
      }
      // 一覧から外された接続（いま読んだ一覧に無い）: この許可だけを断る
      if (grant && !conn.cids.includes(grant.cid ?? '')) {
        log('grant_removed', { tool: STATUS_TOOL })
        return { text: MESSAGES.unpaired, isError: true, auth: true }
      }
      writes = conn.writes
      model = await this.#readModel()
    } catch (e) {
      if (e instanceof ConnectorError && isAuthProblem(e.code)) return { text: e.message, isError: true, auth: true }
      lines.push('（クラウドの設定を読めませんでした）')
    }
    const listed = this.#connCheck
    const cid = grant?.cid ?? ''
    const pairedAt = (grant && listed?.cids.includes(cid) ? listed.pairedAt[cid] : null) ?? p.pairedAt
    lines[1] = `連携: 済み（${pairedAt ? new Date(pairedAt + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ') : '―'} 日本時間）`
    lines.push(`書き込み: ${writes ? '許可' : '停止中（アプリの 設定 →「Claude との連携」→「書き込みを許可」）'}`)
    lines.push(
      `アプリのデータの形: ${model ?? '記録なし'}${model === CONNECTOR_MODEL ? '（一致）' : `（コネクタは ${CONNECTOR_MODEL}。書き込みは止まります）`}`,
    )
    // 写しの新しさ（初めての取り込みの途中・つながらない時も、状態は返す）
    let freshness: string
    try {
      const { note } = await this.#fresh(false)
      freshness = note
        ? `写し: ${note}`
        : `写し: 新しい（最後に新しくした時刻 ${this.#lastSync ? jstClock(this.#lastSync) : '―'}）`
    } catch (e) {
      if (e instanceof ConnectorError && isAuthProblem(e.code)) return { text: e.message, isError: true, auth: true }
      freshness = e instanceof ConnectorError ? `写し: ${e.message}` : '写し: （新しくできませんでした）'
    }
    lines.push(...(await statusDetails(this, args, ctx, freshness)))
    // 接続が2つ以上ある時は、今日の枠がすべての接続を合わせた数であること
    if ((listed?.cids ?? p.cids ?? []).length >= 2) lines.push('（今日の枠は、すべての接続を合わせて数えます）')
    // 許可のある呼び出し（/mcp）だけ、最後にこの接続の名前（いつも最後の行）
    const conn = grant ? this.#connCheck : null
    if (conn && conn.cids.includes(cid))
      lines.push(
        `この接続: ${conn.names[cid]}（接続 ${conn.cids.length} / ${MAX_CONNECTIONS}。名前はアプリの 設定 →「Claude との連携」で変えられます）`,
      )
    return { text: lines.join('\n') }
  }

  // ---------- やる事（alarm）・夜の仕事（cron） ----------

  /** やる事の表を替えた後（B4・B5）: いちばん早いやる事の時刻に alarm を置き直す */
  reschedule(): void {
    this.#reschedule()
  }

  /** いちばん早いやる事の時刻に alarm を置き直す（alarm は1つの DO に1つだけ） */
  #reschedule(): void {
    if (this.pairingState() !== 'paired') return
    const at = this.store.nextTaskAt()
    if (at !== null) this.#d.schedule?.(at)
  }

  /** 気象庁の見張りを置く・外す（気象庁の data が 'ok' の時だけ置く。'trial-only' の間は置かない） */
  #ensureJmaTask(now: number): void {
    if (this.fetchWork.jmaWatchEnabled()) {
      if (!this.store.task('jma')) this.store.putTask('jma', now)
    } else if (this.store.task('jma')) this.store.deleteTask('jma')
  }

  /**
   * 回を始めた後（runs.ts の topicBeginRun から）: 版の回・試しの回は、消えないはずの表の数を比べる（違えば読み直しを alarm に置く）。
   * 今日の決まりをまだ読んでいなければ読む（cron が動かなかった日）・気象庁の見張り・alarm を置き直す。数を比べられなくても回は始める
   */
  async afterRunBegan(now: number, recount: boolean): Promise<void> {
    if (recount)
      try {
        const tables = await this.mirror.recount((n) => this.#takeReads(n))
        if (tables.length) {
          this.mirror.startRecheck(tables)
          this.store.putTask('mirror', now)
        }
      } catch (e) {
        logError('recount_failed', e)
      }
    if (this.store.getMeta<string>('rulesDay') !== jstDateOf(now)) this.store.putTask('rules', now)
    this.#ensureJmaTask(now)
    this.#reschedule()
  }

  /**
   * 候補集めが終わるまで待つ（topic_status(runId)・topic_list_candidates。最大 maxMs。待つ間は CPU を使わない）。候補集めのやる事の
   * 時刻が来ていれば、alarm を待たずにここで1歩進める（alarm が遅れても進むように）
   */
  async waitForCollect(runId: string, maxMs: number): Promise<void> {
    const until = this.#now() + maxMs
    for (let i = 0; i < 200; i++) {
      const run = this.store.getRun(runId)
      if (!run || run.collect.state !== 'collecting') return
      const now = this.#now()
      if (now >= until) return
      const key = `collect:${runId}`
      const t = this.store.task(key)
      if (!t) return
      if (t.at <= now && !this.#running.has(key)) {
        await this.#runTask(key, now)
        continue
      }
      await this.sleep(Math.max(50, Math.min(1_000, until - now, t.at > now ? t.at - now : 1_000)))
    }
  }

  /** やる事を1つ動かす（同じやる事は重ねない）。続きは表に置き直す */
  async #runTask(key: string, now: number): Promise<void> {
    if (this.#running.has(key)) return
    this.#running.add(key)
    try {
      if (key === 'mirror') await this.#mirrorTask(now)
      else if (key.startsWith('collect:')) await this.#collectTask(key.slice('collect:'.length), now)
      else if (key === 'rules') await this.#stepTask(key, now, () => this.fetchWork.rulesStep(this, now), 60 * 60_000)
      else if (key === 'jma') await this.#jmaTask(now)
      else if (key === 'expire') {
        const next = expireRuns(this.store, now)
        if (next === null) this.store.deleteTask('expire')
        else this.store.putTask('expire', next, {}, true)
      } else this.store.deleteTask(key)
    } finally {
      this.#running.delete(key)
    }
  }

  /** 写しの続き・読み直し・辞書の作り直し */
  async #mirrorTask(now: number): Promise<void> {
    const later = (at: number) => this.store.putTask('mirror', at, {}, true)
    try {
      const out = await this.#syncStep(10)
      const sync = { maxPages: 10, workBudget: this.#d.config.workBudgetChars, takeReads: (n: number) => this.#takeReads(n) }
      let step: { done: boolean; outOfReads?: boolean; outOfRows?: boolean } = out
      if (out.done && this.mirror.recheckState()) step = await this.mirror.recheckStep(sync)
      else if (out.done && this.dictionary.rebuilding()) step = await this.mirror.rebuildStep(sync)
      if (step.outOfReads) return later(nextPacificMidnight(now) + 5 * 60_000)
      if (step.outOfRows) return later(nextUtcMidnight(now) + 5 * 60_000)
      if (!step.done || this.mirror.recheckState() || this.dictionary.rebuilding()) return later(this.#now() + 1_000)
      this.store.deleteTask('mirror')
    } catch (e) {
      if (e instanceof ConnectorError && (isAuthProblem(e.code) || e.code === 'permission'))
        return this.store.deleteTask('mirror')
      // Firebase の無料枠を使い切った: 枠が戻る時刻の少し後に続きをする（1分ごとに試し直さない）
      if (e instanceof ConnectorError && e.code === 'firestore_quota') return later(nextPacificMidnight(now) + 5 * 60_000)
      if (!(e instanceof ConnectorError)) logError('mirror_task_failed', e)
      return later(now + 60_000)
    }
  }

  /** 候補集めの続き（回が無い・終わった・期限・集め終わった時は、やる事を消す） */
  async #collectTask(runId: string, now: number): Promise<void> {
    const key = `collect:${runId}`
    const run = this.store.getRun(runId)
    if (!run || run.done || now >= run.expires || run.collect.state !== 'collecting') return this.store.deleteTask(key)
    await this.#stepTask(key, now, () => this.fetchWork.collectStep(this, runId, now), 60_000)
  }

  /** 気象庁の見張り（3時間ごと。data が 'ok' でなくなったら外す） */
  async #jmaTask(now: number): Promise<void> {
    if (!this.fetchWork.jmaWatchEnabled()) return this.store.deleteTask('jma')
    try {
      const step = await this.fetchWork.jmaWatchStep(this, now)
      this.store.putTask('jma', step.done ? now + JMA_WATCH_EVERY_MS : step.next, {}, true)
    } catch (e) {
      logError('jma_watch_failed', e)
      this.store.putTask('jma', now + JMA_WATCH_EVERY_MS, {}, true)
    }
  }

  /** 取りに行く中身の1歩（終われば消す。続きは next に。失敗したら retryMs 後） */
  async #stepTask(key: string, now: number, step: () => Promise<TaskStep>, retryMs: number): Promise<void> {
    try {
      const r = await step()
      if (r.done) {
        this.store.deleteTask(key)
        if (key === 'rules') this.store.setMeta('rulesDay', jstDateOf(now))
      } else this.store.putTask(key, r.next, {}, true)
    } catch (e) {
      logError('task_failed', e, { op: key.startsWith('collect:') ? 'collect' : key })
      this.store.putTask(key, now + retryMs, {}, true)
    }
  }

  /**
   * 続きの仕事（Durable Object の alarm）。時刻の来たやる事を順に動かし、次に呼ぶ時刻（無ければ null）を返す。
   * 出どころへ取りに行くやる事（候補集め・毎日の決まりの読み・気象庁の見張り）は、1回の alarm で1つだけ（外への要求の数を1つの
   * やる事の1歩の中に収める。残りは時刻が来たままなので、すぐ次の alarm で動く）。連携していない間は、回の期限の片付けだけ
   */
  async alarm(): Promise<number | null> {
    const now = this.#now()
    try {
      if (this.pairingState() !== 'paired') {
        const t = this.store.task('expire')
        if (t && t.at <= now) await this.#runTask('expire', now)
        return this.store.task('expire')?.at ?? null
      }
      let outside = false
      for (const t of this.store.tasks()) {
        if (t.at > now) break
        const fetches = t.key.startsWith('collect:') || t.key === 'rules' || t.key === 'jma'
        if (fetches && outside) continue
        await this.#runTask(t.key, now)
        if (fetches) outside = true
      }
    } finally {
      this.store.flushRows()
    }
    return this.store.nextTaskAt()
  }

  /**
   * 夜の仕事（cron。毎日 4:23 日本時間）: 30日を過ぎた写しの行を消す・期限の片付け・消えないはずの表の数を比べる（違えば読み直し）・
   * 毎日の決まりの読み（robots.txt と AI の意思表示。日曜は規約のページの見張りも）を alarm で始める・気象庁の見張りを置く・外す。
   * 連携していない時は、期限の片付けと、写しの30日の消し方だけをして 'skipped'
   */
  async nightly(): Promise<'ok' | 'skipped'> {
    const now = this.#now()
    if (this.pairingState() !== 'paired') {
      // 連携していない間も、期限を過ぎた回の物と、30日を過ぎた写しの行は消す（D21 の守り 7・設計 1.9。日付だけで決まり、クラウド・
      // 出どころへは出ない）
      try {
        this.mirror.expire(now, true)
        const next = expireRuns(this.store, now)
        if (next === null) this.store.deleteTask('expire')
        else this.store.putTask('expire', next, {}, true)
        this.#d.schedule?.(next)
      } finally {
        this.store.flushRows()
      }
      return 'skipped'
    }
    try {
      this.mirror.expire(now, true)
      const next = expireRuns(this.store, now)
      if (next !== null) this.store.putTask('expire', next, {}, true)
      if (this.mirror.warm().done) {
        // 呼ばれた後のクラウドまで読んでから数を比べる（先に始まった取り込みに相乗りしない）
        const out = await this.#syncStep(10, true)
        if (out.done) {
          const tables = await this.mirror.recount((n) => this.#takeReads(n))
          if (tables.length) this.mirror.startRecheck(tables)
        }
        if (!out.done || this.mirror.recheckState()) this.store.putTask('mirror', now + 1_000)
      } else this.store.putTask('mirror', now + 1_000)
      this.store.putTask('rules', now)
      this.#ensureJmaTask(now)
      this.#reschedule()
      return 'ok'
    } catch (e) {
      logError('nightly_failed', e)
      this.store.putTask('rules', now)
      this.#reschedule()
      return 'skipped'
    } finally {
      this.store.flushRows()
    }
  }

  /** 回数の上限（/authorize はネットワークごと＋全体・DCR は全体）。超えていれば、どの上限か */
  takeRate(kind: RateKind, bucket?: string): RateResult {
    return takeRate(this.store, kind, this.#now(), bucket)
  }

  /** 同意（handle の指紋）の承認を1回だけ通す（POST /authorize。2回目からは false） */
  claimConsent(key: string): boolean {
    return claimConsent(this.store, key, this.#now())
  }
}

/** Firestore の REST の時刻（{ timestamp }）を ms にする（読めなければ null） */
function plainMillis(v: unknown): number | null {
  const ts = v && typeof v === 'object' ? (v as Partial<Timestamp>).timestamp : undefined
  if (typeof ts !== 'string') return null
  const ms = timestampMillis(ts)
  return Number.isFinite(ms) ? ms : null
}

/** 読んだ config/connector の「書き込みを許可」と接続の一覧 */
function connectorStateOf(doc: Record<string, unknown>, list: ConnectionInfo[]): ConnectorState {
  return {
    writes: doc.writes === true,
    cids: list.map((c) => c.cid),
    names: Object.fromEntries(list.map((c) => [c.cid, c.name])),
    pairedAt: Object.fromEntries(list.map((c) => [c.cid, c.pairedAt])),
  }
}
