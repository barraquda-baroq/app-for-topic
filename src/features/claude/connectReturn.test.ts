// 連携の画面をログインの画面の後に開き直すための覚え（src/features/claude/connectReturn.ts）と、持ち主の関所（src/App.tsx の AuthGate）:
// 覚えるのは連携の画面の行き先だけ（ほかの引数は捨てる）・30分で古くなる・読むだけでは消さない・連携の画面を開くと消える。
// ログインしていないブラウザで連携の画面を開く → ログインの画面 → ログインして持ち主と確かめる → トップでなく連携の画面へ戻る
// （連携の画面は、テストではコネクタの場所がビルドに無いので「コネクタ未設定」で止まり、クラウドに問い合わせない）
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { routes } from '../../App'
import { fakeSignInForTest, resetSyncForTests, useSync } from '../../sync/controller'
import { setTestWidth, TEST_WIDTHS } from '../../test/width'
import {
  clearConnectReturn,
  CONNECT_RETURN_TTL_MS,
  connectReturnPath,
  peekConnectReturn,
  rememberConnectReturn,
} from './connectReturn'

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  resetSyncForTests()
})

afterEach(() => {
  cleanup()
  resetSyncForTests()
  sessionStorage.clear()
})

describe('覚える行き先', () => {
  it('連携の画面の行き先だけ（連携の印 s だけを残し、ほかの引数は捨てる）。形の違う印・ほかの行き先は覚えない', () => {
    expect(connectReturnPath('/claude/connect?s=abc')).toBe('/claude/connect?s=abc')
    expect(connectReturnPath('/claude/connect?s=a%2Bb&uid=x&origin=https://evil.example')).toBe('/claude/connect?s=a%2Bb')
    expect(connectReturnPath('/claude/connect?s=a%20b')).toBeNull()
    expect(connectReturnPath('/claude/connect')).toBeNull()
    expect(connectReturnPath('/settings?s=abc')).toBeNull()
    expect(connectReturnPath('https://evil.example/claude/connect?s=abc')).toBeNull()
  })

  it('覚えて読む（読むだけでは消さない）・30分で古くなる・消せる', () => {
    const now = 1_800_000_000_000
    rememberConnectReturn('/claude/connect?s=abc&uid=x', now)
    expect(peekConnectReturn(now)).toBe('/claude/connect?s=abc')
    expect(peekConnectReturn(now + 1000)).toBe('/claude/connect?s=abc')
    expect(peekConnectReturn(now + CONNECT_RETURN_TTL_MS)).toBeNull()
    expect(peekConnectReturn(now - 1)).toBeNull()
    clearConnectReturn()
    expect(peekConnectReturn(now)).toBeNull()
    // ほかの行き先は覚えない
    rememberConnectReturn('/settings', now)
    expect(peekConnectReturn(now)).toBeNull()
    // 壊れた覚えは読まない
    sessionStorage.setItem('topic-studio:connect-return', '{x')
    expect(peekConnectReturn(now)).toBeNull()
    sessionStorage.setItem('topic-studio:connect-return', JSON.stringify({ path: '/settings', at: now }))
    expect(peekConnectReturn(now)).toBeNull()
  })
})

describe('持ち主の関所（src/App.tsx）', () => {
  it('ログインしていないブラウザで連携の画面を開くと、ログインの画面へ移り、ログインした後に連携の画面へ戻る', async () => {
    setTestWidth(TEST_WIDTHS.L)
    act(() => useSync.setState({ auth: 'signedOut', user: null }))
    const router = createMemoryRouter(routes, { initialEntries: ['/claude/connect?s=state-123'] })
    render(createElement(RouterProvider, { router }))
    expect(await screen.findByTestId('login-page')).toBeTruthy()
    expect(router.state.location.pathname).toBe('/login')
    expect(peekConnectReturn()).toBe('/claude/connect?s=state-123')

    act(() => fakeSignInForTest({ uid: 'u1', name: 'テスト', email: 'me@example.com' }))
    expect(await screen.findByTestId('connect-page')).toBeTruthy()
    expect(router.state.location.pathname).toBe('/claude/connect')
    expect(router.state.location.search).toBe('?s=state-123')
    // テストではコネクタの場所がビルドに無い
    expect(screen.getByTestId('connect-unconfigured')).toBeTruthy()
    // 開いたら覚えは消える（次のログインはトップへ）
    expect(peekConnectReturn()).toBeNull()
  })

  it('覚えが無ければ、ログインの後はトップへ', async () => {
    setTestWidth(TEST_WIDTHS.L)
    act(() => useSync.setState({ auth: 'signedOut', user: null }))
    const router = createMemoryRouter(routes, { initialEntries: ['/settings'] })
    render(createElement(RouterProvider, { router }))
    expect(await screen.findByTestId('login-page')).toBeTruthy()
    expect(peekConnectReturn()).toBeNull()
    act(() => fakeSignInForTest({ uid: 'u1', name: 'テスト', email: 'me@example.com' }))
    expect(await screen.findByTestId('top-page')).toBeTruthy()
    expect(router.state.location.pathname).toBe('/')
  })
})
