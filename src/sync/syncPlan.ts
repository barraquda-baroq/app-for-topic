// 同期の決まりのうち、Firebase に頼らない部品（docs/SPEC.md の 7.8）。エンジン（src/sync/engine.ts）と偽のクラウド（src/test/fakeCloud.ts）が
// 同じ物を使い、偽のクラウドで確かめた決まりがエンジンでもそのまま効くようにする（DS の偽のクラウドはエンジンの決まりを書き写していたが、
// TS は初めての受け取り・30日の境・送る前の守りが増えたので、決まりをここに1つだけ置く）。
// - 購読する表・初めての受け取りに入るか・購読を始める位置（7.8 の「版と話題を受け取る」）
// - 受け取った文書を反映の1件にする（codec で読み、購読しない表・30日の外の物は捨てる）と、受け取った位置の進め方
// - 30日の手入れで消す表の順・消してよい id・端末の中で消す境（7.8 の「30日で消す」「端末の中で消す」）
// - 送る前の守りの時刻・クラウドで消えていた既読（7.8 の「既読・知ってるを送る・受け取る」）
import type { Change, FirstSync, SyncCursor } from '../db/persistence'
import { isExpiredDocId } from '../domain/ids'
import { firstSyncSinceMs, isCaughtUpStale, ONE_DAY_MS, retentionBoundary } from '../domain/jst'
import { EXPIRING_TABLES, isOneOf, type ExpiringTableName, type Place } from '../domain/types'
import type { SendItem } from './batch'
import { decodeDoc, type DecodeFailure } from './codec'

/**
 * 同期の形の版（_meta の syncSchema）。文書の形・購読する表を変えたら上げる（位置を消して初めての受け取りからやり直す。docs/SPEC.md の
 * 7.8 の「購読する表を足す時」）
 */
export const SYNC_SCHEMA = 1

/**
 * records の購読で受け取る表（docs/SPEC.md の 7.8 の「購読」）。辞書の束（termPacks）は受け取らない（辞書は Claude 用。7. の要点の 7）。
 * 問い合わせは where('table', 'in', この一覧)。ここに表を足す時は SYNC_SCHEMA も上げる
 */
export const RECORDS_SUBSCRIBED_TABLES = ['editions', 'topics', 'corrections', 'editionFails', 'knownTerms'] as const

/** private の購読で受け取る表（表を絞らずに購読するので、後の版が足した表も届くが、ここに無い表は捨てる） */
export const PRIVATE_SUBSCRIBED_TABLES = ['reads'] as const

const SUBSCRIBED: Readonly<Record<Place, ReadonlySet<string>>> = {
  records: new Set(RECORDS_SUBSCRIBED_TABLES),
  private: new Set(PRIVATE_SUBSCRIBED_TABLES),
}

/** その置き場の購読で受け取る表か */
export const isSubscribedTable = (place: Place, table: string): boolean => SUBSCRIBED[place].has(table)

/**
 * 30日の手入れで消す表の順（docs/SPEC.md の 7.8 の「30日で消す」）。版の記録（出してよいの印）を先に消し、話題・訂正を後に消す
 * （1日の上限で途中までになっても、話題の欠けた版が残らないように）。既読は private
 */
export const EXPIRE_ORDER: readonly ExpiringTableName[] = ['editions', 'editionFails', 'topics', 'corrections', 'reads']

/** 最後にクラウドとそろった時刻（_meta の caughtUpAt）を書き直す間隔の下限（1時間に1回まで。docs/SPEC.md の 7.8 の _meta） */
export const CAUGHT_UP_SAVE_MS = 60 * 60 * 1000

/** 版の order の欠けた話題を直接読む数の上限（docs/SPEC.md の 7.8 の「版を出す条件」。order は30件まで） */
export const MAX_TOPIC_FETCH = 30

// ---------- 受け取った位置（文書の updated のサーバー時刻。秒とナノ秒。DS と同じ） ----------

/** ミリ秒（UTC）を受け取った位置の形にする */
export function cursorOfMs(ms: number): SyncCursor {
  const s = Math.floor(ms / 1000)
  return { s, n: Math.round(ms - s * 1000) * 1_000_000 }
}

/** 受け取った位置のミリ秒（UTC） */
export const msOfCursor = (c: SyncCursor): number => c.s * 1000 + Math.floor(c.n / 1_000_000)

/** a が b より後か（b が無ければ後） */
export const laterCursor = (a: SyncCursor, b: SyncCursor | null | undefined): boolean =>
  !b || a.s > b.s || (a.s === b.s && a.n > b.n)

/** 後の方の位置（どちらも無ければ null） */
export function maxCursor(a: SyncCursor | null | undefined, b: SyncCursor | null | undefined): SyncCursor | null {
  if (!a) return b ?? null
  if (!b) return a
  return laterCursor(b, a) ? b : a
}

/** _meta に残った位置を読む（形が違えば無い物とする。初めての受け取りからやり直す） */
export function asCursor(v: unknown): SyncCursor | null {
  if (!v || typeof v !== 'object') return null
  const { s, n } = v as { s?: unknown; n?: unknown }
  return typeof s === 'number' && Number.isFinite(s) && typeof n === 'number' && Number.isFinite(n) ? { s, n } : null
}

// ---------- 初めての受け取り（docs/SPEC.md の 7.8 の「版と話題を受け取る」・16.6 の 26） ----------

export interface FirstSyncState {
  /** records の受け取った位置 */
  recordsCursor: SyncCursor | null
  /** 最後にクラウドとそろった時刻（_meta の caughtUpAt。端末の時計） */
  caughtUpAt: number | null
}

/**
 * 初めての受け取りに入るか: records の位置が無い時と、最後にクラウドとそろった時刻が31日より前の時。位置ではなく caughtUpAt で決める
 * （位置が進むのは記録が届いた時だけなので、コネクタが31日以上書かない間に、開くたびに「知ってる」を全部読み直さないため）。
 * そろった時刻を知らない時と、端末の時計がそろった時刻より1日以上戻った時は、位置（サーバーの時刻）と端末の時計で決める（DS の resyncDue）
 */
export function needsFirstSync(state: FirstSyncState, deviceNow: number): boolean {
  if (!state.recordsCursor) return true
  const { caughtUpAt } = state
  if (caughtUpAt !== null && deviceNow - caughtUpAt >= -ONE_DAY_MS) return isCaughtUpStale(caughtUpAt, deviceNow)
  return isCaughtUpStale(msOfCursor(state.recordsCursor), deviceNow)
}

/** _meta の firstSync を読む（形が違えば無い物とする） */
export function asFirstSync(v: unknown): FirstSync | null {
  if (!v || typeof v !== 'object') return null
  const knownAt = (v as { knownAt?: unknown }).knownAt
  return typeof knownAt === 'number' && Number.isFinite(knownAt) ? { knownAt } : null
}

/**
 * 初めての受け取りの 1.（「知ってる」を読む）をするか。firstSync があれば、2. を再試行する時も 1. をやり直さない（7.8 の 4.）。
 * ただし 1. を終えた時刻が、いま 2. で購読を始める位置（端末の時計 − 32日）より前の時（1. の後、32日より長く閉じていた）はやり直す
 * （その間にほかの端末が押した「知ってる」は、2. の購読の位置より前にあって届かないため）
 */
export function needsKnownRead(firstSync: FirstSync | null, deviceNow: number): boolean {
  return firstSync === null || firstSync.knownAt < firstSyncSinceMs(deviceNow)
}

/** 初めての受け取りの 2. で records の購読を始める位置（端末の時計 − 32日。サーバーの時刻の見積もりは使わない。7.8 の 2.） */
export const firstSyncSince = (deviceNow: number): SyncCursor => cursorOfMs(firstSyncSinceMs(deviceNow))

/**
 * private の購読を始める位置: 位置が無ければ records と同じ端末の時計 − 32日（30日の手入れがされていない古い既読を読まない）、
 * 位置があればその位置（7.8 の 3.）
 */
export const privateStart = (cursor: SyncCursor | null, deviceNow: number): SyncCursor => cursor ?? firstSyncSince(deviceNow)

/**
 * サーバーからの知らせを反映した後の位置（進めないなら null）。届いた記録のいちばん新しい時刻まで進める。初めての受け取りの 2. の
 * 最初の知らせ（startedFrom = 購読を始めた位置）では、届いた記録が0件でも、購読を始めた位置まで進める（7.8 の 2.）。位置は戻さない
 */
export function snapshotAdvance(
  cursor: SyncCursor | null,
  newest: SyncCursor | null,
  startedFrom: SyncCursor | null = null,
): SyncCursor | null {
  const next = maxCursor(newest, startedFrom)
  return next && laterCursor(next, cursor) ? next : null
}

// ---------- 受け取った文書（docs/SPEC.md の 7.8 の「版と話題を受け取る」） ----------

/**
 * 受け取った文書を記録にしない理由。codec が断る形（DecodeFailure）のほか、not-subscribed = その置き場の購読で受け取らない表
 * （辞書の束・後の版が足した表）、expired = 端末の時計で30日の外（初めての受け取りの32日の窓の、30日より前の2日分など。端末の中で
 * 消す境と同じ。入れてもすぐ消すので、反映の前に落とす）
 */
export type RemoteSkip = DecodeFailure | 'not-subscribed' | 'expired'

export interface RemoteContext {
  /** 文書の id（スナップショットの id） */
  docId: string
  place: Place
  /** この端末の ID（自分の書いた文書に own の印を付ける） */
  deviceId: string
  /** 端末の時計（30日の外の物を落とす） */
  deviceNow: number
}

export type RemoteChange = { ok: true; change: Change; hash: string } | { ok: false; reason: RemoteSkip }

/**
 * 受け取った文書（スナップショットの data()）を反映の1件にする。記録は受け取ったまま（知らない値・欄を消さない）。
 * 使えない文書は記録にしないが、呼ぶ側は位置を進める（読めない1件で受け取りを止めない）
 */
export function remoteChangeOf(data: unknown, ctx: RemoteContext): RemoteChange {
  const r = decodeDoc(data, { docId: ctx.docId, place: ctx.place })
  if (!r.ok) return r
  if (!isSubscribedTable(ctx.place, r.table)) return { ok: false, reason: 'not-subscribed' }
  if (isExpiredDocId(ctx.docId, ctx.deviceNow)) return { ok: false, reason: 'expired' }
  const change: Change = { table: r.table, id: r.id, record: r.record, ...(r.device === ctx.deviceId ? { own: true } : {}) }
  return { ok: true, change, hash: r.hash }
}

// ---------- 30日で消す（docs/SPEC.md の 7.8 の「30日で消す」「端末の中で消す」） ----------

/** 端末の中で消す境（端末の時計の、残る版のいちばん古い日付。persistence の expireBefore に渡す） */
export const localExpiryDate = (deviceNow: number): string => retentionBoundary(deviceNow).firstKeptDate

/** クラウドで30日の外を引く文書の id の範囲の下の端（'{表名}:'。上の端は src/domain/jst.ts の expiryDocIdBefore） */
export const expireRangeStart = (table: ExpiringTableName): string => `${table}:`

/**
 * 引いた文書のうち、消してよい id（ルールの expirableRecord・expiredDay と同じ: 表ごとの id の形で、サーバーの時刻の見積もりで
 * 30日を過ぎた物）。形の違う文書を混ぜると、まとめての削除が全部断られるので除く
 */
export const expirableIds = (docIds: readonly string[], serverNow: number): string[] =>
  docIds.filter((id) => isExpiredDocId(id, serverNow))

// ---------- 送る（docs/SPEC.md の 7.8 の「既読・知ってるを送る・受け取る」） ----------

/**
 * 送る前の守り（30日の外の既読を送らない）の時刻: サーバーの時刻の見積もり（クラウドから消す境と同じ）。まだ1件も届いていない時は
 * 端末の時計（端末の中で消す境と同じ。端末の中でもう消える既読を送らない）
 */
export const sendGuardTime = (serverNow: number | null, deviceNow: number): number => serverNow ?? deviceNow

/**
 * クラウドで消えていた既読か（送るトランザクションで読んだら文書が無く、前にそろえた中身 base がある）。ルールで消せるのは30日を
 * 過ぎた既読だけなので、ほかの端末が30日で消した物（か、誰かが Firebase の画面で消した物）。作り直さずに送り終わりにする
 * （送信待ちに残すと、受け取りは removed を無視するので base が新しくならず、送るたびに書けずに止まる。7.8）。
 * 消さない表（知ってる）は decideBatch が作り直すので当たらない
 */
export function goneFromCloud(it: Pick<SendItem, 'table' | 'base' | 'noHistory'>, cloudExists: boolean): boolean {
  return !cloudExists && it.base !== null && !it.noHistory && isOneOf(EXPIRING_TABLES, it.table)
}
