// データの型（docs/SPEC.md の 7.1〜7.4・7.7）。アプリと段階3のコネクタ（Cloudflare Workers）で同じ物を使うので、ブラウザ・Dexie・
// Firebase・React に頼らない、ふつうの TypeScript にしておく（docs/SPEC.md の 7.7 の「名札」）。
// 段階0の DomainError（画面の操作の失敗を知らせる。src/store/uiStore.ts の attempt）は、そのまま残す。

/** 決まりの上でできない操作（画面ではエラーのお知らせにする。src/store/uiStore.ts の attempt） */
export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainError'
  }
}

// ---------- 決まった値（docs/SPEC.md の 7.1 の「決まった値と決まった文」） ----------
// 選べる値は英字の決まった値で持ち、画面の言葉（src/domain/fixedTexts.ts）と分ける。受け取った記録の知らない値（後の版で足した値）は
// 消さずに残す（docs/SPEC.md の 7.7 の「記録に共通の欄」。DS の形3）

export const REGION_VALUES = ['jp', 'world'] as const
/** 地域（国内・世界） */
export type Region = (typeof REGION_VALUES)[number]

export const GENRE_VALUES = ['politics', 'economy', 'tech', 'ai', 'incident', 'sports', 'entertainment'] as const
/** ジャンル（7つ。docs/SPEC.md の 6.2） */
export type Genre = (typeof GENRE_VALUES)[number]

export const CONCLUSION_LABEL_VALUES = ['settled', 'unsettled', 'outlook'] as const
/** 結論ラベル（確定・未確定・見通し。docs/SPEC.md の 5.3） */
export type ConclusionLabel = (typeof CONCLUSION_LABEL_VALUES)[number]

export const STANCE_VALUES = ['for', 'against', 'conditional', 'unknown'] as const
/** 当事者の立場（賛成・反対・条件付き・不明。docs/SPEC.md の 5.5） */
export type Stance = (typeof STANCE_VALUES)[number]

export const VIEW_KIND_VALUES = ['opposed', 'none'] as const
/** 見解の種類（対立見解あり・なし。docs/SPEC.md の 5.6） */
export type ViewKind = (typeof VIEW_KIND_VALUES)[number]

export const SLOT_VALUES = ['12', '20'] as const
/** 版の枠（12:00版・20:00版。D4） */
export type Slot = (typeof SLOT_VALUES)[number]

export const REASON_KIND_VALUES = ['quota', 'outage', 'timeout', 'no-sources', 'other'] as const
/** 作れなかった理由の種類（使用量の上限・障害・時間切れ・読める記事が足りない・そのほか。docs/SPEC.md の 7.2） */
export type ReasonKind = (typeof REASON_KIND_VALUES)[number]

/** 決まった値の並びにある値か */
export function isOneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v)
}

// ---------- 記録に共通の欄（docs/SPEC.md の 7.7） ----------

/** 書いた端末の ID のうち、コネクタが書く物（外側の文書の device。docs/SPEC.md の 7.7） */
export const CONNECTOR_DEVICE = 'claude-connector'

/** コネクタが作る記録（版・話題・辞書の束・作れなかった印・訂正）。誰も書き換えないので updatedAt は無い */
export interface ConnectorBase {
  id: string
  /** 記録の形の版（1 より大きい物は「新しい形の記録」。src/domain/repair.ts） */
  v: 1
  /** ミリ秒（UTC）。コネクタが組み立てた時刻 */
  createdAt: number
  by: 'connector'
  /** 知らない値は残し、「AI」と出す */
  ai: 'claude'
  /** 1〜60字。作った（書いた）モデルの名前（D7）。Claude が名乗った物 */
  model: string
  /** 1〜60字。どの回か（回を始める道具でコネクタが作った id。docs/SPEC.md の 7.8 の「コネクタの足す順」） */
  runId: string
}

/** アプリが作る記録（知ってる・既読） */
export interface UserBase {
  id: string
  v: 1
  createdAt: number
  updatedAt: number
  by: 'user'
  ai: null
}

// ---------- 話題 topics（docs/SPEC.md の 7.1） ----------

/** 結論ラベルと補足 */
export interface Conclusion {
  label: ConclusionLabel
  /** 0〜200字 */
  note: string
  /** 速報・未確認 */
  breaking: boolean
}

/** だから何？の4つ（各 1〜800字。null = 「この話題では特になし」） */
export interface SoWhat {
  /** 暮らし・お金 */
  life: string | null
  /** 社会の仕組み */
  system: string | null
  /** 世界の力関係 */
  world: string | null
  /** なぜ話題か */
  whyNews: string | null
}

/** 当事者の主張（docs/SPEC.md の 5.5） */
export interface Stakeholder {
  /** 1〜60字 */
  name: string
  stance: Stance
  /** 1〜60字（立場の補足） */
  stanceNote: string | null
  /** 1〜400字。null = 「今回集めた報道では、主張を確かめられなかった」（その時 stance は 'unknown'・stanceNote と reason は null） */
  claim: string | null
  /** 1〜300字（主張の理由。claim が null の時は null） */
  reason: string | null
}

/** AI の見解と対立見解（軸 1〜80字・論点 1〜150字・見解と対立見解 各 1〜800字） */
export interface OpposedView {
  kind: 'opposed'
  axis: string
  issue: string | null
  aiView: string
  counterView: string
}

/** 対立見解なし（null = 「対立する見解は特になし（事実の報道のため）」。ほかの理由は 1〜200字） */
export interface NoneView {
  kind: 'none'
  noneReason: string | null
}

/** 見解の欄（view） */
export type ViewSection = OpposedView | NoneView

/** 経緯の1行（書いた順。when は 'YYYY'・'YYYY-MM'・'YYYY-MM-DD' か null。記事に書かれた日付のまま。text 1〜160字） */
export interface TimelineEntry {
  when: string | null
  text: string
}

/** 続報（whatsNew 1〜200字） */
export interface FollowUp {
  prevTopicId: string
  whatsNew: string
}

/** 話題の用語（term 以外はコネクタが辞書から写す。その話題が出た時の説明のまま。D26） */
export interface TopicTerm {
  /** 辞書の語の id（'t' + 12字） */
  termId: string
  /** 1〜40字（この話題での表記） */
  term: string
  /** 0〜10件・各 1〜40字（辞書の写し） */
  aliases: string[]
  /** 1〜200字（その時の辞書の説明の写し） */
  explanation: string
  /** 'YYYY-MM'（辞書の写し） */
  asOf: string | null
}

/** 出典（docs/SPEC.md の 5.10） */
export interface Source {
  /** 1〜40字（社の名前の決まった一覧の書き方。src/domain/outlets.ts） */
  outlet: string
  /** 1〜200字 */
  title: string
  /** 'https:' で、ホストが outlet か via の決まったホストの物だけ。1〜2,000字 */
  url: string
  /** 'YYYY-MM-DDTHH:MM(:SS)?+09:00' か 'YYYY-MM-DD'。分からなければ null */
  publishedAt: string | null
  /** 1〜100字（「掲載日時は不明」など） */
  publishedNote: string | null
  /** 1〜40字。読んだ所（例 'Yahoo!ニュース'）。その時 url は読んだ所の URL、outlet は元の社 */
  via: string | null
}

/** 照合した件数（0〜500）・直した件数（0〜claims）・照合したモデル */
export interface TopicCheck {
  claims: number
  fixed: number
  model: string | null
}

/**
 * 強調（D24）。鍵は欄の道（src/domain/emphasis.ts の EMPHASIS_PATHS）、値はその欄の文に1字も違わずに含まれる語句の並び
 * （各 2〜40字・1つの欄に3つまで・全体で60まで）。強調の無い欄は鍵を書かない。1つも無い時は {}
 */
export type Emphasis = Record<string, string[]>

/** 話題（id = '{editionId}-{指紋8字}'。docs/SPEC.md の 7.1） */
export interface Topic extends ConnectorBase {
  editionId: string
  /** 続報をつなぐ id（初めて出た話題は自分の id） */
  threadId: string
  /** 1〜30（作った時の順位。正は版の order） */
  rank: number
  /** 1〜200字 */
  rankReason: string
  region: Region
  genre: Genre
  major: boolean
  /** 1〜60字（目安 30字台） */
  headline: string
  /** 1〜300字（目安 120〜200字・空白を除く） */
  summary: string
  conclusion: Conclusion
  soWhat: SoWhat
  /** 0〜15件。並びに意味がある（政治は議席の多い順） */
  stakeholders: Stakeholder[]
  view: ViewSection
  /** 0〜12行 */
  timeline: TimelineEntry[]
  followUp: FollowUp | null
  /** 0〜20語（目安 11〜13語） */
  terms: TopicTerm[]
  /** 1〜8本（D23） */
  sources: Source[]
  /** 1〜30件・各 1〜40字。並びは sources の outlet（sources の順・重なりを除く）を先に、そのあとにほかの社。「n社」= 長さ */
  outletNames: string[]
  /** 0〜15件・各 1〜300字（確かめられなかった点） */
  unverified: string[]
  /** 照合しなかった時は null（「照合済み」を出さない） */
  check: TopicCheck | null
  emphasis: Emphasis
}

/** 訂正（id = '{topicId}-{指紋8字}'。指紋は text。D25。docs/SPEC.md の 7.1 の「訂正」） */
export interface CorrectionRecord extends ConnectorBase {
  /** 訂正する話題の id */
  topicId: string
  /** その話題の版の id（topicId の頭と同じ。コネクタが話題から写す） */
  editionId: string
  /** 1〜300字。何がどう誤りで、正しくは何か（ふつうの文） */
  text: string
}

// ---------- 版 editions・作れなかった印 editionFails（docs/SPEC.md の 7.2） ----------

/** 選ばなかった候補（見出し 120字・理由 150字。docs/SPEC.md の 6.5） */
export interface NotChosen {
  headline: string
  whyNot: string
}

/** 版（id = '2026-11-15-12'。版の記録 = 出してよいの印） */
export interface Edition extends ConnectorBase {
  /** 'YYYY-MM-DD'（日本時間） */
  date: string
  slot: Slot
  /** 話題の id。1〜30件。正の並び */
  order: string[]
  /** 0〜10,000。候補の数（docs/SPEC.md の 6.5） */
  candidateCount: number | null
  /** 0〜20件 */
  notChosen: NotChosen[]
  /** 候補を集めた窓（ISO 8601・+09:00） */
  window: { since: string; until: string } | null
  /** 測れる時だけ（docs/SPEC.md の 4.9） */
  usage: { tokens?: number; toolCalls?: number; minutes?: number } | null
}

/** 作れなかった印（id = '{editionId}-{指紋8字}'。指紋は runId・reasonKind・reason。版と別の id） */
export interface EditionFail extends ConnectorBase {
  editionId: string
  reasonKind: ReasonKind
  /** 1〜200字（画面に出す短い理由） */
  reason: string
}

// ---------- 用語の辞書 termPacks（docs/SPEC.md の 7.3） ----------

/** 辞書の1語 */
export interface TermEntry {
  /** 't' + 12字（key の指紋） */
  termId: string
  /** 1〜60字（照らすための形）。国などで中身の違う語は括弧の添え字を付けてよい（例「与党（日本）」） */
  key: string
  /** 1〜40字（見出しの表記） */
  term: string
  /** 0〜10件・各 1〜40字 */
  aliases: string[]
  /** 1〜200字 */
  explanation: string
  /** 'YYYY-MM' */
  asOf: string | null
  /** 1〜。同じ語の新しい説明ほど大きい（コネクタが付ける） */
  rev: number
  /** この語を辞書から外す（誤った語・使わなくなった語） */
  retired?: true
}

/** 辞書の束（id = '{editionId}-{指紋8字}'。指紋は entries の中身） */
export interface TermPack extends ConnectorBase {
  /** どの版の作業で足したか */
  editionId: string
  /** 1〜200語 */
  entries: TermEntry[]
}

// ---------- アプリ側だけの記録（docs/SPEC.md の 7.4） ----------

/** 知ってる（id = termId） */
export interface KnownTerm extends UserBase {
  /** 1〜40字（押した時の表記。設定の一覧に出す） */
  term: string
  /** 知っている説明のうち、いちばん新しい時点（'YYYY-MM'。null がいちばん古い） */
  asOf: string | null
  /** false = 外した（記録は消さない） */
  on: boolean
}

/** 既読・見た版（id = editionId。Claude が読めない置き場） */
export interface ReadMark extends UserBase {
  editionId: string
  /** 0〜30件。読んだ話題の id（重なり無し） */
  topicIds: string[]
  /** その版の一覧を見たか（追いつき） */
  seen: boolean
}

// ---------- 表と置き場（docs/SPEC.md の 7.7 の「表の一覧」） ----------

/** コネクタが作る表（誰も書き換えない） */
export const CONNECTOR_TABLES = ['editions', 'topics', 'corrections', 'termPacks', 'editionFails'] as const
export type ConnectorTableName = (typeof CONNECTOR_TABLES)[number]

/** アプリが作る・直す表 */
export const USER_TABLES = ['knownTerms', 'reads'] as const
export type UserTableName = (typeof USER_TABLES)[number]

export const TABLE_NAMES = [...CONNECTOR_TABLES, ...USER_TABLES] as const
export type TableName = (typeof TABLE_NAMES)[number]

/** 置き場: Claude が読める records と、Claude が読めない private（既読だけ。D21） */
export type Place = 'records' | 'private'

/** 表ごとの置き場（reads は必ず private、ほかは records。docs/SPEC.md の 7.7） */
export const TABLE_PLACE: Readonly<Record<TableName, Place>> = {
  editions: 'records',
  topics: 'records',
  corrections: 'records',
  termPacks: 'records',
  editionFails: 'records',
  knownTerms: 'records',
  reads: 'private',
}

/** 30日で消す表（docs/SPEC.md の 7.8 の「30日で消す」）。knownTerms・termPacks は消さない */
export const EXPIRING_TABLES = ['editions', 'topics', 'corrections', 'editionFails', 'reads'] as const
export type ExpiringTableName = (typeof EXPIRING_TABLES)[number]

/** 表の名前 → 記録の型 */
export interface TableRecords {
  editions: Edition
  topics: Topic
  corrections: CorrectionRecord
  termPacks: TermPack
  editionFails: EditionFail
  knownTerms: KnownTerm
  reads: ReadMark
}

/**
 * 1件の文書の形（外側。docs/SPEC.md の 7.7 の「1件の文書の形」）。DS・NS の RecordDoc と同じ8つの欄。
 * json は記録をキーの順にそろえた JSON（stableStringify）、hash はその指紋（recordHash）、updated はサーバー時刻（Firestore の
 * Timestamp。domain は Firebase に頼らないので型は呼ぶ側が決める）、device は書いた端末の ID（コネクタは CONNECTOR_DEVICE）。
 * chunks はいつも 0、deleted はいつも false（分けた文書と削除の印を使わない。ルールで決め打ち）
 */
export interface RecordDoc<TUpdated = unknown> {
  table: TableName
  id: string
  json: string
  chunks: 0
  deleted: false
  hash: string
  updated: TUpdated
  device: string
}

/** 外側の文書の id（'{表名}:{id}'） */
export const docIdOf = (table: TableName, id: string): string => `${table}:${id}`
