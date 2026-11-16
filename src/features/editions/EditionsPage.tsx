// 版の一覧（#/editions。docs/SPEC.md の 9.・4.7。設計: 段階2の 1.8）: 枠を新しい順に1行ずつ。ヘッダーの版の表示から開く。
// 行はストアの editionRows（30日の内で、いちばん古い「版の記録（新しい形を含む）か作れなかった印のある枠」から、いちばん新しい枠まで）:
// - 版の記録がある枠「11/15（日）12:00版」。押すと前の版 #/e/{版の id}。話題がまだ端末にそろわない版は「受け取り中」を添える（押せる。
//   開くと「版を受け取っています…」）。受け取り中かは Dexie の鍵だけで調べる（話題の中身は読まない。16.6 の 56）
// - 新しい形の記録の枠「… 新しい形の記録（アプリを更新してください）」（押せない。docs/SPEC.md の 7.1）
// - 作れなかった枠「… 作れませんでした（使用量の上限）」と、短い理由の文 reason を小さく（押せない。トップの1行は理由の種類の言葉だけに
//   して、reason の文は静かな所のここに置く。docs/SPEC.md の 4.7・7.2）
// - 版も印も無い枠「… 届いていません」（定期実行が動かなかった時など。押せない）。いちばん新しい枠だけは、トップの状態の1行と同じく
//   枠の時刻の30分後から、同期が落ち着いている時（syncSettled）だけ
// いちばん上に「いちばん新しい版を見る」（トップへ）。開いている版は変えない（前の版を見ていた時は、ヘッダーもその版のまま。2.）。
// 行は、版の記録・作れなかった印・開いている版・同期の落ち着き・時刻（30分ごと。枠の時刻と30分の境）が変わるたびに読み直す
// （開いている版は、話題が端末に届いた時の手がかり。受け取りが済めば同期の表示が落ち着くので、それでも読み直す）。
// 言葉は src/features/top/texts.ts、testid は src/features/top/testIds.ts（editions-row の data-kind・data-edition-id は E2E と見本が
// 探すためだけの物で、CSS では選ばない。src/screensCss.test.ts）
import { useEffect, useState, type JSX } from 'react'
import { Link } from 'react-router-dom'
import { syncSettled } from '../../domain/editionStatus'
import { editionNameText } from '../../domain/fixedTexts'
import { editionIdOf } from '../../domain/ids'
import { paths } from '../../routes'
import { editionRows, useApp, type EditionRow } from '../../store/appStore'
import { useSyncView } from '../../sync/syncView'
import { useDocumentTitle, useNow } from '../../ui/hooks'
import { ChevronRightIcon } from '../../ui/icons'
import { AppHeader } from '../../ui/Layout'
import { editionRowFailedText, EDITIONS_TEXTS } from '../top/texts'
import { testIds } from '../top/testIds'
import './editions.css'

/**
 * 行を見直す間（30分。src/ui/hooks.ts の useNow は 0時（UTC）からの変わり目にそろえるので、枠の時刻 12:00・20:00、「届いていません」の
 * 30分の境 12:30・20:30、30日の境の 0時（日本時間）に当たる。トップの状態の1行と同じ）
 */
export const ROWS_STEP_MS = 30 * 60 * 1000

/** 行の種類（testid editions-row の data-kind。受け取り中の版は edition と分ける。設計: 段階2の 4.3） */
export type EditionRowKind = 'edition' | 'receiving' | 'newer' | 'failed' | 'missing'

export function rowKindOf(row: EditionRow): EditionRowKind {
  return row.kind === 'edition' && row.receiving ? 'receiving' : row.kind
}

export function EditionsPage(): JSX.Element {
  useDocumentTitle(EDITIONS_TEXTS.title)
  const now = useNow(ROWS_STEP_MS)
  const settled = useSyncView((s) => syncSettled(s.view))
  const storeReady = useApp((s) => s.status === 'ready')
  const editions = useApp((s) => s.editions)
  const newerEditions = useApp((s) => s.newerEditions)
  const fails = useApp((s) => s.editionFails)
  const opened = useApp((s) => s.opened)
  const [rows, setRows] = useState<readonly EditionRow[] | null>(null)

  useEffect(() => {
    if (!storeReady) return
    let alive = true
    editionRows(now, settled).then(
      (r) => {
        if (alive) setRows(r)
      },
      (e: unknown) => console.warn('版の一覧を読めませんでした', e),
    )
    return () => {
      alive = false
    }
  }, [storeReady, now, settled, editions, newerEditions, fails, opened])

  return (
    <>
      <AppHeader />
      <main className="page page-narrow editions" data-testid={testIds.editionsPage} aria-busy={rows === null || undefined}>
        <div className="editions-top">
          <h1 className="editions-head">{EDITIONS_TEXTS.title}</h1>
          <Link to={paths.top()} className="btn btn-sm">
            {EDITIONS_TEXTS.toNewest}
          </Link>
        </div>
        {rows === null ? null : rows.length ? (
          <ul className="editions-list">
            {rows.map((row) => (
              <EditionsRowItem key={editionIdOf(row.date, row.slot)} row={row} />
            ))}
          </ul>
        ) : (
          <p className="empty editions-empty">{EDITIONS_TEXTS.empty}</p>
        )}
      </main>
    </>
  )
}

/** 1つの枠の行。押せるのは版の記録がある枠だけ（前の版 #/e/{id}） */
function EditionsRowItem({ row }: { row: EditionRow }): JSX.Element {
  const slotId = editionIdOf(row.date, row.slot)
  const name = editionNameText(row.date, row.slot) ?? slotId
  const kind = rowKindOf(row)
  const common = {
    className: `editions-row is-${kind}`,
    'data-testid': testIds.editionsRow,
    'data-kind': kind,
    'data-edition-id': slotId,
  }
  if (row.kind === 'edition')
    return (
      <li {...common}>
        <Link to={paths.edition(row.editionId)} className="editions-row-link">
          <span className="editions-row-name">{name}</span>
          {row.receiving ? <span className="editions-row-note">{EDITIONS_TEXTS.receiving}</span> : null}
          <ChevronRightIcon className="icon editions-row-go" />
        </Link>
      </li>
    )
  const note =
    row.kind === 'newer'
      ? EDITIONS_TEXTS.newer
      : row.kind === 'failed'
        ? editionRowFailedText(row.reasonKind)
        : EDITIONS_TEXTS.missing
  return (
    <li {...common}>
      <p className="editions-row-line">
        <span className="editions-row-name">{name}</span>
        <span className="editions-row-note">{note}</span>
      </p>
      {row.kind === 'failed' && row.reason ? <p className="editions-row-reason">{row.reason}</p> : null}
    </li>
  )
}
