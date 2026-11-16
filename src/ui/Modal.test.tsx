// 小さな画面（DS の src/ui/Modal.test.tsx から、DS の予定の画面の印の確かめを外した物）: data-testid・クラス、Esc・背景・×で閉じる、
// 開いた直後の Esc、フォーカスの戻り先、日本語の変換の Esc、Tab の囲い。段階2で、開いているかを外から見る isModalOpen を足した
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isModalOpen, Modal } from './Modal'

afterEach(cleanup)

describe('Modal', () => {
  it('data-testid・クラスを .modal に付ける（role は dialog、名前は題）', () => {
    render(
      <Modal title="ホーム画面に追加" onClose={() => {}} testId="m" className="install">
        中身
      </Modal>,
    )
    const modal = screen.getByTestId('m')
    expect(modal.classList.contains('modal')).toBe(true)
    expect(modal.classList.contains('install')).toBe(true)
    expect(modal.getAttribute('role')).toBe('dialog')
    expect(screen.getByRole('dialog', { name: 'ホーム画面に追加' })).toBe(modal)
  })

  it('Esc・背景・×で閉じる', () => {
    const onClose = vi.fn()
    render(
      <Modal title="確かめ" onClose={onClose} testId="m">
        中身
      </Modal>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.mouseDown(document.querySelector('.modal-backdrop')!)
    fireEvent.click(screen.getByTestId('modal-close'))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  // 中身の小さな物（詳細の説明の箱）が開いている時は、フォーカスが中身の外にあっても Esc でそれだけを閉じる（設計: 段階2の 1.12・2.）
  it('onEscape が true を返す Esc では閉じない（false なら閉じる）。上に重ねた窓がある間は呼ばない', () => {
    const onClose = vi.fn()
    let inner = true
    const onEscape = vi.fn(() => inner)
    const { rerender } = render(
      <Modal title="確かめ" onClose={onClose} onEscape={onEscape}>
        中身
      </Modal>,
    )
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    inner = false
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenCalledTimes(1)
    // 変換中の Esc では呼ばない
    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true })
    expect(onEscape).toHaveBeenCalledTimes(2)
    // 上に窓を重ねている間は、上の窓だけが Esc を扱う
    const onTop = vi.fn()
    rerender(
      <>
        <Modal title="確かめ" onClose={onClose} onEscape={onEscape}>
          中身
        </Modal>
        <Modal title="上の窓" onClose={onTop}>
          上
        </Modal>
      </>,
    )
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onTop).toHaveBeenCalledTimes(1)
    expect(onEscape).toHaveBeenCalledTimes(2)
  })

  it('開いた直後（描いたすぐ後・ブラウザが描く前）に押した Esc も聞き、その時にはもう中へフォーカスを移してある（開発）', () => {
    const onClose = vi.fn()
    const seen: boolean[] = []
    /** Modal の後に置いた部品。Modal と同じ描画の useLayoutEffect（Modal の物の後）で、中にフォーカスがあるかを見て Esc を押す */
    function PressEscRightAway() {
      useLayoutEffect(() => {
        seen.push(Boolean(document.querySelector('[data-testid="m"]')?.contains(document.activeElement)))
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      }, [])
      return null
    }
    // 開いたボタン（カードなど）にフォーカスがある所から開く
    const opener = <button type="button">開く</button>
    const { rerender } = render(opener)
    act(() => screen.getByText('開く').focus())
    rerender(
      <>
        {opener}
        <Modal title="確かめ" onClose={onClose} testId="m">
          <input aria-label="件名" />
        </Modal>
        <PressEscRightAway />
      </>,
    )
    expect(seen).toEqual([true])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('開いた物（メニューの項目）が同じ描画で外れた時は、ほかの部品がフォーカスを戻した所（メニューを開いたボタン）を、閉じた後に戻る先にする', () => {
    /** メニュー（DS の src/ui/PopupMenu と同じく、外れる時にフォーカスが body に落ちていれば開いたボタンへ戻す） */
    function Menu({ back }: { back: () => HTMLElement | null }) {
      useEffect(
        () => () => {
          if (document.activeElement === document.body) back()?.focus()
        },
        [back],
      )
      return <button type="button">削除</button>
    }
    const back = () => screen.queryByText('…')
    const view = (menu: boolean, dialog: boolean) => (
      <>
        <button type="button">…</button>
        {menu ? <Menu back={back} /> : null}
        {dialog ? (
          <Modal title="削除しますか？" onClose={() => {}} testId="m">
            <button type="button">やめる</button>
          </Modal>
        ) : null}
      </>
    )
    const { rerender } = render(view(true, false))
    act(() => screen.getByText('削除').focus())
    // メニューの項目を押した: メニューを閉じて、確かめを開く（同じ描画）
    rerender(view(false, true))
    expect(screen.getByTestId('m').contains(document.activeElement)).toBe(true)
    rerender(view(false, false))
    expect(document.activeElement).toBe(screen.getByText('…'))
  })

  it('日本語の変換を取り消す Esc（isComposing・Safari の keyCode 229）では閉じない', () => {
    const onClose = vi.fn()
    render(
      <Modal title="確かめ" onClose={onClose} testId="m">
        中身
      </Modal>,
    )
    fireEvent.keyDown(document, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(document, { key: 'Escape', keyCode: 229 })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Tab の囲いは見えている物だけを数える（checkVisibility。visibility: hidden の畳んだ欄は最後の物にしない）', () => {
    // jsdom は配置も checkVisibility も持たないので、見えるかどうかを data-shown で決める
    const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'checkVisibility')
    Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
      configurable: true,
      writable: true,
      value(this: HTMLElement) {
        return this.dataset.shown !== 'no'
      },
    })
    try {
      render(
        <Modal title="確かめ" onClose={() => {}} testId="m">
          <input aria-label="件名" />
          <button type="button">詳しく</button>
          <textarea aria-label="メモ" data-shown="no" />
        </Modal>,
      )
      // 見えている最後の物（詳しく）から Tab で最初（×）へ戻る。見えないメモへは行かない
      const more = screen.getByText('詳しく')
      more.focus()
      fireEvent.keyDown(document, { key: 'Tab' })
      expect(document.activeElement).toBe(screen.getByTestId('modal-close'))
      // 最初の物から Shift+Tab で、見えている最後の物へ
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
      expect(document.activeElement).toBe(more)
    } finally {
      if (before) Object.defineProperty(HTMLElement.prototype, 'checkVisibility', before)
      else Reflect.deleteProperty(HTMLElement.prototype, 'checkVisibility')
    }
  })

  it('isModalOpen: 開いている間だけ true。2つ重ねて上だけ閉じても true、全部閉じると false（L のパネルの Esc の取り合い。設計: 段階2の 2.）', () => {
    expect(isModalOpen()).toBe(false)
    const view = (outer: boolean, inner: boolean) => (
      <>
        {outer ? (
          <Modal title="下" onClose={() => {}} testId="outer">
            中身
          </Modal>
        ) : null}
        {inner ? (
          <Modal title="上" onClose={() => {}} testId="inner">
            中身
          </Modal>
        ) : null}
      </>
    )
    const { rerender, unmount } = render(view(true, false))
    expect(isModalOpen()).toBe(true)
    rerender(view(true, true))
    expect(isModalOpen()).toBe(true)
    rerender(view(true, false))
    expect(isModalOpen()).toBe(true)
    rerender(view(false, false))
    expect(isModalOpen()).toBe(false)
    rerender(view(true, true))
    unmount()
    expect(isModalOpen()).toBe(false)
  })
})
