// ヘッダーの版の表示（docs/SPEC.md の 9. の「その横に『11/14（土）12:00版』のような版の表示」。設計: 段階2の 1.2）。
// 出している版（useApp の opened.view が ready の時の版の日付と枠）の名前「11/15（日）12:00版」を、アイコンと名前の右に出し、押すと
// 版の一覧（#/editions）へ。前の版（#/e/{id}）を見ている時もその版の名前（opened はその版）。出せる版が無い（まだ版が無い・待っている・
// 新しい形の記録・30日の外・壊れた版）時は出さない。S（600px 未満）は名前を出さずに、これを出す（src/ui/layout.css）。
// 読み上げは「11月15日（日）12:00版（版の一覧へ）」（「11/15」を「11月15日」と読ませる。開発）
import { Link } from 'react-router-dom'
import { weekdayJaOf } from '../domain/dates'
import { editionNameText, editionSlotText } from '../domain/fixedTexts'
import { isYmd } from '../domain/jst'
import { paths } from '../routes'
import { useApp } from '../store/appStore'
import { DownIcon } from './icons'

/** 読み上げる版の名前（「11月15日（日）12:00版」。日付か枠が分からなければ null） */
export function spokenEditionName(date: unknown, slot: unknown): string | null {
  const s = editionSlotText(slot)
  if (!isYmd(date) || s === null) return null
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日（${weekdayJaOf(date)}）${s}`
}

export function EditionLabel() {
  const view = useApp((s) => s.opened.view)
  if (view?.kind !== 'ready') return null
  const { date, slot } = view.edition
  const name = editionNameText(date, slot)
  const spoken = spokenEditionName(date, slot)
  if (name === null || spoken === null) return null
  return (
    <Link
      to={paths.editions()}
      className="edition-label"
      aria-label={`${spoken}（版の一覧へ）`}
      data-testid="edition-label"
      data-edition-id={view.editionId}
    >
      <span>{name}</span>
      <DownIcon small />
    </Link>
  )
}
