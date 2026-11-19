// テスト用: 作り物の出どころ（段階3の設計の 7.「作り物だけを使う」。B5・B8 も使う）。
// - FAKE_SOURCES: 出どころの data と同じ形の作り物（社の名前は src/test/fixtures/fakeOutlets.ts の作り物の社。URL は https://example.com/… だけ）
// - FakeNews: 作り物の HTML の一覧・RSS・Atom・電文・robots.txt・tdmrep.json・規約のページ・確認画面・403・転送を返す fetch
//   （VaultCore の sourceFetch に渡す。グローバルの fetch を通らないので、外へは出ない。test/support/netGuard.ts）。呼ばれた URL・名乗り・時刻を覚える
// - simpleHtmlEvents: Node の単体テスト用の HTML の小さな読み取り（HTMLRewriter と同じ並びを作る。workerd のテストで同じ答えか確かめる）
// - fakeFetchWork: 作り物の出どころと小さな読み取りで作った取りに行く中身（createFetchWork）。idleFetchWork: 何も取りに行かない中身
import { FAKE_CREDIT_OUTLETS } from '../../../src/test/fixtures/fakeOutlets'
import type { FetchEnv } from '../../src/fetch/article'
import type { HtmlEvent } from '../../src/fetch/htmlTokens'
import { normalizeEvents } from '../../src/fetch/htmlTokens'
import type { PendingHost, SourceConfig } from '../../src/fetch/sources'
import { termsFingerprint, termsPageText } from '../../src/fetch/terms'
import type { FetchWork } from '../../src/vault/runs'
import { createFetchWork } from '../../src/vault/tools/fetch'
import {
  FAKE_ANCHOR_PAGE,
  fakeAtom,
  fakePressPage,
  fakeQuakeTelegram,
  fakeRss,
  fakeTermsPage,
  fakeTsunamiTelegram,
  fakeVoicesContent,
  LIST_HEADINGS,
} from '../fixtures/fakePages'

// ---------- HTML の小さな読み取り（Node のテスト用） ----------

/** 中身を文字のまま読む要素 */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])

/** HTML を、HTMLRewriter と同じ形の並びにする（始まり・終わり・文字。文字と属性は元のまま。コメント・DOCTYPE は落とす） */
export function simpleHtmlEvents(html: string): HtmlEvent[] {
  const out: HtmlEvent[] = []
  const re =
    /<!--[\s\S]*?-->|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[5] !== undefined) {
      out.push({ t: 'text', text: m[5] })
      continue
    }
    if (m[2] === undefined) continue
    const name = m[2].toLowerCase()
    if (m[1] === '/') {
      out.push({ t: 'close', name })
      continue
    }
    const attrs: Record<string, string> = {}
    for (const a of (m[3] ?? '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? ''
    out.push({ t: 'open', name, attrs })
    if (RAW_TEXT.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, re.lastIndex)
      const stop = end < 0 ? html.length : end
      if (stop > re.lastIndex) out.push({ t: 'text', text: html.slice(re.lastIndex, stop) })
      re.lastIndex = stop
    }
  }
  return out
}

/** 小さな読み取りの並び（normalizeEvents の後） */
export const eventsOf = (html: string): HtmlEvent[] => normalizeEvents(simpleHtmlEvents(html))

// ---------- 作り物の出どころ ----------

const H = 'https://example.com'

/** 作り物の規約のページの文字と指紋（main の中だけ） */
export const FAKE_TERMS_HTML = fakeTermsPage()
export const FAKE_TERMS_FP = termsFingerprint(termsPageText(eventsOf(FAKE_TERMS_HTML), { scopes: ['main'] }))

const terms = (path: string) => [{ url: `${H}${path}`, scopes: ['main'], fingerprint: FAKE_TERMS_FP, watch: 'weekly' as const }]

/** 作り物の記者の質問の印 */
const QA = ['（記者）', '【記者】']

/** 作り物の出どころ（出どころの data と同じ形。ホストは example.com だけ） */
export const FAKE_SOURCES: readonly SourceConfig[] = [
  {
    id: 'fake-html',
    outlet: FAKE_CREDIT_OUTLETS.site,
    hosts: { list: ['example.com'], body: ['example.com'] },
    lists: [
      {
        kind: 'html',
        label: '報道発表',
        url: `${H}/fake-ministry/press/index.html`,
        itemPath: '^/fake-ministry/press/\\d+\\.(?:html|pdf)$',
      },
    ],
    allowPaths: ['/fake-ministry/'],
    denyPaths: ['/fake-ministry/rss/', '/fake-ministry/other-rules/'],
    body: {
      kind: 'html',
      scopes: ['main', '#contents'],
      dropLines: ['このページの先頭へ', '印刷'],
      dropBlocks: QA,
      qaPages: { paths: ['/fake-ministry/kaiken/'], verified: false },
    },
    hints: { region: 'jp', genres: ['politics'] },
    notes: ['作り物の決まり: 記者の質問は落としてある'],
    terms: { status: 'ok', accepted: '2026-11-01', rssRefused: true },
    termsPages: terms('/fake-ministry/terms.html'),
  },
  {
    id: 'fake-rss',
    outlet: FAKE_CREDIT_OUTLETS.title,
    hosts: { list: ['example.com'], body: ['example.com'] },
    lists: [{ kind: 'rss', label: 'お知らせ', url: `${H}/fake-agency/rss.xml`, excludeCategories: ['調達'] }],
    allowPaths: ['/fake-agency/'],
    denyPaths: [],
    body: { kind: 'html', scopes: ['main'], dropBlocks: QA },
    hints: { region: 'jp', genres: ['tech'] },
    notes: ['作り物の決まり: ロゴは使わない'],
    terms: { status: 'ok', accepted: '2026-11-01' },
    termsPages: terms('/fake-agency/rss-terms.html'),
  },
  {
    id: 'fake-anchor',
    outlet: FAKE_CREDIT_OUTLETS.pdl,
    hosts: { list: ['example.com'], body: ['example.com'] },
    lists: [{ kind: 'rss', label: '新着', url: `${H}/fake-office/index.xml` }],
    allowPaths: ['/fake-office/'],
    denyPaths: [],
    body: { kind: 'anchor', dropBlocks: QA },
    hints: { region: 'jp', genres: ['incident'] },
    notes: ['作り物の決まり: 数は発表のまま'],
    terms: { status: 'ok', accepted: '2026-11-01' },
    termsPages: terms('/fake-office/rss-terms.html'),
  },
  {
    id: 'fake-met',
    outlet: FAKE_CREDIT_OUTLETS.jma,
    hosts: { list: ['example.com'], body: ['example.com'] },
    lists: [{ kind: 'atom', label: '随時の情報', url: `${H}/fake-met/xml/feed/extra.xml`, jmaKinds: true }],
    allowPaths: ['/fake-met/xml/'],
    denyPaths: ['/fake-met/xml/feed/regular.xml'],
    body: { kind: 'jma-xml' },
    hints: { region: 'jp', genres: ['incident'] },
    notes: ['作り物の決まり: 値と区域を変えない'],
    terms: { status: 'ok', accepted: '2026-11-01' },
    termsPages: [{ url: `${H}/fake-met/terms.html`, scopes: ['main'], fingerprint: FAKE_TERMS_FP, watch: 'probe-only' }],
  },
  {
    id: 'fake-voices',
    outlet: FAKE_CREDIT_OUTLETS.ccBy,
    hosts: { list: ['example.com'], body: ['example.com'] },
    lists: [{ kind: 'rss', label: '新着', url: `${H}/fake-voices/feed/` }],
    allowPaths: ['/fake-voices/feed/'],
    denyPaths: [],
    body: { kind: 'feed', excludeIfContains: ['originally published', '©'] },
    hints: { region: 'world', genres: ['politics'] },
    notes: ['作り物の決まり: 英語。訳して書く'],
    terms: { status: 'ok', accepted: '2026-11-01' },
    termsPages: terms('/fake-voices/terms.html'),
  },
]

/** 作り物の今は取らない所 */
export const FAKE_PENDING: readonly PendingHost[] = [
  {
    id: 'fake-pending',
    name: '〇〇協会',
    host: 'pending.example.com',
    statusUrl: 'https://pending.example.com/terms.html',
    termsPages: [{ url: 'https://pending.example.com/terms.html', scopes: ['main'], watch: 'probe-only' }],
  },
]

/** 作り物の出どころの取りに行く中身 */
export function fakeEnv(over: Partial<FetchEnv> = {}): FetchEnv {
  return {
    sources: FAKE_SOURCES,
    pending: FAKE_PENDING,
    html: async (t) => simpleHtmlEvents(t),
    runLimit: 100,
    hostLimit: 40,
    ...over,
  }
}

export const fakeFetchWork = (over: Partial<FetchEnv> = {}) => createFetchWork(fakeEnv(over))

/** 何も取りに行かない中身（候補集めはすぐ終わり、読める候補は0件。出どころの data は空。気象庁の見張りは置かない） */
export function idleFetchWork(): FetchWork {
  return {
    sources: [],
    async collectStep(core, runId) {
      const run = core.store.getRun(runId)
      if (run && run.collect.state === 'collecting') core.store.setRunCollect(runId, { ...run.collect, state: 'done' })
      return { done: true }
    },
    async rulesStep() {
      return { done: true }
    },
    jmaWatchEnabled: () => false,
    async jmaWatchStep() {
      return { done: true }
    },
  }
}

// ---------- 作り物の fetch ----------

/** 答えの作り方（URL ごと） */
export type FakeRoute =
  | string
  | { status?: number; body?: string | Uint8Array<ArrayBuffer>; headers?: Record<string, string> }
  | (() => Response | Promise<Response>)

/** 呼ばれた要求 */
export interface FakeCall {
  url: string
  ua: string
  at: number
  redirect: string
}

export class FakeNews {
  readonly routes = new Map<string, FakeRoute>()
  readonly calls: FakeCall[] = []
  /** 時刻（呼ばれた時刻を覚える。テストの時計を渡す） */
  clock: { now: number }

  constructor(clock: { now: number } = { now: Date.UTC(2026, 10, 19, 3, 0, 0) }) {
    this.clock = clock
  }

  /** 答えを置く（URL は # の後を落として引く） */
  set(url: string, route: FakeRoute): this {
    this.routes.set(url.replace(/#.*$/, ''), route)
    return this
  }

  /** robots.txt を置く（host は example.com など） */
  robots(host: string, text: string | null, status = 200): this {
    return this.set(
      `https://${host}/robots.txt`,
      text === null ? { status } : { status, body: text, headers: { 'content-type': 'text/plain' } },
    )
  }

  html(url: string, html: string, headers: Record<string, string> = {}): this {
    return this.set(url, { body: html, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })
  }

  xml(url: string, xml: string, type = 'application/rss+xml'): this {
    return this.set(url, { body: xml, headers: { 'content-type': `${type}; charset=utf-8` } })
  }

  /** 呼ばれた URL（数える・並びを見る） */
  urls(): string[] {
    return this.calls.map((c) => c.url)
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    this.calls.push({ url, ua: headers.get('User-Agent') ?? '', at: this.clock.now, redirect: String(init?.redirect ?? '') })
    const route = this.routes.get(url.replace(/#.*$/, ''))
    if (route === undefined) return new Response('not found', { status: 404 })
    if (typeof route === 'function') return route()
    if (typeof route === 'string')
      return new Response(route, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    return new Response(route.body ?? '', { status: route.status ?? 200, headers: route.headers ?? {} })
  }
}

// ---------- 作り物の出どころの中身（ふつうの日） ----------

/** 作り物の出どころの中身を置く（2026-11-19 の日。窓の中の項目と、外す項目） */
export function seedFakeNews(news: FakeNews): FakeNews {
  // 〇〇省の HTML の一覧と発表のページ（1003 は PDF・1004 はほかのホスト）
  news.html(`${H}/fake-ministry/press/index.html`, LIST_HEADINGS)
  news.html(`${H}/fake-ministry/press/1001.html`, fakePressPage({ title: '作り物の制度の見直しについて', qa: true }))
  news.html(`${H}/fake-ministry/press/1002.html`, fakePressPage({ title: '「作り物推進計画」の公表について' }))
  news.html(`${H}/fake-ministry/press/1005.html`, fakePressPage({ title: '作り物の会議の開催について' }))
  news.html(`${H}/fake-ministry/terms.html`, FAKE_TERMS_HTML)
  // △△庁の RSS（調達のカテゴリーは外す）
  news.xml(
    `${H}/fake-agency/rss.xml`,
    fakeRss([
      { title: '作り物の手続きの案内', link: `${H}/fake-agency/news/1.html`, date: 'Thu, 19 Nov 2026 08:00:00 +0900' },
      { title: '「作り物推進計画」の説明会', link: `${H}/fake-agency/news/2.html`, date: 'Wed, 18 Nov 2026 20:00:00 +0900' },
      {
        title: '作り物の物品の調達',
        link: `${H}/fake-agency/news/3.html`,
        date: 'Thu, 19 Nov 2026 09:00:00 +0900',
        category: '調達情報',
      },
      { title: '窓より前の作り物の案内', link: `${H}/fake-agency/news/4.html`, date: 'Mon, 16 Nov 2026 09:00:00 +0900' },
    ]),
  )
  news.html(`${H}/fake-agency/news/1.html`, fakePressPage({ title: '作り物の手続きの案内' }))
  news.html(`${H}/fake-agency/news/2.html`, fakePressPage({ title: '「作り物推進計画」の説明会' }))
  news.html(`${H}/fake-agency/rss-terms.html`, FAKE_TERMS_HTML)
  // ▽▽府の RSS（一覧のページの #番号。n102 は PDF への案内だけ）
  news.xml(
    `${H}/fake-office/index.xml`,
    fakeRss([
      { title: '作り物の火災の情報（第1報）', link: '/fake-office/index.html#n101', date: 'Thu, 19 Nov 2026 07:30:00 +0900' },
      { title: '作り物の訓練のお知らせ', link: '/fake-office/index.html#n102', date: 'Thu, 19 Nov 2026 07:00:00 +0900' },
    ]),
  )
  news.html(`${H}/fake-office/index.html`, FAKE_ANCHOR_PAGE)
  news.html(`${H}/fake-office/rss-terms.html`, FAKE_TERMS_HTML)
  // ▲▲台の Atom と電文（最大震度5弱は入る・見出しに要る語の無い物は外す・予報だけの津波は電文で外す）
  news.xml(
    `${H}/fake-met/xml/feed/extra.xml`,
    fakeAtom([
      {
        title: '震度速報',
        link: `${H}/fake-met/xml/data/q1.xml`,
        updated: '2026-11-19T00:58:00Z',
        content: '作り物県で最大震度５弱を観測',
      },
      {
        title: '震度速報',
        link: `${H}/fake-met/xml/data/q2.xml`,
        updated: '2026-11-19T00:30:00Z',
        content: '作り物県で最大震度３を観測',
      },
      { title: '府県天気予報', link: `${H}/fake-met/xml/data/w1.xml`, updated: '2026-11-19T00:40:00Z', content: '作り物の予報' },
      {
        title: '津波警報・注意報・予報a',
        link: `${H}/fake-met/xml/data/t1.xml`,
        updated: '2026-11-19T01:03:00Z',
        content: '津波注意報を発表',
      },
    ]),
    'application/atom+xml',
  )
  news.xml(`${H}/fake-met/xml/data/q1.xml`, fakeQuakeTelegram({ maxInt: '5-' }), 'application/xml')
  news.xml(`${H}/fake-met/xml/data/t1.xml`, fakeTsunamiTelegram({ kind: '津波予報（若干の海面変動）' }), 'application/xml')
  news.html(`${H}/fake-met/terms.html`, FAKE_TERMS_HTML)
  // □□ボイスの全文の RSS（著者の無い物・別の条件の印のある物は外す。写真の説明の © だけでは外さない）
  news.xml(
    `${H}/fake-voices/feed/`,
    fakeRss([
      {
        title: 'A fake voices article',
        link: `${H}/fake-voices/2026/11/19/fake-article-one/`,
        date: 'Thu, 19 Nov 2026 00:10:00 +0000',
        creator: 'Fake Writer',
        content: fakeVoicesContent({ caption: 'Photo © fake photographer' }),
      },
      {
        title: 'A fake article without author',
        link: `${H}/fake-voices/2026/11/19/fake-article-two/`,
        date: 'Thu, 19 Nov 2026 00:20:00 +0000',
        content: fakeVoicesContent(),
      },
      {
        title: 'A fake republished article',
        link: `${H}/fake-voices/2026/11/19/fake-article-three/`,
        date: 'Thu, 19 Nov 2026 00:30:00 +0000',
        creator: 'Fake Writer Two',
        content: fakeVoicesContent({ tail: 'This fake story was originally published by a fake partner.' }),
      },
    ]),
  )
  news.html(`${H}/fake-voices/terms.html`, FAKE_TERMS_HTML)
  return news
}
