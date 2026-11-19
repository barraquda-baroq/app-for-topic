// HTML の一覧の読み（段階3の設計の 1.7 の (3)・(4)。点検2 feasible-F11・F12）: ページの（data に scope があればその要素の中の）全部の
// a[href] とその文字と日付を htmlTokens.ts の readList で拾い、href を一覧の URL を元に絶対の URL に直してから、data の itemPath
// （その出どころの発表のページの道の形）に合う物だけを項目にする。社ごとの選び方は、この道の形だけ（CSS の選び方は持たない）。
// - 同じ一覧の中の同じ URL は1つにする（同じ行に日付があった方を残す）。ページの案内のリンク（itemPath に合わない物）は拾わない
// - 一覧のページが 200 なのに itemPath に合う項目が0件の時は、道の形の数（数字を N にした道の形と件数。題・リンクの文字は出さない）を返す
//   （開発が data の itemPath を直すため。probe の表に出す）
import type { ListConfig, SourceConfig } from './sources'
import { dedupeLinks, readList, type HtmlEvent } from './htmlTokens'
import { pathShape } from './urlPolicy'

/** HTML の一覧の項目 */
export interface HtmlListItem {
  url: string
  title: string
  /** 'YYYY-MM-DD'（無ければ null） */
  date: string | null
  dateFrom: 'row' | 'prev' | null
  yearless: boolean
}

/** HTML の一覧を読んだ結果（数は probe と「一覧の作りが変わったかもしれない」の印に使う） */
export interface HtmlListResult {
  items: HtmlListItem[]
  /** ページの中のリンクの数（同じ一覧のホストの物） */
  links: number
  /** itemPath に合ったリンクの数（同じ URL を1つにした後） */
  matched: number
  /** 日付が読めた数（同じ行・前の見出し・年なし） */
  dated: { row: number; prev: number; yearless: number }
  /** itemPath に合う物が0件の時の、道の形の数（多い順に5つ） */
  shapes: { shape: string; n: number }[]
  /** scope の要素があったか */
  scopeFound: boolean
}

/** HTML の一覧を読む（並びは normalizeEvents の後の物） */
export function readHtmlList(
  events: readonly HtmlEvent[],
  src: SourceConfig,
  list: Extract<ListConfig, { kind: 'html' }>,
  today: string,
): HtmlListResult {
  const { links, scopeFound } = readList(events, { base: list.url, scope: list.scope, today })
  let re: RegExp
  try {
    re = new RegExp(list.itemPath)
  } catch {
    re = /$^/
  }
  const listHost = new URL(list.url).hostname.toLowerCase()
  const items: (HtmlListItem & { title: string })[] = []
  const shapes = new Map<string, number>()
  let sameHost = 0
  for (const l of links) {
    let u: URL
    try {
      u = new URL(l.url)
    } catch {
      continue
    }
    const host = u.hostname.toLowerCase()
    // 道の形は、出どころのホストのリンクだけで比べる（ほかのホストを指す項目は、後で「ほかのホスト」として数える）
    if (host === listHost || src.hosts.body.includes(host)) sameHost += 1
    if (re.test(u.pathname)) {
      items.push({ url: u.href, title: l.text, date: l.date, dateFrom: l.dateFrom, yearless: l.yearless })
      continue
    }
    if (host === listHost) {
      const s = pathShape(u.pathname)
      shapes.set(s, (shapes.get(s) ?? 0) + 1)
    }
  }
  const unique = dedupeLinks(items)
  const dated = { row: 0, prev: 0, yearless: 0 }
  for (const it of unique) {
    if (it.dateFrom === 'row') dated.row += 1
    if (it.dateFrom === 'prev') dated.prev += 1
    if (it.date && it.yearless) dated.yearless += 1
  }
  return {
    items: unique,
    links: sameHost,
    matched: unique.length,
    dated,
    shapes: unique.length
      ? []
      : [...shapes.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([shape, n]) => ({ shape, n })),
    scopeFound,
  }
}
