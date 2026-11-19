// 出典の表示（段階3。docs/SPEC.md の 5.10・段階3の設計の 3.4）。府省ごとの出典の書き方・「…を加工して作成」と加工した主体・
// CC BY の出どころ（Global Voices）の著者とライセンスと変更した旨を、記録の出典（社の名前・題・URL・著者）と社の一覧の credit
// （src/domain/outlets.ts）から作る。記録には文を持たない（社が決まれば文が決まる。記録に足したのは著者の名前だけ）。
// 画面（詳細・クリップ）は、この文をそのまま文として出す（中の URL はリンクにしない。リンクは出典の行にある）。アプリとコネクタで同じ物を使う。
import { canonicalOutletName, DEFAULT_OUTLETS, outletEntryOf, sourceLinkUrl, type OutletDirectory } from './outlets'

/**
 * 加工した主体（作者に伺っている Q19 の今の決め方 A「Topic Studio（AI による要約）」。答えで替わるのはこの1か所）。
 * 作者の名前は書かない（公開の画面に出る文で、名前の欄を持たない）
 */
export const CREDIT_PROCESSOR = 'Topic Studio（AI による要約）'

/** 公共データ利用規約（第1.0版）の名前と URL（独自の出典の書き方の無い府省。outlets.ts の credit の pdl） */
export const PDL_V1_NAME = 'PDL1.0'
export const PDL_V1_URL = 'https://www.digital.go.jp/resources/open_data/public_data_license_v1.0'

/** CC BY 3.0 の名前と URL（Global Voices。outlets.ts の credit の cc-by と同じ値か、src/domain/credit.test.ts で確かめる） */
export const CC_BY_3_NAME = 'CC BY 3.0'
export const CC_BY_3_URL = 'https://creativecommons.org/licenses/by/3.0/'

/** 出典の表示に使う欄（記録の出典か、その表示用の写し） */
export interface CreditSource {
  outlet: string
  title: string
  url: string
  via?: string | null
  author?: string | null
}

const ASCII_WORD = /[A-Za-z0-9]/
const KANA_KANJI = /[぀-ヿ㐀-鿿]/

/** 2つの文をつなぐ（かな・漢字と英数字の間にだけ空白を1つ入れる。主体の名前の頭と終わりが英字でも和文でも、つなぎ目がそろう） */
function join(a: string, b: string): string {
  const x = a.slice(-1)
  const y = b.slice(0, 1)
  const gap = (ASCII_WORD.test(x) && KANA_KANJI.test(y)) || (KANA_KANJI.test(x) && ASCII_WORD.test(y))
  return gap ? `${a} ${b}` : a + b
}

const authorOf = (s: CreditSource): string | null => {
  const a = typeof s.author === 'string' ? s.author.trim() : ''
  return a ? a : null
}

/**
 * 出典の表示の文（社の credit の5つの形から。credit の無い社・一覧に無い社は null）。例（作り物）:
 * - site: 出典：〇〇省ホームページ（https://example.com/…）を加工して作成（加工: Topic Studio（AI による要約））
 * - cc-by: 出典：□□ボイス「題」（著者: 名前）（https://example.com/…）、CC BY 3.0（…）。Topic Studio（AI による要約）が要約・翻訳した
 * cc-by で著者が無い時は「著者: 不明」と書かず、著者の括弧ごと書かない
 */
export function creditText(source: CreditSource, dir: OutletDirectory = DEFAULT_OUTLETS): string | null {
  const entry = outletEntryOf(source.outlet, dir)
  const rule = entry?.credit
  if (!entry || !rule) return null
  const P = CREDIT_PROCESSOR
  const url = source.url
  switch (rule.form) {
    case 'site':
      return `出典：${rule.siteName}（${url}）を加工して作成（加工: ${P}）`
    case 'title':
      return `出典：「${source.title}」（${rule.org}）（${url}）を加工して作成（加工: ${P}）`
    case 'pdl':
      return `出典：${rule.siteName}（${url}）、${PDL_V1_NAME}（${PDL_V1_URL}）を加工して作成（加工: ${P}）`
    case 'jma':
      return `出典：気象庁ホームページ（${url}）を加工して作成（加工: ${P}。${join(join('編集の責任は', P), 'にあります')}）`
    case 'cc-by': {
      const author = authorOf(source)
      const by = author ? `（著者: ${author}）` : ''
      return `出典：${entry.name}「${source.title}」${by}（${url}）、${rule.license}（${rule.licenseUrl}）。${join(P, 'が要約・翻訳した')}`
    }
  }
}

/** 詳細の頭に出す、CC BY の出典の1行（text）と元記事へのリンク（link は画面でリンクにする URL。リンクにできなければ null） */
export interface CreditHead {
  text: string
  links: { outlet: string; title: string; url: string; author: string | null; link: string | null }[]
}

/**
 * CC BY の社（credit が cc-by）を出典に持つ話題の、詳細の頭の1行（Global Voices の帰属の決まり「訳したり再掲したりする時は、元記事への
 * リンクと著者の名前を記事の頭に」。段階3の設計の 3.4）。例（作り物）: 「この話題は、□□ボイス「題」（著者: 名前）を元に、
 * Topic Studio（AI による要約）が要約・翻訳しました」。cc-by の出典が無い話題は null（府省の話題は、出典の段の表示だけ）
 */
export function creditHeadText(sources: readonly CreditSource[], dir: OutletDirectory = DEFAULT_OUTLETS): CreditHead | null {
  const links: CreditHead['links'] = []
  for (const s of sources) {
    if (outletEntryOf(s.outlet, dir)?.credit?.form !== 'cc-by') continue
    links.push({
      outlet: canonicalOutletName(s.outlet, dir),
      title: s.title,
      url: s.url,
      author: authorOf(s),
      link: sourceLinkUrl({ outlet: s.outlet, url: s.url, via: s.via ?? null }, dir),
    })
  }
  if (!links.length) return null
  const items = links.map((l) => `${l.outlet}「${l.title}」${l.author ? `（著者: ${l.author}）` : ''}`)
  return { text: `この話題は、${items.join('・')}を元に、${join(CREDIT_PROCESSOR, 'が要約・翻訳しました')}`, links }
}
