// robots.txt の決まり（段階3の設計の 1.7 の (2) の 2。問1 の作者の答えの芯）: コネクタの名前の組・Claude-User の組・* の組・
// ClaudeBot だけが Disallow: / の robots.txt では取らない・anthropic-ai・Claude-Web・Claude-SearchBot・Claude-Code の組でも同じ・
// コネクタの名前を名指しで許した組がある時だけ取る・ほかの AI の名前の断り・Content-Signal・tdmrep.json の留保・# の注の AI の語・
// 表に無い名前の組の新しい断りで、取りを止める・Crawl-delay
import { describe, expect, it } from 'vitest'
import { ANTHROPIC_AGENTS } from '../../src/fetch/aiAgents'
import { parseTdmRep } from '../../src/fetch/aiSignals'
import {
  crawlDelayOf,
  decidePath,
  hostRulesData,
  hostStateOf,
  parseRobots,
  patternMatches,
  rulesAllow,
  type HostRulesData,
} from '../../src/fetch/robots'

const data = (text: string | null, prev: HostRulesData | null = null, tdm: string | null = null): HostRulesData =>
  hostRulesData(
    { status: text === null ? 404 : 200, text },
    { status: tdm === null ? 404 : 200, entries: tdm === null ? null : parseTdmRep(tdm) },
    prev,
  )
const verdict = (text: string | null, path = '/fake/press/1.html', prev: HostRulesData | null = null) =>
  decidePath(data(text, prev), path).verdict

describe('robots.txt の読み', () => {
  it('続けて書いた User-agent は1つの組。規則の後の User-agent は次の組。注と空の Disallow', () => {
    const p = parseRobots(
      'User-agent: A\nUser-agent: B\nDisallow: /x\n# 作り物の注\nUser-agent: C\nDisallow:\nCrawl-delay: 5\nSitemap: https://example.com/s.xml',
    )
    expect(p.groups).toEqual([
      { agents: ['a', 'b'], rules: [{ allow: false, pattern: '/x' }] },
      { agents: ['c'], rules: [{ allow: true, pattern: '' }], crawlDelay: 5 },
    ])
    expect(p.aiComment).toBe(false)
  })

  it('道の比べ方（いちばん長く当たる規則・同じ長さなら Allow・* と $）', () => {
    expect(patternMatches('/fake/*.pdf$', '/fake/a/b.pdf')).toBe(true)
    expect(patternMatches('/fake/*.pdf$', '/fake/a/b.pdf?x=1')).toBe(false)
    expect(
      rulesAllow(
        [
          { allow: false, pattern: '/fake/' },
          { allow: true, pattern: '/fake/press/' },
        ],
        '/fake/press/1.html',
      ),
    ).toBe(true)
    expect(
      rulesAllow(
        [
          { allow: false, pattern: '/fake/press/' },
          { allow: true, pattern: '/fake/' },
        ],
        '/fake/press/1.html',
      ),
    ).toBe(false)
    expect(
      rulesAllow(
        [
          { allow: false, pattern: '/fake' },
          { allow: true, pattern: '/fake' },
        ],
        '/fake/1',
      ),
    ).toBe(true)
    expect(rulesAllow([], '/any')).toBe(true)
  })
})

describe('取ってよいか（(a)・(b)）', () => {
  it('404（決まりなし）・* の組だけで許す時は取る', () => {
    expect(verdict(null)).toBe('ok')
    expect(verdict('User-agent: *\nDisallow: /private/')).toBe('ok')
    expect(verdict('User-agent: *\nDisallow: /fake/')).toBe('refused')
  })

  it('(a) コネクタの名前の組（無ければ *）と Claude-User の組（無ければ *）の両方', () => {
    expect(verdict('User-agent: TopicStudioConnector\nDisallow: /fake/')).toBe('refused')
    expect(verdict('User-agent: Claude-User\nDisallow: /fake/')).toBe('refused')
    expect(verdict('User-agent: claude-user\nDisallow: /')).toBe('refused')
    // コネクタの名前の組があっても、Claude-User の組が無ければ * の組で見る（* が断れば取らない）
    expect(verdict('User-agent: TopicStudioConnector\nDisallow: /private/\n\nUser-agent: *\nDisallow: /')).toBe('refused')
    expect(
      decidePath(data('User-agent: TopicStudioConnector\nDisallow: /private/\n\nUser-agent: *\nDisallow: /'), '/x').reasons,
    ).toEqual(['claude-user'])
  })

  it('(b) ClaudeBot だけが Disallow: / の robots.txt では取らない。Claude・Anthropic のどの名前の組でも同じ', () => {
    for (const a of ANTHROPIC_AGENTS) {
      expect(verdict(`User-agent: *\nAllow: /\n\nUser-agent: ${a}\nDisallow: /`), a).toBe('refused')
      expect(decidePath(data(`User-agent: ${a}\nDisallow: /`), '/x').reasons.join(','), a).toMatch(/anthropic:|claude-user/)
    }
    // 道を断っていなければ取る
    expect(verdict('User-agent: ClaudeBot\nDisallow: /private/')).toBe('ok')
  })

  it('コネクタの名前を名指しで許した組がある時だけ、Claude・ほかの AI の名前の組を見ない', () => {
    const t =
      'User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: TopicStudioConnector\nAllow: /fake/'
    expect(verdict(t)).toBe('ok')
    // 名指しの組でも、その道を許していなければ取らない
    expect(verdict(t, '/other/1.html')).toBe('refused')
    // 空の Disallow の名指しの組は全部を許す
    expect(verdict('User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: TopicStudioConnector\nDisallow:', '/other/1.html')).toBe(
      'ok',
    )
    // 名指しで許しても、AI への意思表示（Content-Signal）は止める
    expect(verdict(`${t}\nContent-Signal: ai-input=no`)).toBe('stopped')
  })
})

describe('取りを止める（(c)・(d)）', () => {
  it('ほかの AI の名前の組の断り', () => {
    expect(verdict('User-agent: GPTBot\nDisallow: /')).toBe('stopped')
    expect(verdict('User-agent: CCBot\nDisallow: /fake/')).toBe('stopped')
    expect(verdict('User-agent: CCBot\nDisallow: /other/')).toBe('ok')
    expect(decidePath(data('User-agent: Google-Extended\nDisallow: /'), '/x').reasons).toEqual(['ai:google-extended'])
  })

  it('Content-Signal・Content-Usage の AI の利用を断る値（search は数えない）', () => {
    expect(verdict('User-agent: *\nContent-Signal: search=yes, ai-train=no\nAllow: /')).toBe('stopped')
    expect(verdict('User-agent: *\nContent-Signal: search=yes, ai-input=no')).toBe('stopped')
    expect(verdict('Content-Usage: train-ai=n')).toBe('stopped')
    expect(verdict('User-agent: *\nContent-Signal: search=no')).toBe('ok')
    expect(verdict('User-agent: *\nContent-Signal: search=yes, ai-train=yes')).toBe('ok')
  })

  it('# の注に AI・機械学習・学習・LLM・scraping などの語', () => {
    expect(verdict('# No AI training on this fake site\nUser-agent: *\nAllow: /')).toBe('stopped')
    expect(verdict('# 機械学習のための収集はご遠慮ください\nUser-agent: *')).toBe('stopped')
    expect(verdict('# scraping is not allowed\nUser-agent: *')).toBe('stopped')
    // MAIL・DETAIL などの AI は当てない
    expect(verdict('# MAIL: see the DETAIL page\nUser-agent: *')).toBe('ok')
  })

  it('tdmrep.json が取りに行く道を留保した時', () => {
    const reserved = data(null, null, JSON.stringify([{ location: '/fake/*', 'tdm-reservation': 1 }]))
    expect(decidePath(reserved, '/fake/press/1.html').verdict).toBe('stopped')
    expect(decidePath(reserved, '/other/1.html').verdict).toBe('ok')
    const open = data(null, null, JSON.stringify([{ location: '/', 'tdm-reservation': 0 }]))
    expect(decidePath(open, '/fake/1').verdict).toBe('ok')
  })

  it('(d) 表に無い名前の組が増え、その道を断っている時（初めて読んだ時の名前は比べる元。表にある AI でない名前は止めない）', () => {
    const first = data('User-agent: FakeOldBot\nDisallow: /\n\nUser-agent: *\nAllow: /')
    expect(decidePath(first, '/fake/1').verdict).toBe('ok')
    const added = data(
      'User-agent: FakeOldBot\nDisallow: /\n\nUser-agent: FakeNewBot\nDisallow: /\n\nUser-agent: *\nAllow: /',
      first,
    )
    expect(decidePath(added, '/fake/1')).toEqual({ verdict: 'stopped', reasons: ['new-agent:fakenewbot'] })
    // 次の日に読み直しても、比べる元は初めて読んだ時の名前のまま（止めたまま）
    const again = data('User-agent: FakeOldBot\nDisallow: /\n\nUser-agent: FakeNewBot\nDisallow: /', added)
    expect(decidePath(again, '/fake/1').verdict).toBe('stopped')
    const search = data('User-agent: FakeOldBot\nDisallow: /\n\nUser-agent: Googlebot-Image\nDisallow: /', first)
    expect(decidePath(search, '/fake/1').verdict).toBe('ok')
  })

  it('本文の応答で見た意思表示は止めたまま。data の terms.accepted がその日より新しい時だけ外れる', () => {
    const d = { ...data(null), stop: { day: '2026-11-19', reasons: ['meta-noai'] } }
    expect(decidePath(d, '/fake/1').verdict).toBe('stopped')
    expect(decidePath(d, '/fake/1', '2026-11-19').verdict).toBe('stopped')
    expect(decidePath(d, '/fake/1', '2026-11-20').verdict).toBe('ok')
  })

  it('断る（robots.txt）と止める（AI）が両方ある時は、断る', () => {
    expect(verdict('User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /')).toBe('refused')
  })
})

describe('読み落としで取らない（組の名前の書き方・ASCII でない道・大きな robots.txt）', () => {
  it('組の名前の版の書き（ClaudeBot/1.0）は落として比べる。初めて読んだ日でも断る・止める', () => {
    expect(verdict('User-agent: ClaudeBot/1.0\nDisallow: /')).toBe('refused')
    expect(verdict('User-agent: TopicStudioConnector/1.0\nDisallow: /fake/')).toBe('refused')
    expect(verdict('User-agent: GPTBot/1.1\nDisallow: /')).toBe('stopped')
  })

  it('Claude・Anthropic の語を含む名前（表に無い名前でも）の断りは、初めて読んだ日でも断る', () => {
    expect(verdict('User-agent: Claude\nDisallow: /')).toBe('refused')
    expect(verdict('User-agent: Anthropic\nDisallow: /fake/')).toBe('refused')
    expect(verdict('User-agent: FakeClaudeFetcher\nDisallow: /')).toBe('refused')
    // ほかの AI の名前を含む名前は、表のほかの AI の名前と同じに止める
    expect(verdict('User-agent: GPTBot-Image\nDisallow: /')).toBe('stopped')
    // 道を断っていなければ取る
    expect(verdict('User-agent: Claude\nDisallow: /private/')).toBe('ok')
  })

  it('ASCII でない字の規則は %xx にそろえて比べる（URL の道は %xx で来る）', () => {
    const t = 'User-agent: *\nDisallow: /作り物/'
    expect(verdict(t, `/${encodeURIComponent('作り物')}/1.html`)).toBe('refused')
    expect(verdict(t, '/fake/1.html')).toBe('ok')
    expect(verdict('User-agent: *\nDisallow: /fake%2a/', '/fake%2A/1')).toBe('refused')
  })

  it('規則が上限を超えた組は、どの道も断る側に読む。行が上限を超えた robots.txt は取りを止める', () => {
    const many = Array.from({ length: 450 }, (_, i) => `Disallow: /fake-${i}/`).join('\n')
    expect(verdict(`User-agent: *\n${many}\nDisallow: /`)).toBe('refused')
    expect(verdict(`User-agent: *\nAllow: /\n\nUser-agent: ClaudeBot\n${many}\nDisallow: /`)).toBe('refused')
    const long = `${Array.from({ length: 5_100 }, (_, i) => `# fake line ${i}`).join('\n')}\nUser-agent: ClaudeBot\nDisallow: /`
    expect(decidePath(data(long), '/fake/1').reasons).toContain('robots-long')
    expect(decidePath(data(long), '/fake/1').verdict).not.toBe('ok')
    // 1MB で切った robots.txt も同じ
    const cut = hostRulesData(
      { status: 200, text: 'User-agent: *\nAllow: /', truncated: true },
      { status: 404, entries: null },
      null,
    )
    expect(decidePath(cut, '/fake/1').verdict).toBe('stopped')
  })

  it('# の注の AI の語は大文字・小文字を問わない', () => {
    expect(verdict('# no ai crawlers on this fake site\nUser-agent: *')).toBe('stopped')
    expect(verdict('# llm training is not welcome\nUser-agent: *')).toBe('stopped')
  })
})

describe('ホストの状態と Crawl-delay', () => {
  it('出どころの道のどれかで止める → stopped、全部で断る → refused、ほかは ok', () => {
    const d = data('User-agent: *\nDisallow: /a/')
    expect(hostStateOf(d, ['/a/list.html', '/b/']).state).toBe('ok')
    expect(hostStateOf(d, ['/a/list.html']).state).toBe('refused')
    expect(hostStateOf(data('User-agent: GPTBot\nDisallow: /b/'), ['/a/', '/b/']).state).toBe('stopped')
  })

  it('Crawl-delay はコネクタの名前の組（無ければ *）と Claude-User の組の長い方', () => {
    expect(crawlDelayOf(data('User-agent: *\nCrawl-delay: 10'))).toBe(10)
    expect(crawlDelayOf(data('User-agent: *\nCrawl-delay: 1\n\nUser-agent: Claude-User\nCrawl-delay: 4'))).toBe(4)
    expect(crawlDelayOf(data(null))).toBeNull()
  })

  it('前と変わったかは文字の指紋で見る（404 は空）', () => {
    const a = data('User-agent: *\nDisallow: /x')
    const b = data('User-agent: *\nDisallow: /y', a)
    expect(a.fp).not.toBe('')
    expect(a.fp).not.toBe(b.fp)
    expect(data(null).fp).toBe('')
  })
})
