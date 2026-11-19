// 社の名前の一覧と出典の URL（docs/SPEC.md の 4.8・7.1・16.3）: 書き方をそろえる、知らないホストの https: はリンクにならない、
// 一覧は差し替えられる（作り物の版では作り物の一覧）。URL は https://example.com/… だけを使う（公開のリポジトリに本物を入れない）。
// 段階3: ふだんの一覧が府省・庁の7つと Global Voices（どれも credit を持ち、新しい窓で開く・読んだ所は無い・新聞の社が残っていない）、
// リンクの開き方が 'no-link' の社はリンクにしない、ホストの社を引く（段階3の設計の 1.7 の (1)）
import { describe, expect, it } from 'vitest'
import {
  FAKE_CREDIT_OUTLETS,
  FAKE_OUTLET_LIST,
  FAKE_OUTLET_NAMES,
  FAKE_OUTLETS,
  FAKE_UNLISTED_OUTLET,
} from '../test/fixtures/fakeOutlets'
import { normalizeIdText } from './ids'
import {
  canonicalOutletName,
  canonicalViaName,
  createOutletDirectory,
  CREDIT_FORMS,
  DEFAULT_OUTLET_LIST,
  DEFAULT_OUTLETS,
  httpsHostOf,
  isAllowedSourceUrl,
  isKnownHost,
  isKnownOutlet,
  linkOpenOf,
  outletEntryOf,
  outletsOfHost,
  sourceHosts,
  sourceLinkUrl,
  viasOfHost,
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

  it("リンクの開き方が 'no-link' の社は、使ってよい URL でもリンクにしない（URL は文で出す）", () => {
    const url = 'https://example.com/news/9'
    expect(isAllowedSourceUrl(src(FAKE_CREDIT_OUTLETS.noLink, url), FAKE_OUTLETS)).toBe(true)
    expect(sourceLinkUrl(src(FAKE_CREDIT_OUTLETS.noLink, url), FAKE_OUTLETS)).toBeNull()
    expect(linkOpenOf(src(FAKE_CREDIT_OUTLETS.noLink, url), FAKE_OUTLETS)).toBe('no-link')
    // ほかの作り物の社（書いていない社・新しい窓の社）・一覧に無い社は新しい窓
    expect(linkOpenOf(src(FAKE_CREDIT_OUTLETS.site, url), FAKE_OUTLETS)).toBe('new-window')
    expect(linkOpenOf(src('〇〇通信', url), FAKE_OUTLETS)).toBe('new-window')
    expect(linkOpenOf(src(FAKE_UNLISTED_OUTLET, url, '××ニュース'), FAKE_OUTLETS)).toBe('new-window')
    expect(sourceLinkUrl(src(FAKE_CREDIT_OUTLETS.site, url), FAKE_OUTLETS)).toBe(url)
  })
})

describe('ホストの社', () => {
  it('そのホストで資料が読める社と読んだ所（一覧の順。1つのホストに社が2つ以上ある時もある）', () => {
    expect(outletsOfHost('EXAMPLE.com', FAKE_OUTLETS)).toEqual(FAKE_OUTLET_LIST.outlets.map((o) => o.name))
    expect(viasOfHost('example.com', FAKE_OUTLETS)).toEqual(['××ニュース'])
    expect(outletsOfHost('example.org', FAKE_OUTLETS)).toEqual([])
    for (const o of DEFAULT_OUTLET_LIST.outlets) for (const h of o.hosts) expect(outletsOfHost(h)).toEqual([o.name])
  })

  it('社の一覧の1つを、決まった書き方か別名で引く（一覧に無い社は null）', () => {
    expect(outletEntryOf('〇〇省ホームページ', FAKE_OUTLETS)?.name).toBe(FAKE_CREDIT_OUTLETS.site)
    expect(outletEntryOf(FAKE_UNLISTED_OUTLET, FAKE_OUTLETS)).toBeNull()
  })
})

describe('一覧', () => {
  it('ふだんの一覧: 府省・庁の7つと Global Voices。名前と別名は重ならず、ホストは小文字の決まった名前で、ほかの社と重ならない', () => {
    const names = DEFAULT_OUTLET_LIST.outlets.map((o) => o.name)
    expect(names).toEqual(['首相官邸', '内閣府', 'デジタル庁', '厚生労働省', '消防庁', '気象庁', '国土交通省', 'Global Voices'])
    const forms = DEFAULT_OUTLET_LIST.outlets.flatMap((o) => [o.name, ...(o.aliases ?? [])].map(normalizeIdText))
    expect(new Set(forms).size).toBe(forms.length)
    const hosts = DEFAULT_OUTLET_LIST.outlets.flatMap((o) => [...o.hosts])
    expect(new Set(hosts).size).toBe(hosts.length)
    for (const h of hosts) {
      expect(h).toBe(h.toLowerCase())
      expect(h).toMatch(/^[a-z0-9.-]+\.[a-z]+$/)
    }
    expect(() => createOutletDirectory(DEFAULT_OUTLET_LIST)).not.toThrow()
  })

  it('ふだんの一覧: どの社にも出典の書き方（5つの形のどれか）があり、リンクは新しい窓で開く。読んだ所（vias）は空', () => {
    for (const o of DEFAULT_OUTLET_LIST.outlets) {
      expect([o.name, o.credit && CREDIT_FORMS.includes(o.credit.form)]).toEqual([o.name, true])
      expect([o.name, o.linkOpen]).toEqual([o.name, 'new-window'])
    }
    expect(DEFAULT_OUTLET_LIST.vias).toEqual([])
    const forms = Object.fromEntries(DEFAULT_OUTLET_LIST.outlets.map((o) => [o.name, o.credit?.form]))
    expect(forms).toEqual({
      首相官邸: 'site',
      内閣府: 'pdl',
      デジタル庁: 'title',
      厚生労働省: 'site',
      消防庁: 'site',
      気象庁: 'jma',
      国土交通省: 'site',
      'Global Voices': 'cc-by',
    })
  })

  it('ふだんの一覧: 段階2までの新聞・放送・通信の社と読んだ所が残っていない', () => {
    const json = JSON.stringify(DEFAULT_OUTLET_LIST)
    for (const word of ['新聞', '放送', '通信', 'NHK', 'ニュース', 'yahoo', 'reuters', 'bbc', 'apnews', 'nikkei'])
      expect([word, json.toLowerCase().includes(word.toLowerCase())]).toEqual([word, false])
  })

  it('作り物の一覧: ホストは example.com だけ、社の名前は作り物だけ', () => {
    for (const e of [...FAKE_OUTLET_LIST.outlets, ...FAKE_OUTLET_LIST.vias])
      for (const h of e.hosts) expect(h).toBe('example.com')
    expect(FAKE_OUTLET_NAMES).toEqual([
      '〇〇通信',
      '△△新聞',
      '□□放送',
      '〇〇省',
      '△△庁',
      '▽▽府',
      '▲▲台',
      '□□ボイス',
      '〇〇協会',
      '◇◇日報',
    ])
    // 段階2までの作り物の社は出典の書き方を持たない（出典の表示の無い社）。足した作り物の社は5つの形を全部持つ
    for (const name of ['〇〇通信', '△△新聞', '□□放送']) expect(outletEntryOf(name, FAKE_OUTLETS)?.credit).toBeUndefined()
    const forms = new Set(FAKE_OUTLET_LIST.outlets.flatMap((o) => (o.credit ? [o.credit.form] : [])))
    expect([...forms].sort()).toEqual([...CREDIT_FORMS].sort())
  })
})
