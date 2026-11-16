// 話題の詳細の開け閉めと履歴（docs/SPEC.md の 9.・14.5。設計: 段階2の 2.）: 開くと同じ行き先を state.sheet 付きで積み、閉じると1つ戻る。
// もう開いている時は置き換え（履歴を増やさない。side を渡さなければ列のまま）。同じ所で2回閉じても2つ戻らない。読み込み直した後の
// state.sheet は残して読め（TopicHost が開き直す）、戻る物が無ければ印を外して置き換える。差し込み口は出ている間だけ usePanelSlots に入る
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { createElement, type JSX } from 'react'
import { createHashRouter, createMemoryRouter, RouterProvider, type InitialEntry } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openedOnThisPage,
  PAGE_ID,
  PanelSlot,
  resetSheetsForTests,
  sheetOf,
  sheetState,
  usePanelSlots,
  useTopicSheet,
  type PanelSide,
  type TopicSheetApi,
} from './sheets'

afterEach(() => {
  cleanup()
  resetSheetsForTests()
  usePanelSlots.setState({ jp: null, world: null })
})

/** 最後に描いた時の useTopicSheet の返り値 */
let latest: TopicSheetApi | null = null

function Harness(): JSX.Element | null {
  latest = useTopicSheet()
  return null
}

const ROUTES = ['/', '/e/:editionId', '/catch-up'].map((path) => ({ path, element: createElement(Harness) }))

function renderAt(initialEntries: InitialEntry[], initialIndex?: number) {
  latest = null
  const router = createMemoryRouter(ROUTES, { initialEntries, initialIndex })
  render(createElement(RouterProvider, { router }))
  return router
}

const api = () => {
  if (!latest) throw new Error('まだ描いていません')
  return latest
}

describe('開く・閉じる（履歴）', () => {
  it('開くと同じ行き先を state.sheet 付きで積み、閉じると1つ戻る（URL に話題の id を出さない）', async () => {
    const router = renderAt(['/e/2026-11-14-20'])
    expect(api().current).toBeNull()
    await act(async () => api().openTopic('topic-a', { side: 'world' }))
    expect(router.state.historyAction).toBe('PUSH')
    expect(router.state.location.pathname).toBe('/e/2026-11-14-20')
    expect(sheetOf(router.state.location.state)).toEqual({ kind: 'topic', id: 'topic-a', side: 'world' })
    expect(openedOnThisPage(router.state.location.state)).toBe(true)
    expect(api().current).toEqual({ kind: 'topic', id: 'topic-a', side: 'world' })

    await act(async () => api().closeTopic())
    expect(router.state.historyAction).toBe('POP')
    expect(router.state.location.pathname).toBe('/e/2026-11-14-20')
    expect(sheetOf(router.state.location.state)).toBeNull()
    expect(api().current).toBeNull()
  })

  it('side を渡さずに開くと null（S・M・列の無い画面）', async () => {
    const router = renderAt(['/catch-up'])
    await act(async () => api().openTopic('topic-a'))
    expect(sheetOf(router.state.location.state)).toEqual({ kind: 'topic', id: 'topic-a', side: null })
  })

  it('もう開いている時は置き換え（履歴を増やさない）。side を渡さなければ、開いていた列のまま', async () => {
    const router = renderAt(['/'])
    await act(async () => api().openTopic('topic-a', { side: 'jp' }))
    await act(async () => api().openTopic('topic-b'))
    expect(router.state.historyAction).toBe('REPLACE')
    expect(api().current).toEqual({ kind: 'topic', id: 'topic-b', side: 'jp' })
    // side を渡せば、その列にする（null も渡せる）
    await act(async () => api().openTopic('topic-c', { side: null }))
    expect(api().current).toEqual({ kind: 'topic', id: 'topic-c', side: null })
    // 閉じると、開く前の一覧へ1つだけ戻る
    await act(async () => api().closeTopic())
    expect(router.state.location.pathname).toBe('/')
    expect(sheetOf(router.state.location.state)).toBeNull()
    expect(router.state.location.key).toBe('default')
  })

  it('開いていない時に閉じても何もしない', async () => {
    const router = renderAt(['/', '/catch-up'], 1)
    await act(async () => api().closeTopic())
    expect(router.state.location.pathname).toBe('/catch-up')
  })

  it('開く・閉じるは描き直しても同じ物。current は中身が同じなら同じ物', async () => {
    renderAt(['/'])
    const first = api()
    await act(async () => api().openTopic('topic-a', { side: 'world' }))
    const opened = api()
    expect(opened.openTopic).toBe(first.openTopic)
    expect(opened.closeTopic).toBe(first.closeTopic)
    // 同じ話題・同じ列で置き換えても、current は同じ物
    await act(async () => api().openTopic('topic-a', { side: 'world' }))
    expect(api().current).toBe(opened.current)
  })
})

describe('ブラウザの履歴（createHashRouter。戻るのは少し後に届く）', () => {
  let hash: ReturnType<typeof createHashRouter> | null = null
  afterEach(() => {
    cleanup()
    hash?.dispose()
    hash = null
  })

  function renderHash() {
    latest = null
    // 前のテストの履歴の番号を残さない（ルーターが番号 0 から数え直す）
    window.history.replaceState(null, '', '/#/')
    hash = createHashRouter(ROUTES)
    render(createElement(RouterProvider, { router: hash }))
    return hash
  }

  it('同じ所で続けて閉じても、2つ戻らない（押した直後のもう一押し・Esc と背景が重なった時）', async () => {
    const router = renderHash()
    await act(() => router.navigate('/catch-up'))
    await act(async () => api().openTopic('topic-a'))
    const go = vi.spyOn(window.history, 'go')
    act(() => {
      api().closeTopic()
      api().closeTopic()
    })
    // ブラウザの「戻る」は少し後に届くので、2回目の時はまだ印が残っている。それでも戻るのは1回だけ
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-1)
    go.mockRestore()
    await waitFor(() => expect(sheetOf(router.state.location.state)).toBeNull())
    // もう1つ戻る知らせが後から届かない
    await act(() => new Promise((r) => setTimeout(r, 50)))
    expect(router.state.location.pathname).toBe('/catch-up')
  })

  it('アプリの履歴の最初の項目に印がある時は、戻らずに（アプリの外へ出ずに）印を外して置き換える', async () => {
    const router = renderHash()
    await act(() => router.navigate('/', { state: sheetState('topic-a', null), replace: true }))
    expect(router.state.location.key).not.toBe('default')
    expect(api().current?.id).toBe('topic-a')
    await act(async () => api().closeTopic())
    expect(router.state.historyAction).toBe('REPLACE')
    expect(sheetOf(router.state.location.state)).toBeNull()
    expect((window.history.state as { idx?: number }).idx).toBe(0)
  })
})

describe('読み込み直した後', () => {
  it('前のページで開いた state.sheet も読め（TopicHost が開き直す）、戻る物が無ければ印を外して置き換える', async () => {
    const old = { sheet: { kind: 'topic', id: 'topic-a', side: 'jp' }, sheetPage: 'p-before-reload', other: 1 }
    const router = renderAt([{ pathname: '/', state: old }])
    expect(api().current).toEqual({ kind: 'topic', id: 'topic-a', side: 'jp' })
    expect(openedOnThisPage(router.state.location.state)).toBe(false)
    await act(async () => api().closeTopic())
    expect(router.state.historyAction).toBe('REPLACE')
    expect(router.state.location.pathname).toBe('/')
    // ほかの物は残す
    expect(router.state.location.state).toEqual({ other: 1 })
  })

  it('形の違う state.sheet は開いていない物にする（知らない列は null）', () => {
    expect(sheetOf(null)).toBeNull()
    expect(sheetOf({ sheet: { kind: 'detail', id: 'a' } })).toBeNull()
    expect(sheetOf({ sheet: { kind: 'topic', id: '' } })).toBeNull()
    expect(sheetOf({ sheet: { kind: 'topic', id: 'a', side: 'left' } })).toEqual({ kind: 'topic', id: 'a', side: null })
  })

  it('sheetState は navigate の state にそのまま渡せる形（このページの印つき）', () => {
    expect(sheetState('topic-a', 'world')).toEqual({ sheet: { kind: 'topic', id: 'topic-a', side: 'world' }, sheetPage: PAGE_ID })
    expect(openedOnThisPage(sheetState('topic-a', null))).toBe(true)
  })
})

describe('差し込み口（PanelSlot・usePanelSlots）', () => {
  function Slots({ sides }: { sides: PanelSide[] }) {
    return createElement(
      'div',
      null,
      sides.map((side) => createElement(PanelSlot, { key: side, side })),
    )
  }

  it('出ている間だけ usePanelSlots に入り、外すと消える。testid panel-slot・data-side', () => {
    const { rerender, container } = render(createElement(Slots, { sides: ['jp', 'world'] }))
    const jp = usePanelSlots.getState().jp
    const world = usePanelSlots.getState().world
    expect(jp?.getAttribute('data-testid')).toBe('panel-slot')
    expect(jp?.getAttribute('data-side')).toBe('jp')
    expect(world?.getAttribute('data-side')).toBe('world')
    expect(jp?.classList.contains('panel-slot')).toBe(true)
    expect(container.contains(jp ?? null)).toBe(true)

    rerender(createElement(Slots, { sides: ['world'] }))
    expect(usePanelSlots.getState().jp).toBeNull()
    expect(usePanelSlots.getState().world).toBe(world)

    rerender(createElement(Slots, { sides: [] }))
    expect(usePanelSlots.getState()).toEqual({ jp: null, world: null })
  })

  it('同じ列の差し込み口が置き替わった時は、新しい方を残す', () => {
    const { rerender } = render(createElement('div', null, createElement(PanelSlot, { key: 'a', side: 'jp' })))
    const before = usePanelSlots.getState().jp
    rerender(createElement('div', null, createElement(PanelSlot, { key: 'b', side: 'jp' })))
    const after = usePanelSlots.getState().jp
    expect(after).not.toBeNull()
    expect(after).not.toBe(before)
    expect(after?.isConnected).toBe(true)
  })
})
