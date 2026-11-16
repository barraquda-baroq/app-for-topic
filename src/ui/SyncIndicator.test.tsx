// ヘッダーの同期の表示（docs/SPEC.md の 7.8 の「部品」の syncView.ts・9.。DS の src/ui/SyncIndicator.test.tsx から）: 状態が無い間は何も
// 出さない・M と L は雲のアイコンと言葉（止まっている時は斜線の雲）・S はアイコンだけのボタンで、押すと小窓に詳しい言葉・色の段・
// role="status" にしない・ヘッダーでは歯車の左。段階2で DS の形（■12 の A）にした（設計: 段階2の 1.2・4.1）
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

/** 8つの状態と、M・L の字・色の段・斜線の雲か（docs/SPEC.md の 7.8。言葉は src/sync/syncView.ts の syncLabel のまま） */
const STATES: [SyncView, string, 'ok' | 'busy' | 'warn'][] = [
  [{ kind: 'synced' }, '同期済み', 'ok'],
  [{ kind: 'sending' }, '送信中…', 'busy'],
  [{ kind: 'pending', count: 2 }, '未送信 2件', 'busy'],
  [{ kind: 'downloading' }, '受け取り中…', 'busy'],
  [{ kind: 'offline' }, 'オフライン（端末に保存しています）', 'warn'],
  [quota, '今日の無料枠を使い切りました（17:00 ごろに戻ります）', 'warn'],
  [{ kind: 'outdated' }, '要更新（アプリを更新してください）', 'warn'],
  [{ kind: 'error', reason: 'アクセスが拒否されました' }, '同期できません（アクセスが拒否されました）', 'warn'],
]

/** 描いた雲が斜線の物か（CloudOffIcon は斜線の path を持つ。src/ui/icons.tsx） */
const iconPaths = (el: Element) => el.querySelectorAll('svg.icon path').length

describe('ヘッダーの同期の表示', () => {
  it('状態が無い（ログインしていない・持ち主だと確かめていない・同期を始めていない）間は何も出さない', () => {
    renderAt(TEST_WIDTHS.L)
    expect(screen.queryByTestId('sync-indicator')).toBeNull()
    cleanup()
    renderAt(TEST_WIDTHS.S)
    expect(screen.queryByTestId('sync-indicator')).toBeNull()
  })

  it.each(STATES)('L: %j は雲のアイコンと「%s」（色の段 %s）。読み上げは「同期: …」', (view, label, tone) => {
    useSyncView.setState({ view })
    renderAt(TEST_WIDTHS.L)
    const el = screen.getByTestId('sync-indicator')
    expect(el.tagName).toBe('SPAN')
    expect(el.textContent).toBe(`同期: ${label}`)
    expect(el.getAttribute('title')).toBe(label)
    expect(el.getAttribute('data-tone')).toBe(tone)
    expect(el.className).toBe(`sync-indicator ${tone}`)
    expect(within(el).getByText('同期:', { exact: false }).className).toBe('visually-hidden')
    // アイコンは飾り（字が同じ事を言う）
    const icon = el.querySelector('svg.icon')
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    // 送るたびに替わるので、読み上げの live region にはしない（静かに。D9）
    expect(el.getAttribute('role')).toBeNull()
    expect(el.closest('[role="status"]')).toBeNull()
  })

  it('止まっている時（オフライン・無料枠・要更新・同期できない）だけ斜線の雲にする（色だけに頼らない）', () => {
    const paths: Record<string, number> = {}
    for (const [view, , tone] of STATES) {
      useSyncView.setState({ view })
      renderAt(TEST_WIDTHS.M)
      paths[`${view.kind}:${tone}`] = iconPaths(screen.getByTestId('sync-indicator'))
      cleanup()
    }
    const off = Object.entries(paths).filter(([k]) => k.endsWith(':warn'))
    const on = Object.entries(paths).filter(([k]) => !k.endsWith(':warn'))
    expect(new Set(off.map(([, n]) => n)).size).toBe(1)
    expect(new Set(on.map(([, n]) => n)).size).toBe(1)
    expect(off[0][1]).not.toBe(on[0][1])
  })

  it('M も L と同じくアイコンと言葉（押せる物にしない。設定に「同期」の区切りが無いため）', () => {
    useSyncView.setState({ view: { kind: 'pending', count: 2 } })
    renderAt(TEST_WIDTHS.M)
    const el = screen.getByTestId('sync-indicator')
    expect(el.textContent).toBe('同期: 未送信 2件')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('S はアイコンだけのボタン。詳しい言葉は読み上げの名前と title に入れ、短い言葉（段階1の形）は出さない', () => {
    useSyncView.setState({ view: quota })
    renderAt(TEST_WIDTHS.S)
    const el = screen.getByTestId('sync-indicator')
    const full = '今日の無料枠を使い切りました（17:00 ごろに戻ります）'
    expect(el.tagName).toBe('BUTTON')
    expect(el.textContent).toBe('')
    expect(el.getAttribute('aria-label')).toBe(`同期: ${full}`)
    expect(el.getAttribute('title')).toBe(full)
    expect(el.getAttribute('aria-haspopup')).toBe('menu')
    expect(el.getAttribute('aria-expanded')).toBe('false')
    expect(el.getAttribute('data-tone')).toBe('warn')
    expect(el.className).toBe('sync-indicator is-button warn')
    expect(el.getAttribute('role')).toBeNull()
  })

  it('S で押すと小窓に詳しい言葉を出し、もう一度押す・Esc・項目を押すと閉じてボタンへフォーカスを戻す', async () => {
    const user = userEvent.setup()
    useSyncView.setState({ view: { kind: 'error', reason: 'ログインし直してください' } })
    renderAt(TEST_WIDTHS.S)
    const button = screen.getByTestId('sync-indicator')
    await user.click(button)
    const popup = screen.getByTestId('sync-popup')
    expect(popup.getAttribute('role')).toBe('menu')
    expect(popup.getAttribute('aria-label')).toBe('同期')
    expect(within(popup).getByTestId('sync-popup-detail').textContent).toBe('同期できません（ログインし直してください）')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    // 開いた時は詳しい言葉の項目へフォーカス（読み上げがそのまま読む）
    expect(document.activeElement).toBe(screen.getByTestId('sync-popup-detail'))

    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('sync-popup')).toBeNull()
    expect(document.activeElement).toBe(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')

    await user.click(button)
    expect(screen.getByTestId('sync-popup')).toBeTruthy()
    await user.click(button)
    expect(screen.queryByTestId('sync-popup')).toBeNull()

    await user.click(button)
    await user.click(screen.getByTestId('sync-popup-detail'))
    expect(screen.queryByTestId('sync-popup')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('S の小窓は、開いている間に状態が替わると言葉も替わり、状態が無くなると閉じる（戻っても勝手に開かない）', async () => {
    const user = userEvent.setup()
    useSyncView.setState({ view: { kind: 'downloading' } })
    renderAt(TEST_WIDTHS.S)
    await user.click(screen.getByTestId('sync-indicator'))
    expect(screen.getByTestId('sync-popup-detail').textContent).toBe('受け取り中…')
    act(() => useSyncView.setState({ view: { kind: 'synced' } }))
    expect(screen.getByTestId('sync-popup-detail').textContent).toBe('同期済み')
    act(() => useSyncView.setState({ view: null }))
    expect(screen.queryByTestId('sync-indicator')).toBeNull()
    expect(screen.queryByTestId('sync-popup')).toBeNull()
    act(() => useSyncView.setState({ view: { kind: 'synced' } }))
    expect(screen.getByTestId('sync-indicator').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('sync-popup')).toBeNull()
  })

  it('ヘッダーでは、名前の右の空きの後・設定の歯車の左に出す（L は押せる物を足さない）', () => {
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
