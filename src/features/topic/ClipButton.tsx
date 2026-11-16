// ［クリップ］（D10・docs/SPEC.md の 7.6・9.。作者の答え A: 訂正のある話題は要約の後に「訂正: …」を足した順に添え、だから何？は入れない）。
// 押した処理の中で、文を作ってすぐ navigator.clipboard.writeText を呼ぶ（その前に await を置かない。iPhone の Safari は、待った後の書き込みを
// 断る。話題と訂正は詳細を開いた時にもう読んである。設計: 段階2の 1.14・8. の 1）。できたらお知らせ「クリップボードにコピーしました」。
// navigator.clipboard が無い・断られた（Promise が拒んだ）時は、文を選んだ窓（ClipDialog）を出す。読み取りの許可は求めない。
// 何も記録しない（クリップした印・回数・時刻を残さない。端末にもストアにも書かない。7.6・D21）。
// DS の browser.ts の copyText（失敗した時に execCommand に落ちる）は写さない（9. の「選んだ状態の窓」と違う）
import { useEffect, useRef, useState, type JSX } from 'react'
import { clipText, type ClipTopic } from '../../domain/clipText'
import { notify } from '../../store/uiStore'
import { CopyIcon } from '../../ui/icons'
import { testIds } from '../top/testIds'
import { ClipDialog } from './ClipDialog'
import { CLIP_TEXTS } from './detailTexts'

export interface ClipButtonProps {
  /** 話題の表示用の写し（ShownTopic） */
  topic: ClipTopic
  /** その話題の訂正（足した順） */
  corrections: readonly { text: string }[]
}

/** クリップボードに書く（書けたら true、使えない・断られたら false）。呼んだ処理の中で writeText まで同期で進む */
function writeClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (!clipboard || typeof clipboard.writeText !== 'function') return Promise.resolve(false)
  try {
    return clipboard.writeText(text).then(
      () => true,
      () => false,
    )
  } catch {
    return Promise.resolve(false)
  }
}

export function ClipButton({ topic, corrections }: ClipButtonProps): JSX.Element {
  const [dialog, setDialog] = useState<string | null>(null)
  const ref = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // 窓を閉じたらボタンへフォーカスを戻す（押してもフォーカスの移らないブラウザ（Safari）でも、窓の後に詳細の中へ戻れるように）
  const reopenFocus = useRef(false)
  useEffect(() => {
    if (dialog !== null || !reopenFocus.current) return
    reopenFocus.current = false
    ref.current?.focus()
  }, [dialog])

  const onClick = () => {
    const text = clipText(topic, corrections)
    void writeClipboard(text).then((ok) => {
      if (ok) notify(CLIP_TEXTS.copied)
      else if (mounted.current) setDialog(text)
    })
  }

  return (
    <>
      <button ref={ref} type="button" className="btn btn-sm topic-clip" data-testid={testIds.topicClip} onClick={onClick}>
        <CopyIcon />
        {CLIP_TEXTS.button}
      </button>
      {dialog !== null ? (
        <ClipDialog
          text={dialog}
          onClose={() => {
            reopenFocus.current = true
            setDialog(null)
          }}
        />
      ) : null}
    </>
  )
}
