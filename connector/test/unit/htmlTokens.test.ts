// HTML の読みの純粋な部品（段階3の設計の 1.7 の (3)・(6)。点検2 feasible-F6・F11）。作り物の並び（test/support/fakeNews.ts の小さな
// 読み取り）を渡して確かめる。HTMLRewriter が同じ並びを作るかは workerd のテスト（test/worker/htmlRewriter.test.ts）
import { describe, expect, it } from 'vitest'
import {
  cleanLines,
  decodeEntities,
  findDate,
  normalizeEvents,
  readAnchor,
  readBody,
  readList,
  selectorMatches,
  yearHeadingOf,
  type HtmlEvent,
} from '../../src/fetch/htmlTokens'
import { PRESS_QUESTION_MARKS } from '../../src/fetch/sources'
import {
  FAKE_ANCHOR_PAGE,
  FAKE_SHORT_PAGE,
  fakePressPage,
  LIST_HEADINGS,
  LIST_LI_AFTER,
  LIST_TABLE,
  LIST_YEARLESS,
} from '../fixtures/fakePages'
import { eventsOf, simpleHtmlEvents } from '../support/fakeNews'

const BASE = 'https://example.com/fake-ministry/press/index.html'

describe('並びをそろえる', () => {
  it('閉じ忘れの li・p を補い、終わりの無い要素に終わりを足し、文字参照を直す', () => {
    const ev = normalizeEvents(simpleHtmlEvents('<ul><li>あ<li>い</ul><p>う<br>え&amp;お<p>か'))
    expect(ev).toEqual<HtmlEvent[]>([
      { t: 'open', name: 'ul', attrs: {} },
      { t: 'open', name: 'li', attrs: {} },
      { t: 'text', text: 'あ' },
      { t: 'close', name: 'li' },
      { t: 'open', name: 'li', attrs: {} },
      { t: 'text', text: 'い' },
      { t: 'close', name: 'li' },
      { t: 'close', name: 'ul' },
      { t: 'open', name: 'p', attrs: {} },
      { t: 'text', text: 'う' },
      { t: 'open', name: 'br', attrs: {} },
      { t: 'close', name: 'br' },
      { t: 'text', text: 'え&お' },
      { t: 'close', name: 'p' },
      { t: 'open', name: 'p', attrs: {} },
      { t: 'text', text: 'か' },
      { t: 'close', name: 'p' },
    ])
  })

  it('文字参照（数・16進・名前）と、続いた文字のつなぎ', () => {
    expect(decodeEntities('&#12354;&#x3044;&lt;&nbsp;&unknown;')).toBe('あい< &unknown;')
    const ev = normalizeEvents([
      { t: 'text', text: '&am' },
      { t: 'text', text: 'p;x' },
    ])
    expect(ev).toEqual([{ t: 'text', text: '&x' }])
  })

  it('選び方（tag・#id・.class）', () => {
    expect(selectorMatches('main', 'main', {})).toBe(true)
    expect(selectorMatches('#contents', 'div', { id: 'contents' })).toBe(true)
    expect(selectorMatches('.list', 'div', { class: 'a list b' })).toBe(true)
    expect(selectorMatches('div#x', 'section', { id: 'x' })).toBe(false)
  })
})

describe('日付', () => {
  it('和暦・西暦・スラッシュ・点・年の無い日付', () => {
    const ctx = { year: null, today: '2026-11-19' }
    expect(findDate('令和8年11月19日', ctx)).toEqual({ ymd: '2026-11-19', yearless: false })
    expect(findDate('（2026年11月19日）', ctx)).toEqual({ ymd: '2026-11-19', yearless: false })
    expect(findDate('2026/11/18 更新', ctx)).toEqual({ ymd: '2026-11-18', yearless: false })
    expect(findDate('2026.11.17', ctx)).toEqual({ ymd: '2026-11-17', yearless: false })
    expect(findDate('11月17日', ctx)).toEqual({ ymd: '2026-11-17', yearless: true })
    expect(findDate('作り物の題', ctx)).toBeNull()
  })

  it('年の無い日付: 前に出た見出しの年か、無ければ今日から（12月の項目を1月に読んだ時は前の年）', () => {
    expect(findDate('12月28日', { year: null, today: '2027-01-06' })!.ymd).toBe('2026-12-28')
    expect(findDate('1月5日', { year: null, today: '2027-01-06' })!.ymd).toBe('2027-01-05')
    expect(findDate('12月28日', { year: 2025, today: '2027-01-06' })!.ymd).toBe('2025-12-28')
    expect(yearHeadingOf('2026年')).toBe(2026)
    expect(yearHeadingOf('令和8年')).toBe(2026)
    expect(yearHeadingOf('2026年11月')).toBeNull()
  })
})

describe('一覧（readList）', () => {
  it('日付の見出しの下にリンクが並ぶ形: 前にいちばん近く出た日付。href は絶対の URL に', () => {
    const { links } = readList(eventsOf(LIST_HEADINGS), { base: BASE, today: '2026-11-19' })
    const press = links.filter((l) => /\/press\/\d/.test(l.url))
    expect(press.map((l) => [l.url, l.date, l.dateFrom])).toEqual([
      ['https://example.com/fake-ministry/press/1001.html', '2026-11-19', 'prev'],
      ['https://example.com/fake-ministry/press/1002.html', '2026-11-19', 'prev'],
      ['https://example.com/fake-ministry/press/1003.pdf', '2026-11-19', 'prev'],
      ['https://other.example.org/fake/press/1004.html', '2026-11-18', 'prev'],
      ['https://example.com/fake-ministry/press/1005.html', '2026-11-18', 'prev'],
    ])
    expect(press[1].text).toBe('「作り物推進計画」の公表について')
  })

  it('表の中にリンクと日付がある形: 同じ行の日付を先に使う（和暦・スラッシュ）', () => {
    const { links } = readList(eventsOf(LIST_TABLE), { base: BASE, today: '2026-11-19' })
    expect(links.map((l) => [l.url.split('/').pop(), l.date, l.dateFrom])).toEqual([
      ['2001.html', '2026-11-19', 'row'],
      ['2002.html', '2026-11-18', 'row'],
      // 日付の無い行の項目は、前に出た日付（前の行）になる
      ['2003.html', '2026-11-18', 'prev'],
    ])
  })

  it('li の中で日付が題の後ろにある形（同じ行の日付）と、相対の href', () => {
    const { links } = readList(eventsOf(LIST_LI_AFTER), { base: BASE, today: '2026-11-19' })
    const main = links.slice(1)
    expect(main.map((l) => [l.url, l.date, l.dateFrom, l.yearless])).toEqual([
      ['https://example.com/fake-ministry/press/3001.html', '2026-11-19', 'row', false],
      ['https://example.com/fake-ministry/press/3002.html', '2026-11-17', 'row', true],
    ])
  })

  it('年の無い日付の一覧を1月に読む: 12月の項目は前の年', () => {
    const { links } = readList(eventsOf(LIST_YEARLESS), { base: BASE, today: '2027-01-06' })
    expect(links.map((l) => l.date)).toEqual(['2026-12-28', '2027-01-05'])
  })

  it('scope の要素の中だけを読む', () => {
    const r = readList(eventsOf(LIST_HEADINGS), { base: BASE, scope: 'main', today: '2026-11-19' })
    expect(r.scopeFound).toBe(true)
    expect(r.links.some((l) => l.url.endsWith('/fake-ministry/index.html'))).toBe(false)
    expect(readList(eventsOf(LIST_HEADINGS), { base: BASE, scope: '#none', today: '2026-11-19' }).links).toEqual([])
  })
})

describe('本文（readBody）', () => {
  it('scopes の順に試し、script・style・header・nav・footer を除き、案内の行と記者の質問の段を落とす', () => {
    const b = readBody(eventsOf(fakePressPage({ qa: true })), {
      scopes: ['#none', 'main'],
      dropLines: ['このページの先頭へ', '印刷'],
      dropBlocks: ['（記者）', '【記者】'],
      countMarks: PRESS_QUESTION_MARKS,
    })
    expect(b.scope).toBe('main')
    expect(b.title).toBe('作り物の制度の見直しについて')
    expect(b.date).toBe('2026-11-19')
    expect(b.lines[0]).toBe('作り物の制度の見直しについて')
    const text = b.lines.join('\n')
    expect(text).not.toContain('スクリプト')
    expect(text).not.toContain('サイトの頭')
    expect(text).not.toContain('このページの先頭へ')
    expect(text).not.toContain('作り物の質問の文')
    expect(text).not.toContain('もう1つの作り物の質問')
    expect(text).toContain('（長官）作り物の答えの文です。')
    expect(b.chars).toBeGreaterThan(200)
    const i = PRESS_QUESTION_MARKS.indexOf('（記者）')
    expect(b.marks[i]).toEqual({ lines: 1, dropped: 1 })
  })

  it('200字に届く scope が無ければ、いちばん長い scope。どれも無ければページ全体', () => {
    const b = readBody(eventsOf(FAKE_SHORT_PAGE), { scopes: ['article', 'main'] })
    expect(b.scope).toBe('main')
    expect(b.chars).toBeLessThan(200)
    expect(readBody(eventsOf(FAKE_SHORT_PAGE), { scopes: ['article'] }).scope).toBeNull()
  })

  it('記者の質問が2段以上に分かれていても、次の話し手の印の行の前まで落とす（話し手の印が来なければ終わりまで）', () => {
    const r = cleanLines(
      [
        '作り物の発表の文です。',
        '（記者）作り物の質問の1段目です。',
        '作り物の質問の2段目（記者の言葉の続き）です。',
        '（長官）作り物の答えの文です。',
        '答えの続きの段です。',
        '【記者】もう1つの作り物の質問です。',
        '作り物の質問の続きです。',
        '【長官】作り物の2つ目の答えです。',
        'Q.作り物のよくある質問です。',
        '作り物の質問の続きの段です。',
        'A.作り物の答えです。',
        '問：最後の作り物の質問です。',
        '話し手の印が来ない続きの段です。',
      ],
      { dropBlocks: ['（記者）', '【記者】', 'Q.', '問：'], countMarks: ['（記者）'] },
    )
    expect(r.lines).toEqual([
      '作り物の発表の文です。',
      '（長官）作り物の答えの文です。',
      '答えの続きの段です。',
      '【長官】作り物の2つ目の答えです。',
      'A.作り物の答えです。',
    ])
    // 印ごとの数は、その印で始まる行だけ
    expect(r.marks).toEqual([{ lines: 1, dropped: 1 }])
  })

  it('同じ行の重なりを落とす', () => {
    expect(cleanLines(['あ', ' あ ', 'い', '', 'あ'], {}).lines).toEqual(['あ', 'い'])
  })

  it('meta の name と content を返す（noai の確かめに使う）', () => {
    const b = readBody(eventsOf(fakePressPage({ meta: '<meta name="robots" content="noai">' })), { scopes: ['main'] })
    expect(b.metas).toEqual(expect.arrayContaining([{ name: 'robots', content: 'noai' }]))
  })
})

describe('#番号 の項目（readAnchor）', () => {
  it('その id の要素から次の同じ形の項目の前まで。見つからなければ null', () => {
    const ev = eventsOf(FAKE_ANCHOR_PAGE)
    const a = readAnchor(ev, 'n101')!
    expect(a.title).toBe('作り物の火災の情報（第1報）')
    expect(a.chars).toBeGreaterThan(200)
    expect(a.lines.join('')).not.toContain('訓練')
    const b = readAnchor(ev, 'n102')!
    expect(b.lines).toEqual(['作り物の訓練のお知らせ', '資料（PDF）'])
    expect(readAnchor(ev, 'n999')).toBeNull()
  })

  it('空の a name の形（その親の親が閉じるまで・次の a name の前まで）', () => {
    const ev = eventsOf(
      `<div><p><a name="x1"></a>作り物の一つ目</p><p>作り物の続き</p><p><a name="x2"></a>作り物の二つ目</p></div><div>外</div>`,
    )
    expect(readAnchor(ev, 'x1')!.lines).toEqual(['作り物の一つ目', '作り物の続き'])
    expect(readAnchor(ev, 'x2')!.lines).toEqual(['作り物の二つ目'])
  })
})
