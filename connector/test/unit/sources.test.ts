// 出どころの data の確かめ（段階3の設計の 1.7 の (1) の「data の確かめ」。足し忘れ・矛盾を止める）: outlets.ts と sources.ts がそろう・
// RSS の断りのある出どころに RSS が無く、その RSS の道が denyPaths にある・URL が許した道の中・気象庁は /developer/xml/ だけ・
// Global Voices は /feed/ だけ・厚労省と国交省の denyPaths・html の本文はどれも dropBlocks を持つ・termsPages の並び・
// permitted の出どころの permit がそろう・notes の字数と資料の印
import { describe, expect, it } from 'vitest'
import { DEFAULT_OUTLET_LIST, DEFAULT_OUTLETS, outletEntryOf, outletsOfHost } from '../../../src/domain/outlets'
import { AI_AGENTS, ANTHROPIC_AGENTS, CONNECTOR_AGENT, OTHER_AGENTS, USER_AGENT, agentKey } from '../../src/fetch/aiAgents'
import {
  DEFAULT_SOURCES,
  PENDING_HOSTS,
  PRESS_QUESTION_MARKS,
  SOURCE_NOTE_MAX,
  termsFingerprinted,
  type SourceConfig,
} from '../../src/fetch/sources'
import { checkBodyUrl, checkListUrl, pathIn } from '../../src/fetch/urlPolicy'
import { hasMark } from '../../src/vault/tools/common'
import { FAKE_SOURCES } from '../support/fakeNews'

const byId = (id: string) => DEFAULT_SOURCES.find((s) => s.id === id)!

/** data の確かめ（本物の data と作り物の data で同じ物を見る） */
function problemsOf(sources: readonly SourceConfig[]): string[] {
  const out: string[] = []
  const ids = new Set<string>()
  for (const s of sources) {
    if (!/^[a-z0-9-]{2,20}$/.test(s.id)) out.push(`${s.id}: id は ASCII の印`)
    if (ids.has(s.id)) out.push(`${s.id}: id が重なる`)
    ids.add(s.id)
    for (const l of s.lists) {
      const u = new URL(l.url)
      if (!s.hosts.list.includes(u.hostname)) out.push(`${s.id}: 一覧のホスト ${u.hostname}`)
      const httpOk = l.kind === 'rss' && l.http === true && s.permit?.rssAllowed === true
      if (u.protocol !== 'https:' && !httpOk) out.push(`${s.id}: 一覧は https`)
      if (l.kind === 'rss' && l.http && !(s.permit && s.permit.rssAllowed)) out.push(`${s.id}: http の一覧は許しの社だけ`)
      if (!checkListUrl(s, l, l.url).ok) out.push(`${s.id}: 一覧の URL が取らない道`)
      if (l.kind === 'html') {
        try {
          new RegExp(l.itemPath)
        } catch {
          out.push(`${s.id}: itemPath が読めない`)
        }
      }
    }
    for (const p of s.allowPaths) if (!p.startsWith('/')) out.push(`${s.id}: allowPaths は / から`)
    for (const p of s.denyPaths) if (!p.startsWith('/')) out.push(`${s.id}: denyPaths は / から`)
    if (s.body.kind === 'html' && !s.body.dropBlocks.length) out.push(`${s.id}: html の本文は dropBlocks を持つ`)
    if (s.terms.rssRefused) {
      if (s.lists.some((l) => l.kind === 'rss')) out.push(`${s.id}: RSS の断りのある出どころに RSS`)
    }
    if (s.terms.status === 'permitted') {
      const p = s.permit
      if (
        !p ||
        !p.grantedOn ||
        !p.scope ||
        !(p.maxBodiesPerRun > 0) ||
        !(p.minIntervalSec > 0) ||
        typeof p.rssAllowed !== 'boolean'
      )
        out.push(`${s.id}: permitted の出どころは permit の欄が全部そろう`)
      else if (!p.rssAllowed && s.lists.some((l) => l.kind === 'rss')) out.push(`${s.id}: RSS を使ってよくない許しの社に RSS`)
    }
    if (!s.termsPages.length) out.push(`${s.id}: termsPages が無い`)
    if (s.lists.some((l) => l.kind === 'rss') && !s.termsPages.some((p) => /rss/i.test(p.url)) && s.body.kind !== 'feed')
      out.push(`${s.id}: rss の一覧を持つ出どころは RSS の利用条件のページを見張る`)
    for (const n of s.notes) {
      if (Array.from(n).length > SOURCE_NOTE_MAX) out.push(`${s.id}: notes が ${SOURCE_NOTE_MAX}字を超える`)
      if (hasMark(n)) out.push(`${s.id}: notes に資料の印`)
    }
  }
  return out
}

describe('出どころの data（本物）', () => {
  it('8つ（府省・庁の7つと Global Voices）。どれも決まりに合う', () => {
    expect(DEFAULT_SOURCES.map((s) => s.id)).toEqual(['kantei', 'cao', 'digital', 'mhlw', 'fdma', 'jma', 'mlit', 'gv'])
    expect(problemsOf(DEFAULT_SOURCES)).toEqual([])
  })

  it('どの出どころも outlets.ts に同じ名前とホストと credit がある。outlets.ts の社のうち sources.ts に無い物が無い', () => {
    for (const s of DEFAULT_SOURCES) {
      const e = outletEntryOf(s.outlet)
      expect(e, s.id).not.toBeNull()
      expect(e!.name).toBe(s.outlet)
      expect(e!.credit, s.id).toBeDefined()
      for (const h of [...s.hosts.list, ...s.hosts.body])
        expect(outletsOfHost(h, DEFAULT_OUTLETS), `${s.id} ${h}`).toContain(s.outlet)
    }
    for (const o of DEFAULT_OUTLET_LIST.outlets)
      expect(
        DEFAULT_SOURCES.some((s) => s.outlet === o.name),
        o.name,
      ).toBe(true)
  })

  it('名前とホスト（outlets.ts に合わせる）', () => {
    const hosts = Object.fromEntries(DEFAULT_SOURCES.map((s) => [s.outlet, s.hosts.body[0]]))
    expect(hosts).toEqual({
      首相官邸: 'www.kantei.go.jp',
      内閣府: 'www.cao.go.jp',
      デジタル庁: 'www.digital.go.jp',
      厚生労働省: 'www.mhlw.go.jp',
      消防庁: 'www.fdma.go.jp',
      気象庁: 'www.data.jma.go.jp',
      国土交通省: 'www.mlit.go.jp',
      'Global Voices': 'globalvoices.org',
    })
  })

  it('RSS の断りのある官邸・内閣府・厚労省は RSS を使わず、その RSS の配信とページの道が denyPaths にある', () => {
    for (const [id, paths] of [
      ['kantei', ['/index-jnews.rdf', '/rss.html']],
      ['cao', ['/rss/news.rdf', '/rss/index.html']],
      ['mhlw', ['/stf/news.rdf', '/stf/kinkyu.rdf', '/rss/index.html']],
    ] as const) {
      const s = byId(id)
      expect(s.terms.rssRefused, id).toBe(true)
      expect(
        s.lists.every((l) => l.kind === 'html'),
        id,
      ).toBe(true)
      for (const p of paths) {
        // allowPaths の外でも、断った RSS の道は denyPaths に書いておく（allowPaths を広げた時にも取らないように）
        expect(pathIn(p, s.denyPaths), `${id} ${p}`).toBe(true)
        expect(checkBodyUrl(s, `https://${s.hosts.body[0]}${p}`).ok, `${id} ${p}`).toBe(false)
      }
    }
    // 断りの無い所は rssRefused を持たない
    for (const id of ['digital', 'fdma', 'mlit', 'gv']) expect(byId(id).terms.rssRefused, id).toBeUndefined()
  })

  it('気象庁は /developer/xml/ だけ・試しの回だけ（見張りの alarm を置かない）。Global Voices は /feed/ だけ・Crawl-delay 10', () => {
    const jma = byId('jma')
    expect(jma.allowPaths).toEqual(['/developer/xml/'])
    expect(jma.terms.status).toBe('trial-only')
    expect(jma.termsPages.every((p) => p.watch === 'probe-only')).toBe(true)
    expect(jma.lists.map((l) => l.url)).toEqual([
      'https://www.data.jma.go.jp/developer/xml/feed/extra.xml',
      'https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml',
    ])
    expect(checkBodyUrl(jma, 'https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml').ok).toBe(false)
    expect(checkBodyUrl(jma, 'https://www.data.jma.go.jp/sapporo/index.html').ok).toBe(false)
    const gv = byId('gv')
    expect(gv.allowPaths).toEqual(['/feed/'])
    expect(gv.crawlDelaySec).toBe(10)
    expect(gv.body.kind).toBe('feed')
    expect(checkBodyUrl(gv, 'https://globalvoices.org/2026/11/19/fake-article/').ok).toBe(false)
  })

  it('厚労省の denyPaths に別紙の物（/churoi/meirei_db/・/churoi/kouji/）とシンボルマーク、国交省の denyPaths に3つの別のルールの道', () => {
    expect(byId('mhlw').denyPaths).toEqual(
      expect.arrayContaining(['/churoi/meirei_db/', '/churoi/kouji/', '/kouseiroudoushou/symbol/']),
    )
    expect(byId('mlit').denyPaths).toEqual(expect.arrayContaining(['/jidosha/anzen/', '/plateau/', '/sumai_literacy_pf/']))
  })

  it('html の本文を持つ出どころはどれも記者の質問の段を落とす（dropBlocks）。会見の道は確かめるまで verified でない', () => {
    for (const s of DEFAULT_SOURCES)
      if (s.body.kind === 'html') {
        expect(s.body.dropBlocks, s.id).toEqual(PRESS_QUESTION_MARKS)
        if (s.body.qaPages) expect(s.body.qaPages.verified, s.id).toBe(false)
      }
  })

  it('termsPages: RSS の利用条件・リンクの決まり（内閣府・国交省）・気象庁の本体の規約と地方の利用上の注意（probe-only）・Global Voices の帰属の決まりと AI の方針', () => {
    const urls = (id: string) => byId(id).termsPages.map((p) => p.url)
    expect(urls('kantei')).toEqual(expect.arrayContaining(['https://www.kantei.go.jp/rss.html']))
    expect(urls('cao')).toEqual(expect.arrayContaining(['https://www.cao.go.jp/notice/aboutlink.html']))
    expect(urls('mlit')).toEqual(expect.arrayContaining(['https://www.mlit.go.jp/link.html']))
    expect(urls('jma')).toEqual(
      expect.arrayContaining([
        'https://www.jma.go.jp/jma/kishou/info/coment.html',
        'https://www.data.jma.go.jp/sapporo/about/kiyaku.html',
      ]),
    )
    expect(urls('gv')).toEqual(
      expect.arrayContaining([
        'https://globalvoices.org/about/global-voices-attribution-policy/',
        'https://globalvoices.org/about/global-voices-policy-on-ai/',
      ]),
    )
    for (const s of DEFAULT_SOURCES)
      if (s.id !== 'jma')
        expect(
          s.termsPages.every((p) => p.watch === 'weekly'),
          s.id,
        ).toBe(true)
  })

  it('規約のページの指紋は S1c まで無い（指紋の無いページのある出どころは本番で取らない）', () => {
    for (const s of DEFAULT_SOURCES) expect(termsFingerprinted(s), s.id).toBe(false)
  })

  it('ジャンルの手がかり（hints.genres）は、設計の 4.13 のジャンルの割り振りの表の「多い出どころ」と同じ（Q15 の答えで替わる）', () => {
    const byGenre = (g: string) =>
      DEFAULT_SOURCES.filter((s) => (s.hints.genres as readonly string[]).includes(g)).map((s) => s.id)
    expect(byGenre('politics')).toEqual(['kantei', 'cao', 'mhlw'])
    expect(byGenre('economy')).toEqual(['cao', 'mhlw', 'mlit'])
    expect(byGenre('tech')).toEqual(['digital', 'gv'])
    expect(byGenre('ai')).toEqual(['cao', 'digital'])
    expect(byGenre('incident')).toEqual(['mhlw', 'fdma', 'jma', 'mlit'])
    expect(byGenre('sports')).toEqual([])
    expect(byGenre('entertainment')).toEqual([])
  })

  it('今は取らない所（外務省・防衛省・経済産業省）は、取り方を持たず、番号を見る規約のページ1つだけ', () => {
    expect(PENDING_HOSTS.map((p) => p.host)).toEqual(['www.mofa.go.jp', 'www.mod.go.jp', 'www.meti.go.jp'])
    expect(PENDING_HOSTS.find((p) => p.id === 'meti')!.statusUrl).toBe('https://www.meti.go.jp/main/rules.html')
    for (const p of PENDING_HOSTS) {
      expect(new URL(p.statusUrl).hostname).toBe(p.host)
      expect(DEFAULT_SOURCES.some((s) => s.hosts.body.includes(p.host))).toBe(false)
    }
  })
})

describe('名乗りと名前の表', () => {
  it('名乗りはコネクタの名前だけ（ブラウザの名前・連絡先を入れない）', () => {
    expect(USER_AGENT).toBe(`${CONNECTOR_AGENT}/1.0`)
    expect(USER_AGENT).toMatch(/^[A-Za-z]+\/\d+\.\d+$/)
    expect(USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari|@|https?:/i)
  })

  it('Claude・Anthropic の名前は6つ。ほかの AI の表と重ならない', () => {
    expect(ANTHROPIC_AGENTS).toEqual([
      'ClaudeBot',
      'Claude-User',
      'Claude-Web',
      'Claude-SearchBot',
      'Claude-Code',
      'anthropic-ai',
    ])
    const ai = new Set(AI_AGENTS.map(agentKey))
    const other = new Set(OTHER_AGENTS.map(agentKey))
    for (const a of ANTHROPIC_AGENTS) {
      expect(ai.has(agentKey(a))).toBe(false)
      expect(other.has(agentKey(a))).toBe(false)
    }
    for (const a of AI_AGENTS) expect(other.has(agentKey(a)), a).toBe(false)
    expect(AI_AGENTS).toEqual(expect.arrayContaining(['GPTBot', 'CCBot', 'Google-Extended', 'PerplexityBot', 'Bytespider']))
  })
})

describe('作り物の出どころの data', () => {
  it('本物と同じ決まりに合う。ホストは example.com だけ', () => {
    expect(problemsOf(FAKE_SOURCES)).toEqual([])
    for (const s of FAKE_SOURCES) for (const h of [...s.hosts.list, ...s.hosts.body]) expect(h).toBe('example.com')
  })

  it('data の確かめは、矛盾を止める（RSS の断り・permit・dropBlocks・notes・一覧のホスト）', () => {
    const base = FAKE_SOURCES[0]
    const bad: SourceConfig[] = [
      { ...base, id: 'bad-rss', lists: [{ kind: 'rss', label: 'x', url: 'https://example.com/fake-ministry/feed.xml' }] },
      { ...base, id: 'bad-permit', terms: { status: 'permitted', accepted: '2026-11-01' } },
      { ...base, id: 'bad-drop', body: { kind: 'html', scopes: ['main'], dropBlocks: [] } },
      { ...base, id: 'bad-note', notes: ['あ'.repeat(SOURCE_NOTE_MAX + 1), '<<<偽の印'] },
      { ...base, id: 'bad-host', hosts: { list: ['example.org'], body: ['example.com'] } },
      {
        ...base,
        id: 'bad-http',
        terms: { status: 'ok', accepted: '2026-11-01' },
        lists: [{ kind: 'rss', label: 'x', url: 'http://example.com/fake-ministry/feed.xml', http: true }],
      },
    ]
    const p = problemsOf(bad)
    expect(p).toEqual(
      expect.arrayContaining([
        'bad-rss: RSS の断りのある出どころに RSS',
        'bad-permit: permitted の出どころは permit の欄が全部そろう',
        'bad-drop: html の本文は dropBlocks を持つ',
        `bad-note: notes が ${SOURCE_NOTE_MAX}字を超える`,
        'bad-note: notes に資料の印',
        'bad-host: 一覧のホスト example.com',
        'bad-http: http の一覧は許しの社だけ',
      ]),
    )
  })
})
