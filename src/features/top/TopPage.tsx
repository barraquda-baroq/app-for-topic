// トップの画面（docs/SPEC.md の 9.・14.5）。段階0は、ヘッダーの下に版がまだ無いことだけを出す（版の一覧・切り替えの列・詳細は段階2、
// 版が届くのは段階3から）
import { useDocumentTitle } from '../../ui/hooks'
import { AppHeader } from '../../ui/Layout'
import './top.css'

/** 版がまだ無い時の言葉 */
export const EMPTY_TITLE = 'まだ版はありません'
export const EMPTY_NOTE = '12:00版と20:00版は、段階3から届くようになります。'

export function TopPage() {
  useDocumentTitle(undefined)
  return (
    <>
      <AppHeader />
      <main className="page page-narrow top" data-testid="top-page">
        <h1 className="visually-hidden">トップ</h1>
        <div className="top-empty" data-testid="top-empty">
          <p className="top-empty-title">{EMPTY_TITLE}</p>
          <p className="top-empty-note">{EMPTY_NOTE}</p>
        </div>
      </main>
    </>
  )
}
