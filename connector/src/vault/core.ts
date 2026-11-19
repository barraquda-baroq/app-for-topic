// Vault の中身（Durable Object の外でも動く。テストでは node:sqlite と作り物の Firebase で動かす）。NS の connector/src/vault/core.ts を元に、
// B0（コネクタの土台）では NS から写す所だけを置く: 連携の状態・身元・連携の確かめ（verifyPairing）・許可の確かめ（checkGrant）・
// 接続の一覧（config/connector）の読み直し・「書き込みを許可」とデータの形の版の確かめ・数の記録（日枠）・接続の要求の回数と、
// ツールの空の振り分け（TOOL_HANDLERS）。写し・回・下書き・取りに行く所・ツールの中身は B3 以降で足す（設計の 1.1・6.1）。
// 持ち主ごとに1つ（idFromName('owner')）。TS は初めから接続の一覧の形（v2）だけを読む（NS の 2.8 までの v1 の記録・接続 c0 は無い）。
import { connectionsOf, isPairingHash, PAIRING_TTL_MS, type ConnectionInfo } from '../../../src/claude/pairing'
import type { VaultConfig } from '../config'
import { log, logError } from '../log'
import { CONNECTOR_MODEL, CONNECTOR_VERSION } from '../version'
import { ConnectorError, isAuthProblem, MESSAGES, modelMismatchMessage } from './errors'
import { FirestoreError, FirestoreRest } from './firestore'
import { Identity } from './identity'
import { Mutex } from './mutex'
import { firestoreQuotaMessage, freshQuota, type QuotaCounts } from './quota'
import { claimConsent, takeRate, type RateKind, type RateResult } from './ratelimit'
import { MirrorStore, type SqlRunner } from './store'
import { REQUEST_TIMEOUT_MS, withTimeout } from './timeout'
import { fail, headLine, withHead, type RunDeadlines, type ToolResult } from './tools/common'
import { fromFields, timestampMillis, type Timestamp } from './values'

export interface VaultDeps {
  sql: SqlRunner
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

/** config/connector・meta/app を読み直す間隔（どのツールの前・トークンの更新の前も） */
export const RECHECK_MS = 60_000
/** 許可の接続が一覧に無い時、断る前に読み直す（この時間より前に読んだ一覧では断らない。古い写しで許可を取り消さない） */
export const CONNECTION_FRESH_MS = 5_000

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

/**
 * ツールの中身に渡す物（B3 以降のツールが使う）。deadlines は回の締め切り（runId を渡した呼び出しで、中身が回を読んだ時に入れる。
 * 答えの頭の1行に「書く係の締め切りまで n分・照合の打ち切りまで m分」を添える）
 */
export interface ToolCallContext {
  grant?: GrantProps
  client?: string
  /** 呼び出しを受けた時刻（ms） */
  now: number
  deadlines?: RunDeadlines | null
  /** 書き込みの前: 「書き込みを許可」とデータの形の版を確かめる（違えば ConnectorError） */
  requireWrites: () => Promise<void>
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
 * ツールの振り分け（名前 → 中身）。B0 では空（ツールの一覧 mcp/tools.ts も空）。B3 以降で、tools/*.ts の中身を名前ごとに足す
 * （topic_status は連携していない時にも答えるので、callTool の始めで別に扱う。NS の novel_status と同じ）
 */
export const TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = {}

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

export class VaultCore {
  readonly store: MirrorStore
  readonly identity: Identity
  readonly fs: FirestoreRest
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

  constructor(deps: VaultDeps) {
    this.#d = deps
    this.#now = deps.now ?? (() => Date.now())
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    this.store = new MirrorStore(deps.sql)
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
      sleep,
      onLost: () => this.#setUnpaired('identity_lost'),
    })
    this.fs = new FirestoreRest({
      fetch,
      baseUrl: deps.config.firestoreUrl,
      projectId: deps.config.projectId,
      token: (force) => this.identity.idToken(force),
      sleep,
    })
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
    this.#d.schedule?.(null)
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
   * 許可にする（NS の 2.9 と同じ）
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
    // 持ち主が変わった（B3 で写しを消して取り込み直す所）
    if (prev.ownerUid && prev.ownerUid !== ownerUid) log('mirror_owner_changed')
    // 確かめている間に、後から読み始めた同じ記録の一覧が届いていれば、そちらを覚えたままにする（新しい）
    const cached = this.#connCheck
    const state =
      cached && cached.seq > seq && prev.gen === gen ? cached : { ...connectorStateOf(conn, list), at: startedAt, seq }
    this.store.setMeta('pairing', { state: 'paired', ownerUid, pairedAt, gen, cids: state.cids } satisfies PairingMeta)
    this.#connCheck = state
    this.#modelCheck = null
    log('paired', { writes: state.writes, connections: state.cids.length })
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
  #takeWrites(n: number): boolean {
    const q = this.#quota()
    if (n > 0 && q.writes + n > this.#d.config.dailyWriteBudget) return false
    this.store.setMeta('quota', { ...q, writes: Math.max(0, q.writes + n) } satisfies QuotaCounts)
    return true
  }

  /** 今日（太平洋時間）の読み取り・書き込みの数（topic_status の「足りる／残りが少ない」に使う） */
  quota(): QuotaCounts {
    return this.#quota()
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

  // ---------- ツール ----------

  /**
   * ツールを呼ぶ（/mcp の tools/call から RPC で）。前の連携の許可・連携していない・一覧から外された接続は断り（auth: HTTP 401）、
   * ツールの中身（TOOL_HANDLERS）へ振り分ける。答えの頭に今の時刻の1行を付ける（回の締め切りは中身が ctx.deadlines に入れた時だけ）
   */
  async callTool(name: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<ToolResult> {
    const ctx: ToolCallContext = {
      grant: opts.grant,
      client: opts.client,
      now: this.#now(),
      deadlines: null,
      requireWrites: () => this.#requireWrites(),
      serialize: (fn) => this.#mutex.run(fn),
      stillGranted: () => this.#stillGranted(opts.grant),
      takeReads: (n) => this.#takeReads(n),
      takeWrites: (n) => this.#takeWrites(n),
      firestoreFailure: (e) => this.#firestoreFailure(e),
    }
    const head = () => headLine(this.#now(), ctx.deadlines)
    try {
      // 前の連携の許可（解除した後・持ち主が変わった後）は使わない（覚えた連携の状態だけで見る）
      if (opts.grant && !this.#grantMatchesPairing(opts.grant)) {
        log('grant_stale', { tool: name })
        throw new ConnectorError('unpaired', MESSAGES.unpaired)
      }
      this.#requirePaired()
      // 連携の記録を1分ごとに確かめる（どのツールも。解除・作り直し・一覧から外された接続に気付く）
      await this.#requireConnection(opts.grant)
      const handler = Object.hasOwn(TOOL_HANDLERS, name) ? TOOL_HANDLERS[name] : undefined
      if (!handler) return withHead(fail(`知らないツールです（${name}）。ツールの一覧を読み直してください。`), head())
      return withHead(await handler(this, args, ctx), head())
    } catch (e) {
      if (e instanceof ConnectorError) {
        log('tool_refused', { tool: name, code: e.code })
        return { ...withHead({ text: e.message, isError: true }, head()), auth: isAuthProblem(e.code) || undefined }
      }
      logError('tool_failed', e, { tool: name })
      return withHead({ text: MESSAGES.unavailable, isError: true }, head())
    }
  }

  /** 続きの仕事（Durable Object の alarm）。次に呼ぶ時刻（無ければ null）。やる事の表は B3 以降で足す */
  async alarm(): Promise<number | null> {
    return null
  }

  /** 夜の仕事（cron。毎日 4:23 日本時間）。写しの数・古い回・出どころの決まりの読みは B3 以降で足す */
  async nightly(): Promise<'ok' | 'skipped'> {
    return this.pairingState() === 'paired' ? 'ok' : 'skipped'
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
