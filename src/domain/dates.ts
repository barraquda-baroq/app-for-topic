// 暦の日付の計算。日付は端末の現地の暦の日付（壁時計の値。時差では動かさない）、日の変わり目は端末の 0時。
// DS の src/domain/dates.ts から、段階0に要る分（ログインの画面の日付と、日付が変わった時の計算し直し）だけを写した物。
// 曜日・日を足す計算は、DS の直し（日付変更線をまたいで暦の日が飛んだ時差でもずれないよう、その日の UTC の 0時で数える）を入れてある

/** 暦の日付（端末の現地の日付。m は 1〜12） */
export interface Ymd {
  y: number
  m: number
  d: number
}

/** 曜日の英字3文字（日曜始まり） */
export const WEEKDAYS_EN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const

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

/** 次の 0時（端末の現地の時刻）までのミリ秒。今日の計算し直しのタイマーに使う */
export function msUntilNextDay(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return next.getTime() - now.getTime()
}

/** ログインの画面の今日の曜日と日付（「SAT · 2026.11.14」。docs/SPEC.md の 14.4） */
export function coverDateLabel(v: Ymd): string {
  return `${WEEKDAYS_EN[weekdayOf(v)]} · ${v.y}.${pad2(v.m)}.${pad2(v.d)}`
}
