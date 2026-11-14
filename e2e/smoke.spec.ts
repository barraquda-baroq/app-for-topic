// 段階0の完成の目安（docs/SPEC.md の 14.）を通しで確かめる E2E（DS の e2e/smoke.spec.ts から、下の画面を TS の物にした）:
// 起動アニメーション → ログインの画面 → （テスト用のログインで）空のトップ画面、外観4つの切り替え、書体（Roboto Mono）が読み込まれていること。
// 細かい決まりは e2e/launch.spec.ts（起動アニメーション）と e2e/frame.spec.ts（ログインの画面・画面の枠）で確かめる
import { expect, test, type Page } from '@playwright/test'
import { collectDiagnosticsOnFailure, luminance, noHorizontalScroll } from './helpers'

collectDiagnosticsOnFailure()

const PREFS_KEY = 'topic-studio:prefs'
const TEST_AUTH_KEY = 'topic-studio:test-auth'

/** 外観ごとの <html data-theme>・枠の色（meta theme-color）・ページの地（--bg）。DS と同じ値 */
const THEMES = {
  white: { theme: 'white', meta: '#ffffff', bg: 'rgb(246, 246, 244)' },
  dark: { theme: 'dark', meta: '#17181b', bg: 'rgb(16, 17, 19)' },
  'deep-dark': { theme: 'deep-dark', meta: '#0e0f11', bg: 'rgb(8, 9, 10)' },
} as const

async function themeOf(page: Page) {
  return page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    meta: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? null,
    bg: getComputedStyle(document.body).backgroundColor,
  }))
}

const storedAppearance = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}').appearance ?? null, PREFS_KEY)

test(
  '起動アニメーション → ログインの画面 → テスト用のログインで空のトップ画面',
  { tag: ['@pc', '@s', '@ios'] },
  async ({ page }) => {
    // 1. 起動アニメーション（テストではふだん出さないので launch=1 で出す）。ログインしていないので、下ではログインの画面が起動する
    await page.goto('/?launch=1#/', { waitUntil: 'commit' })
    const overlay = page.getByTestId('launch-overlay')
    await expect(overlay).toBeVisible()
    // 2. アニメーションが終わり（2.27秒）、ログインの画面ができたら消える（5秒の期限より前）
    await expect(overlay).toHaveCount(0, { timeout: 8000 })
    await expect(page).toHaveURL(/#\/login$/)
    await expect(page.getByTestId('login-page')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Topic Studio' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible()
    await expect(page.getByTestId('app-header')).toHaveCount(0)
    await noHorizontalScroll(page)
    // 等幅の英数字の書体（Roboto Mono。アプリに同梱）で、ログインの画面の名前を描く（段階0のトップには等幅の字がまだ無い）
    await expect.poll(() => page.evaluate(() => document.fonts.check('12px "Roboto Mono"'))).toBe(true)
    expect(await page.getByRole('heading', { name: 'Topic Studio' }).evaluate((e) => getComputedStyle(e).fontFamily)).toContain(
      'Roboto Mono',
    )

    // 3. テスト用のログインの印を置いて読み込み直すと、ログインの画面からトップへ移る（同じタブなので起動アニメーションは出ない）
    await page.evaluate((key) => localStorage.setItem(key, '1'), TEST_AUTH_KEY)
    await page.goto('/#/login')
    await expect(page.getByTestId('top-page')).toBeVisible()
    await expect(page).toHaveURL(/#\/$/)
    await expect(overlay).toHaveCount(0)
    // 空のトップ画面: ヘッダー（アイコンと名前・設定の歯車）と「まだ版はありません」
    await expect(page.getByTestId('app-header')).toBeVisible()
    await expect(page.getByTestId('brand')).toBeVisible()
    await expect(page.getByTestId('open-settings')).toBeVisible()
    await expect(page.getByTestId('top-empty')).toContainText('まだ版はありません')
    await expect(page.getByTestId('top-empty')).toContainText('12:00版と20:00版は、段階3から届くようになります。')
    await noHorizontalScroll(page)
  },
)

test(
  '外観4つ（端末の設定に合わせる・ホワイト・ダーク・ディープダーク）が設定で切り替わり、読み込み直しても残る',
  { tag: ['@pc', '@s', '@ios'] },
  async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.addInitScript((key) => localStorage.setItem(key, '1'), TEST_AUTH_KEY)
    await page.goto('/#/settings')
    await expect(page.getByTestId('display-settings')).toBeVisible()

    // 初めは「端末の設定に合わせる」（端末がライトなのでホワイト）
    await expect(page.getByTestId('appearance-system')).toHaveAttribute('aria-pressed', 'true')
    expect(await themeOf(page)).toEqual(THEMES.white)

    for (const value of ['dark', 'deep-dark', 'white'] as const) {
      await page.getByTestId(`appearance-${value}`).click()
      await expect(page.getByTestId(`appearance-${value}`)).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(() => themeOf(page)).toEqual(THEMES[value])
      expect(await storedAppearance(page)).toBe(value)
    }

    // ディープダークは読み込み直しても、最初の描画の前（src/launch/launch.js の boot）からディープダークで始まる
    await page.getByTestId('appearance-deep-dark').click()
    await page.reload()
    await expect(page.getByTestId('appearance-deep-dark')).toHaveAttribute('aria-pressed', 'true')
    expect(await themeOf(page)).toEqual(THEMES['deep-dark'])
    // トップ画面でも同じ外観（ヘッダーの面は暗い）
    await page.getByTestId('settings-back').click()
    await expect(page.getByTestId('top-page')).toBeVisible()
    expect(luminance(await page.getByTestId('app-header').evaluate((e) => getComputedStyle(e).backgroundColor))).toBeLessThan(
      0.05,
    )

    // 「端末の設定に合わせる」に戻すと、端末のライト／ダークに付いていく
    await page.getByTestId('open-settings').click()
    await page.getByTestId('appearance-system').click()
    await expect.poll(() => themeOf(page)).toEqual(THEMES.white)
    expect(await storedAppearance(page)).toBe('system')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => themeOf(page)).toEqual(THEMES.dark)
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => themeOf(page)).toEqual(THEMES.white)
    await noHorizontalScroll(page)
  },
)
