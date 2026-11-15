// 版を出す条件（docs/SPEC.md の 7.8 の「版を出す条件」）。画面のストア（16.2 の 7）と偽のクラウドのテスト（src/sync/fakeSync.test.ts）で
// 同じ物を使う。ブラウザ・Dexie・Firebase・React に頼らない（端末から読んだ物を渡す）。
// - 版の記録があり、版の日付が30日の内（端末の時計・日本時間）の時だけ出す。版の記録が無い話題は出さない（版の記録 = 出してよいの印。7.2）
// - order の話題が端末に全部ある時に出す。そろうまでは出さない（画面は前の版を出したまま「受け取り中」）。最初の受け取りが終わっても欠けて
//   いて、クラウドにも無いと分かった話題（コネクタの不具合。エンジンの fetchTopics の missing）だけが欠けている時は、そろっている話題だけで出す
// - いちばん新しい版は id の並びで最後（'2026-11-15-12' < '2026-11-15-20' < '2026-11-16-12'）
// - 訂正は、その話題が端末にある時に、その話題に付けて出す（届く順が前後しても、話題を読んだ時に話題の id で探す）。話題の無い訂正は出さない
import { parseEditionId } from './ids'
import { isWithinRetention } from './jst'

/** 版を出すかどうか */
export type EditionShowState<T> =
  /** 出す。topics は order の順の、端末にある話題。missing はクラウドにも無いと分かった話題（出さずに版を出す） */
  | { kind: 'ready'; topics: T[]; missing: string[] }
  /** まだ出さない（order の話題が端末にそろっていない）。missing は端末に無い話題 */
  | { kind: 'waiting'; missing: string[] }
  /** 30日の外（端末の時計） */
  | { kind: 'expired' }
  /** 版の id の形が違う・order が空（出せない） */
  | { kind: 'broken' }

/**
 * 版を出すか（edition は表示用の写し src/domain/repair.ts の repairEdition の値でよい）。topics は端末の中の order の話題
 * （persistence の getTopics(order) の値。order と同じ並びで、端末に無ければ null）。gone はクラウドにも無いと分かった話題の id
 */
export function editionShowState<T>(
  edition: { id: string; order: readonly string[] },
  topics: readonly (T | null | undefined)[],
  nowMs: number,
  gone: ReadonlySet<string> = new Set(),
): EditionShowState<T> {
  const parsed = parseEditionId(edition.id)
  if (!parsed || !edition.order.length) return { kind: 'broken' }
  if (!isWithinRetention(parsed.date, nowMs)) return { kind: 'expired' }
  const present: T[] = []
  const missing: string[] = []
  edition.order.forEach((id, i) => {
    const t = topics[i]
    if (t === null || t === undefined) missing.push(id)
    else present.push(t)
  })
  if (missing.some((id) => !gone.has(id))) return { kind: 'waiting', missing }
  // 全部が欠けた版は出さない（出す話題が1つも無い）
  if (!present.length) return { kind: 'broken' }
  return { kind: 'ready', topics: present, missing }
}

/** いちばん新しい版の id（id の並びで最後。無ければ null） */
export function newestEditionId(ids: Iterable<string>): string | null {
  let out: string | null = null
  for (const id of ids) if (parseEditionId(id) && (out === null || id > out)) out = id
  return out
}

/**
 * 訂正を話題ごとにまとめる（端末にある話題の分だけ。話題の無い訂正は出さない）。1つの話題の訂正は足された順（createdAt、同じなら id）。
 * corrections は表示用の写し（repairCorrection の値）でよい
 */
export function correctionsByTopic<C extends { id: string; topicId: string; createdAt: number }>(
  corrections: readonly C[],
  topicIds: Iterable<string>,
): Map<string, C[]> {
  const out = new Map<string, C[]>()
  for (const id of topicIds) out.set(id, [])
  for (const c of corrections) out.get(c.topicId)?.push(c)
  for (const list of out.values()) list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}
