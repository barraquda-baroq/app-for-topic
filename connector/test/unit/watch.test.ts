// 見張り（段階3の設計の 1.7 の (2)・(4)・(5)・(10)）: 毎日の決まりの読み（1日1回・cron が動かなかった日は最初の回で・変わった時に
// 決め直して知らせる・読めない時（5xx・403・確認画面）はその日は取らない・404 は決まりなし）・規約のページ（日曜だけ・weekly の物だけ・
// data の指紋と比べる・違えば取りを止める）・気象庁の見張り（data が 'ok' の時だけ・電文は読まない）・一覧の作りの印（1回目から・取りは止めない）
import { describe, expect, it } from 'vitest'
import { FAKE_OUTLETS } from '../../../src/test/fixtures/fakeOutlets'
import type { FetchEnv } from '../../src/fetch/article'
import type { SourceConfig } from '../../src/fetch/sources'
import { jmaUnseen, jmaWatchEnabled, jmaWatchStep, noteJmaSeen, rulesStep } from '../../src/fetch/watch'
import { DEFAULT_FETCH_ENV } from '../../src/fetch/article'
import { fakeTermsPage, LIST_CHANGED } from '../fixtures/fakePages'
import { FakeFirebase } from '../support/fakeFirebase'
import { fakeEnv, fakeFetchWork, FakeNews, FAKE_SOURCES, seedFakeNews } from '../support/fakeNews'
import { drainAlarms, pairedCore } from '../support/harness'

const jst = (h: number, m: number, d = 19) => Date.UTC(2026, 10, d, h - 9, m)

async function setup(at = jst(4, 23), env: Partial<FetchEnv> = {}, prepNews?: (n: FakeNews) => void) {
  const clock = { now: at }
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

/** 気象庁の見張りを置かない作り物（'trial-only'） */
const noJma: SourceConfig[] = FAKE_SOURCES.map((s) =>
  s.id === 'fake-met' ? { ...s, terms: { status: 'trial-only', accepted: '2026-11-01' } } : s,
)

async function rules(s: Awaited<ReturnType<typeof setup>>) {
  for (let i = 0; i < 20; i++) {
    const st = await rulesStep(s.core, s.clock.now)
    if (st.done) return
    if (st.next > s.clock.now) s.clock.now = st.next
  }
  throw new Error('終わらない')
}

describe('毎日の決まりの読み', () => {
  it('ホストごとに robots.txt と tdmrep.json を1日1回（2回目は読まない）。夜の仕事が始め、cron が動かなかった日は最初の回が始める', async () => {
    const s = await setup(jst(4, 23), { sources: noJma })
    expect(await s.core.nightly()).toBe('ok')
    await drainAlarms(s.core, s.clock)
    expect(s.news.urls().sort()).toEqual(['https://example.com/.well-known/tdmrep.json', 'https://example.com/robots.txt'])
    s.news.calls.length = 0
    await rules(s)
    expect(s.news.calls).toHaveLength(0)
    // 次の日は、最初の回が読む（cron が動かなかった日）
    s.clock.now = jst(10, 16, 20)
    await s.core.callTool('topic_begin_run', { kind: 'correction', model: 'fake-writer-model' }, { grant: s.grant })
    await drainAlarms(s.core, s.clock)
    expect(s.news.urls()).toEqual(['https://example.com/robots.txt', 'https://example.com/.well-known/tdmrep.json'])
  })

  it('robots.txt が前と変わったら決め直し、その日の topic_status に「robots.txt が変わりました」', async () => {
    const s = await setup(jst(4, 23), { sources: noJma })
    await rules(s)
    s.clock.now = jst(4, 23, 20)
    s.news.robots('example.com', 'User-agent: *\nDisallow: /fake-agency/')
    await rules(s)
    const rule = s.core.store.hostRule('example.com')!
    expect(rule.changed).not.toBeNull()
    const st = await s.core.callTool('topic_status', {}, { grant: s.grant })
    expect(st.text).toContain('〇〇省: 取っている・robots.txt が変わりました')
  })

  it('読めない時（5xx・403・確認画面）は、その日はそのホストから取らない。404 は決まりなし', async () => {
    for (const route of [
      { status: 503 },
      { status: 403 },
      { status: 200, body: '<title>Just a moment...</title>', headers: { 'cf-mitigated': 'challenge' } },
    ]) {
      const s = await setup(jst(4, 23), { sources: noJma })
      s.clock.now = jst(4, 23, 20)
      s.news.set('https://example.com/robots.txt', route)
      await rules(s)
      expect(s.core.store.hostRule('example.com')!.state, JSON.stringify(route)).toBe('unreadable')
      // tdmrep.json は読まない（robots.txt を読めない日は取らない）
      expect(s.news.urls().filter((u) => u.endsWith('tdmrep.json'))).toEqual([])
      const st = await s.core.callTool('topic_status', {}, { grant: s.grant })
      expect(st.text).toContain('今日は取らない（robots.txt を読めない・403・429・確認画面）')
    }
  })

  it('tdmrep.json が 403 の時も、その日は取らない', async () => {
    const s = await setup(jst(4, 23), { sources: noJma })
    s.clock.now = jst(4, 23, 20)
    s.news.set('https://example.com/.well-known/tdmrep.json', { status: 403 })
    await rules(s)
    expect(s.core.store.hostRule('example.com')!.state).toBe('unreadable')
  })
})

describe('規約のページの見張り', () => {
  // 2026-11-22 は日曜
  it('日曜だけ、weekly の物だけ（probe-only は取らない）。data の指紋と同じなら何もしない', async () => {
    const s = await setup(jst(4, 23, 21), { sources: noJma })
    await rules(s)
    expect(s.news.urls().filter((u) => u.includes('terms'))).toEqual([])
    s.clock.now = jst(4, 23, 22)
    await rules(s)
    const terms = s.news.urls().filter((u) => u.includes('terms'))
    expect(terms.sort()).toEqual([
      'https://example.com/fake-agency/rss-terms.html',
      'https://example.com/fake-ministry/terms.html',
      'https://example.com/fake-office/rss-terms.html',
      'https://example.com/fake-voices/terms.html',
    ])
    expect(s.core.store.termsWatch('https://example.com/fake-ministry/terms.html')!.state).toBe('same')
    // 更新日（scopes の外）だけが変わっても止めない
    s.news.html('https://example.com/fake-ministry/terms.html', fakeTermsPage(undefined, '2026年11月29日'))
    s.clock.now = jst(4, 23, 29)
    await rules(s)
    expect(s.core.store.termsWatch('https://example.com/fake-ministry/terms.html')!.state).toBe('same')
  })

  it('規約のページの文字が変われば、その出どころを「取らない（規約のページが変わりました）」にする', async () => {
    const s = await setup(jst(4, 23, 22), { sources: noJma }, (n) =>
      n.html('https://example.com/fake-ministry/terms.html', fakeTermsPage('作り物の新しい決まりの文です。')),
    )
    await rules(s)
    expect(s.core.store.termsWatch('https://example.com/fake-ministry/terms.html')!.state).toBe('changed')
    const st = await s.core.callTool('topic_status', {}, { grant: s.grant })
    expect(st.text).toContain('〇〇省: 取らない（規約のページが変わりました）')
  })
})

describe('気象庁の見張り', () => {
  it("data が 'ok' で指紋のある時だけ置く。本番の data（'trial-only'）では置かない", () => {
    expect(jmaWatchEnabled(DEFAULT_FETCH_ENV)).toBe(false)
    expect(jmaWatchEnabled(fakeEnv())).toBe(true)
    expect(jmaWatchEnabled(fakeEnv({ sources: noJma }))).toBe(false)
  })

  it("'trial-only' の間は見張りの alarm を置かない", async () => {
    const s = await setup(jst(4, 23), { sources: noJma })
    await s.core.nightly()
    expect(s.core.store.task('jma')).toBeNull()
  })

  it('短い Atom を1本読み、種類の表と要る語に当たる項目だけ（題・リンク・時刻・種類）を控える。電文は読まない', async () => {
    const s = await setup()
    s.clock.now = jst(7, 0)
    await jmaWatchStep(s.core, s.clock.now)
    expect(s.news.urls().filter((u) => u.includes('/fake-met/'))).toEqual(['https://example.com/fake-met/xml/feed/extra.xml'])
    const rows = s.core.store.jmaWatch()
    expect(rows.map((r) => [r.kind, r.link])).toEqual([
      ['quake', 'https://example.com/fake-met/xml/data/q1.xml'],
      ['tsunami', 'https://example.com/fake-met/xml/data/t1.xml'],
    ])
    // 3時間ごと（data が ok の時だけ置く）
    expect(s.core.store.task('jma')).not.toBeNull()
  })

  it('行ごとに7日見えない種類を知らせる（見始めて7日たつまでは知らせない）', () => {
    const s = { store: null as never }
    void s
    const store = new (class {
      meta = new Map<string, unknown>()
      getMeta<T>(k: string) {
        return (this.meta.get(k) as T) ?? null
      }
      setMeta(k: string, v: unknown) {
        this.meta.set(k, v)
      }
    })()
    const t0 = jst(0, 0, 1)
    noteJmaSeen(store as never, ['quake'], t0)
    expect(jmaUnseen(store as never, t0 + 86_400_000)).toEqual([])
    const later = t0 + 8 * 86_400_000
    expect(jmaUnseen(store as never, later)).toContain('tsunami')
    noteJmaSeen(store as never, ['quake'], later)
    expect(jmaUnseen(store as never, later)).not.toContain('quake')
  })
})

describe('一覧の作りの印', () => {
  it('一覧が 200 なのに道の形に合う項目が0件なら、1回目から印（取りは止めない）。候補の一覧と topic_status に出す', async () => {
    const s = await setup(jst(10, 16), { sources: noJma }, (n) =>
      n.html('https://example.com/fake-ministry/press/index.html', LIST_CHANGED),
    )
    const r = await s.core.callTool('topic_begin_run', { kind: 'trial', model: 'fake-writer-model' }, { grant: s.grant })
    const runId = /runId: (r\d{12}-[0-9a-z]{4})/.exec(r.text)![1]
    await drainAlarms(s.core, s.clock, { n: 200, within: 60 * 60_000 })
    expect(s.core.store.sourceFlags('fake-html').structure).toBe(true)
    const l = await s.core.callTool('topic_list_candidates', { runId }, { grant: s.grant })
    expect(l.text).toContain('〇〇省: 取れた 0・一覧の作りが変わったかもしれません（取りは続けます）')
    // ほかの出どころは取れている
    expect(l.text).toMatch(/△△庁: 取れた 2/)
    const st = await s.core.callTool('topic_status', {}, { grant: s.grant })
    expect(st.text).toContain('一覧の作りが変わったかもしれません')
    // 出どころごとの数は直近14回（数だけ）
    expect(s.core.store.sourceCounts('fake-html')[0].counts.ok).toBe(0)
  })
})
