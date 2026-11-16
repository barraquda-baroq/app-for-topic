// 話題の詳細のパネル（L。docs/SPEC.md の 9. の「詳細」。■7 の A: 開いたカードと反対の列の上に重ねる。どの列かはトップの TopWide の
// panelSideFor が state.sheet.side に入れる）。列が置いた差し込み口（src/features/topic/sheets.ts の PanelSlot）へ createPortal する
// （Modal ではない。後ろの一覧は使えるまま。設計: 段階2の 1.4・1.9）。
// - 重ねた列の一覧（差し込み口の兄弟）だけを inert にする（Tab で隠れたカードに入らない。パネルは inert の外）。前から inert だった物は
//   触らない（閉じた時も外さない）
// - 開いた時は見出し（tabIndex -1）へフォーカスし、閉じた時は開いた所（カードの見出しのボタン）へ戻す。ただし閉じた時にフォーカスが
//   ほかの所（開いている列のほかのカードなど）へ移っていれば、そのままにする
// - Esc は document の keydown で受けるが、小さな画面（クリップの窓など。src/ui/Modal.tsx の isModalOpen）が開いている間は何もしない
//   （パネルの方が先に登録しているので、Modal の stopPropagation では止まらず、窓とパネルが両方閉じてフォーカスも失うため。開発。
//   設計: 段階2の 2.）。日本語の変換を取り消す Esc でも閉じない（Modal と同じ）。説明の箱の Esc は詳細の中身が先に止める
// - 出る時は右から 180ms（.panel-in。視差効果を減らす設定では動かさない）
import { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { XIcon } from '../../ui/icons'
import { isModalOpen } from '../../ui/Modal'
import { testIds } from '../top/testIds'
import { DETAIL_TEXTS } from './detailTexts'

export interface TopicPanelProps {
  /** 差し込み口（usePanelSlots の要素） */
  slot: HTMLElement
  /** 頭の行の題（版の行） */
  title: string
  /** 頭の行の［×］の左（［クリップ］。読む間は無い） */
  actions?: ReactNode
  /** ［×］・Esc（呼ぶ側が履歴を1つ戻す） */
  onClose: () => void
  children: ReactNode
}

export function TopicPanel({ slot, title, actions, onClose, children }: TopicPanelProps): JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    const panel = ref.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // 重ねた列の一覧（差し込み口の兄弟）を inert に（前から inert の物は触らない）
    const covered = [...(slot.parentElement?.children ?? [])].filter(
      (el): el is HTMLElement => el !== slot && el instanceof HTMLElement && !el.inert,
    )
    for (const el of covered) el.inert = true
    ;(panel?.querySelector<HTMLElement>('.topic-title') ?? panel?.querySelector<HTMLElement>('.topic-panel-title'))?.focus({
      preventScroll: true,
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return
      if (isModalOpen()) return
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      for (const el of covered) el.inert = false
      const active = document.activeElement
      const lost = !active || active === document.body || Boolean(panel?.contains(active))
      if (lost && opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [slot])

  return createPortal(
    <section ref={ref} className="topic-panel panel-in" aria-label={title}>
      <div className="topic-panel-head">
        <p className="topic-panel-title" tabIndex={-1}>
          {title}
        </p>
        {actions}
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label={DETAIL_TEXTS.close}
          data-testid={testIds.topicClose}
        >
          <XIcon />
        </button>
      </div>
      <div className="topic-panel-body">{children}</div>
    </section>,
    slot,
  )
}
