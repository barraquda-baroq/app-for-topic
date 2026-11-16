// 版の一覧を「見た」にする時（docs/SPEC.md の 7.4・9.。開発。設計: 段階2の 1.6・8. の 16）: 同期が落ち着いている間に 3秒続けて表に出て
// いた時と、一覧を操作した時だけ。受け取りの途中（downloading・null）・オフラインに出た版・裏の間・3秒の前に替わった版は見たにならない。
// アプリが動かすスクロールでは付かない。逆に、落ち着いて3秒・操作ですぐ付く事も確かめる（付かないままだと追いつきの帯が出続けるため）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShownReadMark } from '../../domain/repair'
import { markSeen, resetStoreForTests, useApp } from '../../store/appStore'
import { useSyncView, type SyncView } from '../../sync/syncView'
import { SEEN_AFTER_MS, useSeenMark } from './useSeenMark'

// ストアの markSeen だけを見張る（端末に書く決まりはストアのテストで確かめる）
vi.mock('../../store/appStore', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../store/appStore')>()
  return { ...m, markSeen: vi.fn(() => ({ ok: true, changed: true })) }
})

const A = '2026-11-15-12'
const B = '2026-11-15-20'

function Harness({ editionId }: { editionId: string | null }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  useSeenMark(editionId, root)
  return (
    <div ref={setRoot} data-testid="list">
      <button type="button">カード</button>
    </div>
  )
}

function setSync(view: SyncView | null) {
  act(() => useSyncView.setState({ view }))
}

let visibility: DocumentVisibilityState = 'visible'

function setVisibility(v: DocumentVisibilityState) {
  visibility = v
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  vi.mocked(markSeen).mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useSyncView.setState({ view: null })
  resetStoreForTests()
})

describe('落ち着いた後に 3秒出ていた版を見たにする', () => {
  it('同期が落ち着いている（synced）間に 3秒続けて出ると見たにする（3秒の前は付けない）', () => {
    setSync({ kind: 'synced' })
    render(<Harness editionId={A} />)
    advance(SEEN_AFTER_MS - 1)
    expect(markSeen).not.toHaveBeenCalled()
    advance(1)
    expect(markSeen).toHaveBeenCalledTimes(1)
    expect(markSeen).toHaveBeenCalledWith(A)
    expect(SEEN_AFTER_MS).toBe(3000)
  })

  it.each<SyncView>([{ kind: 'pending', count: 2 }, { kind: 'sending' }])('%o も落ち着いているとみなす', (view) => {
    setSync(view)
    render(<Harness editionId={A} />)
    advance(SEEN_AFTER_MS)
    expect(markSeen).toHaveBeenCalledWith(A)
  })

  it.each<SyncView | null>([
    null,
    { kind: 'downloading' },
    { kind: 'offline' },
    { kind: 'quota', resumeAt: '17:00' },
    { kind: 'outdated' },
    { kind: 'error', reason: '不明なエラー' },
  ])('受け取りの途中・まだ分からない・止まっている間（%o）は、いくら出ていても見たにならない', (view) => {
    setSync(view)
    render(<Harness editionId={A} />)
    advance(SEEN_AFTER_MS * 10)
    expect(markSeen).not.toHaveBeenCalled()
  })

  it('受け取りの途中に出た版は見たにならず、落ち着いてから 3秒で見たになる（落ち着いた時から数える）', () => {
    setSync({ kind: 'downloading' })
    render(<Harness editionId={A} />)
    advance(SEEN_AFTER_MS * 2)
    setSync({ kind: 'synced' })
    advance(SEEN_AFTER_MS - 1)
    expect(markSeen).not.toHaveBeenCalled()
    advance(1)
    expect(markSeen).toHaveBeenCalledWith(A)
  })

  it('3秒の前に版が替わると、前の版は見たにならない（替わった版を初めから数える）', () => {
    setSync({ kind: 'synced' })
    const { rerender } = render(<Harness editionId={A} />)
    advance(SEEN_AFTER_MS - 500)
    rerender(<Harness editionId={B} />)
    advance(SEEN_AFTER_MS - 1)
    expect(markSeen).not.toHaveBeenCalled()
    advance(1)
    expect(vi.mocked(markSeen).mock.calls).toEqual([[B]])
  })

  it('3秒の前に落ち着かなくなると数え直す', () => {
    setSync({ kind: 'synced' })
    render(<Harness editionId={A} />)
    advance(SEEN_AFTER_MS - 500)
    setSync({ kind: 'downloading' })
    advance(SEEN_AFTER_MS)
    setSync({ kind: 'synced' })
    advance(SEEN_AFTER_MS - 1)
    expect(markSeen).not.toHaveBeenCalled()
    advance(1)
    expect(markSeen).toHaveBeenCalledTimes(1)
  })

  it('裏の間は数えず、表に戻ってから 3秒で見たになる（裏で始まった時も同じ）', () => {
    setSync({ kind: 'synced' })
    render(<Harness editionId={A} />)
    advance(SEEN_AFTER_MS - 500)
    setVisibility('hidden')
    advance(SEEN_AFTER_MS * 5)
    expect(markSeen).not.toHaveBeenCalled()
    setVisibility('visible')
    advance(SEEN_AFTER_MS - 1)
    expect(markSeen).not.toHaveBeenCalled()
    advance(1)
    expect(markSeen).toHaveBeenCalledTimes(1)
  })

  it('裏で開いた時は、表になるまで数えない', () => {
    visibility = 'hidden'
    setSync({ kind: 'synced' })
    render(<Harness editionId={A} />)
    advance(SEEN_AFTER_MS * 3)
    expect(markSeen).not.toHaveBeenCalled()
    setVisibility('visible')
    advance(SEEN_AFTER_MS)
    expect(markSeen).toHaveBeenCalledWith(A)
  })

  it('出している版が無い（null）間は何もしない', () => {
    setSync({ kind: 'synced' })
    render(<Harness editionId={null} />)
    advance(SEEN_AFTER_MS * 3)
    fireEvent.pointerDown(screen.getByTestId('list'))
    expect(markSeen).not.toHaveBeenCalled()
  })

  it('もう見た版には何もしない', () => {
    act(() =>
      useApp.setState({
        user: { knownTerms: {}, reads: { [A]: { id: A, editionId: A, topicIds: [], seen: true } as unknown as ShownReadMark } },
      }),
    )
    setSync({ kind: 'synced' })
    render(<Harness editionId={A} />)
    advance(SEEN_AFTER_MS)
    fireEvent.pointerDown(screen.getByRole('button'))
    expect(markSeen).not.toHaveBeenCalled()
  })
})

describe('一覧を操作したらすぐ見たにする', () => {
  it.each([
    ['pointerdown', (el: Element) => fireEvent.pointerDown(el)],
    ['wheel', (el: Element) => fireEvent.wheel(el)],
    ['keydown', (el: Element) => fireEvent.keyDown(el, { key: 'ArrowDown' })],
  ])('%s（落ち着く前・受け取りの途中でも）', (_name, fire) => {
    setSync({ kind: 'downloading' })
    render(<Harness editionId={A} />)
    fire(screen.getByRole('button'))
    expect(markSeen).toHaveBeenCalledTimes(1)
    expect(markSeen).toHaveBeenCalledWith(A)
  })

  it('中の部品が知らせを止めても数える', () => {
    setSync(null)
    render(<Harness editionId={A} />)
    const button = screen.getByRole('button')
    button.addEventListener('pointerdown', (e) => e.stopPropagation())
    fireEvent.pointerDown(button)
    expect(markSeen).toHaveBeenCalledWith(A)
  })

  it('アプリが動かすスクロール（scroll の知らせ・scrollTo）と、一覧の外の操作では付かない', () => {
    setSync(null)
    render(<Harness editionId={A} />)
    const list = screen.getByTestId('list')
    fireEvent.scroll(list)
    fireEvent.scroll(window)
    window.scrollTo(0, 100)
    fireEvent.pointerDown(document.body)
    fireEvent.keyDown(document.body, { key: 'Tab' })
    expect(markSeen).not.toHaveBeenCalled()
  })
})
