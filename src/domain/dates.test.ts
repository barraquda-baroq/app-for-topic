// 暦の日付の計算（DS の src/domain/dates.test.ts から、段階0に写した物の分）: 月の日数（うるう年）・日を足す・次の 0時まで・
// ログインの画面の日付・端末の時差で暦の日が飛んでもずれないこと。段階2で足した版の日付の日本語の曜日（weekdayJaOf）
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addDays,
  coverDateLabel,
  daysInMonth,
  msUntilNextDay,
  sameDay,
  todayYmd,
  weekdayJaOf,
  weekdayOf,
  WEEKDAYS_JA,
  type Ymd,
} from './dates'

const d = (y: number, m: number, day: number): Ymd => ({ y, m, d: day })

afterEach(() => vi.unstubAllEnvs())

describe('暦の小さな計算', () => {
  it('その月の日数（うるう年）', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2028, 2)).toBe(29)
    expect(daysInMonth(2100, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
    expect(daysInMonth(2026, 11)).toBe(30)
  })

  it('日を足す（月・年をまたぐ）と曜日', () => {
    expect(addDays(d(2026, 12, 31), 1)).toEqual(d(2027, 1, 1))
    expect(addDays(d(2028, 3, 1), -1)).toEqual(d(2028, 2, 29))
    expect(weekdayOf(d(2026, 11, 14))).toBe(6)
    expect(weekdayOf(d(2026, 11, 15))).toBe(0)
  })

  it('今日は端末の現地の日付', () => {
    expect(todayYmd(new Date(2026, 10, 10, 23, 59))).toEqual(d(2026, 11, 10))
    expect(todayYmd(new Date(2026, 10, 11, 0, 0))).toEqual(d(2026, 11, 11))
    expect(sameDay(d(2026, 11, 14), d(2026, 11, 14))).toBe(true)
    expect(sameDay(d(2026, 11, 14), d(2026, 11, 15))).toBe(false)
  })

  it('次の 0時までのミリ秒（今日の計算し直しのタイマー）', () => {
    expect(msUntilNextDay(new Date(2026, 10, 10, 23, 59, 30))).toBe(30_000)
    expect(msUntilNextDay(new Date(2026, 10, 10, 0, 0, 0))).toBe(24 * 60 * 60 * 1000)
    expect(msUntilNextDay(new Date(2026, 11, 31, 12, 0, 0))).toBe(12 * 60 * 60 * 1000)
  })

  it('日付変更線をまたいで暦の日が飛んだ時差でも、暦の計算はずれない（壁時計の値）', () => {
    // Pacific/Kiritimati は 1994-12-31 が、Pacific/Apia は 2011-12-30 が無い（端末の暦の Date ではその日を作れない）
    vi.stubEnv('TZ', 'Pacific/Kiritimati')
    expect(new Date(1994, 11, 31).getDate()).toBe(1)
    expect(daysInMonth(1994, 12)).toBe(31)
    expect(weekdayOf(d(1994, 12, 31))).toBe(6)
    expect(addDays(d(1994, 12, 30), 1)).toEqual(d(1994, 12, 31))
    expect(coverDateLabel(d(1994, 12, 31))).toBe('SAT · 1994.12.31')
    vi.stubEnv('TZ', 'Pacific/Apia')
    expect(new Date(2011, 11, 30).getDate()).toBe(31)
    expect(weekdayOf(d(2011, 12, 30))).toBe(5)
    expect(addDays(d(2011, 12, 29), 1)).toEqual(d(2011, 12, 30))
  })
})

describe('coverDateLabel（ログインの画面の日付）', () => {
  it('「SAT · 2026.11.14」の形', () => {
    expect(coverDateLabel(d(2026, 11, 14))).toBe('SAT · 2026.11.14')
    expect(coverDateLabel(d(2027, 1, 3))).toBe('SUN · 2027.01.03')
  })
})

describe('weekdayJaOf（版の日付の日本語の曜日。docs/SPEC.md の 9.）', () => {
  it('日曜始まりの1字', () => {
    expect(WEEKDAYS_JA).toEqual(['日', '月', '火', '水', '木', '金', '土'])
    expect(weekdayJaOf('2026-11-15')).toBe('日')
    expect(weekdayJaOf('2026-11-14')).toBe('土')
    expect(weekdayJaOf('2026-11-13')).toBe('金')
  })

  it('月・年の境とうるう年', () => {
    expect(weekdayJaOf('2026-11-30')).toBe('月')
    expect(weekdayJaOf('2026-12-01')).toBe('火')
    expect(weekdayJaOf('2026-12-31')).toBe('木')
    expect(weekdayJaOf('2027-01-01')).toBe('金')
    expect(weekdayJaOf('2028-02-29')).toBe('火')
  })

  it('形の違う物・本当に無い日は null', () => {
    for (const v of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-11-5', '2026/11/15', '', null, 20261115])
      expect([v, weekdayJaOf(v)]).toEqual([v, null])
  })

  it('端末の時差に左右されない', () => {
    vi.stubEnv('TZ', 'Pacific/Kiritimati')
    expect(weekdayJaOf('1994-12-31')).toBe('土')
    vi.stubEnv('TZ', 'America/Los_Angeles')
    expect(weekdayJaOf('2026-11-15')).toBe('日')
  })
})
