// RSS（2.0・1.0 の RDF）と Atom の読み（段階3の設計の 1.7 の (3)。純粋な部品）: item・entry を小さな読み取り（正規表現）で拾い、
// 題・リンク・日時（pubDate・dc:date・updated・published）・カテゴリー（category・dc:subject）・著者（dc:creator・author/name）・
// 全文（content:encoded・Atom の content）・要約（description・summary）を取る。相対のリンクは一覧の URL から直す（urlPolicy.ts の itemUrl）。
// 中身の文は資料なので、ここでは文字にするだけ（HTML の全文は htmlTokens.ts で文字にする）
import { decodeEntities } from './htmlTokens'

/** 一覧の項目の1つ */
export interface FeedItem {
  title: string
  /** リンク（元のまま。相対もある） */
  link: string
  /** 日時の文字（元のまま。publishedAtOf で直す） */
  date: string | null
  categories: string[]
  author: string | null
  /** 全文の HTML（content:encoded・Atom の content。無ければ null） */
  contentHtml: string | null
  /** 要約（description・summary。文字参照を直した物） */
  summary: string | null
  /** Atom の id・RSS の guid */
  id: string | null
}

export interface ParsedFeed {
  kind: 'rss' | 'rdf' | 'atom' | null
  items: FeedItem[]
}

/** 読む項目の上限（大きな一覧で CPU を使いすぎないように） */
const MAX_ITEMS = 2_000

/** タグを落とす */
const stripTags = (s: string) => s.replace(/<[^>]*>/g, '')

/** 文字にする（CDATA の中は文字のまま、外は文字参照を直す。どちらもタグは落とす） */
export function textOf(raw: string | undefined): string {
  if (raw === undefined) return ''
  const parts: string[] = []
  let last = 0
  for (const m of raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)) {
    parts.push(decodeEntities(stripTags(raw.slice(last, m.index))))
    parts.push(stripTags(m[1]))
    last = (m.index ?? 0) + m[0].length
  }
  parts.push(decodeEntities(stripTags(raw.slice(last))))
  return parts.join('').trim()
}

/** 要素の中身（最初の物。名前は名前空間の頭を含めてそのまま） */
function inner(block: string, name: string): string | undefined {
  const re = new RegExp(`<${escapeName(name)}(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</${escapeName(name)}\\s*>`, 'i')
  return re.exec(block)?.[1]
}

/** 要素の中身（全部） */
function inners(block: string, name: string): string[] {
  const re = new RegExp(`<${escapeName(name)}(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</${escapeName(name)}\\s*>`, 'gi')
  return [...block.matchAll(re)].map((m) => m[1])
}

const escapeName = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 属性の値（最初の要素の） */
function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${escapeName(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return m ? decodeEntities(m[1] ?? m[2] ?? '') : null
}

/** CDATA を外し、文字参照を直した HTML（全文。タグは残す） */
function htmlOf(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw)
  // CDATA の中は HTML のまま。外なら文字参照で書かれた HTML（&lt;p&gt;）を直す
  return m ? m[1] : decodeEntities(raw)
}

/** RSS・RDF・Atom を読む（どれでもなければ kind が null で項目なし） */
export function parseFeed(xml: string): ParsedFeed {
  const head = xml.slice(0, 4_000)
  const atom = /<feed[\s>]/i.test(head) && !/<rss[\s>]/i.test(head)
  const rdf = /<rdf:RDF[\s>]/i.test(head)
  const rss = /<rss[\s>]/i.test(head)
  if (!atom && !rdf && !rss) return { kind: null, items: [] }
  const tag = atom ? 'entry' : 'item'
  const items: FeedItem[] = []
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, 'gi')
  for (const m of xml.matchAll(re)) {
    if (items.length >= MAX_ITEMS) break
    const open = m[1] ?? ''
    const block = m[2]
    let link = ''
    if (atom) {
      const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((x) => x[1])
      const alt = links.find((l) => (attrOf(l, 'rel') ?? 'alternate') === 'alternate') ?? links[0]
      link = alt ? (attrOf(alt, 'href') ?? '') : ''
    } else {
      link = textOf(inner(block, 'link'))
      if (!link && rdf) link = attrOf(open, 'rdf:about') ?? ''
      if (!link) {
        const guid = inner(block, 'guid')
        if (guid && !/isPermaLink\s*=\s*["']false/i.test(block)) link = textOf(guid)
      }
    }
    const date =
      textOf(inner(block, 'pubDate')) ||
      textOf(inner(block, 'dc:date')) ||
      textOf(inner(block, 'published')) ||
      textOf(inner(block, 'updated')) ||
      null
    const categories = [
      ...inners(block, 'category').map(textOf),
      ...inners(block, 'dc:subject').map(textOf),
      ...[...block.matchAll(/<category\b([^>]*)\/>/gi)].map((x) => attrOf(x[1], 'term') ?? ''),
    ].filter(Boolean)
    const author = textOf(inner(block, 'dc:creator')) || textOf(inner(inner(block, 'author') ?? '', 'name')) || null
    const contentHtml = atom ? htmlOf(inner(block, 'content')) : htmlOf(inner(block, 'content:encoded'))
    const summary = textOf(inner(block, 'description')) || textOf(inner(block, 'summary')) || null
    const id = textOf(inner(block, atom ? 'id' : 'guid')) || null
    items.push({
      title: textOf(inner(block, 'title')).replace(/\s+/g, ' '),
      link: link.trim(),
      date,
      categories,
      author,
      contentHtml,
      summary,
      id,
    })
  }
  return { kind: atom ? 'atom' : rdf ? 'rdf' : 'rss', items }
}
