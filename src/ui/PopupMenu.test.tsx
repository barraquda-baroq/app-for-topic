// 小さな窓（src/ui/PopupMenu.tsx。DS の src/ui/PopupMenu.test.tsx から、TS が写した所だけ。設計: 段階2の 1.1）: 外側を押すと閉じるだけ
// （下のリンクは開かない）・高さだけの変化では閉じず、幅が変わったら閉じる・押した所の下に開き、入らなければ上・画面の端からはみ出さない・
// Esc（変換中は閉じない）と Tab で閉じ、開く前の要素へフォーカスを戻す・矢印キーで項目を移る・押した所を押すとそのボタンの操作に任せる・
// 小さな画面より前、お知らせより後ろに出す
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PopupMenu, type PopupMenuProps } from './PopupMenu'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function Harness({ onLink }: { onLink: () => void }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <a
        href="#/elsewhere"
        data-testid="row-link"
        onClick={(e) => {
          e.preventDefault()
          onLink()
        }}
      >
        別の行
      </a>
      {open ? (
        <PopupMenu
          label="操作"
          items={[{ label: '開く', onSelect: () => {}, testId: 'menu-open' }]}
          placement={{ point: { x: 10, y: 10 } }}
          onClose={() => setOpen(false)}
          testId="row-menu"
        />
      ) : null}
    </>
  )
}

const setWindowSize = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  window.dispatchEvent(new Event('resize'))
}

/** 押した要素の位置と窓の大きさ（jsdom は測らないので差し替える） */
function fakeLayout(rect: { top: number; bottom: number; left: number; right: number }, size = { w: 200, h: 60 }) {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('pm-menu') ? size.w : 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('pm-menu') ? size.h : 0
  })
  return () => ({ ...rect, x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }) as DOMRect
}

/** 押すと下に窓を開くボタン（ヘッダーの同期の表示と同じ使い方） */
function AnchorHarness({
  menu = {},
  rect,
  onOther = () => {},
}: {
  menu?: Partial<PopupMenuProps>
  rect?: () => DOMRect
  onOther?: () => void
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        type="button"
        data-testid="anchor"
        ref={(el) => {
          anchor.current = el
          if (el && rect) el.getBoundingClientRect = rect
        }}
        onClick={() => setOpen((o) => !o)}
      >
        同期
      </button>
      <button type="button" data-testid="other" onClick={onOther}>
        ほか
      </button>
      {open && anchor.current ? (
        <PopupMenu
          label="同期"
          items={[
            { label: '同期済み', onSelect: () => {}, testId: 'item-a' },
            { label: '二つ目', ariaLabel: '二つ目の項目', onSelect: () => {}, testId: 'item-b' },
            { label: '三つ目', onSelect: () => {}, testId: 'item-c' },
          ]}
          placement={{ anchor: anchor.current }}
          onClose={() => setOpen(false)}
          testId="anchor-menu"
          {...menu}
        />
      ) : null}
    </>
  )
}

describe('PopupMenu', () => {
  it('外側を押して閉じた時は、続くクリック（下の行のリンク）を取り消す。次に押した時はふつうに届く', () => {
    const onLink = vi.fn()
    render(<Harness onLink={onLink} />)
    const link = screen.getByTestId('row-link')
    expect(screen.getByTestId('row-menu')).toBeTruthy()
    fireEvent.pointerDown(link)
    expect(screen.queryByTestId('row-menu')).toBeNull()
    fireEvent.click(link)
    expect(onLink).not.toHaveBeenCalled()
    // 次に触れた時のクリックは取り消さない
    fireEvent.pointerDown(link)
    fireEvent.click(link)
    expect(onLink).toHaveBeenCalledTimes(1)
  })

  it('クリックが届かなければ、取り消しは少し経つと終わる', () => {
    vi.useFakeTimers()
    const onLink = vi.fn()
    render(<Harness onLink={onLink} />)
    const link = screen.getByTestId('row-link')
    fireEvent.pointerDown(link)
    act(() => {
      vi.advanceTimersByTime(1100)
    })
    fireEvent.click(link)
    expect(onLink).toHaveBeenCalledTimes(1)
  })

  it('画面の高さだけが変わった時（画面キーボードの開閉）は閉じず、幅が変わった時（回転）は閉じる', () => {
    setWindowSize(360, 400)
    render(<Harness onLink={() => {}} />)
    act(() => setWindowSize(360, 740))
    expect(screen.getByTestId('row-menu')).toBeTruthy()
    act(() => setWindowSize(740, 360))
    expect(screen.queryByTestId('row-menu')).toBeNull()
  })

  it('外のスクロールで閉じ、窓の中のスクロールでは閉じない', () => {
    render(<Harness onLink={() => {}} />)
    const menu = screen.getByTestId('row-menu')
    fireEvent.scroll(menu)
    expect(screen.getByTestId('row-menu')).toBeTruthy()
    fireEvent.scroll(window)
    expect(screen.queryByTestId('row-menu')).toBeNull()
  })
})

describe('PopupMenu（押した所の下に開く窓）', () => {
  it('押した所の下に、右端をそろえて開く。下に入らなければ上に開き、画面の端からはみ出さない', () => {
    setWindowSize(360, 740)
    const rect = fakeLayout({ top: 9, bottom: 43, left: 270, right: 304 })
    const { unmount } = render(<AnchorHarness rect={rect} />)
    fireEvent.click(screen.getByTestId('anchor'))
    const menu = screen.getByTestId('anchor-menu')
    expect(menu.style.top).toBe(`${43 + 4}px`)
    expect(menu.style.left).toBe(`${304 - 200}px`)
    expect(menu.style.visibility).toBe('visible')
    unmount()

    const low = fakeLayout({ top: 700, bottom: 734, left: 4, right: 38 })
    render(<AnchorHarness rect={low} />)
    fireEvent.click(screen.getByTestId('anchor'))
    const above = screen.getByTestId('anchor-menu')
    expect(above.style.top).toBe(`${700 - 60 - 4}px`)
    // 画面の左端からはみ出さない
    expect(above.style.left).toBe('8px')
  })

  it('開くと最初の項目へフォーカスし、↓↑・Home・End で項目を移る。ariaLabel は読み上げの名前になる', () => {
    render(<AnchorHarness />)
    fireEvent.click(screen.getByTestId('anchor'))
    const menu = screen.getByTestId('anchor-menu')
    expect(menu.getAttribute('role')).toBe('menu')
    expect(menu.getAttribute('aria-label')).toBe('同期')
    expect(screen.getAllByRole('menuitem')).toHaveLength(3)
    expect(screen.getByTestId('item-b').getAttribute('aria-label')).toBe('二つ目の項目')
    expect(screen.getByTestId('item-a').hasAttribute('aria-label')).toBe(false)
    expect(document.activeElement).toBe(screen.getByTestId('item-a'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('item-b'))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByTestId('item-c'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('item-a'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByTestId('item-c'))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByTestId('item-a'))
    // 左右では動かない（縦の窓）
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByTestId('item-a'))
  })

  it('Esc で閉じ、押した所へフォーカスを戻す。変換中の Esc（変換の取り消し）では閉じない', () => {
    render(<AnchorHarness />)
    const anchor = screen.getByTestId('anchor')
    anchor.focus()
    fireEvent.click(anchor)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', isComposing: true })
    expect(screen.getByTestId('anchor-menu')).toBeTruthy()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByTestId('anchor-menu')).toBeNull()
    expect(document.activeElement).toBe(anchor)
  })

  it('Tab で閉じる（窓の中にフォーカスを閉じ込めない）', () => {
    render(<AnchorHarness />)
    fireEvent.click(screen.getByTestId('anchor'))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(screen.queryByTestId('anchor-menu')).toBeNull()
  })

  it('項目を押すと閉じてからその働きをし、returnFocus を渡すとそこへフォーカスを戻す', () => {
    const onSelect = vi.fn()
    render(<AnchorHarnessWithReturn onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('anchor'))
    fireEvent.click(screen.getByTestId('item-x'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('anchor-menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('return-here'))
  })

  it('押した所（anchor）を押すと、そのボタンの操作で閉じる（外側として閉じ直さない）', () => {
    render(<AnchorHarness />)
    const anchor = screen.getByTestId('anchor')
    fireEvent.click(anchor)
    fireEvent.pointerDown(anchor)
    expect(screen.getByTestId('anchor-menu')).toBeTruthy()
    fireEvent.click(anchor)
    expect(screen.queryByTestId('anchor-menu')).toBeNull()
  })

  it('swallowOutsideClick=false: 開いたまま別のボタンを押すと、閉じてそのボタンも1回で働く', () => {
    const onOther = vi.fn()
    render(<AnchorHarness menu={{ swallowOutsideClick: false }} onOther={onOther} />)
    fireEvent.click(screen.getByTestId('anchor'))
    const other = screen.getByTestId('other')
    fireEvent.pointerDown(other)
    expect(screen.queryByTestId('anchor-menu')).toBeNull()
    fireEvent.click(other)
    expect(onOther).toHaveBeenCalledTimes(1)
  })

  it('autoFocus=false: 開いてもフォーカスを動かさない', () => {
    render(<AnchorHarness menu={{ autoFocus: false }} />)
    const anchor = screen.getByTestId('anchor')
    anchor.focus()
    fireEvent.click(anchor)
    expect(screen.getByTestId('anchor-menu')).toBeTruthy()
    expect(document.activeElement).toBe(anchor)
  })
})

/** 閉じた後のフォーカスの戻り先を渡す窓 */
function AnchorHarnessWithReturn({ onSelect }: { onSelect: () => void }) {
  const [back, setBack] = useState<HTMLElement | null>(null)
  return (
    <>
      <button type="button" data-testid="return-here" ref={setBack}>
        戻り先
      </button>
      <AnchorHarness menu={{ items: [{ label: '押す', onSelect, testId: 'item-x' }], returnFocus: back }} />
    </>
  )
}

describe('窓の重なり（menu.css）', () => {
  // CSS は import するとテストでは中身が空になるので、ファイルを読む（src/styles.test.ts と同じ読み方）
  const NODE_FS = 'node:fs'
  const read = async (relative: string) => {
    const { readFileSync } = (await import(/* @vite-ignore */ NODE_FS)) as {
      readFileSync: (path: string, encoding: 'utf8') => string
    }
    return readFileSync(decodeURIComponent(new URL(relative, import.meta.url).pathname), 'utf8')
  }
  /** そのセレクタの規則の z-index（コメントを除いて探す） */
  const zIndexOf = (css: string, selector: string) => {
    const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const at = src.search(new RegExp(`(^|\\n)${selector.replace(/[.[\]]/g, '\\$&')}\\s*\\{`))
    const body = src.slice(at, src.indexOf('}', at))
    return Number(/z-index:\s*(\d+)/.exec(body)?.[1])
  }

  it('小さな画面（.modal-backdrop）の上で開いた窓も、その前に出す。お知らせ（.toasts）よりは後ろ。ヘッダー（.app-header）より前', async () => {
    const menu = zIndexOf(await read('./menu.css'), '.pm-menu')
    const common = await read('../styles.css')
    expect(menu).toBeGreaterThan(zIndexOf(common, '.modal-backdrop'))
    expect(menu).toBeLessThan(zIndexOf(common, '.toasts'))
    expect(menu).toBeGreaterThan(zIndexOf(common, '.app-header'))
  })
})
