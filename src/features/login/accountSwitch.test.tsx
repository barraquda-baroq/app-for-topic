// 前に別のアカウントで使っていた端末の確かめ（docs/SPEC.md の 7.8 の「既読・知ってるを送る・受け取る」。DS の LoginPage の accountMismatch）:
// 持ち主だと確かめたアカウントでも、この端末を前に別のアカウントで同期していた時は、トップ・設定を出さずに、ログインの画面に確かめの文と
// ［このアカウントで同期する］［ログアウト］を出す。［このアカウントで同期する］で司令塔の confirmAccountSwitch を呼ぶ
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ confirm: vi.fn(async () => {}), signOut: vi.fn(async () => {}) }))

vi.mock('../../sync/controller', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/controller')>()),
  confirmAccountSwitch: mocks.confirm,
  signOut: mocks.signOut,
}))

const { routes } = await import('../../App')
const { useSync } = await import('../../sync/controller')
const { accountSwitchMessage } = await import('./LoginPage')

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

afterEach(() => {
  cleanup()
  mocks.confirm.mockClear()
  mocks.signOut.mockClear()
  useSync.setState({ auth: 'signedOut', user: null, owner: 'unknown', ownerSeen: false, accountMismatch: null })
})

describe('前に別のアカウントで使っていた端末の確かめ', () => {
  it('トップ・設定を出さずに、前のアカウントと確かめの文、［このアカウントで同期する］［ログアウト］', async () => {
    useSync.setState({
      auth: 'signedIn',
      user: { uid: 'u2', name: '', email: 'b@example.com' },
      owner: 'ok',
      ownerSeen: true,
      accountMismatch: { previousEmail: 'a@example.com' },
    })
    for (const path of ['/', '/settings']) {
      const router = renderAt(path)
      expect(router.state.location.pathname).toBe('/login')
      expect(screen.queryByTestId('top-page')).toBeNull()
      expect(screen.queryByTestId('app-settings')).toBeNull()
      cleanup()
    }
    renderAt('/login')
    expect(screen.getByTestId('login-account-switch').textContent).toBe(accountSwitchMessage('a@example.com'))
    expect(accountSwitchMessage('a@example.com')).toBe(
      'この端末は前に別のアカウント（a@example.com）で使っていました。このアカウントで同期すると、この端末の既読と「知ってる」がこのアカウントのクラウドと合わさります。',
    )
    expect(screen.getByText('b@example.com')).toBeTruthy()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['このアカウントで同期する', 'ログアウト'])
    const user = userEvent.setup()
    await user.click(screen.getByTestId('login-confirm-account'))
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId('login-sign-out'))
    expect(mocks.signOut).toHaveBeenCalledTimes(1)
  })

  it('前のアカウントのメールのアドレスが分からない時は「別のアカウント」とだけ言う', () => {
    expect(accountSwitchMessage('')).toBe(
      'この端末は前に別のアカウントで使っていました。このアカウントで同期すると、この端末の既読と「知ってる」がこのアカウントのクラウドと合わさります。',
    )
  })

  it('持ち主の記録が無い・ほかのアカウントの記録の時は、そちらの文を先に出す', () => {
    useSync.setState({
      auth: 'signedIn',
      user: { uid: 'u2', name: '', email: 'b@example.com' },
      owner: 'mismatch',
      ownerSeen: false,
      accountMismatch: { previousEmail: 'a@example.com' },
    })
    renderAt('/login')
    expect(screen.getByTestId('login-owner')).toBeTruthy()
    expect(screen.queryByTestId('login-account-switch')).toBeNull()
  })
})
