// 資料を読む道具（topic_read_article。段階3の設計の 1.2 の 4・1.7 の (2)・(6)・(7)・(11)）: 候補の id と URL・頭の行（題・社・ホスト・
// 掲載の日時・字数・その出どころの決まり）・資料の印・maxChars と cursor・控えから返す（数えない）・取ってよい所だけ（許した道・
// denyPaths・RSS の断りのある出どころの RSS の URL と RSS の応答を本文にしない・PDF・転送は同じホストの中で3回まで）・AI への意思表示
// （X-Robots-Tag・meta noai）・403・会見の道は試しの回だけ・許しの社の本数と期限・Global Voices の記事は RSS から・本文が200字未満
import { describe, expect, it } from 'vitest'
import { FAKE_OUTLETS } from '../../../src/test/fixtures/fakeOutlets'
import type { FetchEnv } from '../../src/fetch/article'
import type { SourceConfig } from '../../src/fetch/sources'
import { materialForRef } from '../../src/vault/tools/fetch'
import { fakePressPage, FAKE_SHORT_PAGE } from '../fixtures/fakePages'
import { FakeFirebase } from '../support/fakeFirebase'
import { fakeFetchWork, FakeNews, FAKE_SOURCES, seedFakeNews } from '../support/fakeNews'
import { drainAlarms, pairedCore } from '../support/harness'

const jst = (h: number, m: number, d = 19) => Date.UTC(2026, 10, d, h - 9, m)
const H = 'https://example.com'

async function setup(env: Partial<FetchEnv> = {}, prepNews?: (n: FakeNews) => void) {
  const clock = { now: jst(10, 16) }
  const news = seedFakeNews(new FakeNews(clock))
  prepNews?.(news)
  const made = await pairedCore(new FakeFirebase(), {
    clock,
    fetchWork: fakeFetchWork(env),
    outlets: FAKE_OUTLETS,
    sourceFetch: news.fetch as typeof fetch,
    sleep: async (ms) => {
      clock.now += ms
    },
  })
  await drainAlarms(made.core, made.clock)
  news.calls.length = 0
  return { ...made, news }
}

type S = Awaited<ReturnType<typeof setup>>

async function run(s: S, kind: 'edition' | 'trial' | 'correction' = 'trial', collect = false) {
  const r = await s.core.callTool('topic_begin_run', { kind, model: 'fake-writer-model' }, { grant: s.grant })
  const runId = /runId: (r\d{12}-[0-9a-z]{4})/.exec(r.text)![1]
  if (collect) await drainAlarms(s.core, s.clock, { n: 200, within: 60 * 60_000 })
  else {
    // 候補集めは止めておく（道具だけを見る）
    const row = s.core.store.getRun(runId)!
    s.core.store.setRunCollect(runId, { ...row.collect, state: kind === 'correction' ? 'none' : 'done' })
    s.core.store.deleteTask(`collect:${runId}`)
  }
  s.news.calls.length = 0
  return runId
}

const read = (s: S, runId: string, ref: string, more: Record<string, unknown> = {}) =>
  s.core.callTool('topic_read_article', { runId, ref, ...more }, { grant: s.grant })

describe('topic_read_article', () => {
  it('候補の id: 頭の行（題・社・ホスト・掲載・字数・その出どころの決まり）と資料の印。控えから返す（取りに行かない）', async () => {
    const s = await setup()
    const runId = await run(s, 'trial', true)
    const r = await read(s, runId, 'c0001')
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('資料: 作り物の制度の見直しについて')
    expect(r.text).toMatch(/社: 〇〇省（example\.com）・掲載: 2026-11-19・本文: [\d,]+字/)
    expect(r.text).toContain('この出どころの決まり: 作り物の決まり: 記者の質問は落としてある')
    expect(r.text).toContain('URL: https://example.com/fake-ministry/press/1001.html（出典の ref には c0001 か この URL を書く）')
    expect(r.text).toContain('<<<資料の本文')
    expect(r.text).not.toContain('作り物の質問の文')
    expect(s.news.calls).toHaveLength(0)
    expect(s.core.store.material(runId, `${H}/fake-ministry/press/1001.html`)!.readAt).toBe(s.clock.now)
    // B5 の下書きが引く控え（候補の id と URL のどちらでも）
    expect(materialForRef(s.core.store, runId, 'c0001', FAKE_SOURCES)!.url).toBe(`${H}/fake-ministry/press/1001.html`)
    expect(materialForRef(s.core.store, runId, `${H}/fake-ministry/press/1001.html#x`, FAKE_SOURCES)).not.toBeNull()
  })

  it('maxChars（1,500〜6,000）と cursor で続きを読む', async () => {
    const s = await setup({}, (n) => n.html(`${H}/fake-ministry/press/9001.html`, fakePressPage({ paragraphs: 40 })))
    const runId = await run(s)
    const a = await read(s, runId, `${H}/fake-ministry/press/9001.html`, { maxChars: 1500 })
    const cursor = /続きがあります（cursor: (o\d+)）/.exec(a.text)![1]
    const b = await read(s, runId, `${H}/fake-ministry/press/9001.html`, { maxChars: 1500, cursor })
    expect(b.text).toContain('<<<資料の本文')
    expect(s.news.calls).toHaveLength(1)
  })

  it('12,000字を超える本文は切って控え、頭の行に書く', async () => {
    const s = await setup({}, (n) => n.html(`${H}/fake-ministry/press/9002.html`, fakePressPage({ paragraphs: 200 })))
    const runId = await run(s)
    const r = await read(s, runId, `${H}/fake-ministry/press/9002.html`)
    expect(r.text).toContain('本文は 12,000字で切ってあります。')
    const m = s.core.store.material(runId, `${H}/fake-ministry/press/9002.html`)!
    expect(m.cut).toBe(true)
    expect(Array.from(m.body).length).toBe(12_000)
  })

  it('許した道の外・denyPaths・ほかのホスト・http は取りに行かずに断る（RSS の断りのある出どころの RSS の道も）', async () => {
    const s = await setup()
    const runId = await run(s)
    for (const ref of [
      `${H}/elsewhere/1.html`,
      `${H}/fake-ministry/rss/feed.xml`,
      'https://example.org/fake-ministry/1.html',
      'http://example.com/../x',
      `${H}/fake-ministry/press/1003.pdf`,
    ]) {
      const r = await read(s, runId, ref)
      expect(r.isError, ref).toBe(true)
    }
    expect(s.news.calls).toHaveLength(0)
  })

  it('RSS の断りのある出どころでは、RSS・Atom の応答を本文にしない', async () => {
    const s = await setup({}, (n) =>
      n.xml(
        `${H}/fake-ministry/feed-like.html`,
        '<?xml version="1.0"?><rss><channel><item><title>x</title></item></channel></rss>',
      ),
    )
    const runId = await run(s)
    const r = await read(s, runId, `${H}/fake-ministry/feed-like.html`)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('RSS の利用条件の断り')
  })

  it('PDF の応答は読まない', async () => {
    const s = await setup({}, (n) =>
      n.set(`${H}/fake-ministry/press/9003.html`, { body: '%PDF-1.4', headers: { 'content-type': 'application/pdf' } }),
    )
    const runId = await run(s)
    const r = await read(s, runId, `${H}/fake-ministry/press/9003.html`)
    expect(r.text).toContain('PDF は読みません')
  })

  it('本文が200字未満なら「本文がほとんど取れませんでした」（出典にできない）', async () => {
    const s = await setup({}, (n) => n.html(`${H}/fake-ministry/press/9004.html`, FAKE_SHORT_PAGE))
    const runId = await run(s)
    const r = await read(s, runId, `${H}/fake-ministry/press/9004.html`)
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('本文がほとんど取れませんでした（PDF の資料だけの発表など）。この資料は出典にできません。')
  })

  it('X-Robots-Tag の noai が出たら取りを止め、そのホストは止めたまま（次の呼び出しは取りに行かない）', async () => {
    const s = await setup({}, (n) => n.html(`${H}/fake-ministry/press/9005.html`, fakePressPage(), { 'x-robots-tag': 'noai' }))
    const runId = await run(s)
    const r = await read(s, runId, `${H}/fake-ministry/press/9005.html`)
    expect(r.text).toContain('取りを止めました（AI への意思表示が出ました。作者に伺います）')
    expect(s.core.store.hostRule('example.com')!.state).toBe('stopped')
    s.news.calls.length = 0
    const again = await read(s, runId, `${H}/fake-ministry/press/1002.html`)
    expect(again.isError).toBe(true)
    expect(s.news.calls).toHaveLength(0)
    const st = await s.core.callTool('topic_status', {}, { grant: s.grant })
    expect(st.text).toContain('〇〇省: 取りを止めました（AI への意思表示が出ました。作者に伺います）')
  })

  it('<meta name="robots" content="noai"> でも取りを止める', async () => {
    const s = await setup({}, (n) =>
      n.html(`${H}/fake-ministry/press/9006.html`, fakePressPage({ meta: '<meta name="robots" content="noindex, noai">' })),
    )
    const runId = await run(s)
    const r = await read(s, runId, `${H}/fake-ministry/press/9006.html`)
    expect(r.text).toContain('取りを止めました')
    expect(s.core.store.hostRule('example.com')!.state).toBe('stopped')
  })

  it('403 はすり抜けない（名乗りを替えて試し直さない。その日はそのホストを取らない）', async () => {
    const s = await setup({}, (n) => n.set(`${H}/fake-ministry/press/9007.html`, { status: 403 }))
    const runId = await run(s)
    const r = await read(s, runId, `${H}/fake-ministry/press/9007.html`)
    expect(r.text).toContain('今日はこのホストを取りません（403・429・確認画面。名乗りを替えて試し直しません）')
    expect(s.news.calls).toHaveLength(1)
    const again = await read(s, runId, `${H}/fake-ministry/press/1001.html`)
    expect(again.isError).toBe(true)
    expect(s.news.calls).toHaveLength(1)
  })

  it('429（間をあけてと言われた）も、その日はそのホストを取らない', async () => {
    const s = await setup({}, (n) => n.set(`${H}/fake-ministry/press/9008.html`, { status: 429 }))
    const runId = await run(s)
    expect((await read(s, runId, `${H}/fake-ministry/press/9008.html`)).text).toContain('今日はこのホストを取りません')
    expect((await read(s, runId, `${H}/fake-ministry/press/1001.html`)).isError).toBe(true)
    expect(s.news.calls).toHaveLength(1)
  })

  it('転送の行き先の道も robots.txt で見る（断る道・AI の名前が断る道へはたどらない）', async () => {
    const s = await setup({}, (n) => {
      n.robots(
        'example.com',
        'User-agent: *\nDisallow: /fake-ministry/closed/\n\nUser-agent: GPTBot\nDisallow: /fake-ministry/ai-closed/',
      )
      n.set(`${H}/fake-ministry/r3.html`, { status: 302, headers: { location: '/fake-ministry/closed/1.html' } })
      n.set(`${H}/fake-ministry/r4.html`, { status: 302, headers: { location: '/fake-ministry/ai-closed/1.html' } })
      n.html(`${H}/fake-ministry/closed/1.html`, fakePressPage())
      n.html(`${H}/fake-ministry/ai-closed/1.html`, fakePressPage())
    })
    // 今日の決まりを読み直す（作り物の robots.txt を置いた後）
    s.core.store.sql.run('DELETE FROM host_rules')
    const runId = await run(s)
    for (const ref of ['r3', 'r4']) {
      const r = await read(s, runId, `${H}/fake-ministry/${ref}.html`)
      expect(r.text, ref).toContain('転送はたどりません')
    }
    expect(s.news.urls().some((u) => u.includes('closed/1.html'))).toBe(false)
  })

  it('気象庁の形（電文）の出どころは .xml の道だけを取りに行く（HTML のページは取らない）', async () => {
    const s = await setup()
    const runId = await run(s)
    for (const p of ['/fake-met/xml/index.html', '/fake-met/xml/data/'])
      expect((await read(s, runId, `${H}${p}`)).isError, p).toBe(true)
    expect(s.news.calls).toHaveLength(0)
  })

  it('転送は同じホストの許した道の中だけで3回まで（ほかのホスト・4回目はたどらない）', async () => {
    const s = await setup({}, (n) => {
      n.set(`${H}/fake-ministry/r1.html`, { status: 301, headers: { location: '/fake-ministry/r2.html' } })
      n.set(`${H}/fake-ministry/r2.html`, { status: 302, headers: { location: `${H}/fake-ministry/press/1001.html` } })
      n.set(`${H}/fake-ministry/x1.html`, { status: 302, headers: { location: 'https://example.org/fake-ministry/a.html' } })
      for (let i = 1; i <= 4; i++)
        n.set(`${H}/fake-ministry/loop${i}.html`, { status: 302, headers: { location: `/fake-ministry/loop${i + 1}.html` } })
      n.set(`${H}/fake-ministry/d1.html`, { status: 302, headers: { location: '/fake-ministry/rss/a.xml' } })
    })
    const runId = await run(s)
    const ok = await read(s, runId, `${H}/fake-ministry/r1.html`)
    expect(ok.isError).toBeUndefined()
    expect(ok.text).toContain('URL: https://example.com/fake-ministry/press/1001.html')
    for (const ref of ['x1', 'loop1', 'd1']) {
      const r = await read(s, runId, `${H}/fake-ministry/${ref}.html`)
      expect(r.text, ref).toContain('転送はたどりません')
    }
    expect(s.news.urls().some((u) => u.includes('example.org'))).toBe(false)
    expect(s.news.urls().filter((u) => u.includes('loop'))).toHaveLength(4)
  })

  it('会見の記録の道（qaPages）は、確かめるまで試しの回だけ', async () => {
    const s = await setup({}, (n) => n.html(`${H}/fake-ministry/kaiken/1.html`, fakePressPage({ qa: true })))
    const ed = await run(s, 'edition')
    expect((await read(s, ed, `${H}/fake-ministry/kaiken/1.html`)).text).toContain('この資料は試しの回だけで取ります')
    expect(s.news.calls).toHaveLength(0)
    const tr = await run(s, 'trial')
    expect((await read(s, tr, `${H}/fake-ministry/kaiken/1.html`)).isError).toBeUndefined()
  })

  it('許しの社: 1つの回の本文は maxBodiesPerRun まで・期限を過ぎたら「取らない（許しの期限）」', async () => {
    const permitted = (until?: string): SourceConfig[] =>
      FAKE_SOURCES.map((x) =>
        x.id === 'fake-html'
          ? {
              ...x,
              terms: { status: 'permitted', accepted: '2026-11-01' },
              permit: {
                grantedOn: '2026-11-01',
                until,
                scope: '作り物の範囲',
                maxBodiesPerRun: 2,
                minIntervalSec: 3,
                rssAllowed: false,
              },
            }
          : x,
      )
    const s = await setup({ sources: permitted() })
    const runId = await run(s)
    expect((await read(s, runId, `${H}/fake-ministry/press/1001.html`)).isError).toBeUndefined()
    expect((await read(s, runId, `${H}/fake-ministry/press/1002.html`)).isError).toBeUndefined()
    const third = await read(s, runId, `${H}/fake-ministry/press/1005.html`)
    expect(third.text).toContain('許しの範囲の本数')
    // 同じホストへの間は permit.minIntervalSec 以上
    const at = s.news.calls.filter((c) => c.url.includes('/press/')).map((c) => c.at)
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(3_000)
    const old = await setup({ sources: permitted('2026-11-18') })
    const r2 = await run(old)
    expect((await read(old, r2, `${H}/fake-ministry/press/1001.html`)).text).toContain('取らない（許しの期限）')
  })

  it('□□ボイス（全文の RSS）の記事の URL: 記事のページを取らず、RSS の同じリンクの項目を返す。無ければ断る', async () => {
    const s = await setup()
    const runId = await run(s, 'correction')
    const r = await read(s, runId, `${H}/fake-voices/2026/11/19/fake-article-one/`)
    expect(r.isError, r.text).toBeUndefined()
    expect(r.text).toContain('著者: Fake Writer')
    expect(r.text).toContain('This is a fake article paragraph')
    expect(r.text).not.toContain('fake photographer')
    expect(s.news.urls()).toEqual([`${H}/fake-voices/feed/`])
    // /feed/ の下の別の道も本文としては取りに行かない（RSS の全文だけ）
    s.news.calls.length = 0
    expect((await read(s, runId, `${H}/fake-voices/feed/other/`)).isError).toBe(true)
    expect(s.news.urls()).toEqual([`${H}/fake-voices/feed/`])
    const none = await read(s, runId, `${H}/fake-voices/2026/11/19/not-in-feed/`)
    expect(none.text).toContain('この出どころは記事のページを取りません（RSS に無い記事は読めません）')
    expect(s.news.urls().some((u) => u.includes('not-in-feed'))).toBe(false)
    const cond = await read(s, runId, `${H}/fake-voices/2026/11/19/fake-article-three/`)
    expect(cond.text).toContain('ほかの条件が書かれた記事')
    // 訂正だけの回の控えは、最後に読んでから1時間で消す（やる事が置かれる）
    expect(s.core.store.task('expire')).not.toBeNull()
  })

  it('同じホストへ15秒を超えて待つ時は「混んでいます」', async () => {
    const s = await setup()
    const runId = await run(s)
    s.core.store.reserveHost('example.com', s.clock.now, 30_000)
    const r = await read(s, runId, `${H}/fake-ministry/press/1001.html`)
    expect(r.text).toContain('混んでいます。もう一度呼んでください')
    expect(s.news.calls).toHaveLength(0)
  })

  it('候補に無い id は断る', async () => {
    const s = await setup()
    const runId = await run(s)
    expect((await read(s, runId, 'c0099')).text).toContain('この回の候補に「c0099」はありません')
  })
})

describe('topic_list_candidates', () => {
  it('集めている途中なら「集めています」（20秒待っても終わらない時）。probe の hosts・terms の回は候補を集めない', async () => {
    const s = await setup()
    const r = await s.core.callTool(
      'topic_begin_run',
      { kind: 'trial', model: 'fake-writer-model', probe: 'hosts' },
      { grant: s.grant },
    )
    const runId = /runId: (r\d{12}-[0-9a-z]{4})/.exec(r.text)![1]
    const l = await s.core.callTool('topic_list_candidates', { runId }, { grant: s.grant })
    expect(l.text).toContain('候補を集めません')
  })

  it('続き（cursor）で 12,000字ずつ', async () => {
    const s = await setup()
    const runId = await run(s, 'trial', true)
    const rows = s.core.store.candidates(runId)
    // 候補を多くする（作り物の題を長く）
    const many = Array.from({ length: 300 }, (_, i) => ({
      ...rows[0],
      cid: `c${String(i + 1).padStart(4, '0')}`,
      url: `${H}/fake-ministry/press/${5000 + i}.html`,
      title: `作り物の長い題 ${'あ'.repeat(60)} ${i}`,
    }))
    s.core.store.putCandidates(many)
    const a = await s.core.callTool('topic_list_candidates', { runId }, { grant: s.grant })
    const cursor = /続きがあります（cursor: (o\d+)）/.exec(a.text)![1]
    const b = await s.core.callTool('topic_list_candidates', { runId, cursor }, { grant: s.grant })
    expect(b.text).toContain('<<<候補（資料）')
    expect(a.text.length).toBeLessThan(16_000)
  })
})
