// 出どころの data（段階3の設計の 1.7 の (1)。v1 の feeds.ts を替える）。部品（一覧の読み・本文・robots.txt・見張り・出典の組み立て）は
// 出どころの名前を知らず、この data だけを読む。社の名前・別名・ホスト・出典の書き方は src/domain/outlets.ts（アプリと同じ物）にあり、
// ここは取り方（一覧・取ってよい道・取らない道・間・本文の取り方・規約の印・規約のページ）だけを持つ。
// - 使う出どころは、作者の問2の答えで済ませた出どころ探し（2026-11-19）で「条件つきで使える」とした8つだけ
//   （府省・庁の7つと Global Voices）。判定と条件の元は、各社の規約・RSS の利用条件・robots.txt（記事は読んでいない）
// - 一覧の道の形（itemPath）・本文の要素（scopes）・記者の質問の印（dropBlocks）・会見の道（qaPages）・気象庁の種類の名前は、
//   S1 の probe の数で合わせる（題を見ずに数だけで決める。6.2）。いまの値は見立て
// - 規約のページの指紋（termsPages の fingerprint）は S1c の回が返す。指紋の無いページのある出どころは試しの回だけで取る（1.7 の (2) の 3）
// - 許しが取れた社を足す時は、outlets.ts と、ここの DEFAULT_SOURCES に1行ずつ足す（docs/CONNECTOR.md の「出どころを足す時」）。
//   terms.status は 'permitted'、permit（許しの範囲の言い換え・期限・本文の数・間・RSS を使ってよいか）を必ず持つ
// - data の確かめは connector/test/unit/sources.test.ts（足し忘れ・矛盾を止める）
import type { Genre, Region } from '../../../src/domain/types'

/** 規約・RSS の利用条件・リンクの決まり・AI の方針のページ（見張り。1.7 の (10)） */
export interface TermsPage {
  url: string
  /** 本文を絞る要素（毎回変わる所で誤って止まらないように。空ならページ全体） */
  scopes: readonly string[]
  /** 開発が確かめた時の文字の指紋（S1c の回が返す。規約の文ではないので公開のリポジトリに置いてよい） */
  fingerprint?: string
  /** 'probe-only' は週の見張りで取らない（気象庁。HTML を自動で取らないため） */
  watch: 'weekly' | 'probe-only'
}

/** 許しの範囲（terms.status が 'permitted' の時は必ず。許しの文そのものは写さない） */
export interface Permit {
  /** 許しの日・期限（'YYYY-MM-DD'。期限を過ぎたら「取らない（許しの期限）」） */
  grantedOn: string
  until?: string
  /** 許しの範囲の短い言い換え */
  scope: string
  /** 1つの回に取る本文の数（依頼の文で約束した数） */
  maxBodiesPerRun: number
  /** 同じホストへの間（秒） */
  minIntervalSec: number
  /** RSS を候補の元にしてよいか（false なら lists に rss を置けない） */
  rssAllowed: boolean
}

/** 一覧の取り方。label は候補の一覧の行に出す一覧の名前（「報道発表」など） */
export type ListConfig =
  | {
      kind: 'rss'
      label: string
      url: string
      /** 外すカテゴリー（カテゴリーの名前にこの文字列を含む項目を外す） */
      excludeCategories?: readonly string[]
      /** 許しの社で https の一覧が無い時だけ（本文はいつも https。1.7 の (11)） */
      http?: true
    }
  | { kind: 'atom'; label: string; url: string; jmaKinds: true }
  | {
      kind: 'html'
      label: string
      url: string
      /** 項目の道の形（正規表現。その出どころの発表のページの道。S1 で数を見て決める） */
      itemPath: string
      /** 一覧を読む要素（main など）。無ければページ全体 */
      scope?: string
    }

/** 本文の取り方（1.7 の (6)） */
export type BodyConfig =
  | {
      kind: 'html'
      /** 本文を探す要素（順に試し、文字が200字以上になった最初の物） */
      scopes: readonly string[]
      /** 落とす案内の行（「このページの先頭へ」など。そろえた行が同じ物） */
      dropLines?: readonly string[]
      /** 落とす段の印（記者の質問の段。行の頭がこの印の物。どの府省も持つ） */
      dropBlocks: readonly string[]
      /** 会見の記録の道（前方一致）。verified になるまで、その道の項目は試しの回だけ */
      qaPages?: { paths: readonly string[]; verified: boolean }
    }
  | { kind: 'anchor'; dropBlocks?: readonly string[] }
  | { kind: 'feed'; excludeIfContains: readonly string[] }
  | { kind: 'jma-xml' }

/** 出どころ1つの取り方 */
export interface SourceConfig {
  /** 'kantei' など（ASCII。ログ・probe に出してよい印） */
  id: string
  /** outlets.ts の決まった書き方 */
  outlet: string
  /** 一覧を取るホストと本文を取るホスト（robots.txt・Crawl-delay・規約の印はホストごと） */
  hosts: { list: readonly string[]; body: readonly string[] }
  lists: readonly ListConfig[]
  /** 本文を取ってよい道（前方一致。本文のホストの中） */
  allowPaths: readonly string[]
  /** 同じホストの中で取らない道（前方一致。別のルールの物・断りのある RSS の道など） */
  denyPaths: readonly string[]
  /** robots.txt の Crawl-delay と 1秒より長くあけたい時（秒） */
  crawlDelaySec?: number
  body: BodyConfig
  /** 選ぶ係への手がかり（候補の一覧には出さない。決まりの文に表で書く） */
  hints: { region: Region; genres: readonly Genre[] }
  /** topic_read_article の頭の行に出す、その出どころの決まり（各 60字まで） */
  notes: readonly string[]
  /**
   * 開発が規約を読んで確かめた印（accepted は確かめた日・許しの日）。'trial-only' は試しの回だけで取る（見張りの alarm も置かない）。
   * rssRefused は RSS の利用条件が断っている（RSS を使わない）
   */
  terms: { status: 'ok' | 'permitted' | 'trial-only'; accepted: string; rssRefused?: true }
  termsPages: readonly TermsPage[]
  permit?: Permit
}

/** 今は取らない所（外務省・防衛省・経済産業省。probe の 'hosts'・'terms' だけが読む。1.7 の (12)） */
export interface PendingHost {
  id: string
  name: string
  host: string
  /** robots.txt が 403 の時だけ番号を見る規約のページ1つ */
  statusUrl: string
  termsPages: readonly TermsPage[]
}

/** 記者の質問の段の印（行の頭。NFKC でそろえて比べる。どの府省の本文でも落とす。S1 の probe の印ごとの行の数で決め直す） */
export const PRESS_QUESTION_MARKS: readonly string[] = [
  '（記者）',
  '【記者】',
  '記者：',
  '記者:',
  '（問）',
  '【問】',
  '問：',
  '問:',
  '問）',
  'Q：',
  'Q:',
  'Q.',
  'Q）',
  '【質問】',
  '（質問）',
  '質問：',
]

/** 落とす案内の行（府省の HTML に共通の物） */
const NAV_LINES: readonly string[] = [
  'このページの先頭へ',
  'ページの先頭へ',
  'ページの先頭へ戻る',
  'ページトップへ',
  'ページトップへ戻る',
  'トップへ戻る',
  '印刷',
  '印刷する',
  'このページを印刷する',
  '前のページへ戻る',
  '一覧へ戻る',
]

/** 府省の HTML の本文の要素（順に試す。S1 の probe の字数で決め直す） */
const GOV_SCOPES: readonly string[] = ['main', '#main', '#contents', '#content', 'article']

/** 日付（出どころ探しの日・規約を読んで確かめた日） */
const ACCEPTED = '2026-11-19'

/**
 * 出どころの一覧（府省・庁の7つと Global Voices）。並びは topic_status・候補の一覧の出どころの並び。
 * 名前とホストは src/domain/outlets.ts の DEFAULT_OUTLET_LIST と同じ（sources.test.ts で確かめる）
 */
export const DEFAULT_SOURCES: readonly SourceConfig[] = [
  {
    id: 'kantei',
    outlet: '首相官邸',
    hosts: { list: ['www.kantei.go.jp'], body: ['www.kantei.go.jp'] },
    lists: [
      {
        kind: 'html',
        label: '新着',
        url: 'https://www.kantei.go.jp/jp/news/index.html',
        itemPath: '^/jp/(?:[0-9a-z_]+/)+[0-9a-z_-]*\\d{4,}[0-9a-z_-]*\\.html$',
      },
      {
        kind: 'html',
        label: '官房長官会見',
        url: 'https://www.kantei.go.jp/jp/tyoukanpress/index.html',
        itemPath: '^/jp/tyoukanpress/\\d{6}/[0-9a-z_-]+\\.html$',
      },
      {
        kind: 'html',
        label: '総理の演説・会見',
        url: 'https://www.kantei.go.jp/jp/105/statement/index.html',
        itemPath: '^/jp/105/statement/\\d{4}/[0-9a-z_-]+\\.html$',
      },
    ],
    allowPaths: ['/jp/'],
    // RSS の利用条件が「その情報に基づいたホームページ・メールマガジンの作成、情報の再配布など」を断るので、RSS の配信とそのページを取らない
    denyPaths: ['/index-jnews.rdf', '/rss.html', '/jp/rss/'],
    body: {
      kind: 'html',
      scopes: GOV_SCOPES,
      dropLines: NAV_LINES,
      dropBlocks: PRESS_QUESTION_MARKS,
      qaPages: { paths: ['/jp/tyoukanpress/', '/jp/105/statement/'], verified: false },
    },
    hints: { region: 'jp', genres: ['politics'] },
    notes: ['会見の記録の記者の質問は落としてある。質問の中身は書かない', '写真・映像・ロゴは使わない'],
    terms: { status: 'ok', accepted: ACCEPTED, rssRefused: true },
    termsPages: [
      { url: 'https://www.kantei.go.jp/jp/terms.html', scopes: GOV_SCOPES, watch: 'weekly' },
      { url: 'https://www.kantei.go.jp/rss.html', scopes: GOV_SCOPES, watch: 'weekly' },
    ],
  },
  {
    id: 'cao',
    outlet: '内閣府',
    hosts: { list: ['www.cao.go.jp'], body: ['www.cao.go.jp'] },
    lists: [
      {
        kind: 'html',
        label: '報道発表',
        url: 'https://www.cao.go.jp/press/houdou.html',
        itemPath: '^/(?:[0-9a-z_-]+/)+[0-9a-z_-]*\\d{4,}[0-9a-z_-]*\\.html$',
      },
    ],
    allowPaths: ['/'],
    // RSS の利用条件の断り（官邸と同じ）。RSS の配信とそのページは /rss/ の下
    denyPaths: ['/rss/'],
    body: { kind: 'html', scopes: GOV_SCOPES, dropLines: NAV_LINES, dropBlocks: PRESS_QUESTION_MARKS },
    hints: { region: 'jp', genres: ['politics', 'economy', 'ai'] },
    notes: ['会見の記録の記者の質問は落としてある。質問の中身は書かない', '統計は発表の値のまま書く'],
    terms: { status: 'ok', accepted: ACCEPTED, rssRefused: true },
    termsPages: [
      { url: 'https://www.cao.go.jp/notice/rule.html', scopes: GOV_SCOPES, watch: 'weekly' },
      { url: 'https://www.cao.go.jp/notice.html', scopes: GOV_SCOPES, watch: 'weekly' },
      { url: 'https://www.cao.go.jp/notice/aboutlink.html', scopes: GOV_SCOPES, watch: 'weekly' },
      { url: 'https://www.cao.go.jp/rss/index.html', scopes: GOV_SCOPES, watch: 'weekly' },
    ],
  },
  {
    id: 'digital',
    outlet: 'デジタル庁',
    hosts: { list: ['www.digital.go.jp'], body: ['www.digital.go.jp'] },
    lists: [
      {
        kind: 'rss',
        label: 'お知らせ',
        url: 'https://www.digital.go.jp/rss/news.xml',
        excludeCategories: ['調達', '採用'],
      },
    ],
    allowPaths: ['/'],
    denyPaths: ['/assets/'],
    body: {
      kind: 'html',
      scopes: GOV_SCOPES,
      dropLines: NAV_LINES,
      dropBlocks: PRESS_QUESTION_MARKS,
      qaPages: { paths: ['/speech/'], verified: false },
    },
    hints: { region: 'jp', genres: ['tech', 'ai'] },
    notes: ['会見の記録の記者の質問は落としてある。質問の中身は書かない', 'ロゴは使わない'],
    terms: { status: 'ok', accepted: ACCEPTED },
    termsPages: [
      { url: 'https://www.digital.go.jp/resources/open_data/public_data_license_v1.0', scopes: GOV_SCOPES, watch: 'weekly' },
      { url: 'https://www.digital.go.jp/copyright-policy', scopes: GOV_SCOPES, watch: 'weekly' },
      { url: 'https://www.digital.go.jp/site-policy', scopes: GOV_SCOPES, watch: 'weekly' },
      { url: 'https://www.digital.go.jp/rss', scopes: GOV_SCOPES, watch: 'weekly' },
    ],
  },
  {
    id: 'mhlw',
    outlet: '厚生労働省',
    hosts: { list: ['www.mhlw.go.jp'], body: ['www.mhlw.go.jp'] },
    lists: [
      {
        kind: 'html',
        label: '報道発表',
        url: 'https://www.mhlw.go.jp/stf/houdou/index.html',
        itemPath: '^/stf/(?:newpage_\\d+|houdou/\\d+[0-9a-z_-]*)\\.html$',
      },
      {
        kind: 'html',
        label: '大臣会見',
        url: 'https://www.mhlw.go.jp/stf/kaiken/index.html',
        itemPath: '^/stf/kaiken/daijin/[0-9a-z_-]+\\.html$',
      },
    ],
    allowPaths: ['/'],
    // RSS の利用条件の断り（官邸と同じ）・シンボルマーク・別紙の物（労働委員会の命令・裁判例のデータベース・中央労働委員会の公示送達など）
    denyPaths: ['/rss/', '/stf/news.rdf', '/stf/kinkyu.rdf', '/kouseiroudoushou/symbol/', '/churoi/meirei_db/', '/churoi/kouji/'],
    body: {
      kind: 'html',
      scopes: GOV_SCOPES,
      dropLines: NAV_LINES,
      dropBlocks: PRESS_QUESTION_MARKS,
      qaPages: { paths: ['/stf/kaiken/'], verified: false },
    },
    hints: { region: 'jp', genres: ['politics', 'economy', 'incident'] },
    notes: ['会見の記録の記者の質問は落としてある。質問の中身は書かない', 'シンボルマーク・写真は使わない'],
    terms: { status: 'ok', accepted: ACCEPTED, rssRefused: true },
    termsPages: [
      { url: 'https://www.mhlw.go.jp/chosakuken/', scopes: GOV_SCOPES, watch: 'weekly' },
      { url: 'https://www.mhlw.go.jp/chosakuken/exhibit.html', scopes: GOV_SCOPES, watch: 'weekly' },
      { url: 'https://www.mhlw.go.jp/rss/index.html', scopes: GOV_SCOPES, watch: 'weekly' },
    ],
  },
  {
    id: 'fdma',
    outlet: '消防庁',
    hosts: { list: ['www.fdma.go.jp'], body: ['www.fdma.go.jp'] },
    lists: [
      { kind: 'rss', label: '新着', url: 'https://www.fdma.go.jp/index.xml' },
      { kind: 'rss', label: '災害情報', url: 'https://www.fdma.go.jp/disaster/info/index.xml' },
      { kind: 'rss', label: '報道発表', url: 'https://www.fdma.go.jp/pressrelease/houdou/index.xml' },
      { kind: 'rss', label: 'お知らせ', url: 'https://www.fdma.go.jp/pressrelease/info/index.xml' },
    ],
    allowPaths: ['/'],
    denyPaths: [],
    // 一覧のページの #番号 の項目の文（中身は PDF が多い見込み。200字未満は出典にできない）
    body: { kind: 'anchor', dropBlocks: PRESS_QUESTION_MARKS },
    hints: { region: 'jp', genres: ['incident'] },
    notes: ['被害の数は発表の値と時点のまま書く', '第三者の写真・ほかから取った物は使わない'],
    terms: { status: 'ok', accepted: ACCEPTED },
    termsPages: [
      { url: 'https://www.fdma.go.jp/about/others/post3.html', scopes: GOV_SCOPES, watch: 'weekly' },
      { url: 'https://www.fdma.go.jp/about/rss.html', scopes: GOV_SCOPES, watch: 'weekly' },
    ],
  },
  {
    id: 'jma',
    outlet: '気象庁',
    hosts: { list: ['www.data.jma.go.jp'], body: ['www.data.jma.go.jp'] },
    lists: [
      {
        kind: 'atom',
        label: '随時の情報',
        url: 'https://www.data.jma.go.jp/developer/xml/feed/extra.xml',
        jmaKinds: true,
      },
      {
        kind: 'atom',
        label: '地震・火山',
        url: 'https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml',
        jmaKinds: true,
      },
    ],
    // 機械向けの Atom と電文だけ（地方気象台の利用上の注意が、ブラウザで見る前提の HTML の自動巡回を「原則として遠慮」とする）
    allowPaths: ['/developer/xml/'],
    // 使わない Atom（定時・その他・長い随時）
    denyPaths: [
      '/developer/xml/feed/regular.xml',
      '/developer/xml/feed/regular_l.xml',
      '/developer/xml/feed/other.xml',
      '/developer/xml/feed/other_l.xml',
      '/developer/xml/feed/extra_l.xml',
    ],
    body: { kind: 'jma-xml' },
    hints: { region: 'jp', genres: ['incident'] },
    notes: [
      '予報の値・区域・警報の種類を変えない。区域をまとめない',
      '自分の予想を書かない。見通しは電文の言葉だけ',
      '「気象庁によると」と発表の時刻を書く',
    ],
    // 本体の規約（www.jma.go.jp）が未読（この環境から届かなかった）。S1c で読むまで試しの回だけで取り、見張りの alarm も置かない
    terms: { status: 'trial-only', accepted: ACCEPTED },
    termsPages: [
      { url: 'https://www.jma.go.jp/jma/kishou/info/coment.html', scopes: GOV_SCOPES, watch: 'probe-only' },
      { url: 'https://www.data.jma.go.jp/developer/index.html', scopes: GOV_SCOPES, watch: 'probe-only' },
      { url: 'https://www.data.jma.go.jp/sapporo/about/kiyaku.html', scopes: GOV_SCOPES, watch: 'probe-only' },
      { url: 'https://xml.kishou.go.jp/xmlpull.html', scopes: GOV_SCOPES, watch: 'probe-only' },
    ],
  },
  {
    id: 'mlit',
    outlet: '国土交通省',
    hosts: { list: ['www.mlit.go.jp'], body: ['www.mlit.go.jp'] },
    lists: [{ kind: 'rss', label: '報道発表', url: 'https://www.mlit.go.jp/pressrelease.rdf' }],
    allowPaths: ['/'],
    // 別のルールの道（自動車総合安全情報・PLATEAU・住まいのリテラシー）
    denyPaths: ['/jidosha/anzen/', '/plateau/', '/sumai_literacy_pf/'],
    body: { kind: 'html', scopes: GOV_SCOPES, dropLines: NAV_LINES, dropBlocks: PRESS_QUESTION_MARKS },
    hints: { region: 'jp', genres: ['economy', 'incident'] },
    notes: ['会見の記録の記者の質問は落としてある。質問の中身は書かない', '共催・後援のように書かない'],
    terms: { status: 'ok', accepted: ACCEPTED },
    termsPages: [
      { url: 'https://www.mlit.go.jp/link.html', scopes: GOV_SCOPES, watch: 'weekly' },
      { url: 'https://www.mlit.go.jp/page/kanbo01_hy_003657.html', scopes: GOV_SCOPES, watch: 'weekly' },
      { url: 'https://www.mlit.go.jp/page/rssinfo.html', scopes: GOV_SCOPES, watch: 'weekly' },
    ],
  },
  {
    id: 'gv',
    outlet: 'Global Voices',
    hosts: { list: ['globalvoices.org'], body: ['globalvoices.org'] },
    lists: [{ kind: 'rss', label: '新着', url: 'https://globalvoices.org/feed/' }],
    // 記事のページは取らない（Crawl-delay 10秒で、全文が RSS にあるため。記事の URL は /feed/ の同じリンクの項目を返す）
    allowPaths: ['/feed/'],
    denyPaths: [],
    crawlDelaySec: 10,
    body: {
      kind: 'feed',
      // 「Unless otherwise stated」の別の条件の物の印（図の説明を除いた本文の、頭の2段と終わりの3段で探す。確かめていない推測の決まり）
      excludeIfContains: [
        'originally published',
        'first published',
        'was published',
        'republished',
        'reprinted',
        'is republished',
        'partnership',
        'All rights reserved',
        '©',
      ],
    },
    hints: { region: 'world', genres: ['tech'] },
    notes: ['英語。訳して書く。著者の名前はコネクタが出典に書く', '誰の言葉かを取り違えない。書き手の立場も主体として書く'],
    terms: { status: 'ok', accepted: ACCEPTED },
    termsPages: [
      { url: 'https://globalvoices.org/about/global-voices-attribution-policy/', scopes: ['main', 'article'], watch: 'weekly' },
      { url: 'https://globalvoices.org/about/global-voices-policy-on-ai/', scopes: ['main', 'article'], watch: 'weekly' },
      { url: 'https://globalvoices.org/feeds/', scopes: ['main', 'article'], watch: 'weekly' },
    ],
  },
]

/** 今は取らない所（S1b の probe 'hosts' で robots.txt を Worker から1回だけ見る） */
export const PENDING_HOSTS: readonly PendingHost[] = [
  {
    id: 'mofa',
    name: '外務省',
    host: 'www.mofa.go.jp',
    statusUrl: 'https://www.mofa.go.jp/mofaj/annai/legalmatters/index.html',
    termsPages: [
      { url: 'https://www.mofa.go.jp/mofaj/annai/legalmatters/index.html', scopes: GOV_SCOPES, watch: 'probe-only' },
      { url: 'https://www.mofa.go.jp/mofaj/rss/index.html', scopes: GOV_SCOPES, watch: 'probe-only' },
    ],
  },
  {
    id: 'mod',
    name: '防衛省',
    host: 'www.mod.go.jp',
    statusUrl: 'https://www.mod.go.jp/j/info/contents.html',
    termsPages: [
      { url: 'https://www.mod.go.jp/j/info/contents.html', scopes: GOV_SCOPES, watch: 'probe-only' },
      { url: 'https://www.mod.go.jp/j/rss/index.html', scopes: GOV_SCOPES, watch: 'probe-only' },
    ],
  },
  {
    id: 'meti',
    name: '経済産業省',
    host: 'www.meti.go.jp',
    statusUrl: 'https://www.meti.go.jp/main/rules.html',
    termsPages: [{ url: 'https://www.meti.go.jp/main/rules.html', scopes: GOV_SCOPES, watch: 'probe-only' }],
  },
]

/** notes の1つの長さの上限 */
export const SOURCE_NOTE_MAX = 60

/** 出どころの id で引く */
export function sourceById(sources: readonly SourceConfig[], id: string): SourceConfig | null {
  return sources.find((s) => s.id === id) ?? null
}

/** そのホストを一覧か本文のホストに持つ出どころ（data の並び） */
export function sourcesOfHost(sources: readonly SourceConfig[], host: string): SourceConfig[] {
  const h = host.toLowerCase()
  return sources.filter((s) => s.hosts.list.includes(h) || s.hosts.body.includes(h))
}

/** 本文のホストにそのホストを持つ出どころ */
export function bodySourcesOfHost(sources: readonly SourceConfig[], host: string): SourceConfig[] {
  const h = host.toLowerCase()
  return sources.filter((s) => s.hosts.body.includes(h))
}

/**
 * URL の出どころ（本文のホストの出どころのうち、その道を allowPaths に持つ物（長く当たる方）。無ければ全文の RSS の出どころ（記事の URL は
 * RSS から返す）。1つのホストに出どころが2つ以上ある時のため）。どれも無ければ null
 */
export function sourceForUrl(sources: readonly SourceConfig[], url: URL): SourceConfig | null {
  const on = bodySourcesOfHost(sources, url.hostname)
  const longest = (s: SourceConfig) =>
    Math.max(-1, ...s.allowPaths.filter((p) => url.pathname.startsWith(p)).map((p) => p.length))
  const allowed = on.filter((s) => s.body.kind !== 'feed' && longest(s) >= 0).sort((a, b) => longest(b) - longest(a))
  if (allowed.length) return allowed[0]
  const prefix = (s: SourceConfig) => {
    const list = s.lists[0] ? new URL(s.lists[0].url).pathname : ''
    let n = 0
    while (n < list.length && list[n] === url.pathname[n]) n++
    return n
  }
  // 1つのホストにほかの出どころもある時は、RSS の道と頭の段（/name/）が同じ物だけ
  const seg = (p: string) => p.split('/')[1] ?? ''
  const feeds = on
    .filter(
      (s) =>
        s.body.kind === 'feed' &&
        (on.length === 1 || (s.lists[0] && seg(new URL(s.lists[0].url).pathname) === seg(url.pathname))),
    )
    .sort((a, b) => prefix(b) - prefix(a))
  return feeds[0] ?? on[0] ?? null
}

/** 出どころが読むホストの全部（一覧と本文。data の並び・重なりなし） */
export function hostsOfSources(sources: readonly SourceConfig[]): string[] {
  const out: string[] = []
  for (const s of sources) for (const h of [...s.hosts.list, ...s.hosts.body]) if (!out.includes(h)) out.push(h)
  return out
}

/** 気象庁の出どころ（電文を本文にする出どころ。data の id に頼らない） */
export function jmaSourceOf(sources: readonly SourceConfig[]): SourceConfig | null {
  return sources.find((s) => s.body.kind === 'jma-xml') ?? null
}

/** 規約のページの指紋がそろっているか（指紋の無いページのある出どころは試しの回だけ） */
export function termsFingerprinted(src: Pick<SourceConfig, 'termsPages'>): boolean {
  return src.termsPages.every((p) => typeof p.fingerprint === 'string' && p.fingerprint !== '')
}
