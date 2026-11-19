// RSS・RDF・Atom の読み（段階3の設計の 1.7 の (3)）: 項目・題（CDATA・文字参照）・リンク（RSS・RDF の rdf:about・Atom の link href）・
// 日時（pubDate・dc:date・updated）・カテゴリー・著者（dc:creator）・全文（content:encoded・Atom の content）
import { describe, expect, it } from 'vitest'
import { parseFeed } from '../../src/fetch/rss'
import { fakeAtom, fakeRdf, fakeRss } from '../fixtures/fakePages'

describe('RSS・Atom の読み', () => {
  it('RSS 2.0: 題（CDATA）・リンク・pubDate・カテゴリー・著者・全文', () => {
    const f = parseFeed(
      fakeRss([
        {
          title: '作り物の<b>お知らせ</b> &amp; 案内',
          link: 'https://example.com/fake-agency/1.html',
          date: 'Thu, 19 Nov 2026 10:00:00 +0900',
          category: '作り物の調達情報',
          creator: 'Fake Writer',
          content: '<p>作り物の全文</p>',
        },
      ]),
    )
    expect(f.kind).toBe('rss')
    expect(f.items).toHaveLength(1)
    const it0 = f.items[0]
    expect(it0.title).toBe('作り物のお知らせ &amp; 案内')
    expect(it0.link).toBe('https://example.com/fake-agency/1.html')
    expect(it0.date).toBe('Thu, 19 Nov 2026 10:00:00 +0900')
    expect(it0.categories).toEqual(['作り物の調達情報'])
    expect(it0.author).toBe('Fake Writer')
    expect(it0.contentHtml).toBe('<p>作り物の全文</p>')
  })

  it('文字参照で書いた題は直す', () => {
    const f = parseFeed('<rss><channel><item><title>A &amp; B &#12354;</title><link>/x</link></item></channel></rss>')
    expect(f.items[0].title).toBe('A & B あ')
    expect(f.items[0].link).toBe('/x')
  })

  it('RSS 1.0（RDF）: dc:date と link（無ければ rdf:about）', () => {
    const f = parseFeed(
      fakeRdf([{ title: '作り物の報道発表', link: 'http://example.com/fake/1.html', date: '2026-11-19T10:00:00+09:00' }]),
    )
    expect(f.kind).toBe('rdf')
    expect(f.items[0]).toMatchObject({
      title: '作り物の報道発表',
      link: 'http://example.com/fake/1.html',
      date: '2026-11-19T10:00:00+09:00',
    })
  })

  it('Atom: link href・updated・content（文字）', () => {
    const f = parseFeed(
      fakeAtom([
        {
          title: '震度速報',
          link: 'https://example.com/fake-met/xml/data/1.xml',
          updated: '2026-11-19T01:00:00Z',
          content: '作り物の見出し',
        },
      ]),
    )
    expect(f.kind).toBe('atom')
    expect(f.items[0]).toMatchObject({
      title: '震度速報',
      link: 'https://example.com/fake-met/xml/data/1.xml',
      date: '2026-11-19T01:00:00Z',
      contentHtml: '作り物の見出し',
      author: '▲▲台',
    })
  })

  it('RSS・Atom でなければ項目なし', () => {
    expect(parseFeed('<html><body>作り物</body></html>')).toEqual({ kind: null, items: [] })
  })
})
