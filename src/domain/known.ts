// 「知ってる」（docs/SPEC.md の 7.4 の「知ってる knownTerms」・5.8・D26）の判定と、押す・外す・2台の合わせ方の部品。
// - 話題の用語（asOf）が「知ってる」か: on で、話題の asOf が null か、記録の asOf があって 話題の asOf ≦ 記録の asOf
//   （'YYYY-MM' は文字の比べで足りる）。記録の asOf が null で話題に asOf が付いた時は、もう一度出す
// - 押した時の asOf は、今の値と押した話題の asOf の新しい方（古い話題で押しても戻らない）。2台の合わせ方も新しい方
//   （「asOf が同じか」で決めると、古い話題と新しい話題で押すたびに行ったり来たりする）
// - 2台の合わせ方: on・term を1組（変えた側の2つをまとめて採る。両方が変えたらこの端末）。asOf は新しい方（docs/SPEC.md の 7.8 の
//   「既読・知ってるを送る・受け取る」）。3者マージそのもの（知らない欄・updatedAt など）は src/sync/merge.ts が受け持ち、ここは表の決まりだけ
// 記録は消さない（外す時も on を切り替えるだけ）。アプリと段階3のコネクタ（いまの説明で知ってる語を Claude に渡す）で同じ判定を使う。
import type { KnownTerm } from './types'

/** 押した語（話題の用語）の材料 */
export interface KnownTermPress {
  termId: string
  /** 押した時の表記（設定の一覧に出す） */
  term: string
  /** 押した話題の用語の説明の時点（'YYYY-MM' か null） */
  asOf: string | null
}

/** 2つの時点の新しい方（null がいちばん古い） */
export function newerAsOf(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return a >= b ? a : b
}

/**
 * 話題の用語が「知ってる」か（説明を出さない）。known は端末の記録（無ければ undefined・null）。
 * 古い話題で押しても新しい話題では出る・記録の asOf が null で、asOf の付いた話題はもう一度出る
 */
export function isKnownTerm(known: Pick<KnownTerm, 'on' | 'asOf'> | null | undefined, termAsOf: string | null): boolean {
  if (!known || known.on !== true) return false
  if (termAsOf === null) return true
  return typeof known.asOf === 'string' && termAsOf <= known.asOf
}

/**
 * 押した後の記録（新しく作るか、端末の記録 prev に重ねる）。prev の知らない欄は残す（DS の形3。アプリの記録はアプリが書き戻すので、
 * 表示用の写しではなく端末の記録に重ねる）。asOf は今の値と押した話題の asOf の新しい方
 */
export function pressKnownTerm(prev: KnownTerm | null | undefined, press: KnownTermPress, now: number): KnownTerm {
  if (!prev)
    return {
      id: press.termId,
      v: 1,
      createdAt: now,
      updatedAt: now,
      by: 'user',
      ai: null,
      term: press.term,
      asOf: press.asOf,
      on: true,
    }
  return { ...prev, term: press.term, asOf: newerAsOf(prev.asOf ?? null, press.asOf), on: true, updatedAt: now }
}

/** 外した後の記録（記録は消さず on を false に。asOf・term はそのまま） */
export function unpressKnownTerm(prev: KnownTerm, now: number): KnownTerm {
  return { ...prev, on: false, updatedAt: now }
}

/** 1組として合わせる欄（変えた側の組をまとめて採る。両方が変えたらこの端末。src/sync/merge.ts の FIELD_GROUPS に使う） */
export const KNOWN_TERM_FIELD_GROUP = ['on', 'term'] as const

type KnownFields = Pick<KnownTerm, 'on' | 'term' | 'asOf'>

/**
 * 2台の「知ってる」の、表の決まりの欄（on・term・asOf）を合わせる。base = 最後にそろえた中身（null = 共通の履歴が無い。両方が新しく作った
 * 時は、両方が変えたとみなしてこの端末を採る）、mine = この端末、theirs = クラウド。
 * 例: スマホで「知ってる」、電波の無い PC で外す → PC が後で同期すれば「外した」（PC が mine）
 */
export function mergeKnownTermFields(base: KnownFields | null, mine: KnownFields, theirs: KnownFields): KnownFields {
  const mineChanged = !base || base.on !== mine.on || base.term !== mine.term
  const pair = mineChanged ? mine : theirs
  return { on: pair.on, term: pair.term, asOf: newerAsOf(mine.asOf ?? null, theirs.asOf ?? null) }
}
