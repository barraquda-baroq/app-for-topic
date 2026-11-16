// 追いつき（docs/SPEC.md の 9. の「追いつき」・7.8 の「続報のつなぎ」の 3.・7.4 の reads.seen）。しばらく開かなかった後に、見ていない版の
// 話題を、続報は threadId ごとに最新の1本にまとめ、重大印 → 各版の順位（版の order の位置。正は order。7.2）→ 新しい版の順に並べる。
// どの版を見ていないかで出し方を変えるだけで、選ぶ話題は変えない（D21。既読・見たは出し方にだけ使う）。
// - catchUpTargetIds: 追いつく版（新しい方から6版の中で、出している版より前で、最後に見た版より後の版）。版の一覧と既読だけで決め、
//   話題は読まない（30日分の話題（約 12MB）を読まない。16.6 の 56）
// - catchUpItems: 追いつく版の話題の並び（読んだ版の写しを渡す。多くて5版・100本）
// 画面に頼らない純粋な関数（開発。設計: 段階2の 1.8）。ストアの catchUpTargets・loadCatchUp（src/store/appStore.ts）が使う
import { parseEditionId } from './ids'
import { isWithinRetention } from './jst'

/** さかのぼる版の数（新しい方から。トップの付いていく版の FOLLOW_SCAN と同じ3日分。■8 で確かめる。設計: 段階2の 1.8） */
export const CATCH_UP_SCAN = 6

/**
 * 追いつきの帯を出す、追いつく版の数の下限（まる1日分。1日1回だけ開く人に毎日は出さない。■8 で確かめる。設計: 段階2の 1.8）
 */
export const CATCH_UP_MIN = 2

export interface CatchUpTargetInput {
  /** 時刻（ミリ秒。端末の時計。30日の内か） */
  now: number
  /** 版の記録の id（useApp の editions の id。新しい形の版の記録は入れない。出せないので） */
  editionIds: readonly string[]
  /** 見た版か（既読の記録 reads の editionId → seen） */
  seen: Readonly<Record<string, { seen: boolean } | undefined>>
  /** 出している版（いちばん新しい出せる版に付いていく時の版。無ければ null = 追いつく版は無い） */
  shownId: string | null
}

/**
 * 追いつく版の id（新しい順）。新しい方から CATCH_UP_SCAN 個の版（30日の内）のうち、出している版より前で、最後に見た版（出している版より
 * 前で seen の、30日の内でいちばん新しい版）より後の版。最後に見た版が6版の中に無い時は、6版の中の出している版より前の版全部。
 * 30日の内に見た版が1つも無い時（初めて使う時）・出している版が無い時は []。帯を出すかは length >= CATCH_UP_MIN で決める
 */
export function catchUpTargetIds(input: CatchUpTargetInput): string[] {
  const { now, shownId } = input
  if (shownId === null) return []
  const within = (id: string) => {
    const p = parseEditionId(id)
    return p !== null && isWithinRetention(p.date, now)
  }
  let lastSeen: string | null = null
  for (const [id, mark] of Object.entries(input.seen))
    if (mark?.seen === true && id < shownId && within(id) && (lastSeen === null || id > lastSeen)) lastSeen = id
  if (lastSeen === null) return []
  const scan = [...new Set(input.editionIds)].filter(within).sort().reverse().slice(0, CATCH_UP_SCAN)
  return scan.filter((id) => id < shownId && id > lastSeen)
}

/** 追いつきに並べる話題の、並べ方に使う欄（ShownTopic の一部） */
export interface CatchUpTopic {
  id: string
  threadId: string
  major: boolean
}

/** 追いつく版1つ（読んだ版の写し。topics は端末にある order の話題） */
export interface CatchUpEdition<T extends CatchUpTopic> {
  editionId: string
  order: readonly string[]
  topics: readonly T[]
}

/** 追いつきの1本（どの版の、order の何番目の話題か） */
export interface CatchUpItem<T extends CatchUpTopic> {
  topic: T
  editionId: string
  /** 版の order の中の位置（0 から。正は order。docs/SPEC.md の 7.2） */
  position: number
}

/**
 * 追いつきの並び。渡した版の話題だけを集め（今の版は入れない）、threadId ごとにいちばん新しい版の1本にする（その1本が今の版にある鎖は、
 * 今の版で読めるので外す）。並びは重大印 → 版の order の位置 → 新しい版の順。知らない地域・ジャンルの話題も残す（選ぶ話題は変えない。D21）。
 * current は今出している版（無ければ null）
 */
export function catchUpItems<T extends CatchUpTopic>(
  editions: readonly CatchUpEdition<T>[],
  current: { editionId: string; topics: readonly T[] } | null,
): CatchUpItem<T>[] {
  const inCurrent = new Set(current?.topics.map((t) => t.threadId) ?? [])
  const newest = new Map<string, CatchUpItem<T>>()
  for (const ed of editions) {
    if (current && ed.editionId === current.editionId) continue
    for (const topic of ed.topics) {
      const position = ed.order.indexOf(topic.id)
      const item: CatchUpItem<T> = { topic, editionId: ed.editionId, position: position < 0 ? ed.order.length : position }
      const had = newest.get(topic.threadId)
      // 同じ鎖はいちばん新しい版の1本（同じ版に2本ある時は order の前の方）
      if (!had || item.editionId > had.editionId || (item.editionId === had.editionId && item.position < had.position))
        newest.set(topic.threadId, item)
    }
  }
  return [...newest.entries()]
    .filter(([threadId]) => !inCurrent.has(threadId))
    .map(([, item]) => item)
    .sort(
      (a, b) =>
        Number(b.topic.major) - Number(a.topic.major) ||
        a.position - b.position ||
        (a.editionId < b.editionId ? 1 : a.editionId > b.editionId ? -1 : 0),
    )
}
