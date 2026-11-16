// 暦の日付の計算。日付は端末の現地の暦の日付（壁時計の値。時差では動かさない）、日の変わり目は端末の 0時。
// DS の src/domain/dates.ts から、段階0に要る分（ログインの画面の日付と、日付が変わった時の計算し直し）だけを写した物。
// 曜日・日を足す計算は、DS の直し（日付変更線をまたいで暦の日が飛んだ時差でもずれないよう、その日の UTC の 0時で数える）を入れてある。
// 段階1で、同期の表示の「無料枠を使い切った（{戻る時刻} ごろ）」の戻る時刻（DS の quotaResumeAt）を足した（docs/SPEC.md の 7.8）。
// 段階2で、版の日付（日本時間の 'YYYY-MM-DD'）の日本語の曜日（WEEKDAYS_JA・weekdayJaOf）を足した（ヘッダーの「11/15（日）12:00版」・
// クリップの「2026年11月15日（日）」。docs/SPEC.md の 9.。DS の WEEKDAYS_JA と同じ並び）

/** 暦の日付（端末の現地の日付。m は 1〜12） */
export interface Ymd {
  y: number
  m: number
  d: number
}

/** 曜日の英字3文字（日曜始まり） */
export const WEEKDAYS_EN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const

/** 曜日の日本語1字（日曜始まり。DS と同じ） */
export const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'] as const

/** 2桁にそろえる（11.08 の 08 など） */
export const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 今の時刻の、端末の現地の暦の日付（今日など「今」を暦の日付にする所だけで使う） */
const fromDate = (date: Date): Ymd => ({ y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() })

/**
 * 暦の計算（月の日数・曜日・日を足す）に使う、その日の UTC の 0時。暦の日付は壁時計の値なので、端末の時差に左右されない
 * UTC で数える（端末の暦の Date では、日付変更線をまたいで飛んだ日（Pacific/Kiritimati の 1994-12-31 など）を作れず、
 * 月の日数・曜日がずれる）。setUTCFullYear なので 0〜99年も 1900年代に読み替えない。d は 0 や月の日数より大きくてもよい（繰り上がる）
 */
function utcDay(y: number, m: number, d: number): Date {
  const t = new Date(0)
  t.setUTCFullYear(y, m - 1, d)
  return t
}
const fromUtcDay = (t: Date): Ymd => ({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() })

/** 今日（端末の現地の日付） */
export function todayYmd(now: Date = new Date()): Ymd {
  return fromDate(now)
}

export function sameDay(a: Ymd, b: Ymd): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d
}

/** その月の日数（うるう年の2月は 29） */
export function daysInMonth(y: number, m: number): number {
  return utcDay(y, m + 1, 0).getUTCDate()
}

/** 曜日（0 = 日曜） */
export function weekdayOf(v: Ymd): number {
  return utcDay(v.y, v.m, v.d).getUTCDay()
}

export function addDays(v: Ymd, days: number): Ymd {
  return fromUtcDay(utcDay(v.y, v.m, v.d + days))
}

/**
 * 'YYYY-MM-DD'（版の日付など、暦の日付の文字）の曜日の日本語1字。形の違う物・本当に無い日（2月30日など）は null（書かない）。
 * 暦の計算なので、端末の時差に左右されない（weekdayOf と同じく UTC の暦で数える）。src/domain/jst.ts の isYmd はこのファイルを
 * 読むので、ここでは読み込まずに同じ確かめをする（読み込みが輪にならないように）
 */
export function weekdayJaOf(date: unknown): string | null {
  if (typeof date !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const v: Ymd = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  if (v.m < 1 || v.m > 12 || v.d < 1 || v.d > daysInMonth(v.y, v.m)) return null
  return WEEKDAYS_JA[weekdayOf(v)]
}

/** 次の 0時（端末の現地の時刻）までのミリ秒。今日の計算し直しのタイマーに使う */
export function msUntilNextDay(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return next.getTime() - now.getTime()
}

/** ログインの画面の今日の曜日と日付（「SAT · 2026.11.14」。docs/SPEC.md の 14.4） */
export function coverDateLabel(v: Ymd): string {
  return `${WEEKDAYS_EN[weekdayOf(v)]} · ${v.y}.${pad2(v.m)}.${pad2(v.d)}`
}

// ---------- 無料枠の戻る時刻（docs/SPEC.md の 7.8 の「持ち主・データの形の版・同期の表示」。DS の src/domain/dates.ts から） ----------

/** Firestore の無料枠が戻る時刻のタイムゾーン（米国太平洋時間。無料枠はその 0時に戻る） */
export const QUOTA_TIME_ZONE = 'America/Los_Angeles'

/** その時刻の、あるタイムゾーンの壁時計の値をミリ秒にした物（UTC として読む） */
function wallMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
}

/** 次の太平洋時間の 0時（ミリ秒。今がちょうど 0時なら次の日の 0時） */
export function nextQuotaResetMs(nowMs: number, timeZone: string = QUOTA_TIME_ZONE): number {
  const wall = new Date(wallMs(nowMs, timeZone))
  const midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1)
  // 壁時計の 0時を UTC に直す（時差は夏時間で変わるので、求めた時刻の時差でもう一度直す）
  const offsetAt = (ms: number) => wallMs(ms, timeZone) - ms
  let t = midnight - offsetAt(midnight)
  t = midnight - offsetAt(t)
  return t
}

/**
 * 無料枠が戻る時刻を、端末の時刻の 'HH:MM' で（「17:00 ごろに戻ります」。日本では 17:00、米国の夏時間の間は 16:00。docs/SPEC.md の 7.8）。
 * displayTimeZone はテスト用（無い時は端末のタイムゾーン）
 */
export function quotaResumeAt(nowMs: number, displayTimeZone?: string): string {
  const t = nextQuotaResetMs(nowMs)
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(displayTimeZone ? { timeZone: displayTimeZone } : {}),
  }).format(new Date(t))
}
