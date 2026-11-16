// トップの状態の1行（docs/SPEC.md の 4.7・7.2・7.8・16.6 の 57。設計: 段階2の 1.7）。選び方は src/domain/editionStatus.ts の
// editionStatusOf（作れなかった・まだ届いていない・待っている・新しい形の記録）。出す所は S・M は切り替えの列の下、L は2列の上。
// 小さな字で静かに出す（role="status" にしない・知らせない。D9）。その枠がいちばん新しい間だけ出し、次の枠の時刻が来れば消える
// （時刻は 30分ごと。枠の時刻 12:00・20:00 と「まだ届いていません」の30分の境 12:30・20:30 に当たる。src/ui/hooks.ts の useNow）。
// 「まだ届いていません」は同期が落ち着いている時だけ（syncSettled。null・受け取り中・オフラインは落ち着いていない）。
// 前の版（#/e/{id}）では、同じ所に「前の版を見ています ［いちばん新しい版へ］」（PastEditionStatus。data-kind="past"）。
// 付いていくトップに出せる版が無く、新しい形の版の記録だけがある時は、空の表示の代わりに同じ形の1行（NewerOnlyStatus。設計: 段階2の 1.7 の 0.）。
// 種類ごとの見た目はクラス（is-failed など）で分け、data-kind を CSS で選ばない（src/styles.test.ts・src/screensCss.test.ts）
import type { JSX } from 'react'
import { Link } from 'react-router-dom'
import {
  editionStatusOf,
  newerOnlyStatusOf,
  syncSettled,
  type EditionStatus as Status,
  type EditionStatusInput,
} from '../../domain/editionStatus'
import { paths } from '../../routes'
import { useApp } from '../../store/appStore'
import { useSyncView } from '../../sync/syncView'
import { useNow } from '../../ui/hooks'
import { PAST_TEXTS } from './texts'
import { testIds } from './testIds'

/** 状態の1行を見直す間（30分。枠の時刻と30分の境に当たる） */
export const STATUS_STEP_MS = 30 * 60 * 1000

/** 状態の1行を選ぶ材料（ストア・同期の表示・30分ごとの時刻から） */
function useStatusInput(): EditionStatusInput {
  const now = useNow(STATUS_STEP_MS)
  const editions = useApp((s) => s.editions)
  const newerEditions = useApp((s) => s.newerEditions)
  const fails = useApp((s) => s.editionFails)
  const opened = useApp((s) => s.opened)
  const settled = useSyncView((s) => syncSettled(s.view))
  return {
    now,
    editionIds: editions.map((e) => e.id),
    newerIds: newerEditions,
    fails,
    shownId: opened.follow && opened.view?.kind === 'ready' ? opened.view.editionId : null,
    waitingId: opened.follow ? opened.waiting : null,
    syncSettled: settled,
  }
}

function StatusLine({ status }: { status: Status | null }): JSX.Element | null {
  if (!status) return null
  return (
    <p className={`edition-status is-${status.kind}`} data-testid={testIds.editionStatus} data-kind={status.kind}>
      {status.text}
    </p>
  )
}

/** いちばん新しい出せる版に付いていくトップの状態の1行（出す物が無ければ何も出さない） */
export function EditionStatus(): JSX.Element | null {
  return <StatusLine status={editionStatusOf(useStatusInput())} />
}

/**
 * 付いていくトップに出せる版が無く、待ってもいないが、新しい形の版の記録がある時の1行（当たらない時は何も出さない）。空の表示
 * （top-empty の「まだ版はありません」）の代わりに出す（src/domain/editionStatus.ts の newerOnlyStatusOf。設計: 段階2の 1.7 の 0.・1.21）
 */
export function NewerOnlyStatus(): JSX.Element | null {
  return <StatusLine status={newerOnlyStatusOf(useStatusInput())} />
}

/**
 * 前の版（#/e/{id}）の1行（「前の版を見ています」・「この版は端末にありません」・「この版は新しい形の記録です…」と［いちばん新しい版へ］）。
 * text を省くと「前の版を見ています」
 */
export function PastEditionStatus({ text = PAST_TEXTS.viewing }: { text?: string }): JSX.Element {
  return (
    <p className="edition-status is-past" data-testid={testIds.editionStatus} data-kind="past">
      <span>{text}</span>
      <Link to={paths.top()} className="btn btn-sm">
        {PAST_TEXTS.toNewest}
      </Link>
    </p>
  )
}
