// 話題の詳細だけの画面の言葉（docs/SPEC.md の 9. の「詳細」・7.6 のクリップ・5.8 の「知ってる」）。詳細の部品（src/features/topic）が
// 同じ言葉を使うので、1か所に置く（開発。設計: 段階2の 1.10・1.13・1.14）。記録の決まった値の言葉と決まった文（「この話題では特になし」
// など。docs/SPEC.md の 7.1）は src/domain/fixedTexts.ts、カードと共通の印（「重大」「続報」）は src/features/top/texts.ts にあり、
// ここでは足さない。言葉の直しは、ここの文だけを替える。
// 段階3で、出典の区切りの見出しを「元記事」から「出典」に替え（言葉は src/domain/fixedTexts.ts の SOURCE_WORDS。Q19 のあわせての A）、
// CC BY の出典（Global Voices）の話題の頭の1行の、元記事へのリンクの言葉を足した（段階3の設計の 3.4）
import { aiLabel, SOURCE_WORDS } from '../../domain/fixedTexts'

/** 区切りの見出し（詳細の中の並び。設計: 段階2の 1.10） */
export const DETAIL_HEADS = {
  soWhat: 'だから何？',
  stakeholders: '当事者の主張',
  view: 'AI の見解と対立見解',
  timeline: '経緯',
  terms: '用語',
  sources: SOURCE_WORDS.sources,
} as const

/** だから何？の4つの観点の小見出し（docs/SPEC.md の 5.4。並びもこの順） */
export const SO_WHAT_LABELS = {
  life: '暮らし・お金',
  system: '社会の仕組み',
  world: '世界の力関係',
  whyNews: 'なぜ話題か',
} as const

export const VIEW_TEXTS = {
  /** 対立の軸（必ず示す。docs/SPEC.md の 5.6） */
  axis: '対立の軸',
  /** 軸の後ろに添える論点 */
  issue: '論点',
  aiView: 'AI の見解',
  counterView: '対立見解',
} as const

/** 「確かめられなかった点（2）」（たたむ。docs/SPEC.md の 15.5） */
export function unverifiedText(count: number): string {
  return `確かめられなかった点（${count}）`
}

/** 続報の話題の「何が新しいか」の頭（docs/SPEC.md の 7.1 の followUp） */
export const FOLLOW_UP_PREFIX = '続報:'
/** 前の話題へのリンクの頭（設計: 段階2の 1.16） */
export const PREV_TOPIC_PREFIX = '前の話題:'
/** もっと新しい続報が端末にある時のリンクの頭 */
export const NEWER_TOPIC_PREFIX = 'この話題には続報があります:'

/** 前の話題・続報へのリンクの文（「{見出し}（{版}）」。版の名前が分からなければ見出しだけ） */
export function threadLinkText(headline: string, editionName: string | null): string {
  return editionName ? `${headline}（${editionName}）` : headline
}

/**
 * CC BY の出典の話題の頭の1行の後ろの、元記事へのリンクの文（「元記事: □□ボイス「題」」。Global Voices の帰属の決まり「元記事への
 * リンクと著者の名前を記事の頭に」。1行の文は src/domain/credit.ts の creditHeadText。段階3の設計の 3.4）
 */
export function creditHeadLinkText(outlet: string, title: string): string {
  return `元記事: ${outlet}「${title}」`
}

/** 出典の読んだ所（「（××ニュースで読んだ）」。docs/SPEC.md の 5.10・7.6） */
export function viaText(via: string): string {
  return `（${via}で読んだ）`
}

/** 照合の件数（docs/SPEC.md の 4.5。件数を出し、照合したモデルの名前は出さない。設計: 段階2の 1.10） */
export function checkText(claims: number, fixed: number): string {
  return `照合: ${claims}件を元記事と照らし、${fixed}件を直しました`
}

/** その順位にした理由（docs/SPEC.md の 6.5。作者が時々のぞける所。カードには出さない） */
export function rankReasonText(rank: number, reason: string): string {
  return `この版で${rank}位にした理由: ${reason}`
}

/** 書いた AI（docs/SPEC.md の 7.7 の「記録に共通の欄」の ai） */
export function writerText(ai: unknown): string {
  return `書いた AI: ${aiLabel(ai)}`
}

/** ［知ってる］とその後（docs/SPEC.md の 5.8。閉じるまで消さずに取り消せる。設計: 段階2の 1.13） */
export const KNOWN_TEXTS = {
  press: '知ってる',
  pressed: '知ってるにしました',
  undo: '取り消す',
  /** 書けなかった時のお知らせ */
  failed: '『知ってる』にできませんでした',
} as const

/** 用語の説明の箱（■2 の A。押すと段落の下に開く） */
export const TERM_NOTE_TEXTS = {
  close: '説明を閉じる',
} as const

/** ［クリップ］（docs/SPEC.md の 7.6・9.） */
export const CLIP_TEXTS = {
  button: 'クリップ',
  copied: 'クリップボードにコピーしました',
  /** クリップボードを使えない時の窓 */
  dialogTitle: 'クリップ',
  dialogNote: '選んでコピーしてください',
  /** 窓の文の欄の読み上げ */
  textLabel: 'クリップの文',
} as const

/** 詳細の頭・閉じる・読む間 */
export const DETAIL_TEXTS = {
  close: '閉じる',
  loading: '読み込み中…',
} as const
