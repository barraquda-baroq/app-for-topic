// ホストごとの間（段階3の設計の 1.6 の「取りに行く間」。点検2 guard-G2-09）: Crawl-delay と data の crawlDelaySec・permit.minIntervalSec と
// 1秒の長い方。取る前に次に取ってよい時刻を予約するので、同じホストへ同時に3つの呼び出しが来ても、どの2つの間も間以上あく。
// 15秒を超える待ちは予約しないで「混んでいます」
import { describe, expect, it } from 'vitest'
import type { FetchEnv } from '../../src/fetch/article'
import { sourceGet } from '../../src/fetch/article'
import { hostGapMs, MIN_GAP_MS, reserve, settle, TOOL_WAIT_MAX_MS, waitFor } from '../../src/fetch/pace'
import type { SourceConfig } from '../../src/fetch/sources'
import { MirrorStore } from '../../src/vault/store'
import { FakeFirebase } from '../support/fakeFirebase'
import { fakeEnv, FakeNews, FAKE_SOURCES } from '../support/fakeNews'
import { makeCore } from '../support/harness'
import { nodeSql } from '../support/nodeSql'

const NOW = Date.UTC(2026, 10, 19, 1, 16, 0)

describe('間の長さ', () => {
  it('robots.txt の Crawl-delay・data の crawlDelaySec・permit.minIntervalSec・1秒の長い方', () => {
    const store = new MirrorStore(nodeSql(), () => NOW)
    expect(hostGapMs(store, FAKE_SOURCES, 'example.com')).toBe(MIN_GAP_MS)
    store.putHostRule({
      host: 'example.com',
      day: '2026-11-19',
      state: 'ok',
      crawlDelay: 3,
      data: {},
      checked: NOW,
      changed: null,
    })
    expect(hostGapMs(store, FAKE_SOURCES, 'example.com')).toBe(3_000)
    const slow: SourceConfig[] = [{ ...FAKE_SOURCES[0], crawlDelaySec: 10 }]
    expect(hostGapMs(store, slow, 'example.com')).toBe(10_000)
    const permit: SourceConfig[] = [
      {
        ...FAKE_SOURCES[0],
        permit: { grantedOn: '2026-11-01', scope: '作り物', maxBodiesPerRun: 10, minIntervalSec: 20, rssAllowed: false },
      },
    ]
    expect(hostGapMs(store, permit, 'example.com')).toBe(20_000)
  })

  it('予約: 次に取ってよい時刻を先に進めてから待つ。待ちが上限を超える時は予約しない', () => {
    const store = new MirrorStore(nodeSql(), () => NOW)
    expect(reserve(store, 'example.com', NOW, 1_000, TOOL_WAIT_MAX_MS)).toBe(0)
    expect(reserve(store, 'example.com', NOW, 1_000, TOOL_WAIT_MAX_MS)).toBe(1_000)
    expect(reserve(store, 'example.com', NOW, 1_000, TOOL_WAIT_MAX_MS)).toBe(2_000)
    expect(store.hostNext('example.com')).toBe(NOW + 3_000)
    expect(reserve(store, 'example.com', NOW, 1_000, 2_500)).toBeNull()
    expect(store.hostNext('example.com')).toBe(NOW + 3_000)
    expect(waitFor(store, 'example.com', NOW + 1_000)).toBe(2_000)
    // ほかのホストは待たない
    expect(reserve(store, 'example.org', NOW, 1_000, 0)).toBe(0)
  })
})

describe('同じホストへの同時の呼び出し', () => {
  it('3つが同時に来ても、どの2つの間も Crawl-delay 以上あく（予約。最後に取った時刻だけを見ない）', async () => {
    const clock = { now: NOW }
    const news = new FakeNews(clock)
    news.html('https://example.com/fake-ministry/a.html', '<p>a</p>')
    // 時計を進める待ち（同時に待つ呼び出しは、それぞれの予約の時刻まで）
    const sleep = async (ms: number) => {
      const target = clock.now + ms
      await new Promise((r) => setTimeout(r, 1))
      clock.now = Math.max(clock.now, target)
    }
    const { core } = makeCore(new FakeFirebase(), { clock, sourceFetch: news.fetch as typeof fetch, sleep })
    core.store.putHostRule({
      host: 'example.com',
      day: '2026-11-19',
      state: 'ok',
      crawlDelay: 2,
      data: {},
      checked: NOW,
      changed: null,
    })
    const env: FetchEnv = fakeEnv()
    const get = () =>
      sourceGet(core, env, { url: 'https://example.com/fake-ministry/a.html', run: null, maxWait: TOOL_WAIT_MAX_MS })
    const rs = await Promise.all([get(), get(), get()])
    expect(rs.every((r) => r.ok)).toBe(true)
    const at = news.calls.map((c) => c.at).sort((a, b) => a - b)
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(2_000)
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(2_000)
  })

  it('遅い応答の後も、応答が終わった時刻から間をあける（予約した時刻は縮めない）', async () => {
    const clock = { now: NOW }
    const news = new FakeNews(clock)
    news.set('https://example.com/fake-ministry/slow.html', () => {
      clock.now += 5_000
      return new Response('<p>slow</p>', { headers: { 'content-type': 'text/html' } })
    })
    news.html('https://example.com/fake-ministry/a.html', '<p>a</p>')
    const { core } = makeCore(new FakeFirebase(), {
      clock,
      sourceFetch: news.fetch as typeof fetch,
      sleep: async (ms) => {
        clock.now += ms
      },
    })
    core.store.putHostRule({
      host: 'example.com',
      day: '2026-11-19',
      state: 'ok',
      crawlDelay: 3,
      data: {},
      checked: NOW,
      changed: null,
    })
    const get = (path: string) =>
      sourceGet(core, fakeEnv(), { url: `https://example.com/fake-ministry/${path}`, run: null, maxWait: TOOL_WAIT_MAX_MS })
    expect((await get('slow.html')).ok).toBe(true)
    const done = clock.now
    expect(core.store.hostNext('example.com')).toBe(done + 3_000)
    expect((await get('a.html')).ok).toBe(true)
    expect(news.calls[1].at - done).toBeGreaterThanOrEqual(3_000)
    // 先の予約がもっと後なら、そのまま（縮めない）
    core.store.reserveHost('example.com', clock.now, 9_000)
    const reserved = core.store.hostNext('example.com')!
    settle(core.store, 'example.com', clock.now, 1_000)
    expect(core.store.hostNext('example.com')).toBe(reserved)
  })

  it('15秒を超える待ちは予約せずに「混んでいます」（busy）', async () => {
    const clock = { now: NOW }
    const news = new FakeNews(clock)
    const { core } = makeCore(new FakeFirebase(), { clock, sourceFetch: news.fetch as typeof fetch })
    core.store.putHostRule({
      host: 'example.com',
      day: '2026-11-19',
      state: 'ok',
      crawlDelay: 10,
      data: {},
      checked: NOW,
      changed: null,
    })
    core.store.reserveHost('example.com', NOW, 20_000)
    const r = await sourceGet(core, fakeEnv(), { url: 'https://example.com/x', run: null, maxWait: TOOL_WAIT_MAX_MS })
    expect(r).toMatchObject({ ok: false, why: 'busy' })
    expect(news.calls).toHaveLength(0)
    expect(core.store.hostNext('example.com')).toBe(NOW + 20_000)
  })
})
