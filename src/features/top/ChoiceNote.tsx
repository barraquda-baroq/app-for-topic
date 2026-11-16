// この版の選び方（docs/SPEC.md の 6.5・7.2。■14 の A。設計: 段階2の 1.22）: トップのいちばん下（S・M はエンタメの区切りの後、L は
// 世界の列の下）に、畳んだ <details>「この版の選び方」。開くと「候補 {candidateCount} 件から20本を選びました」と、選ばなかった見出しと
// 理由（版の notChosen。20件まで。記録の上限も20件）。候補の数が分からない（null）時は候補の行を書かず、選ばなかった見出しが0件なら
// その区切りを書かない。どちらも無ければ何も出さない（開いても何も無い欄を置かない。開発。設計: 段階2）。
// 作者が時々のぞける所（6.5）なので、目立たせない（小さな字・畳んで始める）
import type { JSX } from 'react'
import type { ShownEdition } from '../../domain/repair'
import { CHOICE_TEXTS, choiceCountText } from './texts'
import { testIds } from './testIds'

/** 選ばなかった見出しを出す数（docs/SPEC.md の 7.2 の notChosen の上限と同じ） */
export const NOT_CHOSEN_SHOWN = 20

export function ChoiceNote({
  edition,
}: {
  edition: Pick<ShownEdition, 'candidateCount' | 'notChosen' | 'order'>
}): JSX.Element | null {
  const notChosen = edition.notChosen.slice(0, NOT_CHOSEN_SHOWN)
  const count = edition.candidateCount
  if (count === null && !notChosen.length) return null
  return (
    <details className="choice-note" data-testid={testIds.choiceNote}>
      <summary className="choice-note-summary">{CHOICE_TEXTS.title}</summary>
      <div className="choice-note-body">
        {count !== null ? <p className="choice-note-count">{choiceCountText(count, edition.order.length)}</p> : null}
        {notChosen.length ? (
          <>
            <h3 className="choice-note-head">{CHOICE_TEXTS.notChosen}</h3>
            <ul className="choice-note-list">
              {notChosen.map((n, i) => (
                <li key={i}>
                  <span className="choice-note-headline">{n.headline}</span>
                  {n.whyNot ? <span className="choice-note-why">{n.whyNot}</span> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </details>
  )
}
