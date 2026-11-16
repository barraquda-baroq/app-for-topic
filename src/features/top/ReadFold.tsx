// 既読を沈める「既読 n件」（docs/SPEC.md の 9.・6.5・7.4）。区切り（S・M は総合と各ジャンル、L は国内・世界・そのほか）ごとに、
// 画面を出した時に既読だった話題をこの下に畳む（沈める並びは画面を出した時に決め、その画面の間は変えない。呼ぶ側が決める。
// 設計: 段階2の 1.6）。開け閉めは端末に覚えず（src/store/uiStore.ts の useTopUi。版の id と区切りごと）、アプリを開き直すと畳んで
// 始まる（DS の S・M のリストと同じ）。畳む動きは src/styles.css の .fold（180ms。視差効果を減らす設定では動かさない）。
// 畳んでいる間の中身は見えず、フォーカス・読み上げからも外れる（.fold.is-closed の visibility）。戻す操作は作らない（■13 の A）
import { useId, type JSX, type ReactNode } from 'react'
import { useTopUi, foldKey } from '../../store/uiStore'
import { ChevronRightIcon } from '../../ui/icons'
import { readFoldText } from './texts'
import { testIds } from './testIds'

export interface ReadFoldProps {
  editionId: string
  /** 区切り（'all'・ジャンル・'jp'・'world'・'other'） */
  section: string
  /** 畳む話題の数（0 なら何も出さない） */
  count: number
  /** 畳む中身（カードの並び） */
  children: ReactNode
}

export function ReadFold({ editionId, section, count, children }: ReadFoldProps): JSX.Element | null {
  const bodyId = useId()
  const open = useTopUi((s) => s.openFolds[foldKey(editionId, section)] === true)
  const setFoldOpen = useTopUi((s) => s.setFoldOpen)
  if (count === 0) return null
  return (
    <div className={`top-read-fold${open ? ' is-open' : ''}`} data-testid={testIds.topReadFold}>
      <button
        type="button"
        className="top-read-fold-btn"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setFoldOpen(editionId, section, !open)}
      >
        <span>{readFoldText(count)}</span>
        <ChevronRightIcon small />
      </button>
      <div id={bodyId} className={`fold${open ? '' : ' is-closed'}`}>
        <div className="top-read-fold-body">{children}</div>
      </div>
    </div>
  )
}
