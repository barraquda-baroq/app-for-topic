// 設定の画面（docs/SPEC.md の 14.5。DS の src/features/appSettings/AppSettingsPage.test.tsx から）: 「表示」「アカウント」
// 「ホーム画面に追加」「このアプリについて」を出す。［‹ 戻る］の行き来と、ログアウトでログインの画面へ戻ること
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { routes } from '../../App'
import { DEFAULT_PREFS, usePrefs } from '../../store/uiStore'
import { fakeSignInForTest, resetSyncForTests } from '../../sync/controller'
import { setTestWidth, TEST_WIDTHS } from '../../test/width'
import { FONT_LICENSE_URL, FONT_NOTICE } from './AppSettingsPage'

// テストでは node:fs の型がアプリの tsconfig に無いので、名前を変数にして読み込む（src/styles.test.ts と同じ）
const NODE_FS = 'node:fs'
const { existsSync } = (await import(/* @vite-ignore */ NODE_FS)) as { existsSync: (path: string) => boolean }
/** このファイルからの場所（new URL を直接書くと Vite が開発サーバーの URL に書き換えるので、関数に包む） */
const fileAt = (relative: string) => decodeURIComponent(new URL(relative, import.meta.url).pathname)

function renderAt(path: string) {
  setTestWidth(TEST_WIDTHS.L)
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

beforeEach(() => {
  localStorage.clear()
  usePrefs.setState(DEFAULT_PREFS)
  resetSyncForTests()
  fakeSignInForTest({ uid: 'u1', name: 'テスト', email: 'me@example.com' })
})

afterEach(() => {
  cleanup()
  resetSyncForTests()
})

describe('AppSettingsPage', () => {
  it('「表示」「アカウント」「ホーム画面に追加」「このアプリについて」をこの順に出す', async () => {
    renderAt('/settings')
    const page = await screen.findByTestId('app-settings')
    const titles = within(page)
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent)
    expect(titles).toEqual(['表示', 'アカウント', 'ホーム画面に追加（アプリとして使う）', 'このアプリについて'])
    expect(screen.getByTestId('account-email').textContent).toBe('me@example.com')
    expect(screen.getByTestId('app-header')).toBeTruthy()
    expect(document.title).toBe('設定 — Topic Studio')
  })

  it('「ホーム画面に追加」は追加の手順（枠付き。iPhone・Android・パソコン）', async () => {
    renderAt('/settings')
    const help = await screen.findByTestId('install-help')
    expect(help.classList.contains('is-framed')).toBe(true)
    expect(within(help).getByTestId('install-guide-ios')).toBeTruthy()
    expect(within(help).getByTestId('install-guide-android')).toBeTruthy()
    expect(within(help).getByTestId('install-guide-desktop')).toBeTruthy()
  })

  it('「このアプリについて」は版と、Roboto Mono のライセンスと全文へのリンク（全文は公開物の中にある）', async () => {
    renderAt('/settings')
    expect((await screen.findByTestId('about-version')).textContent).toBe('Topic Studio 0.1')
    expect(screen.getByTestId('about-font').textContent).toBe(FONT_NOTICE)
    expect(FONT_NOTICE).toBe('Roboto Mono — Copyright 2015 The Roboto Mono Project Authors（SIL Open Font License 1.1）')
    const link = screen.getByTestId('about-font-license')
    expect(link.getAttribute('href')).toBe(FONT_LICENSE_URL)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(existsSync(fileAt(`../../../public/${FONT_LICENSE_URL.replace('./', '')}`))).toBe(true)
  })

  it('［‹ 戻る］: 歯車から開いた時は1つ前（トップ）へ、直接開いた時はトップへ置き換える', async () => {
    const user = userEvent.setup()
    const router = renderAt('/')
    await user.click(screen.getByTestId('open-settings'))
    await user.click(await screen.findByTestId('settings-back'))
    expect(router.state.location.pathname).toBe('/')
    expect(router.state.historyAction).toBe('POP')
    cleanup()

    const direct = renderAt('/settings')
    await user.click(await screen.findByTestId('settings-back'))
    expect(direct.state.location.pathname).toBe('/')
    expect(direct.state.historyAction).toBe('REPLACE')
  })

  it('［ログアウト］でログインの画面に戻る', async () => {
    const user = userEvent.setup()
    const router = renderAt('/settings')
    await user.click(await screen.findByTestId('sign-out'))
    expect(await screen.findByTestId('login-page')).toBeTruthy()
    expect(router.state.location.pathname).toBe('/login')
  })
})
