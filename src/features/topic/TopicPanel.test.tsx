// L の列に重ねる詳細のパネル（docs/SPEC.md の 9. の「詳細」。設計: 段階2の 1.4・2.・4.1）: 差し込み口へ出す・重ねた列の一覧（差し込み口の
// 兄弟）だけを inert にし、閉じると戻す（前から inert の物は触らない）・開くと見出しへ、閉じると開いた所へフォーカス・Esc で閉じる・
// 小さな画面（クリップの窓）が開いている間は Esc で閉じず、窓だけが閉じてフォーカスがクリップのボタンへ戻る・変換中の Esc では閉じない
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { repairTopic, type ShownTopic } from '../../domain/repair'
import { makeFakeEdition } from '../../test/fixtures/fakeEditions'
import { FAKE_OUTLETS } from '../../test/fixtures/fakeOutlets'
import { Modal } from '../../ui/Modal'
import { ClipButton } from './ClipButton'
import { TopicPanel } from './TopicPanel'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  Reflect.deleteProperty(navigator, 'clipboard')
})

const TOPIC = (() => {
  const r = repairTopic(makeFakeEdition({ date: '2026-11-15', slot: '12', seed: 'topic-panel' }).topics[0], {
    outlets: FAKE_OUTLETS,
  })
  if (r.kind !== 'ok') throw new Error('作り物の話題を写しにできません')
  return r.value as ShownTopic
})()

/** 列（一覧・前から inert の物・差し込み口）と、開いた所のボタン */
function setUp() {
  const column = document.createElement('div')
  column.innerHTML =
    '<div data-testid="list"><button type="button" data-testid="opener">カード</button></div><div data-testid="old-inert"></div><div class="panel-slot" data-testid="slot"></div>'
  document.body.appendChild(column)
  const oldInert = column.querySelector<HTMLElement>('[data-testid="old-inert"]')!
  oldInert.inert = true
  const opener = column.querySelector<HTMLButtonElement>('[data-testid="opener"]')!
  opener.focus()
  return {
    slot: column.querySelector<HTMLElement>('[data-testid="slot"]')!,
    list: column.querySelector<HTMLElement>('[data-testid="list"]')!,
    oldInert,
    opener,
  }
}

function Harness({
  slot,
  onClose,
  withModal = false,
  onEscape,
}: {
  slot: HTMLElement
  onClose: () => void
  withModal?: boolean
  onEscape?: () => boolean
}) {
  const [open, setOpen] = useState(true)
  const [modal, setModal] = useState(withModal)
  if (!open) return null
  return (
    <>
      <TopicPanel
        slot={slot}
        title="11/15（日）12:00版・国内・テクノロジー"
        actions={<ClipButton topic={TOPIC} corrections={[]} />}
        onClose={() => {
          onClose()
          setOpen(false)
        }}
        onEscape={onEscape}
      >
        <h3 className="topic-title" tabIndex={-1}>
          見出し
        </h3>
      </TopicPanel>
      {modal ? (
        <Modal title="上の窓" onClose={() => setModal(false)}>
          <p>中身</p>
        </Modal>
      ) : null}
    </>
  )
}

describe('出し方（設計: 段階2の 1.4）', () => {
  it('差し込み口の中に出し、重ねた列の一覧だけを inert にする。閉じると戻し、前から inert の物はそのまま', () => {
    const { slot, list, oldInert, opener } = setUp()
    const onClose = vi.fn()
    render(<Harness slot={slot} onClose={onClose} />)
    const panel = slot.querySelector('.topic-panel') as HTMLElement
    expect(panel).toBeTruthy()
    expect(panel.classList.contains('panel-in')).toBe(true)
    expect(list.inert).toBe(true)
    expect(oldInert.inert).toBe(true)
    expect(document.activeElement?.textContent).toBe('見出し')
    // ［クリップ］は頭の行の［×］の左
    const head = panel.querySelector('.topic-panel-head') as HTMLElement
    const buttons = within(head).getAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('data-testid'))).toEqual(['topic-clip', 'topic-close'])
    fireEvent.click(within(head).getByTestId('topic-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(slot.querySelector('.topic-panel')).toBeNull()
    expect(list.inert).toBe(false)
    expect(oldInert.inert).toBe(true)
    // 閉じると開いた所へフォーカスを戻す
    expect(document.activeElement).toBe(opener)
  })

  it('閉じた時に、フォーカスがほかの所へ移っていれば、そのままにする', () => {
    const { slot } = setUp()
    const other = document.createElement('button')
    document.body.appendChild(other)
    const { rerender } = render(<Harness slot={slot} onClose={() => {}} />)
    other.focus()
    rerender(<></>)
    expect(document.activeElement).toBe(other)
  })
})

describe('Esc（設計: 段階2の 2.）', () => {
  it('Esc で閉じる。変換中の Esc では閉じない', () => {
    const { slot } = setUp()
    const onClose = vi.fn()
    render(<Harness slot={slot} onClose={onClose} />)
    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(document.body, { key: 'Escape', keyCode: 229 })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // 説明の箱が開いている時は、フォーカスが中身の外（頭の行の［クリップ］・body）にあっても、Esc で箱だけを閉じる（設計: 段階2の 1.12・2.）
  it('onEscape が true を返す Esc では閉じない（中身の箱だけを閉じた時）。false なら閉じる', () => {
    const { slot } = setUp()
    const onClose = vi.fn()
    let inner = true
    const onEscape = vi.fn(() => inner)
    render(<Harness slot={slot} onClose={onClose} onEscape={onEscape} />)
    screen.getByTestId('topic-clip').focus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    inner = false
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('小さな画面が開いている間（isModalOpen）は Esc で閉じず、上の窓だけが閉じる。次の Esc でパネルが閉じる', () => {
    const { slot } = setUp()
    const onClose = vi.fn()
    render(<Harness slot={slot} onClose={onClose} withModal />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(slot.querySelector('.topic-panel')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('パネルの上のクリップの窓で Esc を押すと窓だけ閉じ、フォーカスはクリップのボタンへ戻る', async () => {
    const { slot } = setUp()
    const onClose = vi.fn()
    // クリップボードが無い（古いブラウザ）ので、文を選んだ窓が出る
    render(<Harness slot={slot} onClose={onClose} />)
    const clip = within(slot).getByTestId('topic-clip')
    clip.focus()
    await act(async () => {
      fireEvent.click(clip)
    })
    const dialog = await screen.findByTestId('clip-dialog')
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('textbox')))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('clip-dialog')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    expect(slot.querySelector('.topic-panel')).toBeTruthy()
    expect(document.activeElement).toBe(clip)
  })
})

describe('部品の外の物（設計: 段階2の 1.4）', () => {
  it('差し込み口の兄弟でない物（ほかの列）は inert にしない', () => {
    const { slot } = setUp()
    const other = document.createElement('div')
    document.body.appendChild(other)
    function Two(): JSX.Element {
      return <Harness slot={slot} onClose={() => {}} />
    }
    render(<Two />)
    expect(other.inert).toBeFalsy()
  })
})
