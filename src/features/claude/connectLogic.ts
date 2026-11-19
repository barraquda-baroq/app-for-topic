// Claude 用のコネクタ（connector/ の Cloudflare Worker）との連携の手順（docs/SPEC.md の 7.7「持ち主の許可」。コネクタの側と同じ手順）。
// NS（Novel Studio）の src/features/claude/connectLogic.ts を写して減らした物（段階3の設計の 3.1）: 見せるタイトル（claudeAccess）と、
// その設定をクラウドへ送り終えるのを待つ所（flush）・2.8 までの v1 の記録の読み方と移し替え（TS は初めから v2）を外し、接続の数を
// 10 → 2 にした。TS の端末の送信待ちは「知ってる」と既読だけで、コネクタに見える物（版・話題など）を変えないので、送り終えるのを待たない。
// 1. コネクタが claude.ai の接続の途中で `${アプリ}/#/claude/connect?s=<state>` を開く（s はコネクタが渡す、意味を持たない印）
// 2. アプリは、ビルドの時に決めたコネクタの origin（URL からは受け取らない）の /connect/identity から
//    コネクタの匿名のアカウント {uid, version, model} を受け取る（URL に書かれた uid も使わない）
// 3. 持ち主が［許可する］を押すと、k（32バイトの乱数。base64url）を作り、config/connector の接続の一覧（2まで）に
//    接続 {name, pairing: sha256hex(s + '.' + k), pairedAt: サーバー時刻, approvedOn: 端末の呼び名} を足す（トランザクション。
//    上の pairing・pairedAt・approvedOn・pairingCid は最後に許可した接続のもの。k そのものは書かない）
// 4. `${コネクタ}/pair/callback?state=<s>&k=<k>` へ移る（コネクタが指紋を確かめて接続を終える）
// 連携の決まりそのもの（URL の形・k・指紋・身元の形・接続の数と名前）は、コネクタと同じ src/claude/pairing.ts。
// データ・通信は外から渡す（テストで差し替える）。Firebase・React は読み込まない（記録を読み書きするのは connectorDoc.ts）。
import {
  callbackUrl,
  connectionNameKey,
  connectionsOf,
  defaultConnectionName,
  identityUrl,
  isPairingKey,
  normalizeOrigin,
  pairingHash,
  parseIdentity,
  validState,
  APPROVED_ON_MAX_LENGTH,
  CONNECTION_ID,
  CONNECTION_NAME_MAX,
  CONNECTOR_DOC_VERSION,
  MAX_CONNECTIONS,
  type ConnectionApproval,
  type ConnectionInfo,
  type ConnectorIdentity,
} from '../../claude/pairing'

export {
  base64url,
  callbackUrl,
  connectorMcpUrl,
  identityUrl,
  isPairingKey,
  normalizeOrigin,
  pairingHash,
  parseIdentity,
  randomPairingKey,
  sha256hex,
  validState,
  type ConnectionApproval,
  type ConnectionInfo,
  type ConnectorIdentity,
} from '../../claude/pairing'

/**
 * ビルドの時に決めたコネクタの origin（vite.config.ts の define。未設定は空）。define の無い所（ルートの vitest.emu.config.ts）でも
 * 読めるように、型で確かめてから使う
 */
export const CONNECTOR_ORIGIN: string = normalizeOrigin(typeof __CONNECTOR_ORIGIN__ === 'string' ? __CONNECTOR_ORIGIN__ : '')

/** 答えの中の短い説明（エラーの時。HTML としては出さない） */
function serverMessage(v: unknown): string {
  if (!v || typeof v !== 'object') return ''
  const o = v as Record<string, unknown>
  const m = typeof o.message === 'string' ? o.message : typeof o.error === 'string' ? o.error : ''
  return m.replace(/\s+/g, ' ').trim().slice(0, 200)
}

export type IdentityResult = { ok: true; identity: ConnectorIdentity } | { ok: false; error: string }

/**
 * コネクタの匿名のアカウントを受け取る。行き先はビルドの時に決めた origin だけ（Cookie などは送らない）。
 * 15秒で答えが無ければやめる
 */
export async function fetchIdentity(
  origin: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<IdentityResult> {
  if (!origin) return { ok: false, error: 'コネクタの場所が設定されていません。' }
  const ctrl = typeof AbortController === 'undefined' ? null : new AbortController()
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const res = await fetchImpl(identityUrl(origin), {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: { accept: 'application/json' },
      ...(ctrl ? { signal: ctrl.signal } : {}),
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    if (!res.ok) {
      const m = serverMessage(body)
      return { ok: false, error: `コネクタが連携を受け付けませんでした（${res.status}${m ? `: ${m}` : ''}）。` }
    }
    const identity = parseIdentity(body)
    if (!identity) return { ok: false, error: 'コネクタの答えの形が違います。コネクタを更新してください。' }
    return { ok: true, identity }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return {
      ok: false,
      error: aborted
        ? 'コネクタから答えがありませんでした。しばらくしてからもう一度お試しください。'
        : 'コネクタにつながりませんでした。インターネットの接続と、コネクタを公開したか（docs/CONNECTOR.md）を確かめてください。',
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 同期がそろうのを待つ長さ（連携の画面） */
export const SYNC_WAIT_MS = 90_000

/** 連携の画面で［許可する］を出す前の確かめに使う外の働き（画面では Firestore・同期、テストでは差し替える） */
export interface PrepareDeps {
  /** ビルドの時に決めたコネクタの origin */
  origin: string
  /** クラウドの持ち主のアカウント（config/owner。記録が無ければ null。読めなければ throw） */
  readOwnerUid(): Promise<string | null>
  /** 同期が「同期済み」になるまで待つ（limitMs まで。なれば true） */
  waitSynced(limitMs: number): Promise<boolean>
  /** コネクタの身元を受け取る（ふつうは fetchIdentity） */
  fetchIdentity(origin: string): Promise<IdentityResult>
  /** いまの連携の記録（config/connector。サーバーから読む。無ければ null。読めなければ throw） */
  readConnector(): Promise<ConnectorStatus | null>
  /** このアプリのデータの形の版（DATA_MODEL。コネクタがこれより古ければ許可させない） */
  dataModel: number
  /** 画面を離れた・やり直した（true なら先へ進まない。コネクタにも問い合わせない） */
  cancelled(): boolean
  /** いまの段階（画面の表示） */
  onStep?(step: 'checking' | 'sync' | 'identity'): void
}

export type PrepareResult =
  | {
      step: 'ready'
      identity: ConnectorIdentity
      ownerUid: string
      /** いまの連携の記録（無ければ null） */
      existing: ConnectorStatus | null
      /** いまの連携の記録を読めなかった（許可はできる。記録はトランザクションでもう一度読む） */
      existingError: boolean
    }
  | { step: 'connectorOld'; identity: ConnectorIdentity }
  | { step: 'notOwner' }
  | { step: 'noOwner' }
  | { step: 'ownerError' }
  | { step: 'syncTimeout' }
  | { step: 'identityError'; error: string }
  | { step: 'cancelled' }

/**
 * ログインしているアカウント（uid）で連携を始められるか確かめる:
 * 1. クラウドの持ち主か（config/owner をサーバーから読む。違えば notOwner。この端末で確かめた持ち主の印とは別に、もう一度確かめる）
 * 2. 同期がそろうのを待つ（この端末の同期が、クラウドのデータの形の版（meta/app）をこのアプリの版に上げてから許可する。コネクタは
 *    クラウドの形の版が自分と同じになるまで書かないため。7.7）。初めての同期なら、持ち主をもう一度読む
 * 3. ビルドの時に決めた origin のコネクタから身元を受け取る（持ち主と同じアカウントなら断る）
 * 4. コネクタのデータの形の版がこのアプリより古ければ許可させない（古いコネクタは、このアプリの記録の形を書けない）
 * 5. いまの連携の記録（接続の一覧）を読む（読めなくても許可はできる）
 */
export async function prepareConnect(deps: PrepareDeps, uid: string): Promise<PrepareResult> {
  const step = (s: 'checking' | 'sync' | 'identity') => {
    if (!deps.cancelled()) deps.onStep?.(s)
  }
  step('checking')
  let owner: string | null
  try {
    owner = await deps.readOwnerUid()
  } catch {
    return { step: 'ownerError' }
  }
  if (owner && owner !== uid) return { step: 'notOwner' }
  if (deps.cancelled()) return { step: 'cancelled' }
  step('sync')
  if (!(await deps.waitSynced(SYNC_WAIT_MS))) return { step: 'syncTimeout' }
  if (deps.cancelled()) return { step: 'cancelled' }
  if (!owner) {
    // 初めての同期で持ち主が記録されたところ（作者が Firebase の画面で作った直後）
    owner = await deps.readOwnerUid().catch(() => null)
    if (!owner) return { step: 'noOwner' }
    if (owner !== uid) return { step: 'notOwner' }
  }
  // 画面を離れた・やり直した後は、コネクタに問い合わせない（問い合わせると、コネクタは匿名のアカウントを作る）
  if (deps.cancelled()) return { step: 'cancelled' }
  step('identity')
  const r = await deps.fetchIdentity(deps.origin)
  if (!r.ok) return { step: 'identityError', error: r.error }
  if (r.identity.uid === uid)
    return { step: 'identityError', error: 'コネクタのアカウントが正しくありません。コネクタを更新してください。' }
  if (r.identity.model === null || r.identity.model < deps.dataModel) return { step: 'connectorOld', identity: r.identity }
  if (deps.cancelled()) return { step: 'cancelled' }
  let existing: ConnectorStatus | null = null
  let existingError = false
  try {
    existing = await deps.readConnector()
  } catch {
    existingError = true
  }
  return { step: 'ready', identity: r.identity, ownerUid: owner, existing, existingError }
}

/** 連携の記録を読めなかった時（連携の画面。許可はできる） */
export const EXISTING_READ_ERROR = 'いまの接続の一覧を読めませんでした（許可はできます）'

/** config/connector の内容（設定の「Claude との連携」・連携の画面に出す） */
export interface ConnectorStatus {
  /** コネクタの匿名のアカウント */
  uid: string
  /** 最後に許可した時刻（サーバー時刻。書いた直後で届いていなければ null） */
  pairedAt: number | null
  /** 最後に許可した端末 */
  approvedOn: string
  /** 「書き込みを許可」（すべての接続に効く） */
  writes: boolean
  /** 接続の一覧（許可した時刻の順、同じなら cid の順） */
  connections: ConnectionInfo[]
  /** 最後に許可した接続（読めなければ null） */
  pairingCid: string | null
}

/** Firestore の時刻（Timestamp）・ms の数を ms にする（読めなければ null） */
export function timeMillis(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = v as { toMillis?: () => number } | null | undefined
  if (t && typeof t.toMillis === 'function') {
    const n = t.toMillis()
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** config/connector の文書を読む（形が違う・正しい接続が1つも無い記録は null = 連携していない。コネクタと同じ読み方） */
export function parseConnectorDoc(v: unknown): ConnectorStatus | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.uid !== 'string' || !o.uid) return null
  const connections = connectionsOf(o, timeMillis)
  if (!connections) return null
  return {
    uid: o.uid,
    pairedAt: timeMillis(o.pairedAt),
    approvedOn: typeof o.approvedOn === 'string' ? o.approvedOn : '',
    writes: o.writes === true,
    connections,
    pairingCid: typeof o.pairingCid === 'string' && CONNECTION_ID.test(o.pairingCid) ? o.pairingCid : null,
  }
}

// ---------- 接続の一覧を書き換える（connectorDoc.ts のトランザクションの中で使う。Firebase は読み込まない） ----------

/** 連携の記録が別のコネクタ（身元を作り直したコネクタ）のもの。記録を消してから新しく作る */
export class IdentityChangedError extends Error {
  constructor() {
    super('コネクタの身元が変わりました')
    this.name = 'IdentityChangedError'
  }
}

/** 接続が上限（2）まである（入れ替える接続を選ぶか、1つ解除する） */
export class ConnectionLimitError extends Error {
  constructor() {
    super(`接続が${MAX_CONNECTIONS}あります`)
    this.name = 'ConnectionLimitError'
  }
}

/** 作者が入れた名前と同じ名前の接続が、記録にある（ほかの端末で足された・一覧を読めなかった） */
export class DuplicateNameError extends Error {
  constructor() {
    super('同じ名前の接続があります')
    this.name = 'DuplicateNameError'
  }
}

/** 名前を変える接続が、もう一覧に無い（ほかの端末で解除した） */
export class ConnectionGoneError extends Error {
  constructor() {
    super('その接続はもうありません')
    this.name = 'ConnectionGoneError'
  }
}

/** 接続が上限まである時（連携はまだ記録していない） */
export const CONNECTION_LIMIT_ERROR = `接続が${MAX_CONNECTIONS}あります（同時に${MAX_CONNECTIONS}まで）。入れ替える接続を選ぶか、一覧で1つ解除してから、もう一度［許可する］を押してください（連携はまだ記録していません）。`
/** 作者が入れた名前と同じ名前の接続が記録にある時（連携はまだ記録していない） */
export const DUPLICATE_NAME_ERROR =
  '同じ名前の接続があります。名前を変えて、もう一度［許可する］を押してください（連携はまだ記録していません）。'
/** 接続の名前が空・長すぎる時 */
export const CONNECTION_NAME_ERROR = `接続の名前は1〜${CONNECTION_NAME_MAX}字にしてください。`

/** 接続の名前を整える（前後の空白を除く）。空・20字を超える・制御文字を含むなら null */
export function cleanNewConnectionName(name: string): string | null {
  const s = name.trim()
  const n = Array.from(s).length
  // eslint-disable-next-line no-control-regex
  if (n < 1 || n > CONNECTION_NAME_MAX || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)) return null
  return s
}

type Raw = Record<string, unknown>
const isMap = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 記録の接続の map（書き戻す形。時刻は読んだ値そのまま）。鍵が接続の id の形でない・値が map でないものは外す（コネクタも数えない。
 * 一覧に出ず解除もできない枠を残さない）。connections が無い・map でない記録は空（TS は初めから v2 なので、v1 の移し替えは無い）
 */
export function connectionEntries(cur: Raw): Record<string, Raw> {
  const out: Record<string, Raw> = {}
  if (!isMap(cur.connections)) return out
  for (const [cid, v] of Object.entries(cur.connections)) if (CONNECTION_ID.test(cid) && isMap(v)) out[cid] = { ...v }
  return out
}

/** 一覧を編集した後の記録（身元・書き込みの許可・最後の許可の指紋・時刻・接続はそのまま。ルールの「一覧の編集」の形） */
function editedDoc(cur: Raw, list: Record<string, Raw>): Raw {
  return {
    uid: cur.uid,
    writes: cur.writes === true,
    v: CONNECTOR_DOC_VERSION,
    pairing: cur.pairing,
    pairedAt: cur.pairedAt,
    approvedOn: typeof cur.approvedOn === 'string' ? cur.approvedOn : '',
    pairingCid: cur.pairingCid,
    connections: list,
  }
}

/**
 * 接続を足す（入れ替える）時に書く記録。serverTime はサーバー時刻の値（Firestore の serverTimestamp()）。
 * 別のコネクタの記録なら IdentityChangedError、入れ替えても上限（2）を超えるなら ConnectionLimitError（どちらも何も書かない）。
 * 同じ cid（記録に失敗した後のやり直し）は上書きする（重ならない）。
 * 残るほかの接続に同じ名前（字の幅・空白の違いは同じ）があれば、既定の名前なら空いている番号の「接続n」にし、作者が入れた
 * 名前なら DuplicateNameError（画面は一覧を読めなかった時・ほかの端末で足された時に、古い一覧で確かめているため）。
 * 「書き込みを許可」は、作者が変えていなければ（a.writes が null）記録の値のまま（記録が無ければ許可）
 */
export function addedConnectorDoc(cur: Raw | null, a: ConnectionApproval, serverTime: unknown): Raw {
  if (cur && cur.uid !== a.uid) throw new IdentityChangedError()
  const list = cur ? connectionEntries(cur) : {}
  if (a.replaceCid) delete list[a.replaceCid]
  delete list[a.cid]
  if (Object.keys(list).length >= MAX_CONNECTIONS) throw new ConnectionLimitError()
  // 名前は一覧に出す形（connectionsOf が整えた名前）で比べる（画面の確かめと同じ）
  const names = (connectionsOf({ connections: list }) ?? []).map((c) => c.name)
  let name = a.name
  if (names.some((n) => connectionNameKey(n) === connectionNameKey(name))) {
    if (!a.defaultName) throw new DuplicateNameError()
    name = defaultConnectionName(names)
  }
  list[a.cid] = { name, pairing: a.pairing, pairedAt: serverTime, approvedOn: a.approvedOn }
  return {
    uid: a.uid,
    writes: a.writes ?? (cur ? cur.writes === true : true),
    v: CONNECTOR_DOC_VERSION,
    pairing: a.pairing,
    pairedAt: serverTime,
    approvedOn: a.approvedOn,
    pairingCid: a.cid,
    connections: list,
  }
}

/** 接続の名前を変えた記録（無い接続なら ConnectionGoneError。名前が正しくなければ例外） */
export function renamedConnectorDoc(cur: Raw | null, cid: string, name: string): Raw {
  const clean = cleanNewConnectionName(name)
  if (clean === null) throw new Error(CONNECTION_NAME_ERROR)
  const list = cur ? connectionEntries(cur) : {}
  if (!cur || !list[cid]) throw new ConnectionGoneError()
  list[cid] = { ...list[cid], name: clean }
  return editedDoc(cur, list)
}

/**
 * 接続を1つ解除した記録。最後の1つなら 'delete'（記録を消す = 連携をすべて解除。次の許可は新しい代になる）。
 * もう無い接続・記録なら 'none'
 */
export function removedConnectorDoc(
  cur: Raw | null,
  cid: string,
): { kind: 'set'; doc: Raw } | { kind: 'delete' } | { kind: 'none' } {
  if (!cur) return { kind: 'none' }
  const list = connectionEntries(cur)
  if (!list[cid]) return { kind: 'none' }
  delete list[cid]
  if (!Object.keys(list).length) return { kind: 'delete' }
  return { kind: 'set', doc: editedDoc(cur, list) }
}

/**
 * 許可した端末の呼び名（接続の一覧の「許可した端末」。NS の src/sync/conflicts.ts の deviceLabel と同じ決め方）。
 * 呼び名はクラウドに残り、ほかの端末でも見えるので「この端末」とは書かない
 */
export function deviceLabel(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Macintosh/.test(ua)) return 'Mac'
  return 'ブラウザ'
}

/** 連携に使う外の働き（画面では Firestore・画面の移動、テストでは差し替える） */
export interface PairingDeps {
  /** ビルドの時に決めたコネクタの origin */
  origin: string
  /** config/connector の一覧に接続を足す（トランザクション。サーバーが受け取るまで待つ） */
  addConnection(a: ConnectionApproval): Promise<void>
  /** config/connector を消す（コネクタの身元が変わった時。前の接続はどれも使えなくなっている） */
  deleteConnector(): Promise<void>
  /** コネクタへ移る（ページごと） */
  navigate(url: string): void
  randomKey(): string
  deviceLabel(): string
}

export interface PairingInput {
  state: string
  identity: ConnectorIdentity
  /** 持ち主のアカウント（コネクタのアカウントと同じなら連携しない） */
  ownerUid: string
  /** 「書き込みを許可」（null = 作者が変えていない: 記録の値のまま。記録が無ければ許可） */
  writes: boolean | null
  /** 足す接続の id（画面を開くごとに1つ作り、やり直しでは同じものを使う） */
  cid: string
  /** 接続の名前（1〜20字） */
  name: string
  /** 作者が名前を入れていない（既定の名前。記録に同じ名前があれば、空いている番号にする） */
  defaultName?: boolean
  /** 入れ替える接続（前の接続は使えなくなる） */
  replaceCid?: string | null
}

export type PairingResult = { ok: true; url: string } | { ok: false; error: string }

/**
 * ［許可する］: config/connector の一覧に接続（連携の指紋）を足し、コネクタへ移る。k はコネクタへ移る URL にだけ入れる
 * （Firestore には指紋だけ）。名前・接続の id は送る前に確かめる。記録できなければ移らない
 */
export async function approvePairing(deps: PairingDeps, input: PairingInput): Promise<PairingResult> {
  const origin = deps.origin
  if (!origin) return { ok: false, error: 'コネクタの場所が設定されていません。' }
  const state = validState(input.state)
  if (!state) return { ok: false, error: '連携の印が正しくありません。claude.ai のコネクタの画面からやり直してください。' }
  if (!input.identity.uid || input.identity.uid === input.ownerUid)
    return { ok: false, error: 'コネクタのアカウントが正しくありません。コネクタを更新してください。' }
  const name = cleanNewConnectionName(input.name)
  if (name === null) return { ok: false, error: CONNECTION_NAME_ERROR }
  if (!CONNECTION_ID.test(input.cid)) return { ok: false, error: '接続の id を作れませんでした。画面を読み込み直してください。' }
  const k = deps.randomKey()
  if (!isPairingKey(k)) return { ok: false, error: '連携の鍵を作れませんでした。もう一度お試しください。' }
  const pairing = await pairingHash(state, k)
  const approval: ConnectionApproval = {
    uid: input.identity.uid,
    pairing,
    approvedOn: deps.deviceLabel().slice(0, APPROVED_ON_MAX_LENGTH),
    writes: input.writes,
    cid: input.cid,
    name,
    defaultName: input.defaultName === true,
    replaceCid: input.replaceCid ?? null,
  }
  try {
    try {
      await deps.addConnection(approval)
    } catch (e) {
      if (!(e instanceof IdentityChangedError)) throw e
      // コネクタが用意し直された: 前の記録（前のコネクタの接続）を消してから、新しく作る（新しい代になり、前の許可は戻らない）
      await deps.deleteConnector()
      await deps.addConnection({ ...approval, replaceCid: null })
    }
  } catch (e) {
    if (e instanceof ConnectionLimitError) return { ok: false, error: CONNECTION_LIMIT_ERROR }
    if (e instanceof DuplicateNameError) return { ok: false, error: DUPLICATE_NAME_ERROR }
    const code = typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
    return {
      ok: false,
      error:
        code === 'permission-denied'
          ? '連携を記録できませんでした（アクセスルールが古いか、持ち主のアカウントではありません）。docs/CONNECTOR.md の手順でアクセスルールを公開してください。'
          : '連携を記録できませんでした。インターネットの接続を確かめて、もう一度お試しください。',
    }
  }
  const url = callbackUrl(origin, state, k)
  deps.navigate(url)
  return { ok: true, url }
}
