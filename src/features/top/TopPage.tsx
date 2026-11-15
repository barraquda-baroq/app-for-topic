// トップの画面（docs/SPEC.md の 9.・14.5）。段階1は仮の一覧: 届いた版（いちばん新しい出せる版。src/store/appStore.ts の opened）の
// 見出しだけを、版の順位の順に並べる（docs/SPEC.md の 16.2 の 8。カード・詳細・既読を沈める・ヘッダーの版の表示などの見た目は段階2）。
// 出せる版がまだ無い時は、版がまだ無いことだけを出す（版が届くのは段階3から。段階1の開発サーバーでは作り物の版が入る）。
// 既読（reads）は見た目を変えず、見出しの行の data-read にだけ置く（同期の E2E で、別の端末の既読が届いたことを確かめる。16.3）
import { useApp } from '../../store/appStore'
import { useDocumentTitle } from '../../ui/hooks'
import { AppHeader } from '../../ui/Layout'
import './top.css'

/** 版がまだ無い時の言葉 */
export const EMPTY_TITLE = 'まだ版はありません'
export const EMPTY_NOTE = '12:00版と20:00版は、段階3から届くようになります。'
/** 届いた版の話題が端末にそろうのを待っている時の言葉（出せる版がまだ無い時だけ。docs/SPEC.md の 7.8 の「版を出す条件」） */
export const WAITING_TEXT = '版を受け取っています…'

export function TopPage() {
  useDocumentTitle(undefined)
  const opened = useApp((s) => s.opened)
  const reads = useApp((s) => s.user.reads)
  const view = opened.view?.kind === 'ready' ? opened.view : null
  const readIds = new Set(view ? (reads[view.editionId]?.topicIds ?? []) : [])
  return (
    <>
      <AppHeader />
      <main className="page page-narrow top" data-testid="top-page">
        <h1 className="visually-hidden">トップ</h1>
        {view ? (
          <ol className="top-headlines" data-testid="top-headlines" data-edition-id={view.editionId}>
            {view.topics.map((t) => (
              <li
                key={t.id}
                className="top-headline"
                data-testid="top-headline"
                data-topic-id={t.id}
                data-read={readIds.has(t.id) ? 'true' : undefined}
              >
                {t.headline}
              </li>
            ))}
          </ol>
        ) : opened.waiting ? (
          <p className="top-waiting" data-testid="top-waiting" role="status">
            {WAITING_TEXT}
          </p>
        ) : (
          <div className="top-empty" data-testid="top-empty">
            <p className="top-empty-title">{EMPTY_TITLE}</p>
            <p className="top-empty-note">{EMPTY_NOTE}</p>
          </div>
        )}
      </main>
    </>
  )
}
