// 版の一覧（#/editions。docs/SPEC.md の 9.・4.7。設計: 段階2の 1.8）: 枠を新しい順に1行ずつ。版の記録がある行だけ押せて前の版 #/e/{id} へ、
// 受け取り中・新しい形の記録・作れなかった（理由の種類の言葉と短い理由の文）・届いていない、の言葉。記録が1つも無ければ「まだ版は
// ありません」。いちばん上の「いちばん新しい版を見る」。同期が落ち着いているか（syncSettled）・時刻を editionRows に渡し、版の記録が
// 変わると読み直す。開いている版は変えない。
// 行の決め方（いちばん古い記録の枠から・いちばん新しい枠の30分・受け取り中は鍵だけ）はストアのテスト（src/store/appStore.test.ts）で確かめる
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editionRows, openEdition, resetStoreForTests, useApp, type EditionRow } from '../../store/appStore'
import { useSyncView } from '../../sync/syncView'
import { setTestWidth, TEST_WIDTHS } from '../../test/width'
import { EditionsPage, rowKindOf } from './EditionsPage'

// ストアの editionRows（行の決め方）と openEdition（開いている版）だけを差し替える
vi.mock('../../store/appStore', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../store/appStore')>()
  return { ...m, editionRows: vi.fn(async () => [] as EditionRow[]), openEdition: vi.fn(async () => {}) }
})

/** 2026-11-15（日）20:40 日本時間 */
const T_2040 = Date.parse('2026-11-15T20:40:00+09:00')

const ROWS: EditionRow[] = [
  { date: '2026-11-15', slot: '20', kind: 'missing' },
  { date: '2026-11-15', slot: '12', kind: 'edition', editionId: '2026-11-15-12', receiving: true },
  { date: '2026-11-14', slot: '20', kind: 'newer', editionId: '2026-11-14-20' },
  {
    date: '2026-11-14',
    slot: '12',
    kind: 'failed',
    reasonKind: 'quota',
    reason: '使用量の上限に届いたため、この回は版を作れませんでした',
  },
  { date: '2026-11-13', slot: '20', kind: 'failed', reasonKind: 'something-new', reason: null },
  { date: '2026-11-13', slot: '12', kind: 'edition', editionId: '2026-11-13-12', receiving: false },
]

function setRows(rows: EditionRow[]) {
  vi.mocked(editionRows).mockImplementation(async () => rows)
}

function renderPage(path = '/editions') {
  const router = createMemoryRouter(
    [
      { path: '/editions', element: <EditionsPage /> },
      { path: '/e/:editionId', element: <p>前の版の画面</p> },
      { path: '/', element: <p>トップの画面</p> },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

const rowsOf = () => screen.queryAllByTestId('editions-row')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T_2040)
  setTestWidth(TEST_WIDTHS.S)
  vi.mocked(editionRows).mockClear()
  vi.mocked(openEdition).mockClear()
  setRows(ROWS)
  act(() => useApp.setState({ status: 'ready' }))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  useSyncView.setState({ view: null })
  vi.useRealTimers()
})

describe('行', () => {
  it('枠を渡された順（新しい順）に1行ずつ、種類ごとの言葉で出す', async () => {
    renderPage()
    await waitFor(() => expect(rowsOf()).toHaveLength(ROWS.length))
    const rows = rowsOf()
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['missing', 'receiving', 'newer', 'failed', 'failed', 'edition'])
    expect(rows.map((r) => r.getAttribute('data-edition-id'))).toEqual([
      '2026-11-15-20',
      '2026-11-15-12',
      '2026-11-14-20',
      '2026-11-14-12',
      '2026-11-13-20',
      '2026-11-13-12',
    ])
    expect(rows.map((r) => r.textContent)).toEqual([
      '11/15（日）20:00版届いていません',
      '11/15（日）12:00版受け取り中',
      '11/14（土）20:00版新しい形の記録（アプリを更新してください）',
      '11/14（土）12:00版作れませんでした（使用量の上限）使用量の上限に届いたため、この回は版を作れませんでした',
      // 知らない理由の種類は「そのほか」、短い理由の文が空（null）の時は書かない
      '11/13（金）20:00版作れませんでした（そのほか）',
      '11/13（金）12:00版',
    ])
    // 種類ごとの見た目はクラスで分ける（data-kind を CSS で選ばない）
    expect(rows[3].className).toBe('editions-row is-failed')
    expect(rows[1].className).toBe('editions-row is-receiving')
    expect(document.title).toBe('版の一覧 — Topic Studio')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('版の一覧')
  })

  it('押せるのは版の記録がある行だけ（受け取り中も押せる）。押すと前の版 #/e/{id} へ', async () => {
    const router = renderPage()
    await waitFor(() => expect(rowsOf()).toHaveLength(ROWS.length))
    const links = rowsOf().map((r) => within(r).queryByRole('link'))
    expect(links.map((l) => l?.getAttribute('href') ?? null)).toEqual([
      null,
      '/e/2026-11-15-12',
      null,
      null,
      null,
      '/e/2026-11-13-12',
    ])
    expect(links[1]!.textContent).toBe('11/15（日）12:00版受け取り中')
    fireEvent.click(links[5]!)
    expect(router.state.location.pathname).toBe('/e/2026-11-13-12')
    expect(screen.getByText('前の版の画面')).toBeTruthy()
  })

  it('いちばん上の「いちばん新しい版を見る」はトップへ', async () => {
    const router = renderPage()
    const link = screen.getByRole('link', { name: 'いちばん新しい版を見る' })
    fireEvent.click(link)
    expect(router.state.location.pathname).toBe('/')
  })

  it('記録が1つも無ければ「まだ版はありません」', async () => {
    setRows([])
    renderPage()
    expect(await screen.findByText('まだ版はありません')).toBeTruthy()
    expect(rowsOf()).toHaveLength(0)
    expect(screen.getByTestId('editions-page').getAttribute('aria-busy')).toBeNull()
  })

  it('読み終えるまでは行も「まだ版はありません」も出さない（aria-busy）', async () => {
    let resolve: (rows: EditionRow[]) => void = () => {}
    vi.mocked(editionRows).mockImplementation(() => new Promise<EditionRow[]>((r) => (resolve = r)))
    renderPage()
    const page = screen.getByTestId('editions-page')
    expect(page.getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText('まだ版はありません')).toBeNull()
    await act(async () => resolve(ROWS))
    expect(rowsOf()).toHaveLength(ROWS.length)
    expect(page.getAttribute('aria-busy')).toBeNull()
  })

  it('rowKindOf: 受け取り中の版だけ edition と分ける', () => {
    expect(ROWS.map(rowKindOf)).toEqual(['missing', 'receiving', 'newer', 'failed', 'failed', 'edition'])
  })
})

describe('読み直す時', () => {
  it('端末の中を読み終えてから読む。時刻と、同期が落ち着いているか（synced・pending・sending だけ）を渡す', async () => {
    act(() => useApp.setState({ status: 'loading' }))
    renderPage()
    expect(editionRows).not.toHaveBeenCalled()
    act(() => useApp.setState({ status: 'ready' }))
    await waitFor(() => expect(editionRows).toHaveBeenCalledTimes(1))
    expect(vi.mocked(editionRows).mock.calls[0]).toEqual([T_2040, false])
    act(() => useSyncView.setState({ view: { kind: 'downloading' } }))
    act(() => useSyncView.setState({ view: { kind: 'offline' } }))
    // 落ち着いていない物の間で替わっても、読み直さない
    expect(editionRows).toHaveBeenCalledTimes(1)
    act(() => useSyncView.setState({ view: { kind: 'synced' } }))
    await waitFor(() => expect(editionRows).toHaveBeenCalledTimes(2))
    expect(vi.mocked(editionRows).mock.calls[1]).toEqual([T_2040, true])
    act(() => useSyncView.setState({ view: { kind: 'pending', count: 2 } }))
    expect(editionRows).toHaveBeenCalledTimes(2)
  })

  it('版の記録・作れなかった印・開いている版が変わると読み直し、新しい行を出す', async () => {
    setRows(ROWS.slice(1))
    renderPage()
    await waitFor(() => expect(rowsOf()).toHaveLength(ROWS.length - 1))
    setRows(ROWS)
    act(() => useApp.setState({ editionFails: [] }))
    await waitFor(() => expect(rowsOf()).toHaveLength(ROWS.length))
    const calls = vi.mocked(editionRows).mock.calls.length
    act(() => useApp.setState({ editions: [] }))
    await waitFor(() => expect(editionRows).toHaveBeenCalledTimes(calls + 1))
    act(() => useApp.setState({ newerEditions: [] }))
    await waitFor(() => expect(editionRows).toHaveBeenCalledTimes(calls + 2))
    act(() => useApp.setState({ opened: { follow: true, view: null, waiting: '2026-11-15-12' } }))
    await waitFor(() => expect(editionRows).toHaveBeenCalledTimes(calls + 3))
  })

  it('後から読み終えた古い結果で、新しい結果を上書きしない', async () => {
    const pending: ((rows: EditionRow[]) => void)[] = []
    vi.mocked(editionRows).mockImplementation(() => new Promise<EditionRow[]>((r) => pending.push(r)))
    renderPage()
    await waitFor(() => expect(pending).toHaveLength(1))
    act(() => useApp.setState({ editionFails: [] }))
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => pending[1](ROWS))
    await act(async () => pending[0]([]))
    expect(rowsOf()).toHaveLength(ROWS.length)
  })

  it('開いている版は変えない（前の版を見ていた時は、その版のまま）', async () => {
    const opened = { follow: false, view: { kind: 'none' as const, editionId: '2026-11-13-12' }, waiting: null }
    act(() => useApp.setState({ opened }))
    renderPage()
    await waitFor(() => expect(rowsOf()).toHaveLength(ROWS.length))
    expect(openEdition).not.toHaveBeenCalled()
    expect(useApp.getState().opened).toBe(opened)
  })
})
