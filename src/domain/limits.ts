// 上限（RECORD_LIMITS）と決まりの範囲（RECORD_NORMS）（docs/SPEC.md の 7.1 の「上限の一覧と決まりの範囲」・7.2〜7.4）。
// アプリ・段階3のコネクタ・ルールで同じ値を使う（NS の RECORD_LIMITS と同じ考え）。上限を超えた物はコネクタが断り、決まりの範囲の外は
// 断らずに知らせる（定期実行の報告に書く。docs/SPEC.md の 16.6 の 13）。確かめる関数は src/domain/validate.ts（コネクタが送る直前）と
// src/domain/emphasis.ts（強調）。
// 字数は Unicode の文字（コードポイント）で前後の空白を除いて数える（DS・NS と同じ。countChars）。json の長さは JS の文字列の長さ。
import type { TableName } from './types'

/** 上限（境目の字数で通り、1字多いと断る。下の段は 7.1〜7.4 の型の注釈と同じ値） */
export const RECORD_LIMITS = {
  /** 1件の記録の json（stableStringify）の長さ（UTF-16。ルールの appDoc・connectorCreate と同じ値。docs/SPEC.md の 7.7） */
  json: {
    topics: 100_000,
    editions: 20_000,
    termPacks: 200_000,
    editionFails: 2_000,
    corrections: 2_000,
    knownTerms: 2_000,
    reads: 5_000,
  } satisfies Record<TableName, number>,
  /** 記録に共通の欄（docs/SPEC.md の 7.7 の「記録に共通の欄」） */
  base: { model: 60, runId: 60 },
  /** 話題（docs/SPEC.md の 7.1） */
  topic: {
    rankMin: 1,
    rankMax: 30,
    rankReason: 200,
    headline: 60,
    summary: 300,
    conclusionNote: 200,
    soWhat: 800,
    stakeholders: 15,
    stakeholderName: 60,
    stanceNote: 60,
    claim: 400,
    claimReason: 300,
    axis: 80,
    issue: 150,
    aiView: 800,
    counterView: 800,
    noneReason: 200,
    timeline: 12,
    timelineText: 160,
    whatsNew: 200,
    terms: 20,
    term: 40,
    termAliases: 10,
    termAlias: 40,
    termExplanation: 200,
    sourcesMin: 1,
    sources: 8,
    outlet: 40,
    sourceTitle: 200,
    url: 2_000,
    publishedNote: 100,
    via: 40,
    /** 出典の著者（著者を書く決まりのある出どころだけ。段階3で足した） */
    author: 80,
    outletNamesMin: 1,
    outletNames: 30,
    outletName: 40,
    unverified: 15,
    unverifiedText: 300,
    checkClaims: 500,
    checkModel: 60,
  },
  /** 強調（docs/SPEC.md の 7.1 の「強調」）。各 2〜40字・1つの欄に3つまで・全体で60まで */
  emphasis: { phraseMin: 2, phraseMax: 40, perField: 3, total: 60 },
  /** 版（docs/SPEC.md の 7.2） */
  edition: { orderMin: 1, order: 30, candidateCount: 10_000, notChosen: 20, notChosenHeadline: 120, whyNot: 150 },
  /** 作れなかった印（docs/SPEC.md の 7.2） */
  editionFail: { reason: 200 },
  /** 辞書の束（docs/SPEC.md の 7.3） */
  termPack: { entriesMin: 1, entries: 200, key: 60, term: 40, aliases: 10, alias: 40, explanation: 200 },
  /** 訂正（docs/SPEC.md の 7.1 の「訂正」。1つの話題に10件までは案。コネクタが断る） */
  correction: { text: 300, perTopic: 10 },
  /** 知ってる（docs/SPEC.md の 7.4） */
  knownTerm: { term: 40 },
  /** 既読（docs/SPEC.md の 7.4） */
  read: { topicIds: 30 },
} as const

/**
 * 決まりの範囲（外れたらコネクタが知らせる。断らない。docs/SPEC.md の 7.1 の「上限の一覧と決まりの範囲」）。
 * 強調の「1つの欄に1〜2か所」は書き方の目安で、3か所でも知らせない。
 * 版の本数・門・予備は、段階3で出どころを府省・庁の発表と Global Voices に替えて、目安10本にした（作者に伺っている Q17 の今の決め方 A。
 * 段階3の設計の 4.13）。コネクタの数の門・決まりの文・依頼文のテストが同じ値を読む
 */
export const RECORD_NORMS = {
  /** 版の話題の数（order。目安。外れたら知らせるだけ。段階2までは 20） */
  editionTopics: 10,
  /**
   * 数の門: 照合済みの下書きがこの数に届くまで、版の回は話題を足さない（辞書の束も書かない）。order がこの数より少ない版は断る。
   * 届かなければ作れなかった印（段階3の設計の 1.3・4.10）
   */
  editionGate: 5,
  /** 選ぶ係が選ぶ予備の本数（読める候補が 門＋予備 に届かなければ選ぶ前に作れなかった印。段階3の設計の 4.13） */
  editionSpares: 3,
  /**
   * 1つの版の中の、ジャンルごとの本数（7つのジャンルそれぞれ）。最低は 0（候補にあるジャンルに1本以上は選ぶ係の決まりで、候補に無い
   * ジャンルを知らせ続けないため。段階2までは 1）。最大5本（版の半分まで）
   */
  genrePerEdition: { min: 0, max: 5 },
  /** 重大印（1日あたり） */
  majorPerDay: { min: 0, max: 3 },
  /** 見出し（30字台） */
  headline: { min: 30, max: 39 },
  /** 要約（空白を除いて数える） */
  summaryNonSpace: { min: 120, max: 200 },
  /** 用語の数 */
  terms: { min: 11, max: 13 },
  /** AI の見解と対立見解の分量の差（長い方の1割まで） */
  viewDiffRatio: 0.1,
  /** 強調: 1つの欄の語句の字数の合計が、欄の字数の2割と12字の大きい方まで */
  emphasis: { ratio: 0.2, minChars: 12 },
} as const

/**
 * 出典にできる資料の本文の字数の下限（これより短い資料は出典にできず、読める候補にも数えない。PDF の資料だけの発表など。段階3の設計の
 * 1.2・1.5。D23・5.10 の「実際に開いて読んだ記事だけ」を作りで守る）
 */
export const SOURCE_BODY_MIN_CHARS = 200

/** 字数（Unicode の文字＝コードポイントで、前後の空白を除いて数える。DS・NS と同じ） */
export function countChars(s: string): number {
  return Array.from(s.trim()).length
}

/** 空白を除いた字数（要約の決まりの範囲「120〜200字（空白を除く）」） */
export function countNonSpace(s: string): number {
  let n = 0
  for (const c of s) if (!/\s/.test(c)) n += 1
  return n
}

/** 文字の並びで、字数が min〜max に入るか */
export function withinChars(v: unknown, min: number, max: number): v is string {
  if (typeof v !== 'string') return false
  const n = countChars(v)
  return n >= min && n <= max
}
