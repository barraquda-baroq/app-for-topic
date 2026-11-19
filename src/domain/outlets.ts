// 社の名前の決まった一覧と、その社の資料が読める所・読んだ所（via）のホスト名・出典の書き方（docs/SPEC.md の 4.8・5.10・7.1）。
// アプリと段階3のコネクタで同じ物を使う。一覧は書き方をそろえる表で、一覧に無い社も、名前のまま outlet・outletNames に入れてよい。
// その時の出典は via の URL に限る（一覧に無い社のホストはリンクにできないため）。
// - コネクタ: url のホストが outlet か via のホストのどれにも当たらない出典を断る（記事の中のリンクや作り出した URL を出典にしない。D23・4.6）。
//   段階3では、出典の社を資料の控えのホストから引く（src/domain/assemble.ts）
// - アプリ: 同じ決まりに当たらない URL はリンクにせず文として出す（一覧を後で足した時の古いアプリも同じ。src/domain/repair.ts）。
//   出典の表示（「…を加工して作成」など）は、社の credit から作る（src/domain/credit.ts）
// 一覧は差し替えられる形（OutletDirectory）にする。作り物の版では作り物の社の一覧を使う（src/test/fixtures/fakeOutlets.ts。docs/SPEC.md の 16.3）。
// ホストは小文字の決まった名前だけで比べる（www の有る無しも別のホスト。4.8 の「許可するドメイン」と同じく、決まった名前だけ）。
// 出どころは部品ではなく data で持つ（段階3の設計の 1.7 の (1)）。部品は社の名前を知らず、この一覧と connector/src/fetch/sources.ts だけを読む。
// 許しが取れた社を足す時は、ここに名前・ホスト（一覧と本文の全部）・credit を1行足す（docs/CONNECTOR.md の「出どころを足す時」）。
import { normalizeIdText } from './ids'

/**
 * 出典の書き方（社ごと。出どころの規約の出典の書き方。{主体} は src/domain/credit.ts の CREDIT_PROCESSOR）:
 * - site: 出典：{siteName}（{url}）を加工して作成（加工: {主体}）
 * - title: 出典：「{title}」（{org}）（{url}）を加工して作成（加工: {主体}）
 * - pdl: 出典：{siteName}（{url}）、PDL1.0（{PDL1.0 の URL}）を加工して作成（加工: {主体}）。独自の出典の書き方の無い府省（PDL1.0 の既定の形）
 * - jma: 出典：気象庁ホームページ（{url}）を加工して作成（加工: {主体}。編集の責任は {主体} にあります）
 * - cc-by: 出典：{outlet}「{title}」（著者: {author}）（{url}）、{license}（{licenseUrl}）。{主体}が要約・翻訳した（著者が無ければ著者の括弧を書かない）
 */
export type CreditRule =
  | { form: 'site'; siteName: string }
  | { form: 'title'; org: string }
  | { form: 'pdl'; siteName: string }
  | { form: 'jma' }
  | { form: 'cc-by'; license: string; licenseUrl: string }

/** 出典の書き方の形（5つ） */
export const CREDIT_FORMS = ['site', 'title', 'pdl', 'jma', 'cc-by'] as const satisfies readonly CreditRule['form'][]

/** リンクの開き方（既定 'new-window'。'no-link' はリンクにせず文で出す。許しの条件でリンクを張れない社のため） */
export type LinkOpen = 'new-window' | 'no-link'

/** 一覧の1つ（社か、読んだ所） */
export interface OutletEntry {
  /** 決まった書き方（outlet・outletNames・via に入れる名前） */
  name: string
  /** ほかの書き方（そろえる前の名前。書き方をそろえる時に使う） */
  aliases?: readonly string[]
  /** その社の資料が読める所のホスト名（小文字。一覧を取るホストと本文を取るホストの全部） */
  hosts: readonly string[]
  /** 出典の書き方と「加工して作成」の書き方（無い社は出典の表示なし。今の8つは全部持つ） */
  credit?: CreditRule
  /** リンクの開き方（省くと 'new-window'） */
  linkOpen?: LinkOpen
}

/** 社の名前の一覧と、読んだ所の一覧 */
export interface OutletList {
  outlets: readonly OutletEntry[]
  vias: readonly OutletEntry[]
}

/** 引きやすくした一覧（createOutletDirectory で作る） */
export interface OutletDirectory {
  list: OutletList
  /** 決まった書き方 → 一覧の1つ（社） */
  outletEntries: ReadonlyMap<string, OutletEntry>
  /** 決まった書き方 → 一覧の1つ（読んだ所） */
  viaEntries: ReadonlyMap<string, OutletEntry>
  /** そろえた名前 → 決まった書き方（社） */
  outletNames: ReadonlyMap<string, string>
  /** そろえた名前 → 決まった書き方（読んだ所） */
  viaNames: ReadonlyMap<string, string>
  /** 決まった書き方 → ホスト（社） */
  outletHosts: ReadonlyMap<string, ReadonlySet<string>>
  /** 決まった書き方 → ホスト（読んだ所） */
  viaHosts: ReadonlyMap<string, ReadonlySet<string>>
}

/** 一覧を引きやすくする（同じ名前・別名が2つの社に当たる一覧は誤りとして投げる） */
export function createOutletDirectory(list: OutletList): OutletDirectory {
  const names = (entries: readonly OutletEntry[]) => {
    const byName = new Map<string, string>()
    const hosts = new Map<string, ReadonlySet<string>>()
    for (const e of entries) {
      for (const n of [e.name, ...(e.aliases ?? [])]) {
        const k = normalizeIdText(n)
        const had = byName.get(k)
        if (had !== undefined && had !== e.name) throw new Error(`社の名前「${n}」が2つの社に当たります`)
        byName.set(k, e.name)
      }
      hosts.set(e.name, new Set(e.hosts.map((h) => h.toLowerCase())))
    }
    return { byName, hosts }
  }
  const o = names(list.outlets)
  const v = names(list.vias)
  const entries = (list: readonly OutletEntry[]) => new Map(list.map((e) => [e.name, e]))
  return {
    list,
    outletEntries: entries(list.outlets),
    viaEntries: entries(list.vias),
    outletNames: o.byName,
    viaNames: v.byName,
    outletHosts: o.hosts,
    viaHosts: v.hosts,
  }
}

/**
 * 段階3の定期実行が読む出どころの一覧（府省・庁の7つと Global Voices。作者の問2の答えで済ませた出どころ探し（2026-11-19）で「条件つきで
 * 使える」とした物。段階3の設計の 1.7 の (1)）。名前は出典に書く社の名前、credit は各社の出典の書き方（内閣府は独自の書き方が無いので PDL1.0 の
 * 既定の形。名前はリンクの決まりの「『内閣府ホームページ』へのリンクであることを明記」に合わせる）。リンクの開き方は8つとも新しい窓
 * （内閣府・国土交通省のリンクの決まり）。読んだ所（via）を通す出どころは無いので vias は空。取り方は connector/src/fetch/sources.ts
 */
export const DEFAULT_OUTLET_LIST: OutletList = {
  outlets: [
    {
      name: '首相官邸',
      aliases: ['官邸', '首相官邸ホームページ'],
      hosts: ['www.kantei.go.jp'],
      credit: { form: 'site', siteName: '首相官邸ホームページ' },
      linkOpen: 'new-window',
    },
    {
      name: '内閣府',
      aliases: ['内閣府ホームページ'],
      hosts: ['www.cao.go.jp'],
      credit: { form: 'pdl', siteName: '内閣府ホームページ' },
      linkOpen: 'new-window',
    },
    {
      name: 'デジタル庁',
      aliases: [],
      hosts: ['www.digital.go.jp'],
      credit: { form: 'title', org: 'デジタル庁' },
      linkOpen: 'new-window',
    },
    {
      name: '厚生労働省',
      aliases: ['厚労省', '厚生労働省ホームページ'],
      hosts: ['www.mhlw.go.jp'],
      credit: { form: 'site', siteName: '厚生労働省ホームページ' },
      linkOpen: 'new-window',
    },
    {
      name: '消防庁',
      aliases: ['総務省消防庁', '消防庁ホームページ'],
      hosts: ['www.fdma.go.jp'],
      credit: { form: 'site', siteName: '消防庁ホームページ' },
      linkOpen: 'new-window',
    },
    {
      name: '気象庁',
      aliases: ['気象庁ホームページ'],
      hosts: ['www.data.jma.go.jp'],
      credit: { form: 'jma' },
      linkOpen: 'new-window',
    },
    {
      name: '国土交通省',
      aliases: ['国交省', '国土交通省ウェブサイト'],
      hosts: ['www.mlit.go.jp'],
      credit: { form: 'site', siteName: '国土交通省ウェブサイト' },
      linkOpen: 'new-window',
    },
    {
      name: 'Global Voices',
      aliases: [],
      hosts: ['globalvoices.org'],
      credit: { form: 'cc-by', license: 'CC BY 3.0', licenseUrl: 'https://creativecommons.org/licenses/by/3.0/' },
      linkOpen: 'new-window',
    },
  ],
  vias: [],
}

/** アプリとコネクタがふだん使う一覧 */
export const DEFAULT_OUTLETS: OutletDirectory = createOutletDirectory(DEFAULT_OUTLET_LIST)

/** 社の名前を決まった書き方にそろえる（一覧に無い社は、前後の空白を除いた名前のまま） */
export function canonicalOutletName(name: string, dir: OutletDirectory = DEFAULT_OUTLETS): string {
  return dir.outletNames.get(normalizeIdText(name)) ?? name.trim()
}

/** 読んだ所の名前を決まった書き方にそろえる（一覧に無い所は、前後の空白を除いた名前のまま） */
export function canonicalViaName(name: string, dir: OutletDirectory = DEFAULT_OUTLETS): string {
  return dir.viaNames.get(normalizeIdText(name)) ?? name.trim()
}

/** 一覧にある社か（決まった書き方か別名） */
export function isKnownOutlet(name: string, dir: OutletDirectory = DEFAULT_OUTLETS): boolean {
  return dir.outletNames.has(normalizeIdText(name))
}

/** 一覧の社（決まった書き方か別名で引く。一覧に無い社は null） */
export function outletEntryOf(name: string, dir: OutletDirectory = DEFAULT_OUTLETS): OutletEntry | null {
  return dir.outletEntries.get(canonicalOutletName(name, dir)) ?? null
}

/** そのホストで資料が読める社の決まった書き方（一覧の順。1つのホストに社が2つ以上ある時もある） */
export function outletsOfHost(host: string, dir: OutletDirectory = DEFAULT_OUTLETS): string[] {
  const h = host.toLowerCase()
  return [...dir.outletHosts].filter(([, hosts]) => hosts.has(h)).map(([name]) => name)
}

/** そのホストの読んだ所の決まった書き方（一覧の順） */
export function viasOfHost(host: string, dir: OutletDirectory = DEFAULT_OUTLETS): string[] {
  const h = host.toLowerCase()
  return [...dir.viaHosts].filter(([, hosts]) => hosts.has(h)).map(([name]) => name)
}

/** 一覧のどこかにあるホストか（社か読んだ所） */
export function isKnownHost(host: string, dir: OutletDirectory = DEFAULT_OUTLETS): boolean {
  const h = host.toLowerCase()
  for (const set of [...dir.outletHosts.values(), ...dir.viaHosts.values()]) if (set.has(h)) return true
  return false
}

/**
 * https: の URL のホスト（小文字）。https: でない・読めない・利用者の名前やパスワードを含む・決まりでない番号のポートの URL は null。
 * URL は Workers・ブラウザ・Node のどれにもある標準の物
 */
export function httpsHostOf(url: unknown): string | null {
  if (typeof url !== 'string') return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
  return u.hostname.toLowerCase() || null
}

/** 出典の社と読んだ所のホスト（社・読んだ所が一覧に無ければ、その分は無い） */
export function sourceHosts(source: { outlet: string; via: string | null }, dir: OutletDirectory = DEFAULT_OUTLETS): Set<string> {
  const out = new Set<string>()
  const outlet = dir.outletHosts.get(canonicalOutletName(source.outlet, dir))
  if (outlet) for (const h of outlet) out.add(h)
  if (source.via !== null) {
    const via = dir.viaHosts.get(canonicalViaName(source.via, dir))
    if (via) for (const h of via) out.add(h)
  }
  return out
}

/**
 * 出典の URL を使ってよいか（https: で、ホストが outlet か via の決まったホストのどれか）。コネクタはこれに当たらない出典を断り、
 * アプリはこれに当たらない URL をリンクにしない（docs/SPEC.md の 7.1）
 */
export function isAllowedSourceUrl(
  source: { outlet: string; url: unknown; via: string | null },
  dir: OutletDirectory = DEFAULT_OUTLETS,
): boolean {
  const host = httpsHostOf(source.url)
  return host !== null && sourceHosts(source, dir).has(host)
}

/**
 * 出典のリンクの開き方（URL のある所の物。読んだ所の URL なら読んだ所の、ほかは社の。一覧に無い所・書いていない所は 'new-window'）
 */
export function linkOpenOf(source: { outlet: string; via: string | null }, dir: OutletDirectory = DEFAULT_OUTLETS): LinkOpen {
  const entry =
    source.via !== null
      ? dir.viaEntries.get(canonicalViaName(source.via, dir))
      : dir.outletEntries.get(canonicalOutletName(source.outlet, dir))
  return entry?.linkOpen ?? 'new-window'
}

/**
 * 画面でリンクにする URL（使ってよい URL なら記録のまま、だめなら null で、文として出す）。リンクの開き方が 'no-link' の所も null
 * （許しの条件でリンクを張れない社。URL は文で出す。段階3の設計の 1.7 の (1)）
 */
export function sourceLinkUrl(
  source: { outlet: string; url: unknown; via: string | null },
  dir: OutletDirectory = DEFAULT_OUTLETS,
): string | null {
  if (linkOpenOf(source, dir) === 'no-link') return null
  return isAllowedSourceUrl(source, dir) ? (source.url as string) : null
}
