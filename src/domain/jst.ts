// 日本時間の日付・枠・30日の境（docs/SPEC.md の 7.7・7.8・16.6 の 3・4）。版の日付・枠と30日の境は、どの端末の時差でも同じ値にする
// （端末の暦の Date を使わず、UTC の時刻に 9時間を足して UTC の暦で読む。日本は夏時間が無いので +9時間で足りる）。
// 段階0の src/domain/dates.ts は端末の現地の暦（ログインの画面の日付・日付が変わった時の計算し直し）で、ここは日本時間の暦。
// 役目が違うので、dates.ts はそのまま残し、2桁にそろえる pad2 と月の日数 daysInMonth（UTC の暦で数える）だけを使い回す。アプリと段階3のコネクタで同じ物を使う。
import { daysInMonth, pad2 } from './dates'
import { isOneOf, SLOT_VALUES, type Slot } from './types'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** 日本時間の時差（+9時間） */
export const JST_OFFSET_MS = 9 * HOUR_MS

/** 版と話題が残る日数（D10。版の日付 D の記録は、日本時間の D＋30日の 0時に消える） */
export const RETENTION_DAYS = 30

/** 枠の時刻（日本時間の時） */
export const SLOT_HOURS: Readonly<Record<Slot, number>> = { '12': 12, '20': 20 }

/** 日本時間の暦と時刻 */
export interface JstParts {
  /** 'YYYY-MM-DD' */
  date: string
  y: number
  m: number
  d: number
  hour: number
  minute: number
}

const fourDigits = (y: number): string => String(y).padStart(4, '0')

/** ミリ秒（UTC）の、日本時間の暦と時刻 */
export function jstParts(ms: number): JstParts {
  const t = new Date(ms + JST_OFFSET_MS)
  const y = t.getUTCFullYear()
  const m = t.getUTCMonth() + 1
  const d = t.getUTCDate()
  return { date: `${fourDigits(y)}-${pad2(m)}-${pad2(d)}`, y, m, d, hour: t.getUTCHours(), minute: t.getUTCMinutes() }
}

/** ミリ秒（UTC）の、日本時間の日付（'YYYY-MM-DD'） */
export function jstDateOf(ms: number): string {
  return jstParts(ms).date
}

/** 'YYYY-MM-DD' の形で、本当にある日付か（2月30日などは false） */
export function isYmd(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)
}

/** 'YYYY-MM' の形か（用語の説明の時点 asOf。docs/SPEC.md の 7.3） */
export function isYm(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)
}

/** 経緯の日付 when の形か（'YYYY'・'YYYY-MM'・'YYYY-MM-DD'。記事に書かれた日付のまま。docs/SPEC.md の 7.1） */
export function isTimelineWhen(v: unknown): v is string {
  return typeof v === 'string' && (/^\d{4}$/.test(v) || isYm(v) || isYmd(v))
}

/**
 * 日本時間の時差つきの日時か（'YYYY-MM-DDTHH:MM(:SS)?+09:00'。出典の publishedAt・候補を集めた窓。docs/SPEC.md の 7.1・7.2）。
 * 日付は本当にある日、時刻は 00:00〜23:59（秒は 00〜59）
 */
export function isJstDateTime(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?\+09:00$/.exec(v)
  if (!m || !isYmd(m[1])) return false
  return Number(m[2]) <= 23 && Number(m[3]) <= 59 && (m[4] === undefined || Number(m[4]) <= 59)
}

/** 出典の掲載日時の形か（日本時間の時差つきの日時か、日付だけ） */
export function isPublishedAt(v: unknown): v is string {
  return isJstDateTime(v) || isYmd(v)
}

/** 'YYYY-MM-DD' に日を足す（月・年をまたぐ。暦の計算なので UTC の暦で数える） */
export function addDaysToDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(0)
  t.setUTCFullYear(y, m - 1, d + days)
  return `${fourDigits(t.getUTCFullYear())}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`
}

/** 日本時間のその日の 0時（ミリ秒・UTC） */
export function jstStartOfDayMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(0)
  t.setUTCFullYear(y, m - 1, d)
  return t.getTime() - JST_OFFSET_MS
}

/** 枠の時刻（日本時間のその日の 12:00・20:00。ミリ秒・UTC） */
export function slotTimeMs(date: string, slot: Slot): number {
  return jstStartOfDayMs(date) + SLOT_HOURS[slot] * HOUR_MS
}

/**
 * その時刻までに、時刻の上で出ているはずのいちばん新しい枠（日本時間）。20:00 から次の 12:00 の前までは 20:00版、12:00 から 20:00 の前までは
 * その日の 12:00版（0時から 12:00 の前は、前の日の 20:00版）。版も作れなかった印も無い時に「まだ届いていません」の類を出すかを決める物
 * （言葉・何分後かは段階2。docs/SPEC.md の 7.2）
 */
export function latestSlotAt(ms: number): { date: string; slot: Slot } {
  const p = jstParts(ms)
  if (p.hour >= SLOT_HOURS['20']) return { date: p.date, slot: '20' }
  if (p.hour >= SLOT_HOURS['12']) return { date: p.date, slot: '12' }
  return { date: addDaysToDate(p.date, -1), slot: '20' }
}

/** 決まった枠の値か */
export const isSlot = (v: unknown): v is Slot => isOneOf(SLOT_VALUES, v)

// ---------- 30日の境（docs/SPEC.md の 7.8 の「30日で消す」） ----------

/** 版の日付 D の記録が消える時刻（日本時間の D＋30日の 0時。ミリ秒・UTC）。ルールの expiredDay と同じ境（docs/SPEC.md の 7.7） */
export function expiresAtMs(date: string): number {
  return jstStartOfDayMs(addDaysToDate(date, RETENTION_DAYS))
}

/** 版の日付 D の記録が、その時刻に30日を過ぎているか（D＋30日の 0時ちょうどから過ぎている） */
export function isExpiredDate(date: string, nowMs: number): boolean {
  return nowMs >= expiresAtMs(date)
}

/**
 * その時刻の30日の境: 消すのは版の日付 ≦ lastExpiredDate（今日 − 30日）の物、残るのは版の日付 ≧ firstKeptDate（今日 − 29日）の物。
 * 例: 12/15 の 0時（日本時間）からは 11/15 の版が消え、11/16〜12/15 の30日分が残る
 */
export function retentionBoundary(nowMs: number): { lastExpiredDate: string; firstKeptDate: string } {
  const today = jstDateOf(nowMs)
  return { lastExpiredDate: addDaysToDate(today, -RETENTION_DAYS), firstKeptDate: addDaysToDate(today, 1 - RETENTION_DAYS) }
}

/** 版の日付がその時刻に30日の内か（画面に出す版・端末の中で消すか。端末の時計で決める。docs/SPEC.md の 7.8） */
export function isWithinRetention(date: string, nowMs: number): boolean {
  return date >= retentionBoundary(nowMs).firstKeptDate
}

/**
 * クラウドで30日の外の文書を引く、文書の id の範囲の上の端（この値より小さい '{表名}:…' を消す。docs/SPEC.md の 7.8 の「30日で消す」）。
 * 境は '{表名}:{今日 − 29日}'。'{表名}:2026-11-15-20' < '{表名}:2026-11-16' < '{表名}:2026-11-16-12' なので、版の日付で切れる。
 * nowMs はサーバーの時刻の見積もり（estimateServerNow）を渡す（時計の進んだ端末が早く消さないように）
 */
export function expiryDocIdBefore(table: string, serverNowMs: number): string {
  return `${table}:${retentionBoundary(serverNowMs).firstKeptDate}`
}

// ---------- 初めての受け取り（docs/SPEC.md の 7.8 の「版と話題を受け取る」・16.6 の 26） ----------

/**
 * 初めての受け取りで購読を始める位置の日数（端末の時計 − 32日）。30日の内の版・話題・作れなかった印・既読だけを受け取るのに、1日の余裕を
 * 足した物。既読は版が出た後に書くので、30日の内の版の既読の updated も32日前より後にある。records・private のどちらも同じ位置から
 * 始める（16.6 の 26）
 */
export const FIRST_SYNC_LOOKBACK_DAYS = 32

/**
 * 最後にクラウドとそろった時刻（_meta の caughtUpAt。端末の時計）がこの日数より前なら、初めての受け取りからやり直す（docs/SPEC.md の
 * 7.8）。位置ではなく caughtUpAt で決めるのは、コネクタが31日以上書かない間に、開くたびに「知ってる」を全部読み直さないため
 */
export const CAUGHT_UP_STALE_DAYS = 31

/**
 * 初めての受け取りで購読を始める位置（ミリ秒・UTC）。サーバーの時刻の見積もりではなく端末の時計で決める（記録がまだ1件も届いていないと
 * 見積もりが無く、「知ってる」だけから見積もると過去にずれる。版を出す条件も端末の時計なので、そろう。docs/SPEC.md の 7.8）
 */
export function firstSyncSinceMs(deviceNowMs: number): number {
  return deviceNowMs - FIRST_SYNC_LOOKBACK_DAYS * DAY_MS
}

/**
 * 最後にクラウドとそろった時刻が、端末の時計で31日より前か（初めての受け取りからやり直すか）。そろった時刻を知らない時・端末の時計が
 * そろった時刻より戻った時の扱いは、DS のエンジン（resyncDue）と同じく呼ぶ側が決める
 */
export function isCaughtUpStale(caughtUpAtMs: number, deviceNowMs: number): boolean {
  return deviceNowMs - caughtUpAtMs > CAUGHT_UP_STALE_DAYS * DAY_MS
}

// ---------- サーバーの時刻の見積もり（docs/SPEC.md の 7.8 の「30日で消す」。DS の clockSkew・serverNow） ----------

/**
 * 届いた文書のサーバー時刻（updated）と、受け取った時の端末の時計の差（端末 − サーバー）のいちばん小さい値を残す。
 * 届いた文書はどれも今より前に書かれたので、差のいちばん小さい値を引いた見積もりは、本当のサーバーの時刻より先に進まない
 * （端末の時計を途中で進めない限り）。DS の src/sync/engine.ts の clockSkew と同じ考え
 */
export function nextClockSkew(prev: number | null, deviceNowMs: number, serverUpdatedMs: number): number {
  const skew = deviceNowMs - serverUpdatedMs
  return prev === null || skew < prev ? skew : prev
}

/** サーバーの時刻の見積もり（まだ1件も届いていなければ null。その間はクラウドから消さない。DS の serverNow） */
export function estimateServerNow(deviceNowMs: number, skew: number | null): number | null {
  return skew === null ? null : deviceNowMs - skew
}

/** 1日のミリ秒（呼ぶ側の計算に） */
export const ONE_DAY_MS = DAY_MS
