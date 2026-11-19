// HTMLRewriter から作る並びが、純粋な部品（htmlTokens.ts）に渡して Node の小さな読み取りと同じ答えになるか（段階3の設計の 1.7 の (3)。
// 点検2 feasible-F6）。府省の形に似せた作り物の一覧: 日付の見出しの下にリンクが並ぶ形・表の中にリンクと日付がある形・li の中で日付が題の
// 後ろにある形・横の新着の欄がある形。本文・#番号 の項目・文字参照も
import { describe, expect, it } from 'vitest'
import { rewriterEvents } from '../../src/fetch/htmlRewriter'
import { normalizeEvents, readAnchor, readBody, readList } from '../../src/fetch/htmlTokens'
import { readHtmlList } from '../../src/fetch/htmlList'
import type { ListConfig } from '../../src/fetch/sources'
import { PRESS_QUESTION_MARKS } from '../../src/fetch/sources'
import {
  FAKE_ANCHOR_PAGE,
  fakePressPage,
  fakeTermsPage,
  LIST_CHANGED,
  LIST_HEADINGS,
  LIST_LI_AFTER,
  LIST_TABLE,
  LIST_YEARLESS,
} from '../fixtures/fakePages'
import { eventsOf, FAKE_SOURCES } from '../support/fakeNews'

const BASE = 'https://example.com/fake-ministry/press/index.html'
const rw = async (html: string) => normalizeEvents(await rewriterEvents(html))

describe('HTMLRewriter の並び', () => {
  it('作り物の一覧・本文の並びが、Node の小さな読み取りと同じ（始まり・終わり・文字・属性）', async () => {
    for (const html of [LIST_HEADINGS, LIST_TABLE, LIST_LI_AFTER, LIST_YEARLESS, LIST_CHANGED, FAKE_ANCHOR_PAGE, fakeTermsPage()])
      expect(await rw(html)).toEqual(eventsOf(html))
  })

  it('文字参照は並びをそろえる所で直す（HTMLRewriter の文字は元のまま）', async () => {
    const ev = await rw('<p title="a&amp;b">x &amp; y &#12354;</p>')
    expect(ev).toEqual([
      { t: 'open', name: 'p', attrs: { title: 'a&b' } },
      { t: 'text', text: 'x & y あ' },
      { t: 'close', name: 'p' },
    ])
  })

  it('一覧の読み（4つの形）は同じ答え', async () => {
    for (const [html, today] of [
      [LIST_HEADINGS, '2026-11-19'],
      [LIST_TABLE, '2026-11-19'],
      [LIST_LI_AFTER, '2026-11-19'],
      [LIST_YEARLESS, '2027-01-06'],
    ] as const)
      expect(readList(await rw(html), { base: BASE, today })).toEqual(readList(eventsOf(html), { base: BASE, today }))
    const src = FAKE_SOURCES[0]
    const list = src.lists[0] as Extract<ListConfig, { kind: 'html' }>
    const r = readHtmlList(await rw(LIST_LI_AFTER), src, list, '2026-11-19')
    expect(r.items.map((i) => [i.url.split('/').pop(), i.date, i.dateFrom])).toEqual([
      ['3001.html', '2026-11-19', 'row'],
      ['3002.html', '2026-11-17', 'row'],
    ])
  })

  it('本文の抜き出し（scopes・script と header を除く・案内の行・記者の質問の段）は同じ答え', async () => {
    const html = fakePressPage({ qa: true })
    const opts = {
      scopes: ['main'],
      dropLines: ['このページの先頭へ', '印刷'],
      dropBlocks: ['（記者）', '【記者】'],
      countMarks: PRESS_QUESTION_MARKS,
    }
    const a = readBody(await rw(html), opts)
    expect(a).toEqual(readBody(eventsOf(html), opts))
    expect(a.lines.join('\n')).not.toContain('作り物の質問の文')
    expect(a.lines.join('\n')).not.toContain('スクリプト')
    expect(a.chars).toBeGreaterThan(200)
  })

  it('#番号 の項目は同じ答え', async () => {
    expect(readAnchor(await rw(FAKE_ANCHOR_PAGE), 'n101')).toEqual(readAnchor(eventsOf(FAKE_ANCHOR_PAGE), 'n101'))
  })
})
