// 話題の下書きの入力の形と、照合の直す所の形（段階3。段階3の設計の 1.5。docs/SPEC.md の 7.8 の「コネクタの足す順」の 3.）。
// 書く係は topic_save_draft でこの形を渡し、コネクタが資料の控えと辞書から記録を組み立てる（src/domain/assemble.ts）。照合の係は全文を
// 書き直さず、直す所（DraftPatch）だけを topic_check_draft で返し、コネクタが入力に当てて組み立て直す（src/domain/patch.ts）。
// 欄の名前は記録と同じ camelCase（16.6 の 14）。記録と違う所:
// - 強調は並びの要素ごと（当事者の主張は claimEmphasis、経緯の行は emphasis、ほかは欄ごとの emphasis）。コネクタが記録の鍵に組み立てる
// - 用語は termId か表記で指す（term 以外はコネクタが辞書から写す）。辞書に無い語・説明を新しくする語は、下書きの中で書く
// - 出典は資料の控えの ref だけ（url・題・掲載日時・社・著者はコネクタが控えから書く）。outletNames は入力に無い（出典の社から作る）
// - 続報は前の版の話題の短い id（'p:'＋8字）で指す。id・threadId・版・回・model・作った時刻・照合の件数は入力に無い
// connector の zod の入力の形が、この型に合うかを型で確かめる（connector の側。B3）。
import type { ConclusionLabel, Genre, Region, Stance } from './types'

/** 欄ごとに強調を付けられる入力の欄（当事者の主張と経緯の行は、要素ごとの欄で付ける） */
export const INPUT_EMPHASIS_FIELDS = [
  'summary',
  'conclusion.note',
  'soWhat.life',
  'soWhat.system',
  'soWhat.world',
  'soWhat.whyNews',
  'view.aiView',
  'view.counterView',
  'followUp.whatsNew',
] as const
export type InputEmphasisField = (typeof INPUT_EMPHASIS_FIELDS)[number]

/** 当事者の入力（claimEmphasis は主張の強調の語句） */
export interface StakeholderInput {
  name: string
  stance: Stance
  stanceNote: string | null
  claim: string | null
  reason: string | null
  claimEmphasis?: string[]
}

/** 見解の入力 */
export type ViewInput =
  | { kind: 'opposed'; axis: string; issue: string | null; aiView: string; counterView: string }
  | { kind: 'none'; noneReason: string | null }

/** 経緯の1行の入力（emphasis はその行の強調の語句） */
export interface TimelineInput {
  when: string | null
  text: string
  emphasis?: string[]
}

/** 続報の入力（prev は前の版の話題の短い id 'p:'＋8字。前の版の話題の一覧の中で解く） */
export interface FollowUpInput {
  prev: string
  whatsNew: string
}

/** 辞書に無い語（下書きの中で書く。辞書の束はコネクタが話題を足す最初の呼び出しで足す） */
export interface NewTermInput {
  key: string
  term: string
  aliases: string[]
  explanation: string
  asOf: string | null
}

/** 辞書の語の説明を新しくする（rev は今の辞書の rev ＋1） */
export interface ReviseTermInput {
  explanation: string
  asOf: string | null
  aliases?: string[]
}

/**
 * 用語の指し方: 辞書にある語（term はこの話題での表記。辞書の表記か別名）／辞書にある語を表記で指す（2つ以上に当たれば断る）／
 * 辞書に無い語／辞書の語の説明を新しくする
 */
export type TermRefInput =
  | { termId: string; term?: string }
  | { term: string }
  | { new: NewTermInput }
  | { termId: string; revise: ReviseTermInput }

/** 出典の入力（ref は 'c0012' か、この回で読んだ資料の URL。outlet は1つのホストに社が2つ以上ある時だけ（今の data には無い）） */
export interface SourceRefInput {
  ref: string
  outlet?: string
}

/** 話題の下書きの入力（topic_save_draft の topic） */
export interface TopicDraftInput {
  rank: number
  rankReason: string
  region: Region
  genre: Genre
  major: boolean
  headline: string
  summary: string
  conclusion: { label: ConclusionLabel; note: string; breaking: boolean }
  soWhat: { life: string | null; system: string | null; world: string | null; whyNews: string | null }
  stakeholders: StakeholderInput[]
  view: ViewInput
  timeline: TimelineInput[]
  followUp: FollowUpInput | null
  terms: TermRefInput[]
  sources: SourceRefInput[]
  unverified: string[]
  emphasis?: Partial<Record<InputEmphasisField, string[]>>
}

// ---------- 照合の直す所（段階3の設計の 1.5 の DraftPatch） ----------

/** 直した訳の種類（回の中で数え、版の答えと報告に出す。話題には件数だけ） */
export const PATCH_WHY_VALUES = [
  'name',
  'date',
  'number',
  'quote',
  'reason',
  'overstate',
  'notInSource',
  'rule',
  'term',
  /** 主体・誰の言い分か・決定の段階（発表の言い分を事実として書いた など） */
  'subject',
  /** 区域・対象（気象庁の警報の区域・震度の地点 など） */
  'area',
  'other',
] as const
export type PatchWhy = (typeof PATCH_WHY_VALUES)[number]

/**
 * 照合の直す所（path は入力の欄の道。'.' でつなぎ、並びは 0 から数える。例 'summary'・'stakeholders.1.claim'・'timeline.3'・'terms.5.explanation'）:
 * - find/to: 欄の文の一部を置き換える（find はその欄に1回だけ出る）
 * - set: 決まった値・null にする（例 conclusion.label・soWhat.life・stakeholders.1.claim）
 * - remove: 並びの要素を消す（timeline.3・stakeholders.2・terms.5・sources.1・unverified.0）
 * - add: 確かめられなかった点を足す（path は 'unverified' だけ）
 * - emphasis: 強調を入れ替える（欄ごと・要素ごと。直した数に数えない）
 */
export type DraftPatch =
  | { path: string; find: string; to: string; why: PatchWhy }
  | { path: string; set: unknown; why: PatchWhy }
  | { path: string; remove: true; why: PatchWhy }
  | { path: 'unverified'; add: string; why: PatchWhy }
  | { path: string; emphasis: string[] }

/** 1回の照合で当てられる直す所の数（topic_check_draft の patches） */
export const PATCHES_MAX = 60
