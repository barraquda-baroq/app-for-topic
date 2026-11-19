// HTML の一覧（段階3の設計の 1.7 の (3)・(4)）: itemPath に合うリンクだけを項目にする・相対の href を直してから比べる・横の新着の欄の
// 同じリンクは同じ行に日付のある方・ページの案内のリンクを拾わない・合う物が0件の時は道の形の数（題・リンクの文字は出さない）
import { describe, expect, it } from 'vitest'
import { readHtmlList } from '../../src/fetch/htmlList'
import type { ListConfig, SourceConfig } from '../../src/fetch/sources'
import { LIST_CHANGED, LIST_HEADINGS, LIST_LI_AFTER } from '../fixtures/fakePages'
import { eventsOf, FAKE_SOURCES } from '../support/fakeNews'

const src: SourceConfig = FAKE_SOURCES.find((s) => s.id === 'fake-html')!
const list = src.lists[0] as Extract<ListConfig, { kind: 'html' }>

describe('HTML の一覧', () => {
  it('itemPath に合うリンクだけ（ページの案内・規約のリンクを拾わない。ほかのホストの物は後で数える）', () => {
    const r = readHtmlList(eventsOf(LIST_HEADINGS), src, list, '2026-11-19')
    // ほかのホストのリンク（other.example.org）は道の形が違うので項目にならない
    expect(r.items.map((i) => i.url)).toEqual([
      'https://example.com/fake-ministry/press/1001.html',
      'https://example.com/fake-ministry/press/1002.html',
      'https://example.com/fake-ministry/press/1003.pdf',
      'https://example.com/fake-ministry/press/1005.html',
    ])
    expect(r.matched).toBe(4)
    expect(r.dated).toEqual({ row: 0, prev: 4, yearless: 0 })
    expect(r.shapes).toEqual([])
  })

  it('相対の href（./3002.html）を直してから itemPath と比べる。横の新着の欄の同じリンクは、同じ行に日付のある方を残す', () => {
    const r = readHtmlList(eventsOf(LIST_LI_AFTER), src, list, '2026-11-19')
    expect(r.items.map((i) => [i.url.split('/').pop(), i.date, i.dateFrom])).toEqual([
      ['3001.html', '2026-11-19', 'row'],
      ['3002.html', '2026-11-17', 'row'],
    ])
    expect(r.dated.yearless).toBe(1)
  })

  it('一覧の作りが変わった時: 合う物が0件で、道の形の数（数字を N にした形と件数だけ）を返す', () => {
    const r = readHtmlList(eventsOf(LIST_CHANGED), src, list, '2026-11-19')
    expect(r.matched).toBe(0)
    expect(r.links).toBe(3)
    expect(r.shapes).toEqual([{ shape: '/fake-ministry/news/item_N.html', n: 3 }])
    expect(JSON.stringify(r.shapes)).not.toContain('作り物')
  })
})
