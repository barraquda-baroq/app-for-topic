// クリップボードを使えない時（許可されない・古いブラウザ）の、文を選んだ窓（docs/SPEC.md の 9. の［クリップ］・7.6）。今の Modal
// （L は真ん中・S・M は下からのシート）に読むだけの文の欄を置き、開いたら欄にフォーカスして文を全部選ぶ（作者が選んでコピーできる
// ように）。iPhone の Safari は読むだけの欄で select() が効かないことがあるので、focus() の後に setSelectionRange(0, 長さ) にする
// （設計: 段階2の 1.14・8. の 1）。読み取りの許可は求めない。何も記録しない（7.6）。画面が変わったら、詳細と一緒に閉じる
import { useEffect, useRef, type JSX } from 'react'
import { Modal } from '../../ui/Modal'
import { testIds } from '../top/testIds'
import { CLIP_TEXTS } from './detailTexts'

export interface ClipDialogProps {
  /** クリップの文（src/domain/clipText.ts の clipText） */
  text: string
  onClose: () => void
}

export function ClipDialog({ text, onClose }: ClipDialogProps): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  // 開いた時（Modal が中へフォーカスを移した後）に、欄にフォーカスして全部を選ぶ
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(0, el.value.length)
  }, [text])
  return (
    <Modal
      title={CLIP_TEXTS.dialogTitle}
      onClose={onClose}
      testId={testIds.clipDialog}
      className="clip-dialog"
      initialFocus=".clip-text"
    >
      <p className="clip-note">{CLIP_TEXTS.dialogNote}</p>
      <textarea
        ref={ref}
        className="textarea clip-text"
        readOnly
        value={text}
        rows={Math.min(14, Math.max(6, text.split('\n').length + 1))}
        aria-label={CLIP_TEXTS.textLabel}
        onFocus={(e) => e.currentTarget.setSelectionRange(0, e.currentTarget.value.length)}
      />
    </Modal>
  )
}
