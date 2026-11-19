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
 * （言葉と30分は段階2で決めた。src/domain/editionStatus.ts の NOT_ARRIVED_AFTER_MIN。docs/SPEC.md の 7.2・17.6 の 7）
 */
export function latestSlotAt(ms: number): { date: string; slot: Slot } {
  const p = jstParts(ms)
  if (p.hour >= SLOT_HOURS['20']) return { date: p.date, slot: '20' }
  if (p.hour >= SLOT_HOURS['12']) return { date: p.date, slot: '12' }
  return { date: addDaysToDate(p.date, -1), slot: '20' }
}

/** 決まった枠の値か */
export const isSlot = (v: unknown): v is Slot => isOneOf(SLOT_VALUES, v)

/** ミリ秒（UTC）の、日本時間の時差つきの日時（'YYYY-MM-DDTHH:MM+09:00'。withSeconds なら秒も。候補を集めた窓・出典の掲載日時の形） */
export function jstDateTimeOf(ms: number, withSeconds = false): string {
  const p = jstParts(ms)
  const sec = withSeconds ? `:${pad2(new Date(ms + JST_OFFSET_MS).getUTCSeconds())}` : ''
  return `${p.date}T${pad2(p.hour)}:${pad2(p.minute)}${sec}+09:00`
}

// ---------- 回の枠・期限・締め切り（段階3。段階3の設計の 1.3。docs/SPEC.md の 7.8 の「コネクタの足す順」の 1.） ----------

/**
 * 回の枠の境（日本時間の時）: 回を始めた時刻が 10:00〜17:59 → その日の 12、18:00〜23:59 → その日の 20、0:00〜9:59 → 前の日の 20。
 * 画面の境（latestSlotAt の 12:00・20:00）とは別の物。定期実行の始まり（10:16・18:16）は境の 16分後で、遅れても境は割らない
 */
export const RUN_SLOT_START_HOURS: Readonly<Record<Slot, number>> = { '12': 10, '20': 18 }

/** 回の期限（どの種類も始めて12時間。過ぎた runId は古い回として断る） */
export const RUN_TTL_MS = 12 * HOUR_MS

/** 回を始めた時刻（ミリ秒・UTC）の枠（日本時間。端末の時差に左右されない） */
export function runSlotAt(ms: number): { date: string; slot: Slot } {
  const p = jstParts(ms)
  if (p.hour >= RUN_SLOT_START_HOURS['20']) return { date: p.date, slot: '20' }
  if (p.hour >= RUN_SLOT_START_HOURS['12']) return { date: p.date, slot: '12' }
  return { date: addDaysToDate(p.date, -1), slot: '20' }
}

/**
 * 枠の窓の頭の決まった時刻（直前の版の window.until が無い・古い時に使う。12 → 前の日の 18:00、20 → その日の 10:00。ミリ秒・UTC）。
 * 前の枠の境と同じ時刻
 */
export function slotWindowFallbackSinceMs(date: string, slot: Slot): number {
  return slot === '12'
    ? jstStartOfDayMs(addDaysToDate(date, -1)) + RUN_SLOT_START_HOURS['20'] * HOUR_MS
    : jstStartOfDayMs(date) + RUN_SLOT_START_HOURS['12'] * HOUR_MS
}

/** 締め切りの分（書く係: 版の時刻の15分前と始めて90分の遅い方。照合: 版の時刻の45分後と始めて150分の遅い方） */
export const RUN_DEADLINE_MINUTES = {
  writerBeforeSlot: 15,
  writerFromStart: 90,
  checkerAfterSlot: 45,
  checkerFromStart: 150,
} as const

/**
 * 回の締め切り（ミリ秒・UTC）。writerMs = 書く係の締め切り、checkerMs = 照合の打ち切り。版の回は、版の時刻からと始めてからの遅い方
 * （作れなかった後に昼過ぎにやり直す回でも、始めてすぐ打ち切りにならない）。試しの回（slot を null で渡す）は始めて90分・150分。
 * 訂正だけの回は締め切りを持たない（呼ばない）
 */
export function runDeadlinesAt(
  startMs: number,
  slot: { date: string; slot: Slot } | null,
): { writerMs: number; checkerMs: number } {
  const M = RUN_DEADLINE_MINUTES
  const writerFromStart = startMs + M.writerFromStart * 60_000
  const checkerFromStart = startMs + M.checkerFromStart * 60_000
  if (slot === null) return { writerMs: writerFromStart, checkerMs: checkerFromStart }
  const at = slotTimeMs(slot.date, slot.slot)
  return {
    writerMs: Math.max(at - M.writerBeforeSlot * 60_000, writerFromStart),
    checkerMs: Math.max(at + M.checkerAfterSlot * 60_000, checkerFromStart),
  }
}

// ---------- 掲載日時（段階3。出典の publishedAt。段階3の設計の 1.5） ----------

/** 掲載日時が読めない・無い時の補足（出典の publishedNote） */
export const PUBLISHED_UNKNOWN_NOTE = '掲載日時は不明'

const ERAS = [
  { name: '令和', first: 2019, since: '2019-05-01', until: '9999-12-31' },
  { name: '平成', first: 1989, since: '1989-01-08', until: '2019-04-30' },
  { name: '昭和', first: 1926, since: '1926-12-25', until: '1989-01-07' },
] as const

const ymdOf = (y: number, m: number, d: number): string | null => {
  const v = `${fourDigits(y)}-${pad2(m)}-${pad2(d)}`
  return y >= 1000 && y <= 9999 && isYmd(v) ? v : null
}

/** 文の中のいちばん前の和暦・西暦の日付と、その終わりの位置（NFKC にそろえた文の位置） */
function findJpDate(text: string): { date: string; end: number } | null {
  const re =
    /(令和|平成|昭和)\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日|(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日|(?<!\d)(\d{4})\/(\d{1,2})\/(\d{1,2})(?!\d)/g
  for (const m of text.matchAll(re)) {
    let date: string | null = null
    if (m[1] !== undefined) {
      const era = ERAS.find((e) => e.name === m[1])
      const n = m[2] === '元' ? 1 : Number(m[2])
      const ymd = era && n >= 1 ? ymdOf(era.first + n - 1, Number(m[3]), Number(m[4])) : null
      date = ymd && era && ymd >= era.since && ymd <= era.until ? ymd : null
    } else if (m[5] !== undefined) date = ymdOf(Number(m[5]), Number(m[6]), Number(m[7]))
    else date = ymdOf(Number(m[8]), Number(m[9]), Number(m[10]))
    if (date) return { date, end: (m.index ?? 0) + m[0].length }
  }
  return null
}

/**
 * 文の中の和暦・西暦の日付（'YYYY-MM-DD'。「令和8年11月19日」「令和元年5月1日」「2026年11月19日」「2026/11/19」。全角の数字も読む。
 * いちばん前の物。本当に無い日付・元号の外の日付は読まない。無ければ null）。HTML の一覧・ページの日付に使う
 */
export function jpDateOf(text: unknown): string | null {
  if (typeof text !== 'string') return null
  return findJpDate(text.normalize('NFKC'))?.date ?? null
}

/** RFC 822 の時差の名前（RSS の pubDate。分） */
const NAMED_ZONES: Readonly<Record<string, number>> = {
  GMT: 0,
  UT: 0,
  UTC: 0,
  Z: 0,
  JST: 9 * 60,
  EST: -5 * 60,
  EDT: -4 * 60,
  CST: -6 * 60,
  CDT: -5 * 60,
  MST: -7 * 60,
  MDT: -6 * 60,
  PST: -8 * 60,
  PDT: -7 * 60,
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** '+09:00'・'+0900'・'-05'・名前 → 分（読めなければ null。無い時は日本時間） */
function zoneMinutes(zone: string | undefined): number | null {
  if (zone === undefined || zone === '') return JST_OFFSET_MS / 60_000
  const named = NAMED_ZONES[zone.toUpperCase()]
  if (named !== undefined) return named
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone)
  if (!m) return null
  const h = Number(m[2])
  const min = Number(m[3] ?? '0')
  if (h > 14 || min > 59) return null
  return (m[1] === '-' ? -1 : 1) * (h * 60 + min)
}

/** 暦と時刻と時差から、日本時間の時差つきの日時（本当に無い日時・読めない時差は null） */
function toJst(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  sec: number | null,
  zone: string | undefined,
): string | null {
  if (!ymdOf(y, mo, d) || h > 23 || mi > 59 || (sec !== null && sec > 59)) return null
  const offset = zoneMinutes(zone)
  if (offset === null) return null
  return jstDateTimeOf(Date.UTC(y, mo - 1, d, h, mi, sec ?? 0) - offset * 60_000, sec !== null)
}

/**
 * 資料の頭の時刻・一覧の日付を、出典の掲載日時の形（日本時間の 'YYYY-MM-DDTHH:MM(:SS)?+09:00' か 'YYYY-MM-DD'）に直す（段階3の設計の 1.5。
 * docs/SPEC.md の 7.1 の「時差の無い値は日本時間として読む」）。読める形: ISO 8601（article:published_time・datePublished・dc:date・
 * Atom の updated・電文の時刻。'Z' やほかの時差は日本時間に計算し直す。時差の無い値は日本時間として読む。秒より細かい所は切る）・
 * RFC 822（RSS の pubDate）・日付だけ（そのまま）・和暦と西暦の日付（jpDateOf。後に「10時30分」「10:30」が続けば時刻も）。
 * 読めない値・無い値は null（その時の出典の publishedNote は PUBLISHED_UNKNOWN_NOTE）
 */
export function publishedAtOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.normalize('NFKC').trim()
  if (!t) return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i.exec(t)
  if (iso) {
    const [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    if (iso[4] === undefined) return ymdOf(y, mo, d)
    return toJst(y, mo, d, Number(iso[4]), Number(iso[5]), iso[6] === undefined ? null : Number(iso[6]), iso[7])
  }
  const rfc =
    /^(?:[a-z]{3},?\s*)?(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4}|\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([a-z]{1,5}|[+-]\d{4})?$/i.exec(
      t,
    )
  if (rfc) {
    const mo = MONTHS.indexOf(rfc[2].toLowerCase()) + 1
    if (mo === 0) return null
    const y = rfc[3].length === 2 ? 2000 + Number(rfc[3]) : Number(rfc[3])
    return toJst(y, mo, Number(rfc[1]), Number(rfc[4]), Number(rfc[5]), rfc[6] === undefined ? null : Number(rfc[6]), rfc[7])
  }
  const jp = findJpDate(t)
  if (!jp) return null
  const time = /^\s*(?:\([^)]{1,4}\))?\s*(\d{1,2})\s*(?:時|:)\s*(\d{1,2})/.exec(t.slice(jp.end))
  if (time) {
    const [y, mo, d] = jp.date.split('-').map(Number)
    const at = toJst(y, mo, d, Number(time[1]), Number(time[2]), null, undefined)
    if (at) return at
  }
  return jp.date
}

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
