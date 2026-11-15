// 決まった値の画面の言葉と、アプリが出す決まった文（docs/SPEC.md の 7.1 の「決まった値と決まった文」）。
// 決まった文（「この話題では特になし」など）は記録に持たず、null・kind: 'none' などの印で持つ。アプリがここの文を出す（揺れを無くす）。
// 知らない値（後の版で足した値）の扱いも表のとおりにする（地域・ジャンルは総合にだけ出す・ラベルは出さない・立場は「不明」と同じ・
// 枠は版として出さない・作れなかった理由は「そのほか」）。
import { isYm } from './jst'
import {
  CONCLUSION_LABEL_VALUES,
  GENRE_VALUES,
  isOneOf,
  REASON_KIND_VALUES,
  REGION_VALUES,
  SLOT_VALUES,
  STANCE_VALUES,
  type ConclusionLabel,
  type Genre,
  type ReasonKind,
  type Region,
  type Slot,
  type Stance,
} from './types'

// ---------- 決まった値の画面の言葉 ----------

export const REGION_LABELS: Readonly<Record<Region, string>> = { jp: '国内', world: '世界' }

export const GENRE_LABELS: Readonly<Record<Genre, string>> = {
  politics: '政治',
  economy: '経済',
  tech: 'テクノロジー',
  ai: 'AI',
  incident: '事故・事件',
  sports: 'スポーツ',
  entertainment: 'エンタメ',
}

/** ジャンルの切り替えの列の言葉（短い形。テクノロジーは「テック」、事故・事件は「事件」） */
export const GENRE_TAB_LABELS: Readonly<Record<Genre, string>> = { ...GENRE_LABELS, tech: 'テック', incident: '事件' }

export const CONCLUSION_LABEL_TEXTS: Readonly<Record<ConclusionLabel, string>> = {
  settled: '確定',
  unsettled: '未確定',
  outlook: '見通し',
}

/** 速報・未確認の印（docs/SPEC.md の 5.3） */
export const BREAKING_LABEL = '速報・未確認'

export const STANCE_LABELS: Readonly<Record<Stance, string>> = {
  for: '賛成',
  against: '反対',
  conditional: '条件付き',
  unknown: '不明',
}

export const SLOT_LABELS: Readonly<Record<Slot, string>> = { '12': '12:00', '20': '20:00' }

export const REASON_KIND_LABELS: Readonly<Record<ReasonKind, string>> = {
  quota: '使用量の上限',
  outage: '障害',
  timeout: '時間切れ',
  'no-sources': '読める記事が足りない',
  other: 'そのほか',
}

/** 地域の言葉（知らない値は null = 国内・世界のどちらにも並べず、総合にだけ出す） */
export function regionLabel(v: unknown): string | null {
  return isOneOf(REGION_VALUES, v) ? REGION_LABELS[v] : null
}

/** ジャンルの言葉（知らない値は null = 総合にだけ出す。D20 の小説のネタを後で足せる） */
export function genreLabel(v: unknown, short = false): string | null {
  return isOneOf(GENRE_VALUES, v) ? (short ? GENRE_TAB_LABELS : GENRE_LABELS)[v] : null
}

/** 結論ラベルの言葉（知らない値は null = ラベルを出さない） */
export function conclusionLabelText(v: unknown): string | null {
  return isOneOf(CONCLUSION_LABEL_VALUES, v) ? CONCLUSION_LABEL_TEXTS[v] : null
}

/** 立場の言葉（知らない値は「不明」と同じ） */
export function stanceLabel(v: unknown): string {
  return isOneOf(STANCE_VALUES, v) ? STANCE_LABELS[v] : STANCE_LABELS.unknown
}

/** 枠の言葉（'12:00'。知らない値は null = 版として出さない） */
export function slotLabel(v: unknown): string | null {
  return isOneOf(SLOT_VALUES, v) ? SLOT_LABELS[v] : null
}

/** 作れなかった理由の言葉（知らない値は「そのほか」） */
export function reasonKindLabel(v: unknown): string {
  return isOneOf(REASON_KIND_VALUES, v) ? REASON_KIND_LABELS[v] : REASON_KIND_LABELS.other
}

/** 書いた AI の言葉（'claude' は「Claude」、知らない値は「AI」。docs/SPEC.md の 7.7 の「記録に共通の欄」） */
export function aiLabel(v: unknown): string {
  return v === 'claude' ? 'Claude' : 'AI'
}

// ---------- アプリが出す決まった文 ----------

export const FIXED_TEXTS = {
  /** 1. soWhat.* が null */
  soWhatNone: 'この話題では特になし',
  /** 2. stakeholders[].claim が null */
  claimUnverified: '今回集めた報道では、主張を確かめられなかった',
  /** 3. view.kind == 'none' かつ noneReason が null */
  viewNone: '対立する見解は特になし（事実の報道のため）',
  /** 4. 当事者の見出しの文（docs/SPEC.md の 5.5） */
  stakeholdersNote: '（並べて示すだけで、どれが正しいかは判定しません）',
  /** 5. 共通の注記（docs/SPEC.md の 5.7） */
  commonNote:
    '「AI の見解」と「対立見解」は、どちらも AI が書いたもので、偏っている可能性があります。両方をあわせて読み、必要なら元記事で確かめてください。',
  /**
   * 6. genre == 'ai' の見解の注記（AI 自身が当事者。docs/SPEC.md の 5.6）。文は段階2で決める（仮。開発が置いた文で、作者に確かめる）
   */
  aiGenreNote:
    'この話題は AI についての話題で、書いている AI 自身が当事者です。見解には、その立場の偏りが入っている可能性があります。',
  /** 8. 訂正の頭の言葉（出し方と言葉は段階2） */
  correctionPrefix: '訂正:',
  /** 記録の v が 1 より大きい物（書き戻さない。docs/SPEC.md の 7.1） */
  newerRecord: '新しい形の記録（アプリを更新してください）',
} as const

/** 7. 作れなかった版（「12:00版は作れませんでした（使用量の上限）」。知らない枠は null = 出さない） */
export function editionFailedText(slot: unknown, reasonKind: unknown): string | null {
  const s = slotLabel(slot)
  return s === null ? null : `${s}版は作れませんでした（${reasonKindLabel(reasonKind)}）`
}

/** 版の名前（「12:00版」。知らない枠は null） */
export function editionSlotText(slot: unknown): string | null {
  const s = slotLabel(slot)
  return s === null ? null : `${s}版`
}

/** 9. 用語の説明の時点（話題の用語の asOf 'YYYY-MM' から「2026年11月時点」。asOf が null・形が違う時は null = 添えない。D26） */
export function asOfText(asOf: unknown): string | null {
  if (!isYm(asOf)) return null
  return `${Number(asOf.slice(0, 4))}年${Number(asOf.slice(5, 7))}月時点`
}
