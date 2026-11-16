// 本文の中の用語の印を押した時の説明の箱と、［知ってる］（docs/SPEC.md の 9.・5.8・7.4。■2 の A）。箱は押した語のある段落のすぐ下に
// 開き（浮く吹き出しにしない。シートの中のスクロール・360px・読み上げで、位置の計算が要らないように。開発。設計: 段階2の 1.12）、
// 語・説明・時点（時期で変わる語。「2026年11月時点」）・［知ってる］・［×］を出す。1度に1つだけ。開け閉めと Esc は詳細の部品
// （TopicDetail）が受け持つ（Esc は document に付けない。先に登録したシートの Esc が先に動いて、シートごと閉じるため）。
// ［知ってる］は押した後も語を消さずに「知ってるにしました ［取り消す］」に替える（その場で消すと一覧が動き、押し間違いを戻せない。
// 書くのは詳細を閉じた時。src/features/topic/useKnownPresses.ts）。用語の一覧（詳細の下）も同じ部品（KnownControl）を使う。
// props の名前に know を使わない（docs/SPEC.md の 16.6 の 59）
import { useEffect, useRef, useState, type JSX } from 'react'
import { asOfText } from '../../domain/fixedTexts'
import type { TopicTerm } from '../../domain/types'
import { XIcon } from '../../ui/icons'
import { testIds } from '../top/testIds'
import { KNOWN_TEXTS, TERM_NOTE_TEXTS } from './detailTexts'
import type { KnownPress, PressedTerm } from './useKnownPresses'

export interface KnownControlProps {
  term: Pick<TopicTerm, 'termId' | 'term' | 'asOf'>
  /** 押した語（まだ押していなければ undefined） */
  pressed: PressedTerm | undefined
  onPressKnown: (term: KnownPress) => void
  onUndoKnown: (termId: string) => void
}

/**
 * ［知ってる］（押した後は「知ってるにしました ［取り消す］」。書いた後は［取り消す］を出さない）。押した・取り消した後は、替わった
 * ボタンへフォーカスを移す（押したボタンが消えて、フォーカスが外へ落ちないように）
 */
export function KnownControl({ term, pressed, onPressKnown, onUndoKnown }: KnownControlProps): JSX.Element {
  const pressRef = useRef<HTMLButtonElement>(null)
  const undoRef = useRef<HTMLButtonElement>(null)
  const [focusNext, setFocusNext] = useState<'press' | 'undo' | null>(null)
  useEffect(() => {
    if (focusNext === null) return
    ;(focusNext === 'undo' ? undoRef : pressRef).current?.focus()
    setFocusNext(null)
  }, [focusNext, pressed])
  if (!pressed)
    return (
      <button
        ref={pressRef}
        type="button"
        className="btn btn-sm term-known"
        data-testid={testIds.termKnown}
        data-term-id={term.termId}
        onClick={() => {
          onPressKnown({ termId: term.termId, term: term.term, asOf: term.asOf })
          setFocusNext('undo')
        }}
      >
        {KNOWN_TEXTS.press}
      </button>
    )
  return (
    <span className="term-known-done" data-term-id={term.termId}>
      <span>{KNOWN_TEXTS.pressed}</span>
      {pressed.written ? null : (
        <button
          ref={undoRef}
          type="button"
          className="btn btn-sm btn-ghost term-known-undo"
          onClick={() => {
            onUndoKnown(term.termId)
            setFocusNext('press')
          }}
        >
          {KNOWN_TEXTS.undo}
        </button>
      )}
    </span>
  )
}

export interface TermNoteProps extends KnownControlProps {
  term: TopicTerm
  /** 箱の要素の id（語のボタンの aria-controls） */
  id: string
  /** ［×］（箱を閉じて、語のボタンへフォーカスを戻す） */
  onClose: () => void
}

/** 用語の説明の箱（testid term-note） */
export function TermNote({ term, id, pressed, onPressKnown, onUndoKnown, onClose }: TermNoteProps): JSX.Element {
  const asOf = asOfText(term.asOf)
  return (
    <div
      className="term-note"
      id={id}
      data-testid={testIds.termNote}
      data-term-id={term.termId}
      role="group"
      aria-label={term.term}
    >
      <div className="term-note-head">
        <p className="term-note-term">{term.term}</p>
        <button type="button" className="icon-btn" aria-label={TERM_NOTE_TEXTS.close} onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <p className="term-note-text">{term.explanation}</p>
      {asOf ? <p className="term-asof">{asOf}</p> : null}
      <KnownControl term={term} pressed={pressed} onPressKnown={onPressKnown} onUndoKnown={onUndoKnown} />
    </div>
  )
}
