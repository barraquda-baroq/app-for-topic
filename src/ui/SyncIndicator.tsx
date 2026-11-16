// ヘッダーの同期の表示（docs/SPEC.md の 7.8 の「部品」の syncView.ts・「持ち主・データの形の版・同期の表示」・9.）。DS の
// src/ui/SyncIndicator.tsx から。状態は同期の司令塔（src/sync/controller.ts）が src/sync/syncView.ts の useSyncView に入れる
// （ログインしていない・持ち主だと確かめていない・同期をまだ始めていない間は何も出さない）。
// 段階2で DS と同じ形にした（■12 の A。設計: 段階2の 1.2・1.19）: 雲のアイコン（止まっている時は斜線の雲）を付け、M・L はアイコンと字
// （syncLabel）、S（600px 未満）はアイコンだけで、押すと小窓（src/ui/PopupMenu.tsx）に詳しい字（syncLabel）を出す。段階1の S の短い言葉
// （syncShortLabel。16.6 の 53）は使わなくなった（■12 で B に選ばれた時のために syncView.ts に残す）。
// 設定に「同期」の区切りは無く［今すぐ同期］も作らない（■12 の C）ので、M・L の表示は押せる物にしない（DS は設定の「同期」へのリンク）。
// 色の段は今の syncTone（そろっている・動いている・止まっている の3つ。src/ui/sync.css）。
// 送るたびに言葉が替わるので、読み上げの live region（role="status"）にはしない（知らせを静かにする D9。読み上げる時は、その場所で読む）
import { useEffect, useState } from 'react'
import { syncLabel, syncTone, useSyncView } from '../sync/syncView'
import { useWidthClass } from './hooks'
import { CloudIcon, CloudOffIcon } from './icons'
import { PopupMenu } from './PopupMenu'
import './sync.css'

export function SyncIndicator() {
  const view = useSyncView((s) => s.view)
  const width = useWidthClass()
  // S の小窓を開いたボタン（開いている間だけ。閉じると null）
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  // 状態が無くなった・幅が S でなくなった時は小窓を閉じる（後で S に戻った時に、押していないのに開かないように）
  useEffect(() => {
    if (!view || width !== 'S') setAnchor(null)
  }, [view, width])
  if (!view) return null
  const label = syncLabel(view)
  const tone = syncTone(view)
  // 止まっている時（オフライン・無料枠・要更新・同期できない）は斜線の雲（DS と同じ。色だけに頼らない）
  const icon = tone === 'warn' ? <CloudOffIcon /> : <CloudIcon />
  if (width === 'S') {
    return (
      <>
        <button
          type="button"
          className={`sync-indicator is-button ${tone}`}
          title={label}
          aria-label={`同期: ${label}`}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          data-testid="sync-indicator"
          data-tone={tone}
          onClick={(e) => {
            const button = e.currentTarget
            setAnchor((a) => (a ? null : button))
          }}
        >
          {icon}
        </button>
        {anchor ? (
          <PopupMenu
            label="同期"
            placement={{ anchor }}
            onClose={() => setAnchor(null)}
            returnFocus={anchor}
            testId="sync-popup"
            // 押しても閉じるだけ（設定に「同期」の区切りが無いので、DS の設定へのリンクにはしない）
            items={[{ label, onSelect: () => {}, testId: 'sync-popup-detail' }]}
          />
        ) : null}
      </>
    )
  }
  return (
    <span className={`sync-indicator ${tone}`} title={label} data-testid="sync-indicator" data-tone={tone}>
      {icon}
      <span className="sync-indicator-text">
        <span className="visually-hidden">同期: </span>
        {label}
      </span>
    </span>
  )
}
