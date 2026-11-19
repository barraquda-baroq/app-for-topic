// 端末の中のデータの入れ物（Zustand）と、端末への自動保存・クラウドから届いた変更の反映（docs/SPEC.md の 7.8 の「端末の表」・「部品」）。
// DS の src/store/appStore.ts（DS は NS の物から）を手本にし、TS の持ち方（7.8 の「画面の状態の持ち方」）に直した:
// - メモリに持つのは、アプリが書く記録（知ってる・既読）と、版の一覧・作れなかった印（どれも小さい）だけ。話題（1本 約1万バイト × 1,200）と
//   訂正は、開いている版の分だけ Dexie から読む（DS のように全部を持つと、スマホで起動のたびに約 12MB を読むため）
// - アプリの記録は3層で持つ（DS の raw・persisted・data）:
//   raw     = 端末の中の記録そのもの（このタブが知っている範囲。クラウドの json と同じ物）
//   unsaved = raw に、まだ保存していないこのタブの変更を重ねた物（端末に書く形）
//   user    = unsaved を表示用に直した写し（src/domain/repair.ts。画面が見る）
//   DS は表示用の写しに変更を重ね、保存の時に端末の形へ戻すが、TS の押す・読んだは写しではなく端末の記録に重ねる（src/domain/known.ts。
//   repair で直した値を書き戻さない）ので、変更を重ねる層を端末の形で持つ
// - 版・話題・訂正・作れなかった印はアプリが書かない（受け取ったまま端末に入れ、ここでは表示用の写しだけを作る）
// - 既読・「知ってる」を付ける関数（markRead・markSeen・know・unknow。7.4）は、端末に書く前に src/domain/validate.ts で確かめる
//   （ルールの上限を超えた記録を送信待ちに積むと、送るトランザクションが毎回断られるため）
// - 版を出すかは src/domain/editionShow.ts で決める（7.8 の「版を出す条件」）。最初の受け取りが終わっても話題が欠けている版は、同期の
//   エンジンの fetchTopics（司令塔が setTopicFetcher で渡す）で欠けた話題を直接読み、クラウドにも無い話題を除いて出す
// 端末への書き込みと送信待ちへの積み込みは src/db/persistence.ts の save が1つのトランザクションでする。別のタブ・同期を受け持つタブが
// 書いた時は BroadcastChannel（topic-studio-sync）で知らせ合い、端末の中を読み直す（DS と同じ）。
// DS から写さなかった物: 復旧用の控え（localStorage）・ゴミ箱・受け取り箱の当て方・バックアップ・競合の控え（TS のアプリの記録は小さく、
// 長い文章を書かないため。docs/SPEC.md の 16.5）
// 段階2で、画面の読む口を足した（設計: 段階2の 1.8・1.9・1.16）: 1本の話題を id で読む loadTopicView（詳細・前の話題へのリンク・読み込み
// 直した後）・続報のつながり threadOf・追いつく版 catchUpTargets と追いつきの話題 loadCatchUp・版の一覧の行 editionRows。どれも開く分
// だけ読み（多くて5版・100本）、30日分の話題（約 12MB）を読まない（16.6 の 56。版の一覧の「受け取り中」は鍵だけ）
import { create } from 'zustand'
import {
  createPersistence,
  emptyUserRecords,
  isUserTable,
  type AnyRecord,
  type Change,
  type ExpireOutcome,
  type Persistence,
  type RemoteApplyOptions,
  type SaveOutcome,
  type UserRecords,
} from '../db/persistence'
import { catchUpItems, catchUpTargetIds, type CatchUpEdition } from '../domain/catchUp'
import { correctionsByTopic, editionShowState } from '../domain/editionShow'
import { latestFail, NOT_ARRIVED_AFTER_MIN } from '../domain/editionStatus'
import { deepEqual } from '../domain/equal'
import { editionIdOf, editionIdOfRecordId, parseEditionId, TOPIC_ID_RE } from '../domain/ids'
import { addDaysToDate, isWithinRetention, latestSlotAt, slotTimeMs } from '../domain/jst'
import { isKnownTerm, pressKnownTerm, unpressKnownTerm, type KnownTermPress } from '../domain/known'
import { RECORD_LIMITS } from '../domain/limits'
import { DEFAULT_OUTLETS, type OutletDirectory } from '../domain/outlets'
import {
  repairCorrection,
  repairEdition,
  repairEditionFail,
  repairKnownTerm,
  repairReadMark,
  repairTopic,
  type ShownCorrection,
  type ShownEdition,
  type ShownEditionFail,
  type ShownKnownTerm,
  type ShownReadMark,
  type ShownTopic,
} from '../domain/repair'
import { USER_TABLES, type KnownTerm, type ReadMark, type Slot, type UserTableName } from '../domain/types'
import { checkKnownTerm, checkReadMark, type Problem } from '../domain/validate'
import { mergeRemote } from '../sync/merge'

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error'

/** アプリの記録の表示用の写し（画面が見る。直せない記録・新しい形の記録は入れない） */
export interface ShownUserRecords {
  knownTerms: Record<string, ShownKnownTerm>
  reads: Record<string, ShownReadMark>
}

/**
 * 1つの版を出すかと、出す時の中身（docs/SPEC.md の 7.8 の「版を出す条件」）。
 * none = 端末に版の記録が無い、newer = 新しい形の版の記録（画面は「アプリを更新してください」）、broken = 出せない（id の形・order が空・
 * 話題が全部欠けた）、expired = 30日の外（端末の時計）、waiting = order の話題がまだそろっていない（missing が端末に無い話題）、
 * ready = 出す（topics は order の順の表示用の写し。newerTopics は新しい形の話題の id、missing はクラウドにも無いと分かった話題。
 * corrections は話題の id → 足された順の訂正。端末にある話題の分だけ）
 */
export type EditionView =
  | { kind: 'none'; editionId: string }
  | { kind: 'newer'; editionId: string }
  | { kind: 'broken'; editionId: string }
  | { kind: 'expired'; editionId: string; edition: ShownEdition }
  | { kind: 'waiting'; editionId: string; edition: ShownEdition; missing: string[] }
  | {
      kind: 'ready'
      editionId: string
      edition: ShownEdition
      topics: ShownTopic[]
      newerTopics: string[]
      missing: string[]
      corrections: Record<string, ShownCorrection[]>
    }

/** 開いている版 */
export interface OpenedEdition {
  /** true = いちばん新しい出せる版に付いていく（トップ）。false = openEdition で選んだ版 */
  follow: boolean
  /** 出す版（付いていく時に、出せる版がまだ無ければ null） */
  view: EditionView | null
  /**
   * 付いていく時に、出している版より新しいのに話題がそろうのを待っている版（そろうまでは前の版を出したまま「受け取り中」。
   * docs/SPEC.md の 7.8 の「版を出す条件」）
   */
  waiting: string | null
}

export interface AppState {
  status: 'loading' | 'ready' | 'error'
  loadError: string | null
  saveStatus: SaveStatus
  saveError: string | null
  /** アプリの記録（知ってる・既読）の表示用の写しに、まだ保存していない変更を重ねた物 */
  user: ShownUserRecords
  /** 版の一覧（表示用の写し。id の順 = 古い順。端末から消えるまでは30日の外の版も入る。出すかは EditionView） */
  editions: ShownEdition[]
  /** 新しい形の版の記録の id（中身を読まない） */
  newerEditions: string[]
  /** 作れなかった印（表示用の写し。id の順） */
  editionFails: ShownEditionFail[]
  /** 開いている版（openEdition） */
  opened: OpenedEdition
}

const emptyShown = (): ShownUserRecords => ({ knownTerms: {}, reads: {} })

const initialState = (): AppState => ({
  status: 'loading',
  loadError: null,
  saveStatus: 'saved',
  saveError: null,
  user: emptyShown(),
  editions: [],
  newerEditions: [],
  editionFails: [],
  opened: { follow: true, view: null, waiting: null },
})

export const useApp = create<AppState>(() => initialState())

/** 変更を保存するまでの待ち（DS と同じ）。操作が続いても、最初の未保存の変更からこの時間以内には必ず保存する */
const SAVE_DELAY_MS = 400
const SAVE_MAX_WAIT_MS = 2000
const RETRY_DELAYS_MS = [3000, 10_000, 30_000, 60_000]
/** データの変化を別のタブに知らせる（同期の状態は src/sync/controller.ts の topic-studio-sync-status。docs/SPEC.md の 7.8 の「部品」） */
const CHANNEL_NAME = 'topic-studio-sync'

let persistence: Persistence | null = null
let raw: UserRecords = emptyUserRecords()
let unsaved: UserRecords = raw
let timer: ReturnType<typeof setTimeout> | null = null
let pendingSince: number | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryCount = 0
let chain: Promise<unknown> = Promise.resolve()
let channel: BroadcastChannel | null = null
const tabId = Math.random().toString(36).slice(2)

type Listener = () => void
const savedListeners = new Set<Listener>()
const externalListeners = new Set<Listener>()

/** このタブが端末にアプリの記録を書いた時（同期の送信のきっかけ。src/sync/controller.ts） */
export function onLocalSave(fn: Listener): () => void {
  savedListeners.add(fn)
  return () => savedListeners.delete(fn)
}

/** 別のタブが端末に書いた時（同期を受け持つタブなら、別のタブが積んだ送信待ちを送る） */
export function onExternalSave(fn: Listener): () => void {
  externalListeners.add(fn)
  return () => externalListeners.delete(fn)
}

function emit(set: ReadonlySet<Listener>): void {
  for (const fn of [...set]) {
    try {
      fn()
    } catch (e) {
      console.error(e)
    }
  }
}

function announce(): void {
  try {
    channel?.postMessage({ from: tabId })
  } catch {
    /* noop */
  }
}

/** 端末の中の保存先（initStore の前は null） */
export function getPersistence(): Persistence | null {
  return persistence
}

/** 端末の中のアプリの記録（受け取ったまま。開発用のフック・テスト用） */
export function getRawUserRecords(): UserRecords {
  return raw
}

/** 処理を1つずつ行う（保存・反映・読み直し・期限で消す。DS の chain と同じ） */
function inChain<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn)
  chain = run.catch(() => undefined)
  return run
}

// ---------- 表示用の写し ----------

type ShownUser = ShownKnownTerm | ShownReadMark
/** 記録 → 表示用の写し（直せない・新しい形の記録は null）。同じ記録を何度も直さない */
const shownCache = new WeakMap<object, ShownUser | null>()

function showRecord(table: UserTableName, rec: AnyRecord): ShownUser | null {
  const hit = shownCache.get(rec)
  if (hit !== undefined) return hit
  const r = table === 'knownTerms' ? repairKnownTerm(rec) : repairReadMark(rec)
  const v = r.kind === 'ok' ? r.value : null
  shownCache.set(rec, v)
  return v
}

/** 最後に写しにした端末の形の表（表の参照が同じなら、前の写しをそのまま使う） */
let shownFrom: UserRecords | null = null
let shownLast: ShownUserRecords = emptyShown()

function showUser(records: UserRecords): ShownUserRecords {
  const out: ShownUserRecords = { ...shownLast }
  let changed = false
  for (const t of USER_TABLES) {
    if (shownFrom && shownFrom[t] === records[t]) continue
    const table: Record<string, ShownUser> = {}
    for (const [id, rec] of Object.entries(records[t])) {
      const v = showRecord(t, rec)
      if (v) table[id] = v
    }
    ;(out as unknown as Record<UserTableName, Record<string, ShownUser>>)[t] = table
    changed = true
  }
  shownFrom = records
  if (changed) shownLast = out
  return shownLast
}

// ---------- アプリの記録の層 ----------

/** 変化をアプリの記録に当てる（変わった表だけ複製する。ほかの表の変化は飛ばす） */
function applyUserChanges(base: UserRecords, changes: readonly Change[]): UserRecords {
  let out: UserRecords | null = null
  const copied = new Set<UserTableName>()
  for (const ch of changes) {
    if (!isUserTable(ch.table)) continue
    out ??= { ...base }
    if (!copied.has(ch.table)) {
      out[ch.table] = { ...out[ch.table] }
      copied.add(ch.table)
    }
    if (ch.record) out[ch.table][ch.id] = ch.record
    else delete out[ch.table][ch.id]
  }
  return out ?? base
}

/**
 * oldBase から newBase への変化を、その後にこのタブで変えた latest に重ねる（DS の rebaseView）。このタブでも変えた記録は、同期と同じ
 * 決まり（src/sync/merge.ts の mergeRemote。既読の seen はどちらかが true なら true・topicIds は並びのマージ、知ってるの asOf は新しい方）で
 * 合わせる。newBase で消えた記録（30日を過ぎた既読）は、このタブで変えていても戻さない
 */
function rebase(latest: UserRecords, oldBase: UserRecords, newBase: UserRecords): UserRecords {
  if (latest === oldBase) return newBase
  const out: UserRecords = { ...latest }
  for (const t of USER_TABLES) {
    const o = oldBase[t]
    const n = newBase[t]
    if (o === n) continue
    const l = latest[t]
    // この表はこのタブで変えていない: 新しい方をそのまま使う
    if (l === o) {
      out[t] = n
      continue
    }
    let table = l
    const write = (id: string, rec: AnyRecord | undefined) => {
      if (table === l) table = { ...l }
      if (rec) table[id] = rec
      else delete table[id]
    }
    for (const id of new Set([...Object.keys(o), ...Object.keys(n)])) {
      if (o[id] === n[id]) continue
      const mine = l[id]
      if (mine === o[id] || !mine || !n[id]) {
        write(id, n[id])
        continue
      }
      const merged = mergeRemote(t, o[id] ?? null, mine, n[id]).record as AnyRecord | null
      if (merged !== mine) write(id, merged ?? n[id])
    }
    out[t] = table
  }
  return out
}

/** 保存の後の、端末の中の記録（このタブが書こうとした記録を、実際に書いた・合わせた・戻さなかった物にする） */
function rawAfterSave(before: UserRecords, next: UserRecords, outcome: SaveOutcome): UserRecords {
  const written = new Map(outcome.written.map((w) => [`${w.table}/${w.id}`, w.record]))
  const merged = new Map<string, AnyRecord>()
  for (const t of USER_TABLES) for (const r of outcome.merged[t] ?? []) merged.set(`${t}/${r.id}`, r)
  const dropped = new Set<string>()
  for (const t of USER_TABLES) for (const id of outcome.dropped[t] ?? []) dropped.add(`${t}/${id}`)
  const changes: Change[] = []
  for (const t of USER_TABLES) {
    if (before[t] === next[t]) continue
    for (const id in next[t]) {
      if (before[t][id] === next[t][id]) continue
      const k = `${t}/${id}`
      // 書いた物・別のタブの変更と合わせた物（合わせた結果が端末と同じで書かなかった物も）・戻さなかった物・端末と同じだった物
      const rec = written.has(k) ? written.get(k)! : merged.has(k) ? merged.get(k)! : dropped.has(k) ? null : next[t][id]
      changes.push({ table: t, id, record: rec })
    }
  }
  return applyUserChanges(before, changes)
}

function publishUser(): void {
  useApp.setState({ user: showUser(unsaved) })
}

function scheduleSave(): void {
  const t = Date.now()
  if (pendingSince === null) pendingSince = t
  if (timer) clearTimeout(timer)
  const delay = Math.max(0, Math.min(SAVE_DELAY_MS, pendingSince + SAVE_MAX_WAIT_MS - t))
  timer = setTimeout(() => {
    timer = null
    void flushNow()
  }, delay)
}

function scheduleRetry(): void {
  if (retryTimer) return
  const delay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)]
  retryCount += 1
  retryTimer = setTimeout(() => {
    retryTimer = null
    void flushNow()
  }, delay)
}

/** このタブの変更を重ね、少し待ってから保存する */
function commit(next: UserRecords): void {
  if (next === unsaved) return
  unsaved = next
  useApp.setState({ user: showUser(unsaved), saveStatus: 'pending' })
  scheduleSave()
}

/** 保留中の変更を保存する（chain の中で呼ぶ）。保存できたら（保存する物が無ければ）true */
async function saveOnce(): Promise<boolean> {
  const p = persistence
  if (!p) return true
  const next = unsaved
  if (next === raw) {
    if (useApp.getState().saveStatus !== 'error') useApp.setState({ saveStatus: 'saved' })
    return useApp.getState().saveStatus !== 'error'
  }
  useApp.setState({ saveStatus: 'saving' })
  try {
    const outcome = await p.save(raw, next)
    const before = raw
    raw = rawAfterSave(before, next, outcome)
    // 保存している間に、このタブでまた変えていた: その変更を、保存した後の記録に重ねる
    unsaved = unsaved === next ? raw : rebase(unsaved, next, raw)
    retryCount = 0
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    useApp.setState({
      user: showUser(unsaved),
      saveStatus: unsaved === raw ? 'saved' : 'pending',
      saveError: null,
    })
    if (unsaved !== raw) scheduleSave()
    if (outcome.written.length) {
      announce()
      emit(savedListeners)
    }
    return true
  } catch (e) {
    useApp.setState({ saveStatus: 'error', saveError: e instanceof Error ? e.message : String(e) })
    scheduleRetry()
    return false
  }
}

/**
 * 保留中の変更をすぐに保存する（画面を離れる時など）。保存できたら true、端末に書けなかったら false で終わる
 * （失敗した時は少し待って自動で再試行する）
 */
export function flushNow(): Promise<boolean> {
  if (timer) clearTimeout(timer)
  timer = null
  pendingSince = null
  return inChain(saveOnce)
}

// ---------- 既読・知ってるを付ける（docs/SPEC.md の 7.4） ----------

/** 付けた結果。ok でない時は書かない（not-ready = 端末の中を読み終える前、newer = 新しい形の記録、expired = 30日の外の版、invalid = 形が違う） */
export type EditResult<T> =
  | { ok: true; record: T; changed: boolean }
  | { ok: false; reason: 'not-ready' | 'newer' | 'expired' | 'invalid' | 'missing'; problems?: Problem[] }

const versionOf = (r: { v?: unknown }): number => (typeof r.v === 'number' && Number.isFinite(r.v) ? r.v : 1)
const uniqueStrings = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : []

function ready(): boolean {
  return persistence !== null && useApp.getState().status === 'ready'
}

/**
 * 話題を読んだ・版の一覧を見た（docs/SPEC.md の 7.4 の「既読・見た版 reads」）。topicId が null なら読んだ話題は足さない。opts.seen で
 * 版の一覧を見たにする（戻さない。戻す操作は作らない。docs/SPEC.md の 17.4・見本の ■13）。topicIds は重なり無し・30件まで・
 * その版の話題だけ。30日の外の版には付けない（送る前の守りと端末の中の削除で捨てられるため）。変わらない時は書かない
 */
export function markRead(editionId: string, topicId: string | null, opts: { seen?: boolean } = {}): EditResult<ReadMark> {
  if (!ready()) return { ok: false, reason: 'not-ready' }
  const parsed = parseEditionId(editionId)
  if (!parsed) return { ok: false, reason: 'invalid' }
  if (topicId !== null && !(TOPIC_ID_RE.test(topicId) && topicId.startsWith(`${editionId}-`)))
    return { ok: false, reason: 'invalid' }
  const now = Date.now()
  if (!isWithinRetention(parsed.date, now)) return { ok: false, reason: 'expired' }
  const prev = unsaved.reads[editionId] as (ReadMark & Record<string, unknown>) | undefined
  if (prev && versionOf(prev) > 1) return { ok: false, reason: 'newer' }
  const ids = prev ? uniqueStrings(prev.topicIds) : []
  const add = topicId !== null && !ids.includes(topicId) && ids.length < RECORD_LIMITS.read.topicIds
  const seen = prev?.seen === true || opts.seen === true
  // 変わらない時は書かない（壊れた欄を直しただけの書き戻しもしない）
  if (prev && !add && (prev.seen === true) === seen) return { ok: true, record: prev, changed: false }
  const topicIds = add ? [...ids, topicId] : ids
  const rec: ReadMark = prev
    ? { ...prev, topicIds, seen, updatedAt: now }
    : { id: editionId, v: 1, createdAt: now, updatedAt: now, by: 'user', ai: null, editionId, topicIds, seen }
  const check = checkReadMark(rec)
  if (check.errors.length) return { ok: false, reason: 'invalid', problems: check.errors }
  commit({ ...unsaved, reads: { ...unsaved.reads, [editionId]: rec } })
  return { ok: true, record: rec, changed: true }
}

/** 版の一覧を見た（追いつき。docs/SPEC.md の 9.） */
export function markSeen(editionId: string): EditResult<ReadMark> {
  return markRead(editionId, null, { seen: true })
}

/**
 * 「知ってる」を押した（src/domain/known.ts の pressKnownTerm。asOf は今の値と押した話題の asOf の新しい方）。端末の記録に重ね、
 * 知らない欄は残す。変わらない時は書かない
 */
export function know(press: KnownTermPress): EditResult<KnownTerm> {
  if (!ready()) return { ok: false, reason: 'not-ready' }
  const prev = unsaved.knownTerms[press.termId] as (KnownTerm & Record<string, unknown>) | undefined
  if (prev && versionOf(prev) > 1) return { ok: false, reason: 'newer' }
  const rec = pressKnownTerm(prev ?? null, press, Date.now())
  if (prev && prev.on === rec.on && prev.term === rec.term && prev.asOf === rec.asOf)
    return { ok: true, record: prev, changed: false }
  const check = checkKnownTerm(rec)
  if (check.errors.length) return { ok: false, reason: 'invalid', problems: check.errors }
  commit({ ...unsaved, knownTerms: { ...unsaved.knownTerms, [rec.id]: rec } })
  return { ok: true, record: rec, changed: true }
}

/** 「知ってる」を外した（記録は消さず on を false に。src/domain/known.ts の unpressKnownTerm） */
export function unknow(termId: string): EditResult<KnownTerm> {
  if (!ready()) return { ok: false, reason: 'not-ready' }
  const prev = unsaved.knownTerms[termId] as (KnownTerm & Record<string, unknown>) | undefined
  if (!prev) return { ok: false, reason: 'missing' }
  if (versionOf(prev) > 1) return { ok: false, reason: 'newer' }
  if (prev.on === false) return { ok: true, record: prev, changed: false }
  const rec = unpressKnownTerm(prev, Date.now())
  const check = checkKnownTerm(rec)
  if (check.errors.length) return { ok: false, reason: 'invalid', problems: check.errors }
  commit({ ...unsaved, knownTerms: { ...unsaved.knownTerms, [termId]: rec } })
  return { ok: true, record: rec, changed: true }
}

/** 話題の用語（termId・asOf）が「知ってる」か（説明を出さない。src/domain/known.ts の isKnownTerm） */
export function isKnown(user: ShownUserRecords, termId: string, termAsOf: string | null): boolean {
  return isKnownTerm(user.knownTerms[termId], termAsOf)
}

// ---------- 版の一覧 ----------

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 版の記録を表示用の写しにして、一覧に当てる（null は端末から消えた） */
function applyEditionChanges(changes: readonly { id: string; record: AnyRecord | null }[]): void {
  if (!changes.length) return
  const s = useApp.getState()
  const editions = new Map(s.editions.map((e) => [e.id, e]))
  const newer = new Set(s.newerEditions)
  for (const ch of changes) {
    editions.delete(ch.id)
    newer.delete(ch.id)
    if (!ch.record) continue
    const r = repairEdition(ch.record)
    if (r.kind === 'ok') editions.set(ch.id, r.value)
    else if (r.kind === 'newer') newer.add(ch.id)
  }
  useApp.setState({ editions: [...editions.values()].sort(byId), newerEditions: [...newer].sort() })
}

function applyFailChanges(changes: readonly { id: string; record: AnyRecord | null }[]): void {
  if (!changes.length) return
  const fails = new Map(useApp.getState().editionFails.map((f) => [f.id, f]))
  for (const ch of changes) {
    fails.delete(ch.id)
    if (!ch.record) continue
    const r = repairEditionFail(ch.record)
    if (r.kind === 'ok') fails.set(ch.id, r.value)
  }
  useApp.setState({ editionFails: [...fails.values()].sort(byId) })
}

/** 版の一覧と作れなかった印を、端末の中から読み直す */
async function loadEditionLists(p: Persistence): Promise<void> {
  const [eds, fails] = await Promise.all([p.listEditions(), p.listEditionFails()])
  const editions: ShownEdition[] = []
  const newer: string[] = []
  for (const e of eds) {
    const r = repairEdition(e)
    if (r.kind === 'ok') editions.push(r.value)
    else if (r.kind === 'newer') newer.push(e.id)
  }
  const shownFails: ShownEditionFail[] = []
  for (const f of fails) {
    const r = repairEditionFail(f)
    if (r.kind === 'ok') shownFails.push(r.value)
  }
  useApp.setState({ editions: editions.sort(byId), newerEditions: newer.sort(), editionFails: shownFails.sort(byId) })
}

// ---------- 版を開く（話題は版ごとに読む。docs/SPEC.md の 7.8 の「版を出す条件」） ----------

/** 出典のリンクにする社の一覧（作り物の版では作り物の一覧。開発用のフック・テストが差し替える。src/domain/outlets.ts） */
let outlets: OutletDirectory = DEFAULT_OUTLETS

/** 話題の出典のリンクにする社の一覧を差し替える（作り物の版を出す開発サーバー・テスト用。開いている版を読み直す） */
export function setTopicOutlets(dir: OutletDirectory = DEFAULT_OUTLETS): void {
  outlets = dir
  scheduleViewRefresh()
}

/** 今の社の一覧（詳細の出典の表示とクリップの出典の行が、作り物の版の時も同じ一覧で出典の書き方を引く。本番は DEFAULT_OUTLETS） */
export function topicOutlets(): OutletDirectory {
  return outlets
}

/** 欠けた話題をクラウドから直接読む関数（同期を受け持つタブの司令塔が、エンジンの fetchTopics を渡す。受け持たない時は null） */
export type TopicFetcher = (ids: readonly string[]) => Promise<{ found: string[]; missing: string[] }>
let fetcher: TopicFetcher | null = null
/** 最初の受け取りが終わった（同期のエンジンの status.downloaded。司令塔が知らせる） */
let downloaded = false
/** 版ごとの、クラウドにも無いと分かった話題 */
const goneTopics = new Map<string, Set<string>>()
/** 欠けた話題を直接読んだ版（1回の起動で1回だけ。多くて 30回の読み取り） */
const fetchedEditions = new Set<string>()

export function setTopicFetcher(fn: TopicFetcher | null): void {
  fetcher = fn
  if (fn) scheduleViewRefresh()
}

/** 最初の受け取りが終わったか（終わったら、話題の欠けた版の欠けた話題を直接読む） */
export function noteSyncDownloaded(done: boolean): void {
  if (downloaded === done) return
  downloaded = done
  if (done) scheduleViewRefresh()
}

/**
 * 1つの版を出すかと、出す時の中身を端末から読む（版の記録はメモリの一覧から、話題と訂正は Dexie から。受け取った記録は変えない）。
 * gone はクラウドにも無いと分かった話題（無ければ、これまでに分かった物）
 */
export async function loadEditionView(
  editionId: string,
  opts: { gone?: ReadonlySet<string>; now?: number } = {},
): Promise<EditionView> {
  const p = persistence
  const s = useApp.getState()
  if (s.newerEditions.includes(editionId)) return { kind: 'newer', editionId }
  const edition = s.editions.find((e) => e.id === editionId)
  if (!p || !edition) return { kind: 'none', editionId }
  const gone = opts.gone ?? goneTopics.get(editionId) ?? new Set<string>()
  const rawTopics = await p.getTopics(edition.order)
  const state = editionShowState(edition, rawTopics, opts.now ?? Date.now(), gone)
  if (state.kind === 'broken') return { kind: 'broken', editionId }
  if (state.kind === 'expired') return { kind: 'expired', editionId, edition }
  if (state.kind === 'waiting') return { kind: 'waiting', editionId, edition, missing: state.missing }
  const topics: ShownTopic[] = []
  const newerTopics: string[] = []
  for (const t of state.topics) {
    const r = repairTopic(t, { outlets })
    if (r.kind === 'ok') topics.push(r.value)
    else if (r.kind === 'newer') newerTopics.push(r.id)
  }
  const corrections = (await p.correctionsOfEdition(editionId))
    .map((c) => repairCorrection(c))
    .flatMap((r) => (r.kind === 'ok' ? [r.value] : []))
  const byTopic = correctionsByTopic(
    corrections,
    topics.map((t) => t.id),
  )
  return {
    kind: 'ready',
    editionId,
    edition,
    topics,
    newerTopics,
    missing: state.missing,
    corrections: Object.fromEntries(byTopic),
  }
}

/**
 * 付いていく時に話題を読んで確かめる版の数（新しい方から。3日分）。話題のそろわない版が続いた時に、30日分の話題（約 12MB）を読まないように
 */
const FOLLOW_SCAN = 6

/** 付いていく版の候補（30日の内の版。新しい順に FOLLOW_SCAN まで） */
function followCandidates(now: number): string[] {
  return useApp
    .getState()
    .editions.filter((e) => {
      const parsed = parseEditionId(e.id)
      return parsed !== null && isWithinRetention(parsed.date, now)
    })
    .map((e) => e.id)
    .reverse()
    .slice(0, FOLLOW_SCAN)
}

/**
 * 最初の受け取りが終わっても話題の欠けている版: 欠けた話題をクラウドから直接読み（多くて 30件。読めた版は1回の起動で1回）、クラウドにも無い
 * 話題を覚えて読み直す。読んだ話題は同期のエンジンが端末に入れ、その反映で開いている版も読み直す
 */
function fetchMissing(view: EditionView): void {
  if (view.kind !== 'waiting' || !downloaded || !fetcher || fetchedEditions.has(view.editionId)) return
  const id = view.editionId
  fetchedEditions.add(id)
  void fetcher(view.missing)
    .then((r) => {
      if (r.missing.length) {
        const set = goneTopics.get(id) ?? new Set<string>()
        for (const m of r.missing) set.add(m)
        goneTopics.set(id, set)
      }
      scheduleViewRefresh()
    })
    .catch((e: unknown) => {
      // 読めなかった（オフラインなど）: 読んだ印を外し、次に版を読み直す時（記録が届いた・版を開いた時など）にもう一度読む（docs/SPEC.md の 16.6 の 56）
      console.warn('欠けた話題を読めませんでした', e)
      fetchedEditions.delete(id)
    })
}

/** 開いている版（null = いちばん新しい出せる版に付いていく） */
let openTarget: string | null = null

async function computeOpened(): Promise<OpenedEdition> {
  const now = Date.now()
  if (openTarget !== null) {
    const view = await loadEditionView(openTarget, { now })
    fetchMissing(view)
    return { follow: false, view, waiting: null }
  }
  let waiting: string | null = null
  for (const id of followCandidates(now)) {
    const view = await loadEditionView(id, { now })
    if (view.kind === 'ready') return { follow: true, view, waiting }
    if (view.kind === 'waiting' && waiting === null) {
      // いちばん新しい「待っている版」の欠けた話題だけを直接読む
      waiting = id
      fetchMissing(view)
    }
  }
  return { follow: true, view: null, waiting }
}

let refreshing: Promise<void> | null = null
let refreshAgain = false

/** 開いている版を読み直す（続けて頼まれたら、終わった後にもう1回だけ） */
function scheduleViewRefresh(): Promise<void> {
  if (!persistence || useApp.getState().status !== 'ready') return Promise.resolve()
  if (refreshing) {
    refreshAgain = true
    return refreshing
  }
  refreshing = (async () => {
    try {
      do {
        refreshAgain = false
        const target = openTarget
        const opened = await computeOpened()
        // 読んでいる間に開く版が替わっていたら、替わった版で読み直す
        if (target !== openTarget) {
          refreshAgain = true
          continue
        }
        if (!deepEqual(opened, useApp.getState().opened)) useApp.setState({ opened })
      } while (refreshAgain)
    } catch (e) {
      console.warn('版を読めませんでした', e)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

/** 版を開く（null = いちばん新しい出せる版に付いていく。トップ）。読み終えたら終わる */
export function openEdition(editionId: string | null): Promise<void> {
  openTarget = editionId
  return scheduleViewRefresh()
}

// ---------- 段階2の画面の読む口（詳細・続報のつながり・追いつき・版の一覧。設計: 段階2の 1.8・1.9・1.16） ----------

/**
 * 話題を出してよい版（版の記録があり（版の記録 = 出してよいの印。docs/SPEC.md の 7.2）、30日の内で、order にその話題がある）。
 * 無ければ null、版の記録が新しい形なら 'newer'
 */
function editionOfTopic(topicId: string, now: number): ShownEdition | 'newer' | null {
  const editionId = TOPIC_ID_RE.test(topicId) ? editionIdOfRecordId(topicId) : null
  if (!editionId) return null
  const s = useApp.getState()
  if (s.newerEditions.includes(editionId)) return 'newer'
  const edition = s.editions.find((e) => e.id === editionId)
  if (!edition || !isWithinRetention(edition.id.slice(0, 10), now) || !edition.order.includes(topicId)) return null
  return edition
}

/** 1本の話題を読んだ結果（ready = 写しと、足された順の訂正。newer = 新しい形の記録。none = 出せない（端末に無い・30日の外など）） */
export type TopicView =
  | { kind: 'ready'; topic: ShownTopic; corrections: ShownCorrection[] }
  | { kind: 'newer' }
  | { kind: 'none' }

/**
 * 1本の話題を id で端末から読む（開いた版に無い話題の詳細: 追いつきの画面・前の話題へのリンク・読み込み直した後にほかの版の話題を
 * 開いていた時。設計: 段階2の 1.9）。版の記録が無い・30日の外・版の order に無い・端末に無い話題は none。話題か版の記録が新しい形なら newer。
 * 訂正はその話題に足された順
 */
export async function loadTopicView(topicId: string, opts: { now?: number } = {}): Promise<TopicView> {
  const p = persistence
  const edition = editionOfTopic(topicId, opts.now ?? Date.now())
  if (!p || edition === null) return { kind: 'none' }
  if (edition === 'newer') return { kind: 'newer' }
  const [raw] = await p.getTopics([topicId])
  if (!raw) return { kind: 'none' }
  const r = repairTopic(raw, { outlets })
  if (r.kind === 'newer') return { kind: 'newer' }
  if (r.kind !== 'ok') return { kind: 'none' }
  const corrections = (await p.correctionsOfTopic(topicId))
    .map((c) => repairCorrection(c))
    .flatMap((x) => (x.kind === 'ok' ? [x.value] : []))
  return { kind: 'ready', topic: r.value, corrections: correctionsByTopic(corrections, [topicId]).get(topicId) ?? [] }
}

/** 続報のつながりの1本（前の話題へのリンク・「続報あり」に使う物だけ） */
export interface ThreadTopic {
  id: string
  editionId: string
  headline: string
}

/**
 * 続報のつながり（同じ threadId）の、端末にあって出してよい話題（版の id の順 = 古い順。同じ版の中は order の順）。新しい形の記録・
 * 版の記録の無い話題・30日の外の話題は入れない（docs/SPEC.md の 7.8 の「続報のつなぎ」）
 */
export async function threadOf(threadId: string, opts: { now?: number } = {}): Promise<ThreadTopic[]> {
  const p = persistence
  if (!p || !TOPIC_ID_RE.test(threadId)) return []
  const now = opts.now ?? Date.now()
  const out: (ThreadTopic & { position: number })[] = []
  for (const raw of await p.topicsOfThread(threadId)) {
    const edition = editionOfTopic(raw.id, now)
    if (edition === null || edition === 'newer') continue
    const r = repairTopic(raw, { outlets })
    if (r.kind !== 'ok' || r.value.threadId !== threadId) continue
    out.push({ id: r.value.id, editionId: edition.id, headline: r.value.headline, position: edition.order.indexOf(r.value.id) })
  }
  return out
    .sort((a, b) => (a.editionId < b.editionId ? -1 : a.editionId > b.editionId ? 1 : a.position - b.position))
    .map(({ id, editionId, headline }) => ({ id, editionId, headline }))
}

/** いくつかの続報のつながりをまとめて引く（前の版の話題の threadId。多くて 20回の索引の読み） */
export async function threadsOf(
  threadIds: Iterable<string>,
  opts: { now?: number } = {},
): Promise<Record<string, ThreadTopic[]>> {
  const out: Record<string, ThreadTopic[]> = {}
  for (const id of new Set(threadIds)) out[id] = await threadOf(id, opts)
  return out
}

/** 出している版（いちばん新しい出せる版に付いていく時の、出している版。付いていかない・出せる版が無い時は null） */
function followedView(state: Pick<AppState, 'opened'>): Extract<EditionView, { kind: 'ready' }> | null {
  const { opened } = state
  return opened.follow && opened.view?.kind === 'ready' ? opened.view : null
}

/**
 * 追いつく版の id（新しい順。src/domain/catchUp.ts の catchUpTargetIds。設計: 段階2の 1.8）。出している版は、いちばん新しい出せる版に
 * 付いていく時の版（前の版 #/e/{id} を開いている時・出せる版が無い時は []）。版の一覧と既読だけで決め、話題は読まない。
 * 帯は length >= CATCH_UP_MIN の時
 */
export function catchUpTargets(state: Pick<AppState, 'editions' | 'user' | 'opened'>, now: number): string[] {
  return catchUpTargetIds({
    now,
    editionIds: state.editions.map((e) => e.id),
    seen: state.user.reads,
    shownId: followedView(state)?.editionId ?? null,
  })
}

/** 追いつきの1本（話題・その版・その話題の訂正） */
export interface CatchUpEntry {
  topic: ShownTopic
  edition: ShownEdition
  /** 足された順 */
  corrections: ShownCorrection[]
}

/**
 * 追いつきの話題を読む（版ごとに loadEditionView → src/domain/catchUp.ts の catchUpItems。読むのは多くて5版・100本）。出せない版
 * （話題がそろわない・30日の外など）は飛ばす。いちばん新しい1本が今出している版にある続報は外す
 */
export async function loadCatchUp(ids: readonly string[], opts: { now?: number } = {}): Promise<CatchUpEntry[]> {
  const now = opts.now ?? Date.now()
  const current = followedView(useApp.getState())
  const views = new Map<string, Extract<EditionView, { kind: 'ready' }>>()
  for (const id of new Set(ids)) {
    if (id === current?.editionId) continue
    const view = await loadEditionView(id, { now })
    if (view.kind === 'ready') views.set(id, view)
  }
  const editions: CatchUpEdition<ShownTopic>[] = [...views.values()].map((v) => ({
    editionId: v.editionId,
    order: v.edition.order,
    topics: v.topics,
  }))
  return catchUpItems(editions, current).map((item) => {
    const view = views.get(item.editionId)!
    return { topic: item.topic, edition: view.edition, corrections: view.corrections[item.topic.id] ?? [] }
  })
}

/**
 * 版の一覧の1行（枠ごと。設計: 段階2の 1.8）: edition = 版の記録がある（receiving = 話題がまだ端末にそろわない）・newer = 新しい形の
 * 版の記録・failed = 作れなかった印だけ（reason は短い理由の文。空なら null）・missing = 版も印も無い
 */
export type EditionRow = { date: string; slot: Slot } & (
  | { kind: 'edition'; editionId: string; receiving: boolean }
  | { kind: 'newer'; editionId: string }
  | { kind: 'failed'; reasonKind: string; reason: string | null }
  | { kind: 'missing' }
)

/** 次の枠（12:00 → その日の 20:00、20:00 → 次の日の 12:00） */
function nextSlotOf(date: string, slot: Slot): { date: string; slot: Slot } {
  return slot === '12' ? { date, slot: '20' } : { date: addDaysToDate(date, 1), slot: '12' }
}

/**
 * 版の一覧の行（新しい順。設計: 段階2の 1.8）。出す枠は、30日の内で、いちばん古い「版の記録（新しい形を含む）か作れなかった印のある枠」から、
 * 時刻の上でいちばん新しい枠まで（それより前の枠・この端末が受け取る前は出さない。記録が1つも無ければ []）。版も印も無い枠は missing。
 * ただし、いちばん新しい枠の missing は、トップの状態の1行と同じく、枠の時刻の30分後から、同期が落ち着いている時だけ。
 * 「受け取り中」は版の order の話題が端末にあるかを鍵だけで調べる（話題の中身は読まない。クラウドにも無いと分かった話題は欠けに数えない）
 */
export async function editionRows(now: number, syncSettled: boolean): Promise<EditionRow[]> {
  const p = persistence
  if (!p) return []
  const s = useApp.getState()
  const within = (id: string) => {
    const parsed = parseEditionId(id)
    return parsed !== null && isWithinRetention(parsed.date, now) ? parsed : null
  }
  const editions = new Map(s.editions.filter((e) => within(e.id)).map((e) => [e.id, e]))
  const newer = new Set(s.newerEditions.filter((id) => within(id)))
  const failed = new Set(s.editionFails.map((f) => f.editionId).filter((id) => within(id)))
  const known = [...editions.keys(), ...newer, ...failed].sort()
  if (!known.length) return []
  const latest = latestSlotAt(now)
  const latestId = editionIdOf(latest.date, latest.slot)
  const last = known[known.length - 1] > latestId ? known[known.length - 1] : latestId
  const present = await p.presentTopicIds([...editions.values()].flatMap((e) => e.order))
  const rows: EditionRow[] = []
  for (let at = within(known[0]); at; at = nextSlotOf(at.date, at.slot)) {
    const id = editionIdOf(at.date, at.slot)
    if (id > last) break
    const slot = { date: at.date, slot: at.slot }
    const edition = editions.get(id)
    if (edition) {
      const gone = goneTopics.get(id)
      rows.push({
        ...slot,
        kind: 'edition',
        editionId: id,
        receiving: edition.order.some((t) => !present.has(t) && !gone?.has(t)),
      })
      continue
    }
    if (newer.has(id)) {
      rows.push({ ...slot, kind: 'newer', editionId: id })
      continue
    }
    const fail = latestFail(s.editionFails, id)
    if (fail) {
      rows.push({ ...slot, kind: 'failed', reasonKind: fail.reasonKind, reason: fail.reason || null })
      continue
    }
    // 版も印も無い枠: いちばん新しい枠は30分たって同期が落ち着いてから。それより後の枠（端末の時計が遅れている時）は出さない
    if (id > latestId) continue
    if (id === latestId && !(syncSettled && now >= slotTimeMs(at.date, at.slot) + NOT_ARRIVED_AFTER_MIN * 60 * 1000)) continue
    rows.push({ ...slot, kind: 'missing' })
  }
  return rows.reverse()
}

/** 端末の中の話題・訂正・版が変わった時に、開いている版を読み直すか */
function touchesEditions(changes: readonly Change[]): boolean {
  return changes.some((c) => c.table === 'editions' || c.table === 'topics' || c.table === 'corrections')
}

// ---------- 受け取った変更・期限で消した物を当てる（同期を受け持つタブ） ----------

/** 端末に書いた変化を、メモリの3層・版の一覧に当てる（chain の中で呼ぶ） */
function absorb(changes: readonly Change[]): void {
  if (!changes.length) return
  const before = raw
  const after = applyUserChanges(before, changes)
  if (after !== before) {
    raw = after
    unsaved = unsaved === before ? after : rebase(unsaved, before, after)
    publishUser()
  }
  applyEditionChanges(changes.filter((c) => c.table === 'editions'))
  applyFailChanges(changes.filter((c) => c.table === 'editionFails'))
  if (touchesEditions(changes)) void scheduleViewRefresh()
}

/**
 * クラウドから届いた変更を反映する（同期を受け持つタブだけが呼ぶ。src/sync/controller.ts のエンジンの口 SyncTarget の applyRemote）。
 * 先にこのタブの未保存の変更を保存し（保存できなければ投げる。エンジンは後でやり直す）、端末の中で送信待ちと3者マージしてから
 * （src/db/persistence.ts の applyRemote。位置と _meta も同じトランザクション）、メモリにも重ねる。実際に端末に書いた内容を返す
 */
export function applyRemoteChanges(changes: readonly Change[], opts?: RemoteApplyOptions): Promise<Change[]> {
  return inChain(async () => {
    const p = persistence
    if (!p) throw new Error('保存先が初期化されていません')
    if (!(await saveOnce())) throw new Error('この端末の変更を保存できないため、クラウドの変更を反映できません')
    const written = await p.applyRemote(changes, opts)
    absorb(written)
    if (written.length) announce()
    return written
  })
}

/**
 * 30日の外の行を端末から消し（src/db/persistence.ts の expireBefore。送信待ちの行も一緒に消し、送信待ちに積まない）、メモリからも外す
 * （同期を受け持つタブの SyncTarget の expireBefore。docs/SPEC.md の 7.8 の「端末の中で消す」）
 */
export function expireLocalRecords(firstKeptDate: string): Promise<ExpireOutcome> {
  return inChain(async () => {
    const p = persistence
    if (!p) throw new Error('保存先が初期化されていません')
    const out = await p.expireBefore(firstKeptDate)
    absorb(out.removed)
    // 版の記録が消えなくても、30日の外の版は出さなくなるので読み直す
    void scheduleViewRefresh()
    if (out.removed.length) announce()
    return out
  })
}

/** 読み直した記録のうち、中身が同じ記録・表は前の参照のままにする（画面を描き直さない） */
function keepSame(before: UserRecords, loaded: UserRecords): UserRecords {
  const next: UserRecords = { ...loaded }
  for (const t of USER_TABLES) {
    const b = before[t]
    const l = loaded[t]
    let same = Object.keys(b).length === Object.keys(l).length
    const table: Record<string, AnyRecord> = {}
    for (const id in l) {
      if (b[id] && deepEqual(b[id], l[id])) table[id] = b[id]
      else {
        table[id] = l[id]
        same = false
      }
    }
    next[t] = same ? b : table
  }
  return next
}

/**
 * 端末の中を読み直す（別のタブ・同期を受け持つタブが書いた時、アカウントを切り替えて Claude の記録の写しを消した時）。先にこのタブの変更を
 * 保存する（保存できない時は、読み直すと未保存の変更が消えるので読まない）
 */
export async function reloadFromDisk(): Promise<boolean> {
  const p = persistence
  if (!p) return false
  if (!(await flushNow())) return false
  await inChain(async () => {
    const before = raw
    const next = keepSame(before, await p.loadUserRecords())
    raw = next
    unsaved = unsaved === before ? next : rebase(unsaved, before, next)
    publishUser()
    await loadEditionLists(p)
  })
  await scheduleViewRefresh()
  return true
}

// ---------- 起動 ----------

/** 起動時に呼ぶ（src/main.tsx。ログインの状態を確かめる前に）。端末の中のアプリの記録と版の一覧を読む */
export async function initStore(p: Persistence = createPersistence()): Promise<void> {
  persistence = p
  try {
    const loaded = await p.loadUserRecords()
    raw = loaded
    unsaved = loaded
    useApp.setState({ user: showUser(loaded) })
    await loadEditionLists(p)
    useApp.setState({ status: 'ready', loadError: null })
  } catch (e) {
    useApp.setState({ status: 'error', loadError: e instanceof Error ? e.message : String(e) })
    return
  }
  try {
    channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME)
    if (channel) {
      channel.onmessage = (ev: MessageEvent<{ from?: string }>) => {
        if (ev.data?.from === tabId) return
        emit(externalListeners)
        void reloadFromDisk()
      }
    }
  } catch {
    channel = null
  }
  // 開いている版（トップはいちばん新しい出せる版）を読む。ログインの状態を確かめるのを待たせないよう、終わるのを待たない
  void scheduleViewRefresh()
}

/** テスト用: 状態とタイマーを初期化する */
export function resetStoreForTests(): void {
  if (timer) clearTimeout(timer)
  timer = null
  pendingSince = null
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  retryCount = 0
  chain = Promise.resolve()
  persistence = null
  raw = emptyUserRecords()
  unsaved = raw
  shownFrom = null
  shownLast = emptyShown()
  savedListeners.clear()
  externalListeners.clear()
  outlets = DEFAULT_OUTLETS
  fetcher = null
  downloaded = false
  goneTopics.clear()
  fetchedEditions.clear()
  openTarget = null
  refreshing = null
  refreshAgain = false
  try {
    channel?.close()
  } catch {
    /* noop */
  }
  channel = null
  useApp.setState(initialState())
}
