// URL の決まり・文字の符号（段階3の設計の 1.7 の (11)）: 本文は https だけ・本文のホストの allowPaths の中・denyPaths の外・PDF は読まない・
// http: true の一覧は許しの社だけで、項目のリンクを同じ社の本文のホストの https に直す・RSS と Atom の応答の見分け・1MB で止める・
// Shift_JIS（Node の TextDecoder。workerd でも test/worker/charset.test.ts で確かめる）・確認画面
import { describe, expect, it } from 'vitest'
import type { SourceConfig } from '../../src/fetch/sources'
import {
  charsetOf,
  checkBodyUrl,
  checkListUrl,
  decodeBytes,
  isChallenge,
  isFeedResponse,
  itemRefusal,
  itemUrl,
  listHopOk,
  MAX_RESPONSE_BYTES,
  pathShape,
  readCapped,
} from '../../src/fetch/urlPolicy'
import { FAKE_SOURCES } from '../support/fakeNews'

const src = FAKE_SOURCES.find((s) => s.id === 'fake-html')!

/** 一覧のホストと本文のホストが違う、許しの社の作り物（http の一覧） */
const permitted: SourceConfig = {
  ...src,
  id: 'fake-permit',
  hosts: { list: ['feeds.example.com'], body: ['example.com'] },
  lists: [{ kind: 'rss', label: '総合', url: 'http://feeds.example.com/fake/rss', http: true }],
  terms: { status: 'permitted', accepted: '2026-11-01' },
  permit: { grantedOn: '2026-11-01', scope: '作り物の範囲', maxBodiesPerRun: 2, minIntervalSec: 10, rssAllowed: true },
}

describe('URL の決まり', () => {
  it('本文は https・本文のホスト・allowPaths の中・denyPaths の外・PDF でない', () => {
    expect(checkBodyUrl(src, 'https://example.com/fake-ministry/press/1.html').ok).toBe(true)
    expect(checkBodyUrl(src, 'http://example.com/fake-ministry/press/1.html')).toEqual({ ok: false, why: 'scheme' })
    expect(checkBodyUrl(src, 'https://example.org/fake-ministry/press/1.html')).toEqual({ ok: false, why: 'host' })
    expect(checkBodyUrl(src, 'https://example.com/other/1.html')).toEqual({ ok: false, why: 'path' })
    expect(checkBodyUrl(src, 'https://example.com/fake-ministry/rss/feed.xml')).toEqual({ ok: false, why: 'deny' })
    expect(checkBodyUrl(src, 'https://example.com/fake-ministry/press/1.pdf')).toEqual({ ok: false, why: 'pdf' })
    expect(checkBodyUrl(src, 'https://user:pw@example.com/fake-ministry/1.html')).toEqual({ ok: false, why: 'url' })
    expect(checkBodyUrl(src, 'https://example.com:8443/fake-ministry/1.html')).toEqual({ ok: false, why: 'url' })
  })

  it('取らない道は、大文字・小文字と %xx の書き方を替えてもすり抜けない（会見の道も同じ）', () => {
    for (const p of [
      '/fake-ministry/RSS/feed.html',
      '/Fake-Ministry/rss/a.html',
      '/fake-ministry/%72ss/a.html',
      '/fake-ministry%2Frss/a',
    ])
      expect(checkBodyUrl(src, `https://example.com${p}`), p).toEqual({ ok: false, why: 'deny' })
    expect(checkBodyUrl(src, 'https://example.com/fake-ministry/press/1.html').ok).toBe(true)
  })

  it('RSS の断りのある出どころでは、配信の形の道（.rdf・.rss・.xml・.atom）を本文としても一覧としても取りに行かない', () => {
    expect(src.terms.rssRefused).toBe(true)
    for (const p of [
      '/fake-ministry/news.rdf',
      '/fake-ministry/a.RSS',
      '/fake-ministry/press/index.xml',
      '/fake-ministry/a.atom',
    ])
      expect(checkBodyUrl(src, `https://example.com${p}`), p).toEqual({ ok: false, why: 'deny' })
    const rss = { kind: 'rss' as const, label: '作り物', url: 'https://example.com/fake-ministry/news.html' }
    expect(checkListUrl(src, rss, rss.url)).toEqual({ ok: false, why: 'deny' })
    // 断りの無い出どころの .xml は道の決まりだけで見る
    const other = FAKE_SOURCES.find((s) => s.id === 'fake-rss')!
    expect(checkBodyUrl(other, 'https://example.com/fake-agency/a.xml').ok).toBe(true)
  })

  it('一覧の転送の行き先: 一覧の決まりに合い、本文のホストの中なら allowPaths の中だけ', () => {
    const voices = FAKE_SOURCES.find((s) => s.id === 'fake-voices')!
    const l = voices.lists[0]
    expect(listHopOk(voices, l, new URL('https://example.com/fake-voices/feed/?paged=1'))).toBe(true)
    expect(listHopOk(voices, l, new URL('https://example.com/fake-voices/2026/11/19/fake-article-one/'))).toBe(false)
    expect(listHopOk(src, src.lists[0], new URL('https://example.com/fake-ministry/rss/index.html'))).toBe(false)
    // 一覧だけのホスト（許しの社）は一覧の決まりだけ
    expect(listHopOk(permitted, permitted.lists[0], new URL('http://feeds.example.com/fake/rss2'))).toBe(true)
  })

  it('一覧は https だけ。http: true の一覧は許しの社（rssAllowed）だけ', () => {
    expect(checkListUrl(src, src.lists[0], src.lists[0].url).ok).toBe(true)
    expect(checkListUrl(permitted, permitted.lists[0], permitted.lists[0].url).ok).toBe(true)
    const noPermit = { ...permitted, permit: undefined }
    expect(checkListUrl(noPermit, noPermit.lists[0], noPermit.lists[0].url)).toEqual({ ok: false, why: 'scheme' })
    // 一覧のホストは hosts.list だけ（本文のホストの一覧は取らない）
    expect(checkListUrl(permitted, permitted.lists[0], 'https://example.com/fake/rss').ok).toBe(false)
  })

  it('項目のリンク: 相対は一覧の URL から。http: は同じ社の本文のホストの時だけ https: に直す（直せない物は null）', () => {
    expect(itemUrl(src, '/fake-ministry/press/1.html#top', 'https://example.com/fake-ministry/press/index.html')).toBe(
      'https://example.com/fake-ministry/press/1.html',
    )
    expect(itemUrl(src, '#n101', 'https://example.com/fake-office/index.html', true)).toBe(
      'https://example.com/fake-office/index.html#n101',
    )
    expect(itemUrl(permitted, 'http://example.com/fake/1.html', permitted.lists[0].url)).toBe('https://example.com/fake/1.html')
    expect(itemUrl(permitted, 'http://other.example.org/1.html', permitted.lists[0].url)).toBeNull()
    expect(itemUrl(src, 'javascript:alert(1)', 'https://example.com/')).toBeNull()
  })

  it('候補にしない訳: ほかのホスト・取らない道・PDF・許していない道', () => {
    expect(itemRefusal(src, 'https://other.example.org/fake/1.html')).toBe('other-host')
    expect(itemRefusal(src, 'https://example.com/fake-ministry/other-rules/1.html')).toBe('deny')
    expect(itemRefusal(src, 'https://example.com/fake-ministry/1.pdf')).toBe('pdf')
    expect(itemRefusal(src, 'https://example.com/elsewhere/1.html')).toBe('path')
    expect(itemRefusal(src, 'https://example.com/fake-ministry/press/1.html')).toBeNull()
  })

  it('RSS・Atom の応答の見分け（Content-Type か、中身の頭）', () => {
    expect(isFeedResponse('application/rss+xml; charset=utf-8', '')).toBe(true)
    expect(isFeedResponse('text/xml', '<?xml version="1.0"?>\n<rdf:RDF xmlns:rdf="x">')).toBe(true)
    expect(isFeedResponse('text/html', '﻿<feed xmlns="http://www.w3.org/2005/Atom">')).toBe(true)
    expect(isFeedResponse('text/html', '<!DOCTYPE html><html>')).toBe(false)
  })

  it('確認画面の見分け（cf-mitigated・「Just a moment...」）', () => {
    expect(isChallenge(new Headers({ 'cf-mitigated': 'challenge' }), 403)).toBe(true)
    expect(isChallenge(new Headers(), 503, '<html><head><title>Just a moment...</title>')).toBe(true)
    expect(isChallenge(new Headers(), 200, '<html><title>作り物</title>')).toBe(false)
  })

  it('1つの応答は 1MB で読むのを止める', async () => {
    const big = new Uint8Array(MAX_RESPONSE_BYTES + 5_000).fill(97)
    const r = await readCapped(new Response(big))
    expect(r.truncated).toBe(true)
    expect(r.bytes.byteLength).toBe(MAX_RESPONSE_BYTES)
    const small = await readCapped(new Response('作り物'))
    expect(small.truncated).toBe(false)
  })

  it('文字の符号: Content-Type・XML の宣言・meta charset の順。Shift_JIS を読む。読めない符号は null', () => {
    // 「〇〇省テスト」の Shift_JIS のバイト列（作り物）
    const sjis = new Uint8Array([0x81, 0x5a, 0x81, 0x5a, 0x8f, 0xc8, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67])
    expect(charsetOf('text/xml; charset=Shift_JIS', sjis)).toBe('shift_jis')
    const decl = new TextEncoder().encode('<?xml version="1.0" encoding="Shift_JIS"?><rdf:RDF>')
    expect(charsetOf('application/rdf+xml', decl)).toBe('shift_jis')
    expect(charsetOf(null, new TextEncoder().encode('<html><meta charset="EUC-JP">'))).toBe('euc-jp')
    expect(charsetOf(null, new Uint8Array([0x61]))).toBe('utf-8')
    expect(decodeBytes(sjis, 'shift_jis')).toBe('〇〇省テスト')
    expect(decodeBytes(sjis, 'x-sjis')).toBe('〇〇省テスト')
    expect(decodeBytes(sjis, 'no-such-charset')).toBeNull()
  })

  it('道の形は数字を N に、英語の題の slug に見える所は SLUG に（題・リンクの文字は出さない）', () => {
    expect(pathShape('/stf/newpage_12345.html')).toBe('/stf/newpage_N.html')
    // 作り物の題の語でできた道
    expect(pathShape('/2026/11/19/fake-title-words-here/')).toBe('/N/N/N/SLUG/')
    expect(pathShape('/press/fake-words-19-more.html')).toBe('/press/SLUG.html')
    // 2語までの道（一覧の名前など）はそのまま
    expect(pathShape('/press-release/list.html')).toBe('/press-release/list.html')
  })

  it('続いたスラッシュの道（//other-rules/・/fake-ministry//rss/）は、本文としても一覧としても取らない', () => {
    expect(checkBodyUrl(src, 'https://example.com/fake-ministry/other-rules/a.html').ok).toBe(false)
    for (const u of [
      'https://example.com//fake-ministry/other-rules/a.html',
      'https://example.com/fake-ministry//other-rules/a.html',
      'https://example.com/fake-ministry//rss/a.html',
      'https://example.com/fake-ministry//kaiken/1.html',
    ]) {
      const c = checkBodyUrl(src, u)
      expect(c.ok, u).toBe(false)
      expect(itemRefusal(src, u), u).toBe('deny')
    }
    expect(checkListUrl(src, src.lists[0], 'https://example.com/fake-ministry//press/index.html').ok).toBe(false)
    // 一重の道はこれまでどおり
    expect(checkBodyUrl(src, 'https://example.com/fake-ministry/press/1001.html').ok).toBe(true)
  })

  it('<?xml-stylesheet?>・<!DOCTYPE>・注が頭にある RSS・RDF も配信と見る。text/xml の頭に channel・item・entry があれば配信', () => {
    const pi =
      '<?xml version="1.0" encoding="UTF-8"?>\n<?xml-stylesheet type="text/xsl" href="/fake.xsl"?>\n<rss version="2.0"><channel>'
    expect(isFeedResponse('text/xml', pi)).toBe(true)
    expect(isFeedResponse(null, pi)).toBe(true)
    const rdf = '<?xml version="1.0"?>\n<!DOCTYPE rdf:RDF>\n<!-- fake -->\n<rdf:RDF xmlns:rdf="x">'
    expect(isFeedResponse('text/xml', rdf)).toBe(true)
    expect(isFeedResponse('application/xml', '<?xml version="1.0"?><fake-root><channel><title>x</title>')).toBe(true)
    // HTML はこれまでどおり配信ではない
    expect(isFeedResponse('text/html', '<!DOCTYPE html><html><body><p>item</p></body></html>')).toBe(false)
    expect(isFeedResponse('text/html', '<!DOCTYPE html><html><body><item>x</item></body></html>')).toBe(false)
  })
})
