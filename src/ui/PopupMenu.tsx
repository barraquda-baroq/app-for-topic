// ボタンの下に開く小さな窓（メニュー）。DS の src/ui/PopupMenu.tsx から（DS は NS の物から）。TS では、S（600px 未満）のヘッダーの
// 同期の表示を押した時に、詳しい字を出す小窓だけに使う（docs/SPEC.md の 7.8・9.。■12 の A。設計: 段階2の 1.1・1.2）。
// 外側を押す・Esc・Tab・スクロール・画面の幅の変更で閉じ、矢印キーで項目を移動できる。閉じたら開く前の要素へフォーカスを戻す。
// 外側を押して閉じた時は閉じるだけ（下にあるリンクなどは開かない）。
// DS の、本文にカーソルを置いたまま開く作り（keepFocus）・上に開く作り（side: 'above'）・横一列（layout: 'row'）・押せない項目と理由（hint）・
// 削除の項目（danger）・アイコンは、TS に使う所が無いので写さない（シンプル。D22）
import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import './menu.css'

export interface PopupMenuItem {
  label: string
  /** 読み上げの名前（省くと label） */
  ariaLabel?: string
  onSelect: () => void
  testId?: string
}

/** 開く位置。point は画面上の座標、anchor はその要素の下（右端をそろえる。下に入らなければ上） */
export type MenuPlacement = { point: { x: number; y: number } } | { anchor: Element }

export interface PopupMenuProps {
  /** 窓の名前（読み上げと、窓の頭の小さな字） */
  label: string
  items: PopupMenuItem[]
  placement: MenuPlacement
  onClose: () => void
  /** 閉じた後にフォーカスを戻す要素（省くと開く前にフォーカスしていた要素） */
  returnFocus?: HTMLElement | null
  /** 開いた時に最初の項目へフォーカスする（既定 true） */
  autoFocus?: boolean
  /** 外側を押して閉じた時に、続くクリックを取り消す（既定 true）。false なら、押した外側のボタンもそのまま働く */
  swallowOutsideClick?: boolean
  testId?: string
}

/** 画面の端からの余白 */
const EDGE = 8

/**
 * 外側を押して窓を閉じた時は、続けて届くクリック（下にあるリンクなど）を取り消す（閉じるだけにする。各 OS のメニューと同じ）。
 * 取り消しは document に付けるので、閉じて消えた窓より長く残る
 */
function swallowNextClick(): void {
  const stop = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    done()
  }
  const done = () => {
    clearTimeout(timer)
    document.removeEventListener('click', stop, true)
    document.removeEventListener('pointerdown', done, true)
  }
  // クリックが届かなかった時（なぞってスクロールした等）は持ち越さない
  const timer = setTimeout(done, 1000)
  document.addEventListener('click', stop, true)
  // 次に触れたら取り消しをやめる（今の pointerdown の途中で足したものは、今回は呼ばれない）
  document.addEventListener('pointerdown', done, true)
}

/** 置く位置を測るまでは見せない（位置は描いた後に直接置く） */
const HIDDEN = { left: 0, top: 0, visibility: 'hidden' } as const

export function PopupMenu({
  label,
  items,
  placement,
  onClose,
  returnFocus,
  autoFocus = true,
  swallowOutsideClick = true,
  testId,
}: PopupMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const previous = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement)
  const focusBack = useRef(returnFocus)
  focusBack.current = returnFocus
  const options = useRef({ autoFocus, swallowOutsideClick })

  // 画面からはみ出さない位置に置く（右・下にはみ出す時は左・上へ寄せる）。
  // 描き直さずに直接置く（隠れたままだとフォーカスを移せないので、描いた直後に見えるようにする）
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let x: number
    let y: number
    if ('anchor' in placement) {
      const r = placement.anchor.getBoundingClientRect()
      x = r.right - w
      y = r.bottom + 4
      if (y + h > vh - EDGE) y = r.top - h - 4
    } else {
      x = placement.point.x
      y = placement.point.y
      if (x + w > vw - EDGE) x = x - w
      if (y + h > vh - EDGE) y = y - h
    }
    el.style.left = `${Math.max(EDGE, Math.min(x, vw - w - EDGE))}px`
    el.style.top = `${Math.max(EDGE, Math.min(y, vh - h - EDGE))}px`
    el.style.visibility = 'visible'
  }, [placement])

  useEffect(() => {
    const el = ref.current
    if (options.current.autoFocus) {
      el?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    }
    // 開いたボタン（anchor）を押した時は、そのボタンの操作（開く・閉じる）に任せる
    const anchor = 'anchor' in placement ? placement.anchor : null
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (anchor?.contains(target)) return
      if (ref.current && !ref.current.contains(target)) {
        // 外側を押して閉じる時は、閉じるだけにする（下にあるリンクなどを開かない）
        if (options.current.swallowOutsideClick) swallowNextClick()
        closeRef.current()
      }
    }
    // Esc は document の捕捉の段階で受けて止める（フォーカスがほかにあっても閉じられ、同じ1回の Esc で後ろの部品まで閉じない）。
    // 変換中の Esc では閉じない（今の Modal と同じ）
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
      closeRef.current()
    }
    // 画面キーボードの開閉（高さだけが変わる）では閉じない。回転・ウィンドウの幅の変更の時だけ閉じる（置いた位置がずれるので）
    const openWidth = window.innerWidth
    const onResize = () => {
      if (window.innerWidth !== openWidth) closeRef.current()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      // 閉じた後は開く前の場所へ（フォーカスがほかへ移っていた時は動かさない）
      const back = focusBack.current ?? (previous.current instanceof HTMLElement ? previous.current : null)
      const active = document.activeElement
      if (back?.isConnected && (!active || active === document.body || el?.contains(active))) {
        back.focus({ preventScroll: true })
      }
    }
    // 開いた時に1回だけ付ける（置き場所が変わった時は上の useLayoutEffect が置き直す）
  }, [])

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let j = -1
    if (e.key === 'ArrowDown') j = (i + 1) % buttons.length
    else if (e.key === 'ArrowUp') j = (i - 1 + buttons.length) % buttons.length
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = buttons.length - 1
    // Esc は上の document の捕捉の段階で受ける
    else if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
      return
    }
    if (j < 0 || buttons.length === 0) return
    e.preventDefault()
    buttons[j].focus()
  }

  return createPortal(
    <div
      ref={ref}
      className="pm-menu"
      role="menu"
      id={menuId}
      aria-label={label}
      onKeyDown={onKey}
      // 右クリックで窓の上にブラウザのメニューを重ねない
      onContextMenu={(e) => e.preventDefault()}
      style={HIDDEN}
      data-testid={testId ?? 'popup-menu'}
    >
      <p className="pm-title" aria-hidden="true">
        {label}
      </p>
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className="pm-item"
          aria-label={it.ariaLabel}
          onClick={() => {
            closeRef.current()
            it.onSelect()
          }}
          data-testid={it.testId}
        >
          <span className="pm-label">{it.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
