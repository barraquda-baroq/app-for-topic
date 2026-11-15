// 社の名前の一覧と出典の URL（docs/SPEC.md の 4.8・7.1・16.3）: 書き方をそろえる、知らないホストの https: はリンクにならない、
// 一覧は差し替えられる（作り物の版では作り物の一覧）。URL は https://example.com/… だけを使う（公開のリポジトリに本物を入れない）
import { describe, expect, it } from 'vitest'
import { FAKE_OUTLET_LIST, FAKE_OUTLET_NAMES, FAKE_OUTLETS, FAKE_UNLISTED_OUTLET } from '../test/fixtures/fakeOutlets'
import {
  canonicalOutletName,
  canonicalViaName,
  createOutletDirectory,
  DEFAULT_OUTLET_LIST,
  DEFAULT_OUTLETS,
  httpsHostOf,
  isAllowedSourceUrl,
  isKnownHost,
  isKnownOutlet,
  sourceHosts,
  sourceLinkUrl,
} from './outlets'

const src = (outlet: string, url: string, via: string | null = null) => ({ outlet, url, via })

describe('社の名前の書き方', () => {
  it('別名・全角と半角・前後の空白を決まった書き方にそろえる。一覧に無い社は名前のまま', () => {
    expect(canonicalOutletName('〇〇', FAKE_OUTLETS)).toBe('〇〇通信')
    expect(canonicalOutletName(' 〇〇通信 ', FAKE_OUTLETS)).toBe('〇〇通信')
    expect(canonicalOutletName(FAKE_UNLISTED_OUTLET, FAKE_OUTLETS)).toBe('◇◇日報')
    expect(canonicalViaName('××ニュース', FAKE_OUTLETS)).toBe('××ニュース')
    expect(isKnownOutlet('△△', FAKE_OUTLETS)).toBe(true)
    expect(isKnownOutlet(FAKE_UNLISTED_OUTLET, FAKE_OUTLETS)).toBe(false)
  })

  it('同じ名前・別名が2つの社に当たる一覧は誤り', () => {
    expect(() =>
      createOutletDirectory({
        outlets: [
          { name: '〇〇通信', aliases: ['〇〇'], hosts: [] },
          { name: '〇〇新聞', aliases: ['〇〇'], hosts: [] },
        ],
        vias: [],
      }),
    ).toThrow()
  })
})

describe('出典の URL', () => {
  it('https: のホスト（読めない・http:・利用者の名前・決まりでないポートは null）', () => {
    expect(httpsHostOf('https://EXAMPLE.com/a?b=1#c')).toBe('example.com')
    expect(httpsHostOf('http://example.com/a')).toBeNull()
    expect(httpsHostOf('https://user:pass@example.com/a')).toBeNull()
    expect(httpsHostOf('https://example.com:8443/a')).toBeNull()
    expect(httpsHostOf('javascript:alert(1)')).toBeNull()
    expect(httpsHostOf('example.com/a')).toBeNull()
    expect(httpsHostOf(null)).toBeNull()
  })

  it('社か読んだ所の決まったホストの https: だけがリンクになる', () => {
    expect(sourceLinkUrl(src('〇〇通信', 'https://example.com/news/1'), FAKE_OUTLETS)).toBe('https://example.com/news/1')
    expect(sourceLinkUrl(src('〇〇', 'https://example.com/news/1'), FAKE_OUTLETS)).toBe('https://example.com/news/1')
    expect(sourceLinkUrl(src('〇〇通信', 'http://example.com/news/1'), FAKE_OUTLETS)).toBeNull()
    // 一覧に無い社は、読んだ所の URL でだけ
    expect(sourceLinkUrl(src(FAKE_UNLISTED_OUTLET, 'https://example.com/via/2'), FAKE_OUTLETS)).toBeNull()
    expect(sourceLinkUrl(src(FAKE_UNLISTED_OUTLET, 'https://example.com/via/2', '××ニュース'), FAKE_OUTLETS)).toBe(
      'https://example.com/via/2',
    )
    expect(sourceHosts(src(FAKE_UNLISTED_OUTLET, '', '××ニュース'), FAKE_OUTLETS)).toEqual(new Set(['example.com']))
  })

  it('知らないホストの https: はリンクにならない（一覧を後で足した時の古いアプリも同じ）', () => {
    // 社の一覧にまだ example.com が無い（古い）一覧
    const old = createOutletDirectory({ outlets: [{ name: '〇〇通信', hosts: [] }], vias: [] })
    expect(isKnownHost('example.com', old)).toBe(false)
    expect(isAllowedSourceUrl(src('〇〇通信', 'https://example.com/news/1'), old)).toBe(false)
    expect(sourceLinkUrl(src('〇〇通信', 'https://example.com/news/1'), old)).toBeNull()
    // ふだんの一覧には作り物の社もホストも無い
    expect(isKnownHost('example.com', DEFAULT_OUTLETS)).toBe(false)
    expect(sourceLinkUrl(src('〇〇通信', 'https://example.com/news/1'))).toBeNull()
  })
})

describe('一覧', () => {
  it('ふだんの一覧: 名前は重ならず、ホストは小文字の決まった名前', () => {
    const names = DEFAULT_OUTLET_LIST.outlets.map((o) => o.name)
    expect(new Set(names).size).toBe(names.length)
    for (const e of [...DEFAULT_OUTLET_LIST.outlets, ...DEFAULT_OUTLET_LIST.vias])
      for (const h of e.hosts) {
        expect(h).toBe(h.toLowerCase())
        expect(h).toMatch(/^[a-z0-9.-]+\.[a-z]+$/)
      }
    expect(DEFAULT_OUTLET_LIST.vias.length).toBeGreaterThan(0)
  })

  it('作り物の一覧: ホストは example.com だけ、社の名前は作り物だけ', () => {
    for (const e of [...FAKE_OUTLET_LIST.outlets, ...FAKE_OUTLET_LIST.vias])
      for (const h of e.hosts) expect(h).toBe('example.com')
    expect(FAKE_OUTLET_NAMES).toEqual(['〇〇通信', '△△新聞', '□□放送', '◇◇日報'])
  })
})
