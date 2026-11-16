// 話題の詳細のシート（docs/SPEC.md の 9. の「詳細」・14.5）: S・M は下からのシート、L で列の差し込み口の無い画面（追いつき・段階1の
// 仮のトップ）は真ん中の小さな画面。どちらも今の Modal（wide）のまま（後ろは inert・Esc・背景・［×］で閉じる・閉じると開いた所へ
// フォーカスを戻す）。題は版の行（「11/15（日）12:00版・国内・経済」。短く、上に固定されるので）、見出しは本文の頭の <h3>（開いた時は
// そこへフォーカス）。［クリップ］は下の帯（指が届く所）。シートの中の端まで送った時に、後ろへスクロールが移らないようにする
// （topic.css の overscroll-behavior。下へ引いて閉じる動きは作らない。設計: 段階2の 1.9・2.・8. の 2）
import type { JSX, ReactNode } from 'react'
import { Modal } from '../../ui/Modal'
import { DETAIL_TEXTS } from './detailTexts'

export interface TopicSheetProps {
  /** 題（版の行） */
  title: string
  /** 下の帯（［クリップ］。読む間は無い） */
  footer?: ReactNode
  /** ［×］・Esc・背景（呼ぶ側が履歴を1つ戻す） */
  onClose: () => void
  /** Esc で閉じる前に呼ぶ。true を返すと閉じない（中身の説明の箱だけを閉じた時。フォーカスが下の帯の［クリップ］・body にある時のため） */
  onEscape?: () => boolean
  children: ReactNode
}

export function TopicSheet({ title, footer, onClose, onEscape, children }: TopicSheetProps): JSX.Element {
  return (
    <Modal
      title={title}
      onClose={onClose}
      onEscape={onEscape}
      footer={footer}
      wide
      className="topic-sheet"
      initialFocus=".topic-title"
      closeLabel={DETAIL_TEXTS.close}
    >
      {children}
    </Modal>
  )
}
