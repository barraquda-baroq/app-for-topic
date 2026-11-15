// 日本時間の日付・枠・30日の境（docs/SPEC.md の 7.7・7.8・16.3）: 端末の時差に左右されない（Asia/Tokyo・America/Los_Angeles・
// Pacific/Kiritimati）、日本時間の 0時をまたぐ前後、30日の境（D＋30日の 0時）、サーバーの時刻の見積もり（時計の進んだ端末が早く消さない）
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addDaysToDate,
  CAUGHT_UP_STALE_DAYS,
  estimateServerNow,
  expiresAtMs,
  expiryDocIdBefore,
  FIRST_SYNC_LOOKBACK_DAYS,
  firstSyncSinceMs,
  isCaughtUpStale,
  isExpiredDate,
  isJstDateTime,
  isPublishedAt,
  isTimelineWhen,
  isWithinRetention,
  isYm,
  isYmd,
  jstDateOf,
  jstParts,
  jstStartOfDayMs,
  latestSlotAt,
  nextClockSkew,
  ONE_DAY_MS,
  retentionBoundary,
  slotTimeMs,
} from './jst'

const ZONES = ['Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati'] as const

/** 日本時間の壁時計の時刻（ミリ秒・UTC） */
const jst = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) => Date.UTC(y, m - 1, d, h - 9, min, s, ms)

afterEach(() => vi.unstubAllEnvs())

describe('日本時間の日付', () => {
  it('日本時間の 0時で日付が変わる（UTC の 15時）', () => {
    expect(jstDateOf(jst(2026, 11, 15, 23, 59, 59, 999))).toBe('2026-11-15')
    expect(jstDateOf(jst(2026, 11, 16, 0, 0))).toBe('2026-11-16')
    expect(jstDateOf(Date.UTC(2026, 10, 15, 14, 59, 59, 999))).toBe('2026-11-15')
    expect(jstDateOf(Date.UTC(2026, 10, 15, 15, 0))).toBe('2026-11-16')
    expect(jstDateOf(jst(2026, 12, 31, 23, 59))).toBe('2026-12-31')
    expect(jstDateOf(jst(2027, 1, 1, 0, 0))).toBe('2027-01-01')
    expect(jstParts(jst(2026, 11, 15, 12, 5))).toMatchObject({ date: '2026-11-15', hour: 12, minute: 5 })
  })

  it('端末の時差に左右されない（Asia/Tokyo・America/Los_Angeles・Pacific/Kiritimati で同じ）', () => {
    const times = [jst(2026, 11, 15, 0, 0), jst(2026, 11, 15, 23, 59), jst(2027, 3, 14, 2, 30), jst(2026, 11, 1, 9, 0)]
    const results = ZONES.map((tz) => {
      vi.stubEnv('TZ', tz)
      return times.map((t) => [jstDateOf(t), jstStartOfDayMs(jstDateOf(t)), expiresAtMs(jstDateOf(t)), latestSlotAt(t)])
    })
    // 端末の時差が本当に変わっている（同じ時刻の、端末の現地の日付が違う）
    vi.stubEnv('TZ', 'America/Los_Angeles')
    const la = new Date(jst(2026, 11, 15, 9, 0)).getDate()
    vi.stubEnv('TZ', 'Pacific/Kiritimati')
    const kiri = new Date(jst(2026, 11, 15, 9, 0)).getDate()
    expect(la).not.toBe(kiri)
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])
  })

  it('日付・時点・経緯の日付・日時の形', () => {
    expect(isYmd('2026-11-15')).toBe(true)
    expect(isYmd('2028-02-29')).toBe(true)
    expect(isYmd('2026-02-29')).toBe(false)
    expect(isYmd('2026-11-31')).toBe(false)
    expect(isYmd('2026-13-01')).toBe(false)
    expect(isYmd('2026-1-01')).toBe(false)
    expect(isYm('2026-11')).toBe(true)
    expect(isYm('2026-00')).toBe(false)
    expect(isYm('2026-11-01')).toBe(false)
    expect(['2026', '2026-11', '2026-11-15'].every(isTimelineWhen)).toBe(true)
    expect(isTimelineWhen('11月15日')).toBe(false)
    expect(isJstDateTime('2026-11-15T10:00+09:00')).toBe(true)
    expect(isJstDateTime('2026-11-15T10:00:30+09:00')).toBe(true)
    expect(isJstDateTime('2026-11-15T10:00Z')).toBe(false)
    expect(isJstDateTime('2026-11-15T24:00+09:00')).toBe(false)
    expect(isJstDateTime('2026-11-15T10:00:00.000+09:00')).toBe(false)
    expect(isPublishedAt('2026-11-15')).toBe(true)
    expect(isPublishedAt('2026/11/15')).toBe(false)
  })

  it('日を足す（月・年・うるう年をまたぐ）', () => {
    expect(addDaysToDate('2026-11-15', 30)).toBe('2026-12-15')
    expect(addDaysToDate('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysToDate('2028-03-01', -1)).toBe('2028-02-29')
    expect(addDaysToDate('2026-01-10', -30)).toBe('2025-12-11')
  })

  it('枠の時刻と、時刻の上で出ているはずのいちばん新しい枠', () => {
    expect(slotTimeMs('2026-11-15', '12')).toBe(jst(2026, 11, 15, 12))
    expect(slotTimeMs('2026-11-15', '20')).toBe(jst(2026, 11, 15, 20))
    expect(latestSlotAt(jst(2026, 11, 15, 11, 59))).toEqual({ date: '2026-11-14', slot: '20' })
    expect(latestSlotAt(jst(2026, 11, 15, 12, 0))).toEqual({ date: '2026-11-15', slot: '12' })
    expect(latestSlotAt(jst(2026, 11, 15, 19, 59))).toEqual({ date: '2026-11-15', slot: '12' })
    expect(latestSlotAt(jst(2026, 11, 15, 20, 0))).toEqual({ date: '2026-11-15', slot: '20' })
    expect(latestSlotAt(jst(2026, 11, 16, 0, 30))).toEqual({ date: '2026-11-15', slot: '20' })
  })
})

describe('30日の境（docs/SPEC.md の 7.8 の「30日で消す」）', () => {
  it('11/15 の版は 12/15 の 0時（日本時間）に消える。0時の前は残る', () => {
    expect(expiresAtMs('2026-11-15')).toBe(jst(2026, 12, 15, 0, 0))
    expect(isExpiredDate('2026-11-15', jst(2026, 12, 14, 23, 59, 59, 999))).toBe(false)
    expect(isExpiredDate('2026-11-15', jst(2026, 12, 15, 0, 0))).toBe(true)
    // 29日目は残り、30日目は消える
    expect(isExpiredDate('2026-11-16', jst(2026, 12, 15, 12, 0))).toBe(false)
  })

  it('境: 今日 − 30日 までを消し、今日 − 29日 からを残す（30日分）', () => {
    const now = jst(2026, 12, 15, 0, 0)
    expect(retentionBoundary(now)).toEqual({ lastExpiredDate: '2026-11-15', firstKeptDate: '2026-11-16' })
    expect(retentionBoundary(now - 1)).toEqual({ lastExpiredDate: '2026-11-14', firstKeptDate: '2026-11-15' })
    expect(isWithinRetention('2026-11-16', now)).toBe(true)
    expect(isWithinRetention('2026-11-15', now)).toBe(false)
    expect(isWithinRetention('2026-11-15', now - 1)).toBe(true)
    // 境の日付と isExpiredDate はそろう
    for (const t of [now - 1, now, now + ONE_DAY_MS / 2]) {
      const { lastExpiredDate, firstKeptDate } = retentionBoundary(t)
      expect(isExpiredDate(lastExpiredDate, t)).toBe(true)
      expect(isExpiredDate(firstKeptDate, t)).toBe(false)
    }
  })

  it('クラウドで引く文書の id の範囲の上の端（版の日付で切れる）', () => {
    const cut = expiryDocIdBefore('editions', jst(2026, 12, 15, 0, 0))
    expect(cut).toBe('editions:2026-11-16')
    expect('editions:2026-11-15-20' < cut).toBe(true)
    expect('editions:2026-11-16-12' < cut).toBe(false)
    const topics = expiryDocIdBefore('topics', jst(2026, 12, 15, 0, 0))
    expect('topics:2026-11-15-20-abcdefgh' < topics).toBe(true)
    expect('topics:2026-11-16-12-abcdefgh' < topics).toBe(false)
    const corr = expiryDocIdBefore('corrections', jst(2026, 12, 15, 0, 0))
    expect('corrections:2026-11-15-20-abcdefgh-12345678' < corr).toBe(true)
  })

  it('サーバーの時刻の見積もり: 時計の進んだ端末が早く消さない', () => {
    // 端末の時計が2日進んでいる。届いた文書のサーバー時刻と受け取った時の端末の時計の差のいちばん小さい値を残す
    const server = jst(2026, 12, 14, 23, 0)
    const ahead = 2 * ONE_DAY_MS
    let skew: number | null = null
    expect(estimateServerNow(server + ahead, skew)).toBeNull()
    skew = nextClockSkew(skew, server + ahead, server - 60_000) // 1分前に書かれた文書
    skew = nextClockSkew(skew, server + ahead + 1000, server + 500) // 0.5秒前に書かれた文書（差が小さい方を残す）
    skew = nextClockSkew(skew, server + ahead + 2000, server - 3_600_000) // 古い文書（差が大きいので変えない）
    expect(skew).toBe(ahead + 500)
    const deviceNow = server + ahead + 10_000
    const est = estimateServerNow(deviceNow, skew)!
    // 見積もりは本当のサーバーの時刻（server + 10秒）より先に進まない
    expect(est).toBeLessThanOrEqual(server + 10_000)
    // 端末の時計では 11/15 の版はもう30日を過ぎているが、見積もりでは過ぎていない（12/15 の 0時の前）
    expect(isExpiredDate('2026-11-15', deviceNow)).toBe(true)
    expect(isExpiredDate('2026-11-15', est)).toBe(false)
    // 遅れている端末は、見積もりで遅れを取り戻す
    const behind = nextClockSkew(null, server - ahead, server - 1000)
    expect(estimateServerNow(server - ahead, behind)).toBe(server - 1000)
  })
})

describe('初めての受け取り（docs/SPEC.md の 7.8 の「版と話題を受け取る」）', () => {
  it('購読は端末の時計 − 32日から。30日の内のどの版の枠の時刻より前で、30日の境より2日前まで', () => {
    expect(FIRST_SYNC_LOOKBACK_DAYS).toBe(32)
    for (const now of [jst(2026, 12, 15, 0, 0), jst(2026, 12, 15, 23, 59, 59, 999), jst(2028, 3, 1, 9, 30)]) {
      const since = firstSyncSinceMs(now)
      expect(now - since).toBe(32 * ONE_DAY_MS)
      // 30日の内でいちばん古い日の版（12:00版の回は 10:20 ごろに始まる）も、購読を始める位置より後に書かれる
      const { firstKeptDate } = retentionBoundary(now)
      expect(jstStartOfDayMs(firstKeptDate)).toBeGreaterThan(since)
      expect(slotTimeMs(firstKeptDate, '12') - 100 * 60_000).toBeGreaterThan(since)
    }
  })

  it('最後にクラウドとそろった時刻が31日より前なら、初めての受け取りからやり直す（ちょうど31日はやり直さない）', () => {
    expect(CAUGHT_UP_STALE_DAYS).toBe(31)
    const caughtUp = jst(2026, 11, 15, 12, 0)
    expect(isCaughtUpStale(caughtUp, caughtUp + 31 * ONE_DAY_MS)).toBe(false)
    expect(isCaughtUpStale(caughtUp, caughtUp + 31 * ONE_DAY_MS + 1)).toBe(true)
    expect(isCaughtUpStale(caughtUp, caughtUp + ONE_DAY_MS)).toBe(false)
  })
})
