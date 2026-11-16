// トップの状態の1行（docs/SPEC.md の 4.7・7.2・7.8・16.6 の 57）の選び方と、同期が落ち着いているか。画面に頼らない純粋な関数にして、
// 単体で確かめる（開発。設計: 段階2の 1.7）。トップ（src/features/top/EditionStatus.tsx）と版の一覧（src/store/appStore.ts の
// editionRows）が同じ決まりを使う。
// - 出すのは、出している版が「時刻の上でいちばん新しい枠（latestSlotAt(now)）」の版でない時だけ。その枠がいちばん新しい間だけ出し、
//   次の枠の時刻が来れば消える（後から版が届けば版を出す。docs/SPEC.md の 4.7）
// - 版の記録が1つも無い時（top-empty）・出せる版が無く待っている時（top-waiting）は出さない（段階3までは毎日 12:30・20:30 から
//   「まだ版はありません」と「12:00版はまだ届いていません」が並ぶため）
// - 「まだ届いていません」は枠の時刻の30分後から、同期が落ち着いている時だけ（オフラインで起動した時に一瞬でも出さない。設計: 段階2の 8. の 5）
// 言葉は D9 のとおり静かに（role="status" にしない・知らせない）。文はこのファイルに置き、画面の言葉（src/features/top/texts.ts）から
// 読み直す（domain は画面のファイルを読まない）
import { editionFailedText, editionNameText, editionSlotText } from './fixedTexts'
import { editionIdOf, parseEditionId } from './ids'
import { latestSlotAt, slotTimeMs } from './jst'
import type { SyncView } from '../sync/syncView'

/** 「まだ届いていません」を出すまでの分（枠の時刻から。開発。■11 の C は60分。設計: 段階2の 1.7） */
export const NOT_ARRIVED_AFTER_MIN = 30

const MINUTE_MS = 60 * 1000

/**
 * 同期が落ち着いているか（受け取りが済んでいる）。synced・pending・sending だけ true（どれも受け取りは済んでいて、未送信 → 送信中の間に
 * 1行が消えたり出たりしない）。null（ログインの直後・エンジンが始まる前・同期を受け持たないタブが状態を受け取る前）・downloading・
 * offline・quota・outdated・error は落ち着いていない（docs/SPEC.md の 7.8。設計: 段階2の 1.7・8. の 5）
 */
export function syncSettled(view: SyncView | null | undefined): boolean {
  return view?.kind === 'synced' || view?.kind === 'pending' || view?.kind === 'sending'
}

/** 状態の1行の種類（testid edition-status の data-kind。前の版を見ている時の 'past' は、トップの部品が出す） */
export type EditionStatusKind = 'waiting' | 'newer' | 'failed' | 'not-arrived'

export interface EditionStatus {
  kind: EditionStatusKind
  text: string
}

/** 待っている版を受け取っている時（「11/15（日）20:00版を受け取っています…」） */
export function waitingEditionText(editionId: string): string {
  const p = parseEditionId(editionId)
  const name = p ? editionNameText(p.date, p.slot) : null
  return `${name ?? '新しい版'}を受け取っています…`
}

/** いちばん新しい枠の版が、アプリより新しい形の記録の時（「20:00版は新しい形の記録です（アプリを更新してください）」） */
export function newerEditionText(slot: unknown): string {
  return `${editionSlotText(slot) ?? 'この版'}は新しい形の記録です（アプリを更新してください）`
}

/** いちばん新しい枠に版も作れなかった印も無いまま、時間がたった時（「20:00版はまだ届いていません」） */
export function notArrivedText(slot: unknown): string {
  return `${editionSlotText(slot) ?? 'この版'}はまだ届いていません`
}

/**
 * その枠の作れなかった印のうち、いちばん後に足した物（同じ枠でやり直して2つある時。足した時刻、同じなら id の順で後の物）。
 * 版の一覧の行（src/store/appStore.ts の editionRows）も使う
 */
export function latestFail<F extends { editionId: string; createdAt: number; id: string }>(
  fails: readonly F[],
  editionId: string,
): F | null {
  let out: F | null = null
  for (const f of fails) {
    if (f.editionId !== editionId) continue
    if (!out || f.createdAt > out.createdAt || (f.createdAt === out.createdAt && f.id > out.id)) out = f
  }
  return out
}

export interface EditionStatusInput {
  /** 時刻（ミリ秒。端末の時計） */
  now: number
  /** 版の記録の id（useApp の editions の id） */
  editionIds: readonly string[]
  /** 新しい形の版の記録の id（useApp の newerEditions） */
  newerIds: readonly string[]
  /** 作れなかった印（useApp の editionFails） */
  fails: readonly { id: string; editionId: string; reasonKind: string; createdAt: number }[]
  /** 出している版（opened.view が ready の版。無ければ null） */
  shownId: string | null
  /** 付いていく時に、出している版より新しく、話題がそろうのを待っている版（opened.waiting） */
  waitingId: string | null
  /** 同期が落ち着いているか（syncSettled） */
  syncSettled: boolean
}

/**
 * トップの状態の1行（出さない時は null）。決め方の順（設計: 段階2の 1.7）:
 * 0. 出している版が無い（版の記録が1つも無い top-empty・出せる版が無く待っている top-waiting）→ 出さない
 * 1. 出している版がいちばん新しい枠の版 → 出さない
 * 2. 出している版より新しい版を待っている → 「{版の名前}を受け取っています…」
 * 3. いちばん新しい枠の版が新しい形の記録 → 「{枠}版は新しい形の記録です（アプリを更新してください）」
 * 4. いちばん新しい枠に版の記録が無く、作れなかった印がある → 「{枠}版は作れませんでした（{理由の種類}）」
 * 5. いちばん新しい枠に版も印も無く、枠の時刻から30分たち、同期が落ち着いている → 「{枠}版はまだ届いていません」
 */
export function editionStatusOf(input: EditionStatusInput): EditionStatus | null {
  if (input.shownId === null) return null
  const latest = latestSlotAt(input.now)
  const latestId = editionIdOf(latest.date, latest.slot)
  if (input.shownId === latestId) return null
  if (input.waitingId !== null) return { kind: 'waiting', text: waitingEditionText(input.waitingId) }
  if (input.newerIds.includes(latestId)) return { kind: 'newer', text: newerEditionText(latest.slot) }
  if (input.editionIds.includes(latestId)) return null
  const fail = latestFail(input.fails, latestId)
  if (fail) return { kind: 'failed', text: editionFailedText(latest.slot, fail.reasonKind) ?? '' }
  if (input.syncSettled && input.now >= slotTimeMs(latest.date, latest.slot) + NOT_ARRIVED_AFTER_MIN * MINUTE_MS)
    return { kind: 'not-arrived', text: notArrivedText(latest.slot) }
  return null
}
