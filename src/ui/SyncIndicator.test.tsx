// ヘッダーの同期の表示（docs/SPEC.md の 7.8 の「部品」の syncView.ts。DS の src/ui/SyncIndicator.test.tsx から）: 状態が無い間は何も
// 出さない・M と L は言葉をそのまま・S は短い言葉で詳しい言葉は読み上げと title に・色の段・ヘッダーでは歯車の左・押せる物を足さない
import { cleanup, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { useSyncView, type SyncView } from '../sync/syncView'
import { setTestWidth, TEST_WIDTHS } from '../test/width'
import { AppHeader } from './Layout'
import { SyncIndicator } from './SyncIndicator'

function renderAt(width: number, element = <SyncIndicator />) {
  setTestWidth(width)
  const router = createMemoryRouter([{ path: '/', element }], { initialEntries: ['/'] })
  render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
  useSyncView.setState({ view: null })
})

const quota: SyncView = { kind: 'quota', resumeAt: '17:00' }

describe('ヘッダーの同期の表示', () => {
  it('状態が無い（ログインしていない・持ち主だと確かめていない・同期を始めていない）間は何も出さない', () => {
    renderAt(TEST_WIDTHS.L)
    expect(screen.queryByTestId('sync-indicator')).toBeNull()
  })

  it.each([
    ['L', TEST_WIDTHS.L],
    ['M', TEST_WIDTHS.M],
  ])('%s は言葉をそのまま出し、読み上げは「同期: …」', (_w, width) => {
    useSyncView.setState({ view: { kind: 'pending', count: 2 } })
    renderAt(width)
    const el = screen.getByTestId('sync-indicator')
    expect(el.textContent).toBe('同期: 未送信 2件')
    // 送るたびに替わるので、読み上げの live region にはしない（静かに）
    expect(el.getAttribute('role')).toBeNull()
    expect(el.getAttribute('title')).toBe('未送信 2件')
    expect(el.getAttribute('data-tone')).toBe('busy')
    expect(el.className).toBe('sync-indicator busy')
    expect(within(el).getByText('同期:', { exact: false }).className).toBe('visually-hidden')
  })

  it('S は短い言葉を出し、詳しい言葉は読み上げと title に入れる（無料枠は戻る時刻も）', () => {
    useSyncView.setState({ view: quota })
    renderAt(TEST_WIDTHS.S)
    const el = screen.getByTestId('sync-indicator')
    const full = '今日の無料枠を使い切りました（17:00 ごろに戻ります）'
    expect(el.getAttribute('title')).toBe(full)
    expect(el.getAttribute('data-tone')).toBe('warn')
    const shown = [...el.children].filter((c) => c.getAttribute('aria-hidden') === 'true')
    expect(shown.map((c) => c.textContent)).toEqual(['無料枠を使い切りました'])
    const spoken = [...el.querySelectorAll('.visually-hidden')].map((c) => c.textContent).join('')
    expect(spoken).toBe(`同期: ${full}`)
  })

  it('S でも短い言葉が同じ物（同期済み・未送信 n件 など）は1回だけ出す', () => {
    useSyncView.setState({ view: { kind: 'synced' } })
    renderAt(TEST_WIDTHS.S)
    const el = screen.getByTestId('sync-indicator')
    expect(el.textContent).toBe('同期: 同期済み')
    expect(el.getAttribute('data-tone')).toBe('ok')
  })

  it('持ち主の記録が無い時は「同期できません（持ち主の記録がまだありません）」（止まっている色）', () => {
    useSyncView.setState({ view: { kind: 'error', reason: '持ち主の記録がまだありません' } })
    renderAt(TEST_WIDTHS.L)
    const el = screen.getByTestId('sync-indicator')
    expect(el.textContent).toBe('同期: 同期できません（持ち主の記録がまだありません）')
    expect(el.getAttribute('data-tone')).toBe('warn')
  })

  it('ヘッダーでは、名前の右の空きの後・設定の歯車の左に出す（押せる物は足さない）', () => {
    useSyncView.setState({ view: { kind: 'downloading' } })
    renderAt(TEST_WIDTHS.L, <AppHeader />)
    const header = screen.getByTestId('app-header')
    const el = within(header).getByTestId('sync-indicator')
    const gear = within(header).getByTestId('open-settings')
    expect(el.compareDocumentPosition(gear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(el.previousElementSibling?.className).toBe('spacer')
    expect(within(header).getAllByRole('link')).toHaveLength(2)
    expect(within(header).queryAllByRole('button')).toHaveLength(0)
  })
})
