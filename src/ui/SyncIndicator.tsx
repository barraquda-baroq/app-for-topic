// ヘッダーの同期の表示（docs/SPEC.md の 7.8 の「部品」の syncView.ts・「持ち主・データの形の版・同期の表示」）。DS の
// src/ui/SyncIndicator.tsx から。状態は同期の司令塔（src/sync/controller.ts）が src/sync/syncView.ts の useSyncView に入れる
// （ログインしていない・持ち主だと確かめていない・同期をまだ始めていない間は何も出さない）。
// 見た目は控えめに、段階0の部品に合わせて小さな字だけにした（DS のアイコン・設定の「同期」へのリンク・S の小さな窓と［今すぐ同期］は、
// 設定に同期の区切りが無い段階1では持ち込まない。段階2で画面を作る時に決める）。M・L は言葉をそのまま、S は短い言葉にし、詳しい言葉は
// 読み上げと title に入れる。色は src/ui/layout.css（そろっている・動いている・止まっている の3段）。
// 送るたびに言葉が替わるので、読み上げの live region（role="status"）にはしない（知らせを静かにする D9。読み上げる時は、その場所で読む）
import { syncLabel, syncShortLabel, syncTone, useSyncView } from '../sync/syncView'
import { useWidthClass } from './hooks'

export function SyncIndicator() {
  const view = useSyncView((s) => s.view)
  const width = useWidthClass()
  if (!view) return null
  const label = syncLabel(view)
  const short = width === 'S' ? syncShortLabel(view) : label
  const tone = syncTone(view)
  return (
    <span className={`sync-indicator ${tone}`} title={label} data-testid="sync-indicator" data-tone={tone}>
      <span className="visually-hidden">同期: </span>
      {short === label ? (
        label
      ) : (
        <>
          <span aria-hidden="true">{short}</span>
          <span className="visually-hidden">{label}</span>
        </>
      )}
    </span>
  )
}
