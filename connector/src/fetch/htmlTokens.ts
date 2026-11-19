// HTML の読みの純粋な部品（段階3の設計の 1.7 の (3)・(6)。点検2 feasible-F6）: 「要素の始まり・終わり・文字の並び → 項目・本文」を作る。
// HTMLRewriter は Workers にしか無いので、HTMLRewriter から並びを渡すだけの薄い部品（htmlRewriter.ts）と分け、行の区切り・日付・itemPath・
// dropBlocks・scopes の決まりは全部ここに置く（Node の単体テストは作り物の並びを渡して確かめ、HTMLRewriter そのものは workerd のテストで）。
// - 並びは、要素の始まり（名前と属性）・終わり・文字。文字と属性の値は元のまま（&amp; などは normalizeEvents が直す）
// - 閉じ忘れ（li・p・dt・dd・tr・td など）は normalizeEvents が補う。読む部品は、始まりと終わりがそろった並びだけを見る
// - 一覧（readList）: 全部の a[href] とその文字を、出てきた順に、どの行（li・tr・dd/dt の組・p）の中かと一緒に拾い、日付は同じ行の中の日付を
//   先に、無ければその前にいちばん近く出た日付。年の無い日付は、前に出た見出しの年か、無ければ今の日付から（12月の項目を1月に読んだ時は前の年）
// - 本文（readBody）: scopes の要素を順に試し、文字が200字以上になった最初の物。script・style・nav・header・footer・aside を除き、
//   見出し・段・項目・表の枡の文を行にする。案内の行（dropLines）・同じ行の重なり・記者の質問の段（dropBlocks）を落とす
// - #番号 の項目（readAnchor）: その id・name の要素から次の同じ形の項目まで（消防庁）
import { jpDateOf } from '../../../src/domain/jst'
import { SOURCE_BODY_MIN_CHARS } from '../../../src/domain/limits'

/** HTML の並びの1つ */
export type HtmlEvent =
  | { t: 'open'; name: string; attrs: Readonly<Record<string, string>> }
  | { t: 'close'; name: string }
  | { t: 'text'; text: string }

/** 終わりの無い要素 */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** p を閉じる要素（HTML の決まり） */
const CLOSES_P = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
])

/** 閉じ忘れを補う: 開く要素 → 閉じる前の要素（その手前で止まる要素） */
const IMPLIED: Readonly<Record<string, { close: readonly string[]; stop: readonly string[] }>> = {
  li: { close: ['li'], stop: ['ul', 'ol', 'menu'] },
  dt: { close: ['dt', 'dd'], stop: ['dl'] },
  dd: { close: ['dt', 'dd'], stop: ['dl'] },
  tr: { close: ['tr', 'td', 'th'], stop: ['table', 'tbody', 'thead', 'tfoot'] },
  td: { close: ['td', 'th'], stop: ['tr', 'table'] },
  th: { close: ['td', 'th'], stop: ['tr', 'table'] },
  tbody: { close: ['tbody', 'thead', 'tr', 'td', 'th'], stop: ['table'] },
  thead: { close: ['tbody', 'thead', 'tr', 'td', 'th'], stop: ['table'] },
  tfoot: { close: ['tbody', 'thead', 'tr', 'td', 'th'], stop: ['table'] },
  option: { close: ['option'], stop: ['select', 'datalist'] },
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  bull: '•',
  times: '×',
  yen: '¥',
  shy: '',
  zwj: '',
  zwnj: '',
}

/** HTML・XML の文字参照を直す（&amp;・&#12354;・&#x3042;・よく使う名前） */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,10});/gi, (m, body: string) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return m
      return String.fromCodePoint(n)
    }
    const v = NAMED_ENTITIES[body.toLowerCase()]
    return v === undefined ? m : v
  })
}

/**
 * 並びをそろえる: 名前を小文字に・続いた文字をつなぐ・文字参照を直す・終わりの無い要素に終わりを足す・閉じ忘れを補う・
 * 開いていない終わりを落とす・最後に開いたままの要素を閉じる
 */
export function normalizeEvents(events: Iterable<HtmlEvent>): HtmlEvent[] {
  const out: HtmlEvent[] = []
  const stack: string[] = []
  let text = ''
  const flush = () => {
    if (text) out.push({ t: 'text', text: decodeEntities(text) })
    text = ''
  }
  const popTo = (i: number) => {
    while (stack.length > i) out.push({ t: 'close', name: stack.pop()! })
  }
  for (const e of events) {
    if (e.t === 'text') {
      text += e.text
      continue
    }
    flush()
    const name = e.name.toLowerCase()
    if (e.t === 'open') {
      const rule = IMPLIED[name]
      if (rule)
        for (let i = stack.length - 1; i >= 0; i--) {
          if (rule.stop.includes(stack[i])) break
          if (rule.close.includes(stack[i])) {
            popTo(i)
            break
          }
        }
      if (CLOSES_P.has(name)) {
        const p = stack.lastIndexOf('p')
        // p の中の p 以外の要素（span など）は閉じてから p を閉じる。ただし表・項目の中の p は越えない
        if (p >= 0 && !stack.slice(p + 1).some((x) => ['td', 'th', 'li', 'dd', 'dt', 'div', 'blockquote'].includes(x))) popTo(p)
      }
      const attrs: Record<string, string> = {}
      for (const [k, v] of Object.entries(e.attrs)) attrs[k.toLowerCase()] = decodeEntities(v)
      out.push({ t: 'open', name, attrs })
      if (VOID.has(name)) out.push({ t: 'close', name })
      else stack.push(name)
    } else {
      if (VOID.has(name)) continue
      const i = stack.lastIndexOf(name)
      if (i >= 0) popTo(i)
    }
  }
  flush()
  popTo(0)
  return out
}

// ---------- 選び方（scope・scopes） ----------

/** 簡単な選び方（tag・#id・.class・tag#id・tag.class）がその要素に当たるか */
export function selectorMatches(sel: string, name: string, attrs: Readonly<Record<string, string>>): boolean {
  const m = /^([a-z0-9-]*)(?:#([A-Za-z0-9_:.-]+))?(?:\.([A-Za-z0-9_-]+))?$/.exec(sel.trim())
  if (!m) return false
  const [, tag, id, cls] = m
  if (tag && tag !== name) return false
  if (id && attrs.id !== id) return false
  if (cls && !(attrs.class ?? '').split(/\s+/).includes(cls)) return false
  return Boolean(tag || id || cls)
}

/** 空白をそろえる（改行・タブ・全角の空白も1つの空白に） */
export const squash = (s: string): string => s.replace(/[\s　 ]+/g, ' ').trim()

// ---------- 日付 ----------

/** 日付の読み（ymd = 'YYYY-MM-DD'。年の無い日付は、yearless = true） */
export interface FoundDate {
  ymd: string
  yearless: boolean
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 本当にある日付か */
function validYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const t = new Date(Date.UTC(y, m - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`
}

/** 年だけの見出し（「2026年」「令和8年」）の年（無ければ null） */
export function yearHeadingOf(text: string): number | null {
  const t = squash(text.normalize('NFKC'))
  const ad = /^(\d{4})\s*年(?:度)?$/.exec(t)
  if (ad) return Number(ad[1])
  const era = /^(令和|平成)\s*(元|\d{1,2})\s*年(?:度)?$/.exec(t)
  if (era) return (era[1] === '令和' ? 2018 : 1988) + (era[2] === '元' ? 1 : Number(era[2]))
  return null
}

/**
 * 文の中のいちばん前の日付（年のある物は jpDateOf と YYYY.MM.DD・YYYY-MM-DD。年の無い「11月19日」は year か今日から決める:
 * 今日より2日以上先になる時は前の年）
 */
export function findDate(text: string, ctx: { year: number | null; today: string }): FoundDate | null {
  const t = text.normalize('NFKC')
  const full = jpDateOf(t)
  const dotted = /(?<!\d)(\d{4})[.-](\d{1,2})[.-](\d{1,2})(?!\d)/.exec(t)
  const yl = /(?<![\d/年.])(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(t)
  // いちばん前の物を使う
  const candidates: { at: number; ymd: string; yearless: boolean }[] = []
  if (full) {
    const at = firstIndexOfDate(t)
    candidates.push({ at, ymd: full, yearless: false })
  }
  if (dotted) {
    const v = validYmd(Number(dotted[1]), Number(dotted[2]), Number(dotted[3]))
    if (v) candidates.push({ at: dotted.index, ymd: v, yearless: false })
  }
  if (yl) {
    const m = Number(yl[1])
    const d = Number(yl[2])
    let y = ctx.year ?? Number(ctx.today.slice(0, 4))
    let v = validYmd(y, m, d)
    if (v && ctx.year === null) {
      // 今日から決める時: 今日より2日以上先なら前の年（12月の項目を1月に読んだ時）
      const limit = Date.parse(`${ctx.today}T00:00:00Z`) + 2 * 86_400_000
      if (Date.parse(`${v}T00:00:00Z`) >= limit) {
        y -= 1
        v = validYmd(y, m, d)
      }
    }
    if (v) candidates.push({ at: yl.index, ymd: v, yearless: true })
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => a.at - b.at)
  return { ymd: candidates[0].ymd, yearless: candidates[0].yearless }
}

/** jpDateOf が読んだ日付の位置（だいたい。年の数字の頭） */
function firstIndexOfDate(t: string): number {
  const m = /(令和|平成|昭和)\s*(元|\d{1,2})\s*年|(\d{4})\s*年\s*\d{1,2}\s*月|(?<!\d)\d{4}\/\d{1,2}\/\d{1,2}/.exec(t)
  return m ? m.index : 0
}

// ---------- 一覧 ----------

/** 行の要素 */
const ROW_TAGS = new Set(['li', 'tr', 'dt', 'dd', 'p'])

/** 一覧のリンクの1つ */
export interface ListLink {
  /** href（一覧の URL を元に絶対の URL にした物。直せない物は元のまま） */
  url: string
  /** リンクの文字（空白を詰めた物） */
  text: string
  /** 日付（'YYYY-MM-DD'。無ければ null） */
  date: string | null
  /** 日付の元（row = 同じ行・prev = 前に出た日付・null = 無い） */
  dateFrom: 'row' | 'prev' | null
  /** 年の無い日付から決めた */
  yearless: boolean
}

/** 一覧を読む（scope があればその要素の中だけ。scopeFound = scope の要素があったか） */
export function readList(
  events: readonly HtmlEvent[],
  opts: { base: string; scope?: string; today: string },
): { links: ListLink[]; scopeFound: boolean } {
  const links: (ListLink & { rows: number[]; prev: FoundDate | null; own: FoundDate | null })[] = []
  const rowDate = new Map<number, FoundDate>()
  const stack: { name: string; row: number | null; scope: boolean }[] = []
  let rowSeq = 0
  let year: number | null = null
  let last: FoundDate | null = null
  let lastRowClosed: { name: string; id: number } | null = null
  let inScope = opts.scope ? 0 : 1
  let scopeFound = !opts.scope
  let link: { href: string; text: string; rows: number[]; prev: FoundDate | null } | null = null
  /** 今の行（内側から外側へ。li の中の p のように行が重なる時は、外の行にも日付を付ける） */
  const currentRows = () => {
    const out: number[] = []
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].row !== null) out.push(stack[i].row!)
    return out
  }
  let pendingText = ''
  const flushText = () => {
    const raw = pendingText
    pendingText = ''
    if (!raw || inScope <= 0) return
    const y = yearHeadingOf(raw)
    if (y !== null) {
      year = y
      return
    }
    const found = findDate(raw, { year, today: opts.today })
    if (found) {
      if (!found.yearless) year = Number(found.ymd.slice(0, 4))
      for (const row of currentRows()) if (!rowDate.has(row)) rowDate.set(row, found)
      last = found
    }
  }
  for (const e of events) {
    if (e.t === 'text') {
      if (inScope > 0 && link) link.text += e.text
      pendingText += e.text
      continue
    }
    if (e.t === 'open') {
      const scopeHit = opts.scope ? selectorMatches(opts.scope, e.name, e.attrs) : false
      // 文字は要素の切れ目で区切って日付を探す（行の中の文字は行の日付になる）
      flushText()
      if (scopeHit) {
        inScope += 1
        scopeFound = true
      }
      let row: number | null = null
      if (ROW_TAGS.has(e.name)) {
        // dt の後の dd は同じ行（dt/dd の組）
        if (e.name === 'dd' && lastRowClosed?.name === 'dt') row = lastRowClosed.id
        else row = ++rowSeq
        lastRowClosed = null
      }
      stack.push({ name: e.name, row, scope: scopeHit })
      if (e.name === 'a' && typeof e.attrs.href === 'string' && inScope > 0) {
        let href = e.attrs.href.trim()
        try {
          href = new URL(href, opts.base).href
        } catch {
          // 直せない href は元のまま（後で捨てる）
        }
        link = { href, text: '', rows: currentRows(), prev: last }
      }
      continue
    }
    // 終わり
    flushText()
    const top = stack.pop()
    if (!top) continue
    if (top.name === 'a' && link) {
      const text = squash(link.text)
      const own = findDate(text, { year, today: opts.today })
      links.push({
        url: link.href,
        text,
        date: null,
        dateFrom: null,
        yearless: false,
        rows: link.rows,
        prev: link.prev,
        own,
      })
      link = null
    }
    if (top.row !== null) lastRowClosed = { name: top.name, id: top.row }
    if (top.scope) inScope -= 1
  }
  flushText()
  for (const l of links) {
    const inRow = l.rows.map((r) => rowDate.get(r)).find((d) => d !== undefined)
    const r = inRow ?? l.own ?? null
    const d = r ?? l.prev
    l.date = d?.ymd ?? null
    l.dateFrom = r ? 'row' : d ? 'prev' : null
    l.yearless = d?.yearless ?? false
  }
  return {
    links: links.map(({ url, text, date, dateFrom, yearless }) => ({ url, text, date, dateFrom, yearless })),
    scopeFound,
  }
}

/**
 * 同じ URL を1つにする（同じ行に日付があった方を残す。横の新着の欄の物で日付がずれないように。どちらも同じなら先の物）
 */
export function dedupeLinks<T extends { url: string; dateFrom: ListLink['dateFrom'] }>(links: readonly T[]): T[] {
  const best = new Map<string, T>()
  const order: string[] = []
  for (const l of links) {
    const had = best.get(l.url)
    if (!had) {
      best.set(l.url, l)
      order.push(l.url)
    } else if (had.dateFrom !== 'row' && l.dateFrom === 'row') best.set(l.url, l)
  }
  return order.map((u) => best.get(u)!)
}

// ---------- 本文 ----------

/** 文字を読まない要素 */
export const SKIP_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'nav',
  'header',
  'footer',
  'aside',
  'noscript',
  'template',
  'svg',
  'iframe',
  'select',
  'button',
])

/** 行を区切る要素 */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'blockquote',
  'br',
  'caption',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
])

/** 本文の読み方 */
export interface BodyOptions {
  /** 本文を探す要素（順に試す。空ならページ全体） */
  scopes?: readonly string[]
  dropLines?: readonly string[]
  dropBlocks?: readonly string[]
  /** probe で行の数を数える印（記者の質問の印の候補） */
  countMarks?: readonly string[]
  /** ほかに文字を読まない要素（Global Voices の図の説明 figcaption など） */
  skipTags?: readonly string[]
}

/** 本文の読み */
export interface BodyResult {
  lines: string[]
  /** 本文の字数（行を改行でつないだ字数） */
  chars: number
  /** 使った要素（scopes のどれか。null はページ全体） */
  scope: string | null
  /** 題（og:title か h1） */
  title: string | null
  /** ページの中のいちばん前の日付（'YYYY-MM-DD'） */
  date: string | null
  /** meta の name と content（robots・AI の名前） */
  metas: { name: string; content: string }[]
  /** 印ごとの、その印で始まる行の数と落とした数（countMarks の並びの番号ごと） */
  marks: { lines: number; dropped: number }[]
}

const nfkc = (s: string) => s.normalize('NFKC')
const charLen = (s: string) => Array.from(s).length

/**
 * 話し手の印で始まる行か（NFKC の後。「(大臣)」「【長官】」「答:」「A.」など。記者の質問の段の終わりを決める。答えの印は府省ごとに違うので、
 * 括弧の中の短い名前・短い語とコロン・A と答の印を広く当てる）
 */
const SPEAKER = /^(?:[(【[〔][^)】\]〕]{1,12}[)】\]〕]|[^\s:]{1,10}:|A[.)]|答[.)])/

/**
 * 行を掃除する（空白・空の行・案内の行・同じ行の重なり・記者の質問の段）。記者の質問の段は、質問の印で始まる行から、次に話し手の印
 * （答える人の印など）で始まる行の前まで落とす（質問が2段以上に分かれていても、第三者の部分を残さない。話し手の印が来なければ終わりまで
 * 落とす。外す側に寄せる）
 */
export function cleanLines(
  raw: readonly string[],
  opts: Pick<BodyOptions, 'dropLines' | 'dropBlocks' | 'countMarks'>,
): { lines: string[]; marks: { lines: number; dropped: number }[] } {
  const drop = new Set((opts.dropLines ?? []).map((l) => squash(nfkc(l))))
  const blocks = (opts.dropBlocks ?? []).map((b) => squash(nfkc(b)))
  const count = (opts.countMarks ?? []).map((b) => squash(nfkc(b)))
  const marks = count.map(() => ({ lines: 0, dropped: 0 }))
  const seen = new Set<string>()
  const lines: string[] = []
  let inQuestion = false
  for (const r of raw) {
    const line = squash(r)
    if (!line) continue
    const n = squash(nfkc(line))
    const block = blocks.some((b) => b && n.startsWith(b))
    count.forEach((b, i) => {
      if (b && n.startsWith(b)) {
        marks[i].lines += 1
        if (block) marks[i].dropped += 1
      }
    })
    if (block) {
      inQuestion = true
      continue
    }
    // 記者の質問の続きの段（話し手の印の行が来るまで）
    if (inQuestion) {
      if (!SPEAKER.test(n)) continue
      inQuestion = false
    }
    if (drop.has(n)) continue
    if (seen.has(line)) continue
    seen.add(line)
    lines.push(line)
  }
  return { lines, marks }
}

/** 本文を読む（scopes の要素ごとに行を集め、200字以上の最初の物・無ければいちばん長い物・どれも無ければページ全体） */
export function readBody(events: readonly HtmlEvent[], opts: BodyOptions = {}): BodyResult {
  const scopes = opts.scopes ?? []
  const skip = new Set([...SKIP_TAGS, ...(opts.skipTags ?? [])])
  // 0 = ページ全体、1.. = scopes の順
  const bufs = [{ depth: 1, matched: true, lines: [] as string[], cur: '' }]
  for (let i = 0; i < scopes.length; i++) bufs.push({ depth: 0, matched: false, lines: [], cur: '' })
  const stack: { name: string; hits: number[]; skip: boolean }[] = []
  let skipDepth = 0
  let title: string | null = null
  let ogTitle: string | null = null
  let h1: string | null = null
  let inH1 = false
  const metas: { name: string; content: string }[] = []
  const flush = () => {
    for (const b of bufs)
      if (b.cur) {
        if (b.depth > 0) b.lines.push(b.cur)
        b.cur = ''
      }
  }
  for (const e of events) {
    if (e.t === 'text') {
      if (skipDepth > 0) continue
      if (inH1) h1 = (h1 ?? '') + e.text
      for (const b of bufs) if (b.depth > 0) b.cur += e.text
      continue
    }
    if (e.t === 'open') {
      if (e.name === 'meta') {
        const name = (e.attrs.name ?? '').trim()
        const prop = (e.attrs.property ?? '').trim().toLowerCase()
        const content = e.attrs.content ?? ''
        if (prop === 'og:title' && ogTitle === null) ogTitle = squash(content)
        if (name) metas.push({ name, content })
      }
      if (BLOCK_TAGS.has(e.name)) flush()
      const hits: number[] = []
      scopes.forEach((s, i) => {
        if (selectorMatches(s, e.name, e.attrs)) {
          bufs[i + 1].depth += 1
          bufs[i + 1].matched = true
          hits.push(i + 1)
        }
      })
      const sk = skip.has(e.name)
      if (sk) skipDepth += 1
      if (e.name === 'h1' && h1 === null && skipDepth === 0) inH1 = true
      stack.push({ name: e.name, hits, skip: sk })
      continue
    }
    const top = stack.pop()
    if (!top) continue
    if (BLOCK_TAGS.has(top.name)) flush()
    if (top.name === 'h1') inH1 = false
    if (top.skip) skipDepth -= 1
    for (const i of top.hits) {
      flush()
      bufs[i].depth -= 1
    }
  }
  flush()
  const cleaned = bufs.map((b) => ({ matched: b.matched, ...cleanLines(b.lines, opts) }))
  const len = (c: { lines: string[] }) => charLen(c.lines.join('\n'))
  let pick = 0
  if (scopes.length) {
    const first = cleaned.findIndex((c, i) => i > 0 && len(c) >= SOURCE_BODY_MIN_CHARS)
    if (first > 0) pick = first
    else {
      let best = -1
      cleaned.forEach((c, i) => {
        if (i > 0 && c.matched && len(c) > 0 && (best < 0 || len(c) > len(cleaned[best]))) best = i
      })
      if (best > 0) pick = best
    }
  }
  const chosen = cleaned[pick]
  title = ogTitle || (h1 !== null ? squash(h1) : null) || null
  // 年のある日付だけを使う（年の無い日付はページの中では決めない）
  let date: string | null = null
  for (const l of chosen.lines) {
    const d = findDate(l, { year: null, today: '2000-01-01' })
    if (d && !d.yearless) {
      date = d.ymd
      break
    }
  }
  return {
    lines: chosen.lines,
    chars: len(chosen),
    scope: pick === 0 ? null : scopes[pick - 1],
    title,
    date,
    metas,
    marks: chosen.marks,
  }
}

/**
 * #番号 の項目を読む（消防庁）: その id・name の要素から、次の同じ要素名で id・name を持つ要素の前まで（その要素の親（a の時は親の親）が
 * 閉じたら終わり）。見つからなければ null
 */
export function readAnchor(
  events: readonly HtmlEvent[],
  anchor: string,
  opts: Pick<BodyOptions, 'dropLines' | 'dropBlocks' | 'countMarks'> = {},
): { lines: string[]; chars: number; title: string | null; marks: { lines: number; dropped: number }[] } | null {
  const stack: string[] = []
  let active = false
  let found = false
  let tag = ''
  let boundary = 0
  let skipDepth = 0
  const skipAt: number[] = []
  const raw: string[] = []
  let cur = ''
  const flush = () => {
    if (cur) raw.push(cur)
    cur = ''
  }
  for (const e of events) {
    if (e.t === 'text') {
      if (active && skipDepth === 0) cur += e.text
      continue
    }
    if (e.t === 'open') {
      const id = e.attrs.id ?? e.attrs.name
      if (active && e.name === tag && id !== undefined && id !== anchor) {
        flush()
        active = false
        break
      }
      if (!found && id === anchor) {
        found = true
        active = true
        tag = e.name
        boundary = Math.max(0, stack.length - (e.name === 'a' ? 1 : 0))
      }
      if (BLOCK_TAGS.has(e.name)) flush()
      stack.push(e.name)
      if (SKIP_TAGS.has(e.name)) {
        skipDepth += 1
        skipAt.push(stack.length)
      }
      continue
    }
    if (BLOCK_TAGS.has(e.name)) flush()
    if (skipAt.length && skipAt[skipAt.length - 1] === stack.length) {
      skipAt.pop()
      skipDepth -= 1
    }
    stack.pop()
    if (active && stack.length < boundary) {
      flush()
      active = false
      break
    }
  }
  flush()
  if (!found) return null
  const { lines, marks } = cleanLines(raw, opts)
  return { lines, chars: charLen(lines.join('\n')), title: lines[0] ?? null, marks }
}
