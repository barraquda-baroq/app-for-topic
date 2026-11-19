// ホストごとの間（段階3の設計の 1.6 の「取りに行く間」）: 同じホストへは、robots.txt の Crawl-delay と data の crawlDelaySec・
// permit.minIntervalSec と 1秒の、いちばん長い間をあける。取りに行く前に、そのホストの「次に取ってよい時刻」を先に進めてから待つ
// （取る時刻の予約。vault/store.ts の host_pace の表。同じ時に呼ばれた道具・alarm が同じ表を使うので、重なっても間が縮まない）。
// 待つ間は CPU を使わない（core.sleep）。道具の呼び出しの待ちが15秒を超える時は、予約せずに「混んでいます」。応答が終わった時刻からも
// 同じ間をあける（settle。予約した時刻は縮めない）
import type { MirrorStore } from '../vault/store'
import { sourcesOfHost, type SourceConfig } from './sources'

/** いちばん短い間（ms） */
export const MIN_GAP_MS = 1_000
/** 道具の呼び出しで待つ上限（ms。超えたら「混んでいます。もう一度呼んでください」） */
export const TOOL_WAIT_MAX_MS = 15_000

/** そのホストの間（ms）: robots.txt の Crawl-delay・data の crawlDelaySec・permit.minIntervalSec・1秒の長い方 */
export function hostGapMs(store: MirrorStore, sources: readonly SourceConfig[], host: string): number {
  let gap = MIN_GAP_MS
  const rule = store.hostRule(host)
  if (rule?.crawlDelay !== null && rule?.crawlDelay !== undefined) gap = Math.max(gap, Math.ceil(rule.crawlDelay * 1_000))
  for (const s of sourcesOfHost(sources, host)) {
    if (s.crawlDelaySec !== undefined) gap = Math.max(gap, s.crawlDelaySec * 1_000)
    if (s.permit) gap = Math.max(gap, s.permit.minIntervalSec * 1_000)
  }
  return gap
}

/** 予約しないで、今から待つ ms（次に取ってよい時刻まで） */
export function waitFor(store: MirrorStore, host: string, now: number): number {
  const next = store.hostNext(host)
  return next === null ? 0 : Math.max(0, next - now)
}

/**
 * 取る時刻を予約する（待ちが maxWait を超える時は予約せずに null）。読みと書きの間に await を挟まないので、同時の呼び出しでも間は縮まない。
 * 返すのは待つ ms
 */
export function reserve(store: MirrorStore, host: string, now: number, gapMs: number, maxWait: number): number | null {
  if (waitFor(store, host, now) > maxWait) return null
  return store.reserveHost(host, now, gapMs)
}

/**
 * 応答が終わった時: 次に取ってよい時刻を、終わった時刻から間をあけた時刻より前にしない（遅い応答の直後に次を取らない。予約した時刻は
 * 縮めない）
 */
export function settle(store: MirrorStore, host: string, doneAt: number, gapMs: number): void {
  const next = store.hostNext(host)
  if (next !== null && next >= doneAt + gapMs) return
  store.sql.run('UPDATE host_pace SET next = ? WHERE host = ? AND next < ?', doneAt + gapMs, host, doneAt + gapMs)
  store.countRows(1)
}
