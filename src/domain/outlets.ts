// 社の名前の決まった一覧と、その社の記事が読める所（配信先の新聞社のサイトを含む）・読んだ所（via）のホスト名（docs/SPEC.md の 4.8・7.1）。
// アプリと段階3のコネクタで同じ物を使う。一覧は書き方をそろえる表で、一覧に無い社（Yahoo!ニュースや Google ニュースの束に出る地方の社など）も、
// 名前のまま outlet・outletNames に入れてよい。その時の出典は via の URL に限る（一覧に無い社のホストはリンクにできないため）。
// - コネクタ: url のホストが outlet か via のホストのどれにも当たらない出典を断る（記事の中のリンクや作り出した URL を出典にしない。D23・4.6）
// - アプリ: 同じ決まりに当たらない URL はリンクにせず文として出す（一覧を後で足した時の古いアプリも同じ。src/domain/repair.ts）
// 一覧は差し替えられる形（OutletDirectory）にする。作り物の版では作り物の社の一覧を使う（src/test/fixtures/fakeOutlets.ts。docs/SPEC.md の 16.3）。
// ホストは小文字の決まった名前だけで比べる（www の有る無しも別のホスト。4.8 の「許可するドメイン」と同じく、決まった名前だけ）。
import { normalizeIdText } from './ids'

/** 一覧の1つ（社か、読んだ所） */
export interface OutletEntry {
  /** 決まった書き方（outlet・outletNames・via に入れる名前） */
  name: string
  /** ほかの書き方（そろえる前の名前。書き方をそろえる時に使う） */
  aliases?: readonly string[]
  /** その社の記事が読める所のホスト名（小文字。配信先の新聞社のサイトを含む） */
  hosts: readonly string[]
}

/** 社の名前の一覧と、読んだ所の一覧 */
export interface OutletList {
  outlets: readonly OutletEntry[]
  vias: readonly OutletEntry[]
}

/** 引きやすくした一覧（createOutletDirectory で作る） */
export interface OutletDirectory {
  list: OutletList
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
  return { list, outletNames: o.byName, viaNames: v.byName, outletHosts: o.hosts, viaHosts: v.hosts }
}

/**
 * 段階3の定期実行が読む社の一覧（docs/SPEC.md の 4.8 の「許可するドメイン」で読めた・読めない社。決まった書き方・別名は開発が決めた仮の物で、
 * 段階3の依頼文と合わせて直す）。読めない社（相手のサイトがロボット対策で断る）も、Yahoo!ニュースなどで読んだ時の outlet の書き方をそろえるので、
 * 一覧に入れる。Google ニュースの束は候補集めに使う所で、記事を読む所ではないので via にしない
 */
export const DEFAULT_OUTLET_LIST: OutletList = {
  outlets: [
    { name: 'NHK', aliases: ['NHKニュース', '日本放送協会'], hosts: ['www.nhk.or.jp', 'www3.nhk.or.jp', 'news.web.nhk'] },
    { name: '共同通信', aliases: ['共同'], hosts: ['kumanichi.com'] },
    { name: '時事通信', aliases: ['時事', '時事ドットコム'], hosts: ['www.jiji.com'] },
    { name: '毎日新聞', aliases: ['毎日'], hosts: ['mainichi.jp'] },
    { name: '朝日新聞', aliases: ['朝日'], hosts: ['www.asahi.com'] },
    { name: '読売新聞', aliases: ['読売'], hosts: ['www.yomiuri.co.jp'] },
    { name: '日本経済新聞', aliases: ['日経', '日経新聞'], hosts: ['www.nikkei.com'] },
    { name: '東京新聞', aliases: [], hosts: ['www.tokyo-np.co.jp'] },
    { name: 'AP通信', aliases: ['AP', 'Associated Press'], hosts: ['apnews.com'] },
    { name: 'ロイター', aliases: ['Reuters', 'ロイター通信'], hosts: ['www.reuters.com'] },
    { name: 'BBC', aliases: ['BBC News', 'BBCニュース'], hosts: ['www.bbc.com', 'feeds.bbci.co.uk'] },
  ],
  vias: [{ name: 'Yahoo!ニュース', aliases: ['Yahoo!', 'Yahoo! JAPAN ニュース', 'ヤフーニュース'], hosts: ['news.yahoo.co.jp'] }],
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

/** 画面でリンクにする URL（使ってよい URL なら記録のまま、だめなら null で、文として出す） */
export function sourceLinkUrl(
  source: { outlet: string; url: unknown; via: string | null },
  dir: OutletDirectory = DEFAULT_OUTLETS,
): string | null {
  return isAllowedSourceUrl(source, dir) ? (source.url as string) : null
}
