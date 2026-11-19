// 候補集め（段階3の設計の 1.7 の (3)〜(9)・1.6）: 作り物の出どころ（test/support/fakeNews.ts）で、alarm の続き・窓・外して数える物・
// 本文の先読み・気象庁の電文・Global Voices の全文・似た題の印・出どころの状態（試しの回だけ・robots.txt・403）・回の上限・probe の表
import { describe, expect, it } from 'vitest'
import { FAKE_OUTLETS } from '../../../src/test/fixtures/fakeOutlets'
import type { FetchEnv } from '../../src/fetch/article'
import { collectStep, inWindow } from '../../src/fetch/collector'
import type { SourceConfig } from '../../src/fetch/sources'
import { USER_AGENT } from '../../src/fetch/aiAgents'
import { CONNECTOR_DEVICE } from '../../../src/domain/types'
import { FakeFirebase } from '../support/fakeFirebase'
import { fakeAtom, fakeQuakeTelegram } from '../fixtures/fakePages'
import { fakeFetchWork, FakeNews, FAKE_SOURCES, seedFakeNews } from '../support/fakeNews'
import { drainAlarms, pairedCore, seedRecords } from '../support/harness'

/** 日本時間の時刻（2026-11-d h:m） */
const jst = (h: number, m: number, d = 19) => Date.UTC(2026, 10, d, h - 9, m)

async function setup(
  at = jst(10, 16),
  env: Partial<FetchEnv> = {},
  prep?: (fake: FakeFirebase) => void,
  prepNews?: (news: FakeNews) => void,
) {
  const clock = { now: at }
  const news = seedFakeNews(new FakeNews(clock))
  prepNews?.(news)
  const fake = new FakeFirebase()
  prep?.(fake)
  const made = await pairedCore(fake, {
    clock,
    fetchWork: fakeFetchWork(env),
    outlets: FAKE_OUTLETS,
    sourceFetch: news.fetch as typeof fetch,
    // 待つ間は時計を進める（ホストごとの間）
    sleep: async (ms) => {
      clock.now += ms
    },
  })
  await drainAlarms(made.core, made.clock)
  made.clock.now = at
  news.calls.length = 0
  return { ...made, news, fake }
}

const runIdOf = (text: string) => /runId: (r\d{12}-[0-9a-z]{4})/.exec(text)![1]

async function begin(s: Awaited<ReturnType<typeof setup>>, args: Record<string, unknown>) {
  const r = await s.core.callTool('topic_begin_run', { model: 'fake-writer-model', ...args }, { grant: s.grant })
  expect(r.isError, r.text).toBeUndefined()
  return runIdOf(r.text)
}

async function collect(s: Awaited<ReturnType<typeof setup>>, args: Record<string, unknown> = { kind: 'edition' }) {
  const runId = await begin(s, args)
  await drainAlarms(s.core, s.clock, { n: 200, within: 60 * 60_000 })
  return runId
}

const list = (s: Awaited<ReturnType<typeof setup>>, runId: string, cursor?: string) =>
  s.core.callTool('topic_list_candidates', { runId, ...(cursor ? { cursor } : {}) }, { grant: s.grant })

describe('候補集め（作り物の出どころ）', () => {
  it('一覧・本文の先読み・電文・全文を集め、外す物を数え、読める候補を c0001 から並べる（窓を広げた印も）', async () => {
    const s = await setup()
    const runId = await collect(s)
    const run = s.core.store.getRun(runId)!
    expect(run.collect.state).toBe('done')
    const r = await list(s, runId)
    expect(r.isError).toBeUndefined()
    const t = r.text
    expect(t).toContain('読める候補: 8件')
    expect(t).toContain('窓を広げました（候補が少ないため）')
    expect(t).toContain('<<<候補（資料）')
    const lines = t.split('\n').filter((l) => /^c\d{4} /.test(l))
    expect(lines.map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual([
      'c0001 〇〇省',
      'c0002 〇〇省',
      'c0003 〇〇省',
      'c0004 △△庁',
      'c0005 △△庁',
      'c0006 ▽▽府',
      'c0007 ▲▲台',
      'c0008 □□ボイス',
    ])
    // 一覧の名前・日付（時刻が分かる時だけ時刻）・印
    expect(lines[0]).toBe('c0001 〇〇省 報道発表 11/19 作り物の制度の見直しについて')
    expect(lines[3]).toBe('c0004 △△庁 お知らせ 11/19 08:00 作り物の手続きの案内')
    expect(lines[6]).toContain('[最大震度5弱]')
    expect(lines[7]).toContain('[英語]')
    // 似た題の印（「」の中の名前が同じ）
    expect(lines[1]).toContain('[似た題 c0005]')
    expect(lines[4]).toContain('[似た題 c0002]')
    // 外して数えた物（PDF・カテゴリー・本文が短い・著者なし・別の条件・気象庁の種類と条件）
    expect(t).toMatch(/〇〇省: 取れた 3・.*PDF だけ 1/)
    expect(t).toMatch(/△△庁: 取れた 2・.*カテゴリーで外した 1/)
    expect(t).toMatch(/▽▽府: 取れた 1・.*本文が短い 1/)
    expect(t).toMatch(/▲▲台: 取れた 1・/)
    expect(t).toMatch(/▲▲台: .*種類で外した 1/)
    expect(t).toMatch(/▲▲台: .*条件で外した 1/)
    expect(t).toMatch(/□□ボイス: 取れた 1・.*別の条件 1.*著者なし 1|□□ボイス: 取れた 1・.*著者なし 1.*別の条件 1/)
    // 本文は出さない
    expect(t).not.toContain('作り物の検討会での議論')
    // 名乗りはコネクタの名前・転送は自分でたどる
    expect(s.news.calls.every((c) => c.ua === USER_AGENT && c.redirect === 'manual')).toBe(true)
    // 記事のページ（□□ボイスの記事の URL）と PDF・ほかのホストは取りに行かない
    const urls = s.news.urls()
    expect(urls.some((u) => u.includes('/fake-voices/2026/'))).toBe(false)
    expect(urls.some((u) => u.endsWith('.pdf'))).toBe(false)
    expect(urls.some((u) => u.includes('other.example.org'))).toBe(false)
    // 電文は要る語・種類で絞った物だけを読む
    expect(urls.filter((u) => u.includes('/fake-met/xml/data/')).sort()).toEqual([
      'https://example.com/fake-met/xml/data/q1.xml',
      'https://example.com/fake-met/xml/data/t1.xml',
    ])
    // 本文の控えは読める候補の物だけ（窓の中の HTML は先に読んである）
    const mats = s.core.store.materials(runId)
    expect(mats).toHaveLength(8)
    expect(mats.every((m) => m.bodyChars >= 200)).toBe(true)
    // 仮の候補は残さない
    expect(s.core.store.candidates(runId).every((c) => /^c\d{4}$/.test(c.cid) && c.readable)).toBe(true)
    // 窓を広げた時刻は回の窓にも入れる
    expect(s.core.store.getRun(runId)!.sinceMs).toBe(jst(18, 0, 18) - 24 * 3_600_000)
  })

  it('topic_status(runId) は集め終わるまで待ち、読める候補の数だけを返す（題は出さない）', async () => {
    const s = await setup()
    const runId = await begin(s, { kind: 'trial' })
    let r = await s.core.callTool('topic_status', { runId }, { grant: s.grant })
    for (let i = 0; i < 10 && !r.text.includes('終わりました'); i++)
      r = await s.core.callTool('topic_status', { runId }, { grant: s.grant })
    expect(r.text).toMatch(/候補集め: 終わりました（読める候補 8件/)
    expect(r.text).not.toContain('作り物の制度の見直し')
  })

  it('前の版（直近3日・6版）で出典にした URL は、いつも候補から除く', async () => {
    const s = await setup(jst(10, 16), {}, (fake) =>
      seedRecords(fake, [
        {
          table: 'editions',
          record: {
            id: '2026-11-18-20',
            date: '2026-11-18',
            slot: '20',
            order: ['p0000aaaa'],
            window: { since: '2026-11-18T10:00:00+09:00', until: '2026-11-18T18:16:00+09:00' },
          } as never,
        },
        {
          table: 'topics',
          record: {
            id: 'p0000aaaa',
            editionId: '2026-11-18-20',
            sources: [{ url: 'https://example.com/fake-agency/news/2.html', outlet: '△△庁' }],
          } as never,
        },
      ]),
    )
    const runId = await collect(s)
    const t = (await list(s, runId)).text
    expect(t).not.toContain('「作り物推進計画」の説明会')
    expect(t).toMatch(/△△庁: 取れた 1・.*前の版の出典 1/)
  })

  it('試しの回だけの出どころは、版の回で取らない（試しの回では取る）', async () => {
    const only: SourceConfig[] = FAKE_SOURCES.map((x) =>
      x.id === 'fake-rss' ? { ...x, terms: { status: 'trial-only', accepted: '2026-11-01' } } : x,
    )
    const s = await setup(jst(10, 16), { sources: only })
    const ed = await collect(s)
    const t = (await list(s, ed)).text
    expect(t).toContain('△△庁: 取らない（試しの回だけ）')
    expect(s.news.urls().some((u) => u.includes('/fake-agency/'))).toBe(false)
    const tr = await collect(s, { kind: 'trial' })
    expect((await list(s, tr)).text).toMatch(/△△庁: 取れた 2/)
  })

  it('規約のページの指紋が無い出どころは、版の回で取らない', async () => {
    const nofp: SourceConfig[] = FAKE_SOURCES.map((x) =>
      x.id === 'fake-html' ? { ...x, termsPages: x.termsPages.map((p) => ({ ...p, fingerprint: undefined })) } : x,
    )
    const s = await setup(jst(10, 16), { sources: nofp })
    const ed = await collect(s)
    expect((await list(s, ed)).text).toContain('〇〇省: 取らない（試しの回だけ）')
    expect(s.news.urls().some((u) => u.includes('/fake-ministry/'))).toBe(false)
  })

  it('robots.txt で ClaudeBot が断る時は、robots.txt と tdmrep.json のほかは何も取らない', async () => {
    // 気象庁の見張り（作り物は 'ok'）が連携の後に決まりを読むので、robots.txt は先に置く
    const s = await setup(jst(10, 16), {}, undefined, (n) =>
      n.robots('example.com', 'User-agent: *\nAllow: /\n\nUser-agent: ClaudeBot\nDisallow: /'),
    )
    const runId = await collect(s)
    // 決まりは連携の後に読んである。その後は何も取りに行かない
    expect(s.news.urls()).toEqual([])
    expect(s.core.store.hostRule('example.com')!.state).toBe('refused')
    const t = (await list(s, runId)).text
    expect(t).toContain('〇〇省: 取らない（robots.txt）')
    expect(t).toContain('候補はありません')
  })

  it('ほかの AI の名前の断りでは、取りを止めて知らせる', async () => {
    const s = await setup(jst(10, 16), {}, undefined, (n) => n.robots('example.com', 'User-agent: GPTBot\nDisallow: /'))
    const runId = await collect(s)
    const t = (await list(s, runId)).text
    expect(t).toContain('取りを止めました（AI への意思表示が出ました。作者に伺います）')
    expect(s.news.urls().filter((u) => !u.endsWith('robots.txt') && !u.endsWith('tdmrep.json'))).toEqual([])
  })

  it('403 が返ったホストは、その日は取らない（名乗り・道・時刻を替えて試し直さない）', async () => {
    const s = await setup()
    s.news.set('https://example.com/fake-ministry/press/index.html', { status: 403, body: 'forbidden' })
    const runId = await collect(s)
    const after = s.news.urls().indexOf('https://example.com/fake-ministry/press/index.html')
    expect(after).toBeGreaterThanOrEqual(0)
    // 403 の後は、そのホストに取りに行かない
    expect(s.news.urls().slice(after + 1)).toEqual([])
    expect(s.news.calls.filter((c) => c.url.endsWith('/fake-ministry/press/index.html'))).toHaveLength(1)
    expect(s.core.store.hostRule('example.com')!.state).toBe('unreadable')
    expect((await list(s, runId)).text).toContain('今日は取らない（robots.txt を読めない・403・429・確認画面）')
  })

  it('確認画面（cf-mitigated: challenge）も 403 と同じに、その日は取らない', async () => {
    const s = await setup()
    s.news.set('https://example.com/fake-ministry/press/index.html', {
      status: 403,
      body: '<html><title>Just a moment...</title></html>',
      headers: { 'cf-mitigated': 'challenge' },
    })
    await collect(s)
    expect(s.core.store.hostRule('example.com')!.state).toBe('unreadable')
    expect(s.news.calls.filter((c) => c.url.endsWith('/fake-ministry/press/index.html'))).toHaveLength(1)
  })

  it('気象庁の形の出どころ: 訓練・試験の電文は入れない。取消の電文は、それ自身と同じ組（EventID・系統）の候補を外す', async () => {
    const s = await setup()
    s.news.xml(
      'https://example.com/fake-met/xml/data/q1.xml',
      fakeQuakeTelegram({ maxInt: '6-', status: '訓練' }),
      'application/xml',
    )
    const drill = await collect(s)
    expect(s.core.store.candidates(drill).some((c) => c.source === 'fake-met')).toBe(false)
    expect(s.core.store.runCount(drill, 'src:fake-met:drill')).toBe(1)

    const s2 = await setup()
    s2.news.xml(
      'https://example.com/fake-met/xml/feed/extra.xml',
      fakeAtom([
        {
          title: '震度速報',
          link: 'https://example.com/fake-met/xml/data/q1.xml',
          updated: '2026-11-19T00:58:00Z',
          content: '作り物県で最大震度５弱を観測',
        },
        {
          title: '震度速報',
          link: 'https://example.com/fake-met/xml/data/q9.xml',
          updated: '2026-11-19T01:05:00Z',
          content: '作り物県で最大震度５弱を観測',
        },
      ]),
      'application/atom+xml',
    )
    s2.news.xml(
      'https://example.com/fake-met/xml/data/q9.xml',
      fakeQuakeTelegram({ maxInt: '5-', infoType: '取消' }),
      'application/xml',
    )
    const cancel = await collect(s2)
    expect(s2.core.store.candidates(cancel).some((c) => c.source === 'fake-met')).toBe(false)
    expect(s2.core.store.runCount(cancel, 'src:fake-met:drill')).toBeGreaterThanOrEqual(1)
  })

  it('RSS の断りのある出どころの HTML の一覧の道が RSS を返しても読まない。一覧の転送は許した道の中だけ', async () => {
    const s = await setup()
    s.news.xml(
      'https://example.com/fake-ministry/press/index.html',
      '<?xml version="1.0"?><rss><channel><item><title>作り物</title><link>https://example.com/fake-ministry/press/1001.html</link></item></channel></rss>',
    )
    // □□ボイスの /feed/ が記事のページへ転送する
    s.news.set('https://example.com/fake-voices/feed/', {
      status: 301,
      headers: { location: '/fake-voices/2026/11/19/fake-article-one/' },
    })
    const runId = await collect(s)
    expect(s.core.store.runCount(runId, 'src:fake-html:feed')).toBe(1)
    expect(s.core.store.candidates(runId).some((c) => c.source === 'fake-html')).toBe(false)
    expect(s.news.urls().some((u) => u.includes('/fake-ministry/press/1001.html'))).toBe(false)
    expect(s.news.urls().some((u) => u.includes('/fake-voices/2026/'))).toBe(false)
    expect(s.core.store.candidates(runId).some((c) => c.source === 'fake-voices')).toBe(false)
  })

  it('1つの回に取りに行く上限（数えない robots.txt と AI の意思表示のほか）', async () => {
    const s = await setup(jst(10, 16), { runLimit: 4 })
    const runId = await collect(s)
    const counted = s.news.urls().filter((u) => !u.endsWith('robots.txt') && !u.endsWith('tdmrep.json'))
    expect(counted.length).toBeLessThanOrEqual(4)
    expect(s.core.store.runCount(runId, 'net')).toBeLessThanOrEqual(4)
  })

  it('同じホストへの要求は、間（1秒）をあける', async () => {
    const s = await setup()
    await collect(s)
    const at = s.news.calls.map((c) => c.at)
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(1_000)
  })

  it('気象庁の Atom と全文の RSS は、1回の alarm に1本（ほかと重ねない）。1回の alarm は外への要求6本まで', async () => {
    const s = await setup()
    const runId = await begin(s, { kind: 'trial' })
    // 毎日の決まりの読みを先に済ませる
    await s.core.callTool('topic_status', {}, { grant: s.grant })
    const steps: string[][] = []
    for (let i = 0; i < 60; i++) {
      const before = s.news.calls.length
      const st = await collectStep(s.core, runId)
      steps.push(s.news.urls().slice(before))
      if (st.done) break
      if (!st.done && st.next > s.clock.now) s.clock.now = st.next
    }
    for (const step of steps) {
      const heavy = step.filter((u) => u.endsWith('/fake-met/xml/feed/extra.xml') || u.endsWith('/fake-voices/feed/'))
      if (heavy.length) expect(step.filter((u) => !u.endsWith('robots.txt') && !u.endsWith('tdmrep.json'))).toEqual(heavy)
      expect(step.length).toBeLessThanOrEqual(8)
    }
    expect(s.core.store.getRun(runId)!.collect.state).toBe('done')
  })

  it('試しの回の skip の出どころは取らない', async () => {
    const s = await setup()
    const runId = await collect(s, { kind: 'trial', skip: ['fake-met', 'fake-voices'] })
    expect(s.news.urls().some((u) => u.includes('/fake-met/') || u.includes('/fake-voices/'))).toBe(false)
    expect((await list(s, runId)).text).toContain('▲▲台: 取らない（この回の probe から外した）')
  })

  it('同じ枠の回が1時間以内に集めた候補を使い回す（取りに行かない）', async () => {
    const s = await setup()
    const a = await collect(s, { kind: 'trial' })
    const n = s.news.calls.length
    s.clock.now += 10 * 60_000
    const b = await collect(s, { kind: 'trial' })
    expect(s.news.calls.length).toBe(n)
    expect(s.core.store.candidateCount(b)).toBe(s.core.store.candidateCount(a))
  })

  it('日付だけの項目は、初めて見た回の始めの時刻で窓に入れる（版の回だけ覚える。試しの回は覚えない）', async () => {
    const s = await setup()
    await collect(s, { kind: 'trial' })
    expect(s.core.store.sql.all('SELECT * FROM first_seen')).toHaveLength(0)
    s.clock.now += 2 * 3_600_000
    const ed = await collect(s, { kind: 'edition' })
    const seen = s.core.store.sql.all<{ at: number }>('SELECT at FROM first_seen')
    expect(seen.length).toBe(3)
    expect(new Set(seen.map((r) => Number(r.at)))).toEqual(new Set([s.core.store.getRun(ed)!.started]))
    // 窓の始まりちょうどの物は前の窓（「始まりより後」）
    const c = { atMs: jst(12, 16), published: '2026-11-19', tags: ['@d'] }
    expect(inWindow(c, jst(12, 16), jst(20, 0))).toBe(false)
    expect(inWindow(c, jst(12, 15), jst(20, 0))).toBe(true)
    // その日付が窓の始まりより前に終わる項目は入れない
    expect(inWindow({ ...c, published: '2026-11-18' }, jst(0, 30), jst(20, 0))).toBe(false)
  })
})

describe('一覧のホストと本文のホストが違う出どころ（許しの社の http の一覧）', () => {
  /** 一覧は feeds.example.com（http）・本文は example.com の作り物の許しの社 */
  const split: SourceConfig = {
    ...FAKE_SOURCES[1],
    id: 'fake-split',
    hosts: { list: ['feeds.example.com'], body: ['example.com'] },
    lists: [{ kind: 'rss', label: '総合', url: 'http://feeds.example.com/fake/rss' }],
    terms: { status: 'permitted', accepted: '2026-11-01' },
    permit: { grantedOn: '2026-11-01', scope: '作り物の範囲', maxBodiesPerRun: 10, minIntervalSec: 2, rssAllowed: true },
  }
  const withHttp: SourceConfig = {
    ...split,
    lists: [{ kind: 'rss', label: '総合', url: 'http://feeds.example.com/fake/rss', http: true }],
  }
  const rss = (n: FakeNews) =>
    n.xml(
      'http://feeds.example.com/fake/rss',
      `<rss><channel><item><title>作り物の分かれた一覧の項目</title><link>http://example.com/fake-agency/news/1.html</link><pubDate>Thu, 19 Nov 2026 08:00:00 +0900</pubDate></item></channel></rss>`,
    )

  it('http の一覧は data に http: true がある時だけ。項目のリンクは本文のホストの https に直し、ホストごとに robots.txt を当てる', async () => {
    const no = await setup(jst(10, 16), { sources: [split] }, undefined, rss)
    await collect(no, { kind: 'trial' })
    expect(no.news.urls().some((u) => u.startsWith('http://feeds.example.com/fake/rss'))).toBe(false)

    const s = await setup(jst(10, 16), { sources: [withHttp] }, undefined, (n) => {
      rss(n)
      n.set('http://feeds.example.com/robots.txt', {
        body: 'User-agent: *\nCrawl-delay: 4',
        headers: { 'content-type': 'text/plain' },
      })
    })
    const runId = await collect(s, { kind: 'trial' })
    const urls = s.news.urls()
    // http の一覧だけのホストの robots.txt は同じ http で読む
    expect(urls).toContain('http://feeds.example.com/robots.txt')
    expect(urls).toContain('http://feeds.example.com/fake/rss')
    expect(urls).toContain('https://example.com/fake-agency/news/1.html')
    expect(s.core.store.hostRule('feeds.example.com')!.crawlDelay).toBe(4)
    expect(s.core.store.candidates(runId).map((c) => c.url)).toEqual(['https://example.com/fake-agency/news/1.html'])
  })

  it('一覧のホストの robots.txt が断れば、本文のホストが許していても一覧を取らない', async () => {
    const s = await setup(jst(10, 16), { sources: [withHttp] }, undefined, (n) => {
      rss(n)
      n.set('http://feeds.example.com/robots.txt', {
        body: 'User-agent: Claude-User\nDisallow: /',
        headers: { 'content-type': 'text/plain' },
      })
    })
    await collect(s, { kind: 'trial' })
    expect(s.news.urls().some((u) => u.includes('/fake/rss'))).toBe(false)
  })
})

describe('probe（試しの回）', () => {
  it("'sources': 出どころごとの数と番号だけ（題・本文・リンクの文字は出さない）", async () => {
    const s = await setup()
    const runId = await collect(s, { kind: 'trial', probe: 'sources' })
    const r = await s.core.callTool('topic_status', { runId }, { grant: s.grant })
    expect(r.text).toContain('probe の表')
    const row = (id: string) => r.text.split('\n').find((l) => l.startsWith(`- ${id}: `)) ?? ''
    for (const cell of ['robots=404', 'rules=ok', 'l0.status=200', 'l0.matched=4', 'l0.links=7', 'ex.pdf=1', 'l0.type=text/html'])
      expect(row('fake-html')).toContain(cell)
    for (const cell of ['jma.quake.atom=2', 'jma.quake.word=1', 'jma.quake.noword=1', 'jma.read=2', 'jma.after=1'])
      expect(row('fake-met')).toContain(cell)
    for (const cell of ['gv.noauthor=1', 'gv.mark0=1']) expect(row('fake-voices')).toContain(cell)
    expect(row('_collect')).toContain('readable=8')
    expect(r.text).not.toContain('作り物の制度')
    expect(r.text).not.toContain('fake-article-one')
    // 記者の質問の印ごとの行の数（1001 のページの「（記者）」「【記者】」）
    expect(row('fake-html')).toContain('qa0.lines=1')
    expect(row('fake-html')).toContain('qa0.dropped=1')
  })

  it("'hosts': 今は取らない所の robots.txt を1回だけ。403 の時だけ規約のページ1つの番号（本文は読まない）。候補は集めない", async () => {
    const s = await setup()
    s.news.robots('pending.example.com', null, 403)
    s.news.set('https://pending.example.com/terms.html', {
      status: 200,
      body: '<main>作り物</main>',
      headers: { server: 'fake-server/1' },
    })
    const runId = await collect(s, { kind: 'trial', probe: 'hosts' })
    expect(s.news.urls().filter((u) => u.includes('pending.example.com'))).toEqual([
      'https://pending.example.com/robots.txt',
      'https://pending.example.com/terms.html',
    ])
    expect(s.core.store.candidateCount(runId, false)).toBe(0)
    const r = await s.core.callTool('topic_status', { runId }, { grant: s.grant })
    expect(r.text).toMatch(/- fake-pending: robots=403・.*verdict=unreadable・page=200・pageServer=fake-server/)
    expect(r.text).not.toContain('作り物')
  })

  it("'terms': data の規約のページだけを2回ずつ取り、指紋と文字（資料の印で囲む）を返す。候補は集めない", async () => {
    const s = await setup()
    const runId = await collect(s, {
      kind: 'trial',
      probe: 'terms',
      skip: ['fake-rss', 'fake-anchor', 'fake-met', 'fake-voices'],
    })
    const terms = s.news.urls().filter((u) => !u.endsWith('robots.txt') && !u.endsWith('tdmrep.json'))
    expect(terms).toEqual(['https://example.com/fake-ministry/terms.html', 'https://example.com/fake-ministry/terms.html'])
    const r = await s.core.callTool('topic_status', { runId }, { grant: s.grant })
    expect(r.text).toMatch(/- fake-html\.t0: verdict=ok・status=200・chars=\d+・fp=[0-9a-z]{16}・fp2=[0-9a-z]{16}・same=true/)
    expect(r.text).toContain('<<<規約のページ（資料）')
    expect(r.text).toContain('作り物の利用規約の文です。')
    // robots.txt を読めていない今は取らない所は取らない
    expect(r.text).toMatch(/- fake-pending\.t0: verdict=skipped/)
    expect(s.core.store.candidateCount(runId, false)).toBe(0)
  })
})

describe('記録の device', () => {
  it('作り物の出どころの社は作り物の一覧の社（本物の社の名前を使わない）', () => {
    for (const s of FAKE_SOURCES) expect(FAKE_OUTLETS.outletEntries.has(s.outlet)).toBe(true)
    expect(CONNECTOR_DEVICE).toBeTruthy()
  })
})
