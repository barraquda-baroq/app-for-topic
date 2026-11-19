// AI への意思表示の読み（段階3の設計の 1.7 の (2) の 2 の (c)）: Content-Signal・Content-Usage・tdmrep.json・X-Robots-Tag・meta robots
import { describe, expect, it } from 'vitest'
import { metaNoAi, parseTdmRep, signalRefusals, tdmReserved, xRobotsNoAi } from '../../src/fetch/aiSignals'

describe('AI への意思表示', () => {
  it('Content-Signal・Content-Usage の断る値（search だけは数えない。知らない鍵・鍵の無い断る値も数える）', () => {
    expect(signalRefusals('Content-Signal', 'search=yes, ai-train=no, ai-input=no')).toEqual([
      'content-signal:ai-train',
      'content-signal:ai-input',
    ])
    expect(signalRefusals('Content-Usage', 'train-ai=n')).toEqual(['content-usage:train-ai'])
    expect(signalRefusals('Content-Usage', '/fake/ genai=n')).toEqual(['content-usage:genai'])
    expect(signalRefusals('Content-Signal', 'search=no')).toEqual([])
    expect(signalRefusals('Content-Signal', 'ai-train=yes')).toEqual([])
    // 自動の処理（bots）・知らない鍵の断る値・鍵の無い断る値も止める側に
    expect(signalRefusals('Content-Usage', 'bots=n, search=y')).toEqual(['content-usage:bots'])
    expect(signalRefusals('Content-Signal', 'fake-use=no')).toEqual(['content-signal:fake-use'])
    expect(signalRefusals('Content-Usage', 'n')).toEqual(['content-usage:all'])
    expect(signalRefusals('Content-Usage', '/fake/ n')).toEqual(['content-usage:all'])
    expect(signalRefusals('Content-Usage', '/fake/ y')).toEqual([])
  })

  it('tdmrep.json（配列。URL の location は道に。読めなければ null）', () => {
    const e = parseTdmRep(
      JSON.stringify([
        { location: 'https://example.com/fake/*', 'tdm-reservation': 1 },
        { location: '/open/', 'tdm-reservation': 0 },
        'x',
      ]),
    )
    expect(e).toEqual([
      { location: '/fake/*', reserved: true },
      { location: '/open/', reserved: false },
    ])
    expect(tdmReserved(e, '/fake/1.html')).toBe(true)
    expect(tdmReserved(e, '/open/1.html')).toBe(false)
    expect(parseTdmRep('<html>not json</html>')).toBeNull()
    expect(tdmReserved(null, '/x')).toBe(false)
  })

  it('X-Robots-Tag の noai・noimageai（名前つきの値も）', () => {
    expect(xRobotsNoAi('noai')).toBe(true)
    expect(xRobotsNoAi('noindex, noimageai')).toBe(true)
    expect(xRobotsNoAi('FakeBot: noai')).toBe(true)
    expect(xRobotsNoAi('noindex, nofollow')).toBe(false)
    expect(xRobotsNoAi(null)).toBe(false)
  })

  it('<meta name="robots"> の noai（AI・Claude の名前の meta も。Claude の名前の noindex も止める）', () => {
    expect(metaNoAi('robots', 'noai, noimageai')).toBe(true)
    expect(metaNoAi('robots', 'noindex')).toBe(false)
    expect(metaNoAi('GPTBot', 'noai')).toBe(true)
    expect(metaNoAi('ClaudeBot', 'noindex')).toBe(true)
    expect(metaNoAi('description', 'noai')).toBe(false)
  })
})
