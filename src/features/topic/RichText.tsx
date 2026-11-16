// 本文の1つの欄の文（docs/SPEC.md の 4.6・7.1・5.12・9.）。記録の文は文のまま出し（HTML として読まない。dangerouslySetInnerHTML を
// 使わない）、強調の語句は <strong class="emph">（オレンジの字＋太字。作者の答え A・D24）、本文の中の用語の印は
// <button class="term-mark">（■2 の A。押すと段落の下に説明の箱）で包むだけ。区切り方は src/domain/termMarks.ts の richSegments
// （強調と用語は重なってよい。用語の印の中に強調があれば、ボタンの中を <strong> で分ける）。
// 囲む要素を持たない（呼ぶ側が <p> などに入れる）。どの欄の強調・印かは呼ぶ側が渡す（強調は ShownTopic.emphasis[鍵]、印は findTermHits の
// その欄の物）。カードの要約には印を渡さない（押し間違えないように。設計: 段階2の 1.12）。クリップの文には使わない（1.14）。
// 説明の箱の開け閉め・Esc は詳細の部品が受け持つ（ここは押した事を知らせるだけ）。props の名前に know・markRead・markSeen を使わない
// （docs/SPEC.md の 16.6 の 59）
import { Fragment, useMemo, type JSX, type MouseEvent, type ReactNode } from 'react'
import { richSegments, type RichSegment, type TermHit } from '../../domain/termMarks'
import { testIds } from '../top/testIds'

export interface RichTextProps {
  /** 欄の文（記録のまま） */
  text: string
  /** 強調する語句（ShownTopic.emphasis[欄の鍵]。無ければ強調なし） */
  phrases?: readonly string[]
  /** この欄の用語の印（findTermHits の結果のうち、この欄の物。hitsOf で絞る） */
  hits?: readonly Pick<TermHit, 'start' | 'end' | 'termId'>[]
  /** 説明の箱が開いている語（その語のボタンを aria-expanded="true" にする） */
  openTermId?: string | null
  /** 説明の箱の要素の id（開いている語のボタンの aria-controls） */
  noteId?: string
  /** 用語の印を押した時（語の id と押したボタン。箱を閉じた後にフォーカスを戻す先） */
  onPressTerm?: (termId: string, button: HTMLButtonElement) => void
}

/** 渡されなかった時の空の並び（描き直すたびに新しい並びを作って、区切りを作り直さないように） */
const NONE: readonly never[] = []

/** 区切りの並びを、用語の印ごとにまとめる（印の頭の区切りから、同じ語の区切りが続く所まで） */
function groupSegments(segments: readonly RichSegment[]): { termId: string | null; parts: RichSegment[] }[] {
  const out: { termId: string | null; parts: RichSegment[] }[] = []
  for (const s of segments) {
    const last = out[out.length - 1]
    if (s.termId !== null && !s.termStart && last && last.termId === s.termId) last.parts.push(s)
    else out.push({ termId: s.termId, parts: [s] })
  }
  return out
}

function partsOf(parts: readonly RichSegment[]): ReactNode[] {
  return parts.map((p, i) =>
    p.strong ? (
      <strong key={i} className="emph">
        {p.text}
      </strong>
    ) : (
      <Fragment key={i}>{p.text}</Fragment>
    ),
  )
}

export function RichText({
  text,
  phrases = NONE,
  hits = NONE,
  openTermId = null,
  noteId,
  onPressTerm,
}: RichTextProps): JSX.Element {
  const groups = useMemo(() => groupSegments(richSegments(text, phrases, hits)), [text, phrases, hits])
  return (
    <>
      {groups.map((g, i) => {
        if (g.termId === null) return <Fragment key={i}>{partsOf(g.parts)}</Fragment>
        const termId = g.termId
        const open = openTermId === termId
        return (
          <button
            key={i}
            type="button"
            className="term-mark"
            data-testid={testIds.termMark}
            data-term-id={termId}
            aria-expanded={open}
            aria-controls={open && noteId ? noteId : undefined}
            onClick={(e: MouseEvent<HTMLButtonElement>) => onPressTerm?.(termId, e.currentTarget)}
          >
            {partsOf(g.parts)}
          </button>
        )
      })}
    </>
  )
}
