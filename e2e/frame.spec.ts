// 画面の枠とログインの画面の E2E（docs/SPEC.md の 14.4・14.5・14.6。DS の e2e/frame.spec.ts から、DS のカレンダー・リスト・MIM の
// 確かめを外し、TS のトップ（版がまだ無い）と設定の区切りを足した物）: ログインの画面 → 空のトップ画面 → 設定。
// ログインした状態は、テストの時だけ効く印（localStorage の topic-studio:test-auth。src/features/login/testAuth.ts）で作る
import { expect, test, type Page } from '@playwright/test'
import { darkSurfaces, noHorizontalScroll, tapSize } from './helpers'
import { firebaseConfigIsPlaceholder } from '../src/sync/firebaseConfig'

const PREFS_KEY = 'topic-studio:prefs'

/** ログインした状態でアプリを開く（Firebase は使わない） */
async function openSignedIn(page: Page, hash = '/') {
  await page.addInitScript(() => localStorage.setItem('topic-studio:test-auth', '1'))
  await page.goto(`/#${hash}`)
  await expect(page.getByTestId('top-page').or(page.getByTestId('app-settings'))).toBeVisible()
}

/** CSS 変数の色を、その場で計算した rgb() にする */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const probe = document.createElement('div')
    probe.style.color = `var(${t})`
    document.body.appendChild(probe)
    const c = getComputedStyle(probe).color
    probe.remove()
    return c
  }, token)
}

test.describe('ログインの画面', { tag: ['@pc', '@s'] }, () => {
  test('ログインしていなければログインの画面だけを出す（グレーの地・等幅の名前・今日の日付・［Google でログイン］）', async ({
    page,
  }) => {
    await page.goto('/#/')
    await expect(page).toHaveURL(/#\/login$/)
    const login = page.getByTestId('login-page')
    await expect(login).toBeVisible()
    await expect(page.getByTestId('app-header')).toHaveCount(0)
    await expect(page.getByTestId('top-page')).toHaveCount(0)

    expect(await login.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(await tokenColor(page, '--cover'))
    const logo = page.getByRole('heading', { name: 'Topic Studio' })
    expect(await logo.evaluate((e) => getComputedStyle(e).fontFamily)).toContain('Roboto Mono')
    await expect(page.getByTestId('login-date')).toHaveText(/^(SUN|MON|TUE|WED|THU|FRI|SAT) · \d{4}\.\d{2}\.\d{2}$/)
    await expect(page.getByText('TOPIC STUDIO', { exact: true })).toBeVisible()
    await expect(page.getByText('v0.1', { exact: true })).toBeVisible()
    await expect(page).toHaveTitle('ログイン — Topic Studio')

    const button = page.getByRole('button', { name: 'Google でログイン' })
    const box = await button.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
    // 字は --on-cover、ボタンの枠はグレーの地と 3:1 以上の --cover-border（比は src/styles.test.ts で確かめる）
    expect(await login.evaluate((e) => getComputedStyle(e).color)).toBe(await tokenColor(page, '--on-cover'))
    expect(await button.evaluate((e) => getComputedStyle(e).borderTopColor)).toBe(await tokenColor(page, '--cover-border'))
    await noHorizontalScroll(page)
  })

  test('Firebase の設定が仮の値の時は、押すと「まだ公開の準備ができていません（docs/DEPLOY.md）」と出す', async ({ page }) => {
    // 本物の設定値（topic-studio-1a463）に差し替えてあるので、この場面は起きない。言葉と、ログインを始めないことは
    // 単体テスト（src/features/login/LoginPage.test.tsx。設定値を仮の値にして確かめる）で確かめ続ける
    test.skip(!firebaseConfigIsPlaceholder, '本物の設定値に差し替え済み（単体テストで確かめる）')
    await page.goto('/#/login')
    await page.getByRole('button', { name: 'Google でログイン' }).click()
    await expect(page.getByRole('alert')).toHaveText('まだ公開の準備ができていません（docs/DEPLOY.md）')
    await expect(page).toHaveURL(/#\/login$/)
  })
})

test.describe('空のトップ画面', { tag: ['@pc', '@s'] }, () => {
  test('テスト用の印でログインした状態になり、ヘッダーの左にアイコン（600px からは名前も）、右端に設定の歯車。下に「まだ版はありません」', async ({
    page,
  }) => {
    await openSignedIn(page)
    const header = page.getByTestId('app-header')
    const brand = header.getByTestId('brand')
    await expect(brand).toBeVisible()
    await expect(brand.locator('img')).toHaveAttribute('src', './icon.svg')
    expect(await brand.locator('img').evaluate((e) => e.getBoundingClientRect().width)).toBe(26)
    // 名前の字は S（600px 未満。@s）でも持つ（隠すだけ。設計: 段階2の 1.2）
    await expect(header.locator('.brand-name')).toHaveText('Topic Studio')
    if ((page.viewportSize()?.width ?? 0) >= 600) await expect(header.locator('.brand-name')).toBeVisible()
    else await expect(header.locator('.brand-name')).toBeHidden()
    const gear = await header.getByTestId('open-settings').boundingBox()
    const brandBox = await brand.boundingBox()
    const headerBox = await header.boundingBox()
    expect(gear && brandBox && brandBox.x < gear.x).toBe(true)
    // 歯車は右の余白の内側の端
    expect(gear && headerBox && headerBox.x + headerBox.width - (gear.x + gear.width)).toBeLessThanOrEqual(24)
    await tapSize(header.getByTestId('open-settings'), '設定の歯車')
    // 高さ 52px（＋ノッチの分）。下に 1px の線、ぼかした面
    expect(await header.evaluate((e) => e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(52)
    expect(await header.evaluate((e) => getComputedStyle(e).borderBottomWidth)).toBe('1px')
    expect(await header.evaluate((e) => getComputedStyle(e).backdropFilter)).toContain('blur')

    await expect(page.getByTestId('top-empty')).toHaveText('まだ版はありません12:00版と20:00版が、ここに届きます。')
    await expect(page).toHaveTitle('Topic Studio')
    // 段階0は同期の表示も版の表示も無い
    await expect(page.getByTestId('sync-indicator')).toHaveCount(0)
    await noHorizontalScroll(page)
  })

  test('歯車で設定の画面を開き（表示・知ってる・Claude との連携・アカウント・ホーム画面に追加・このアプリについて）、［‹ 戻る］でトップへ戻る', async ({
    page,
  }) => {
    await openSignedIn(page)
    await page.getByTestId('open-settings').click()
    await expect(page).toHaveURL(/#\/settings$/)
    await expect(page.getByTestId('app-settings')).toBeVisible()
    for (const id of ['display-settings', 'known-terms', 'claude-settings', 'account-settings', 'install-help', 'about-app'])
      await expect(page.getByTestId(id)).toBeVisible()
    await expect(page.getByTestId('about-version')).toHaveText('Topic Studio 0.1')
    await expect(page.getByTestId('about-font-license')).toHaveAttribute('href', './licenses/RobotoMono-OFL.txt')
    await noHorizontalScroll(page)
    await page.getByTestId('settings-back').click()
    await expect(page.getByTestId('top-page')).toBeVisible()
  })

  test('設定の［ログアウト］でログインの画面に戻る', async ({ page }) => {
    await openSignedIn(page, '/settings')
    await page.getByTestId('sign-out').click()
    await expect(page.getByTestId('login-page')).toBeVisible()
    await expect(page).toHaveURL(/#\/login$/)
  })

  test('ディープダークでは、ヘッダー・トップ・設定の面に明るい色が出ない', async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ v: 1, appearance: 'deep-dark' })), PREFS_KEY)
    await openSignedIn(page)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'deep-dark')
    await darkSurfaces(page, ['body', '.app-header', '.top-empty'])
    await page.getByTestId('open-settings').click()
    // 設定の画面（開いた時に読み込む）が出てから測る（入れ替わる途中のヘッダーを測らないように）
    await expect(page.getByTestId('about-app')).toBeVisible()
    await darkSurfaces(page, ['body', '.app-header', '.card', '.install-guide'])
  })
})

test.describe('新しい版の帯', { tag: ['@pc', '@s'] }, () => {
  /** ページを3画面ぶんの高さにする（段階2で版の話題が増えた時と同じ形。帯の有無でヘッダーの固定が崩れないか見る） */
  async function makeTall(page: Page, container: string) {
    await page.evaluate((sel) => {
      const filler = document.createElement('div')
      filler.style.height = `${window.innerHeight * 3}px`
      filler.dataset.testFiller = '1'
      document.querySelector(sel)?.appendChild(filler)
    }, container)
  }

  test('帯が出ていても、下までスクロールした時にヘッダーは上に固定のまま。［更新する］を押すと切り替える', async ({
    page,
    isMobile,
  }) => {
    await openSignedIn(page)
    await page.waitForFunction(() => Boolean(window.__ts))
    await page.evaluate(() => window.__ts.showUpdateBanner())
    const banner = page.getByTestId('update-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('アプリの新しい版があります')
    // 指で操作する端末では押せる所を 34px 以上に（PC のマウスでは .btn-sm の 30px）
    if (isMobile) await tapSize(banner.getByTestId('app-update'), '［更新する］', false)

    // トップ・設定の画面はページ全体がスクロールする。ヘッダーは上に固定のまま
    for (const [open, container] of [
      [null, '[data-testid="top-page"]'],
      ['open-settings', '[data-testid="app-settings"]'],
    ] as const) {
      if (open) await page.getByTestId(open).click()
      await expect(page.locator(container)).toBeVisible()
      await expect(banner).toBeVisible()
      await makeTall(page, container)
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000)
      await expect.poll(async () => (await page.getByTestId('app-header').boundingBox())?.y).toBe(0)
      await noHorizontalScroll(page)
    }

    await banner.getByTestId('app-update').click()
    await expect.poll(() => page.evaluate(() => window.__ts.updateApplied())).toBe(true)
  })
})

test.describe('狭い幅（S）', { tag: ['@pc', '@s'] }, () => {
  // 段階2で、名前を隠す幅を 380px 未満から S（600px 未満）にした（ヘッダーに版の表示を入れるため。設計: 段階2の 1.2）
  test('幅 360px でも横にはみ出さない。S（600px 未満）のヘッダーは名前を出さずアイコンだけ（600px から名前を出す）', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 })
    await openSignedIn(page)
    await noHorizontalScroll(page)
    await expect(page.locator('.brand-name')).toBeHidden()
    await expect(page.getByTestId('brand').locator('img')).toBeVisible()
    await tapSize(page.getByTestId('open-settings'), '設定の歯車')
    await page.setViewportSize({ width: 599, height: 740 })
    await expect(page.locator('.brand-name')).toBeHidden()
    await page.setViewportSize({ width: 600, height: 740 })
    await expect(page.locator('.brand-name')).toBeVisible()
  })
})
