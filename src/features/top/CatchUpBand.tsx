// 追いつきの帯（docs/SPEC.md の 9. の「追いつき」。■8 の A。設計: 段階2の 1.8）: トップの状態の1行の下に
// 「見ていない版が 2つあります（11/13（金）20:00版から）［追いつく］［×］」。
// 追いつく版はストアの catchUpTargets（新しい方から6版の中で、出している版より前で、最後に見た版より後の版。版の一覧と既読だけで決め、
// 話題は読まない）。帯を出すのは2つ以上（CATCH_UP_MIN。まる1日分）の時だけ（1日1回だけ開く人に毎日は出さない。D9）。
// いちばん新しい出せる版に付いていくトップだけに出す（前の版では出さない。catchUpTargets が [] を返す）。
// ［追いつく］は #/catch-up（開いた時に追いつく版を決めて、出した版を見たにするのは追いつきの画面）。［×］は読まずに閉じる:
// 帯に出した版を全部見たにする（最後に見た版がそこまで進むので、帯は出なくなる）。版の数は字で出す（数字のアイコンにしない。D9）
import { useMemo, type JSX } from 'react'
import { Link } from 'react-router-dom'
import { CATCH_UP_MIN } from '../../domain/catchUp'
import { paths } from '../../routes'
import { catchUpTargets, markSeen, useApp } from '../../store/appStore'
import { useNow } from '../../ui/hooks'
import { XIcon } from '../../ui/icons'
import { STATUS_STEP_MS } from './EditionStatus'
import { CATCH_UP_TEXTS, catchUpBandText } from './texts'
import { testIds } from './testIds'

export function CatchUpBand(): JSX.Element | null {
  // 30日の境は日付で決まるので、30分ごとに見直せば足りる
  const now = useNow(STATUS_STEP_MS)
  const editions = useApp((s) => s.editions)
  const user = useApp((s) => s.user)
  const opened = useApp((s) => s.opened)
  const ids = useMemo(() => catchUpTargets({ editions, user, opened }, now), [editions, user, opened, now])
  if (ids.length < CATCH_UP_MIN) return null
  const dismiss = () => {
    for (const id of ids) markSeen(id)
  }
  return (
    <div className="catch-up-band" data-testid={testIds.catchUpBand}>
      <p className="catch-up-band-text">{catchUpBandText(ids.length, ids[ids.length - 1])}</p>
      <Link to={paths.catchUp()} className="btn btn-sm">
        {CATCH_UP_TEXTS.go}
      </Link>
      <button
        type="button"
        className="icon-btn catch-up-band-close"
        aria-label={CATCH_UP_TEXTS.dismiss}
        title={CATCH_UP_TEXTS.dismiss}
        onClick={dismiss}
      >
        <XIcon />
      </button>
    </div>
  )
}
