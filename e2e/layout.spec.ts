// 画面の並べ方の E2E（docs/SPEC.md の 9.・14.5。DS の e2e/layout.spec.ts の確かめ方（横にスクロールする所を探す sideScrollers・
// 小さな画面の形 sheetShape・幅の並び）を、段階0の画面に当てた物）:
// - ログインの画面・トップ・設定が、幅 360・390・412（S）・600・768（M）・960・1400（L）のどれでも横にスクロールしない
//   （ページも、中のスクロールする所も）
// - ログインの画面の［追加の手順］の小さな画面は、L は真ん中（幅 520px まで・角丸 14px）、S・M は下からのシート
// - 指で操作する端末（S・M）では、押せる所が 34px 以上
import { expect, test, type Locator, type Page } from '@playwright/test'
import { collectDiagnosticsOnFailure, tapSize } from './helpers'

collectDiagnosticsOnFailure()

const TEST_AUTH_KEY = 'topic-studio:test-auth'
/** iPhone の Chrome（ログインの画面に「ホーム画面に追加」の案内と［追加の手順］が出る） */
const IPHONE_CHROME_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.7444.77 Mobile/15E148 Safari/604.1'

/** 横にスクロールする所（ページと、overflow-x が auto・scroll の物）のうち、中身が幅を超えている物（DS と同じ） */
const sideScrollers = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = []
    const doc = document.documentElement
    if (doc.scrollWidth > window.innerWidth) out.push(`ページ ${doc.scrollWidth} > ${window.innerWidth}`)
    for (const e of document.body.querySelectorAll('*')) {
      const ox = getComputedStyle(e).overflowX
      if ((ox === 'auto' || ox === 'scroll') && e.scrollWidth > e.clientWidth + 1)
        out.push(
          `${e.tagName.toLowerCase()}.${String(e.className).trim().replace(/\s+/g, '.')} ${e.scrollWidth} > ${e.clientWidth}`,
        )
    }
    return out
  })

/** ページも、中のスクロールする所も、横にはみ出していない */
async function noSideScroll(page: Page, label: string, sheet?: Locator) {
  expect(await sideScrollers(page), `${label}: 横にスクロールする所`).toEqual([])
  if (!sheet) return
  const m = await sheet.evaluate((e) => ({
    scroll: e.scrollWidth,
    client: e.clientWidth,
    right: e.getBoundingClientRect().right,
    width: window.innerWidth,
  }))
  expect(m.scroll, `${label}: 小さな画面の中の幅`).toBeLessThanOrEqual(m.client + 1)
  expect(m.right, `${label}: 小さな画面の右の端`).toBeLessThanOrEqual(m.width + 0.5)
}

/** 小さな画面の形（DS と同じ）: L（幅 900px から）は真ん中（幅 520px まで・角丸 14px）、M・S は下からのシート。出る動きの後に測る */
async function sheetShape(dialog: Locator, label: string) {
  await dialog.evaluate((e) => Promise.all(e.getAnimations({ subtree: true }).map((a) => a.finished)))
  const m = await dialog.evaluate((e) => {
    const r = e.getBoundingClientRect()
    const s = getComputedStyle(e)
    return {
      left: r.left,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      vw: window.innerWidth,
      vh: window.innerHeight,
      radius: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius],
    }
  })
  if (m.vw >= 900) {
    expect(m.width, `${label}: 幅`).toBeLessThanOrEqual(520)
    expect(Math.abs(m.left - (m.vw - m.right)), `${label}: 左右の真ん中`).toBeLessThanOrEqual(1)
    expect(m.bottom, `${label}: 下の端`).toBeLessThan(m.vh - 1)
    expect(m.radius, `${label}: 角丸`).toEqual(['14px', '14px', '14px', '14px'])
  } else {
    expect([m.left, m.right], `${label}: 幅いっぱい`).toEqual([0, m.vw])
    expect(Math.abs(m.bottom - m.vh), `${label}: 下の端は画面の下の端`).toBeLessThanOrEqual(1)
    expect(m.height, `${label}: 高さは最大 92dvh`).toBeLessThanOrEqual(m.vh * 0.92 + 1)
    expect(m.radius, `${label}: 上の角だけ 16px`).toEqual(['16px', '16px', '0px', '0px'])
  }
}

/** ログインの画面（ログインしていない）→ テスト用の印でログインしてトップ → 設定 のどれでも、横にはみ出さない */
async function sweep(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.goto('/#/login')
  await expect(page.getByTestId('login-page')).toBeVisible()
  await noSideScroll(page, `${width}px ログイン`)
  await page.evaluate((key) => localStorage.setItem(key, '1'), TEST_AUTH_KEY)
  await page.reload()
  await expect(page.getByTestId('top-page')).toBeVisible()
  await noSideScroll(page, `${width}px トップ`)
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('about-app')).toBeVisible()
  await noSideScroll(page, `${width}px 設定`)
  // 次に開く時はログインしていない状態から（同じページのまま # を替えると、ログインした状態が残る）
  await page.evaluate((key) => localStorage.removeItem(key), TEST_AUTH_KEY)
  await page.goto('about:blank')
}

/** 指で押せる所（34px 以上）: ログインの画面・トップのヘッダー・設定 */
async function touchTargets(page: Page) {
  await page.goto('/#/login')
  await tapSize(page.getByTestId('login-google'), '［Google でログイン］')
  await page.evaluate((key) => localStorage.setItem(key, '1'), TEST_AUTH_KEY)
  await page.reload()
  await expect(page.getByTestId('top-page')).toBeVisible()
  await tapSize(page.getByTestId('brand'), 'アイコンと名前')
  await tapSize(page.getByTestId('open-settings'), '設定の歯車')
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('app-settings')).toBeVisible()
  await tapSize(page.getByTestId('settings-back'), '［‹ 戻る］')
  for (const a of ['system', 'white', 'dark', 'deep-dark']) await tapSize(page.getByTestId(`appearance-${a}`), `外観 ${a}`)
  await tapSize(page.getByTestId('launch-switch'), '起動アニメーションのスイッチ')
  await tapSize(page.getByTestId('sign-out'), '［ログアウト］')
  await tapSize(page.getByTestId('about-font-license'), '［全文を開く］')
}

/** iPhone の Chrome としてログインの画面を開き、［追加の手順］の小さな画面の形と横のはみ出しを見る */
async function installHelpSheet(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.goto('/#/login')
  await expect(page.getByTestId('login-home-notice')).toBeVisible()
  await noSideScroll(page, `${width}px ログイン（iPhone の案内）`)
  await page.getByTestId('login-install-help').click()
  const dialog = page.getByTestId('install-help-modal')
  await expect(dialog).toBeVisible()
  await noSideScroll(page, `${width}px 追加の手順`, dialog)
  await sheetShape(dialog, `${width}px 追加の手順`)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
}

test.describe('横にスクロールしない（PC）', { tag: ['@pc'] }, () => {
  test('960・1400px: ログインの画面・トップ・設定で横にはみ出さない', async ({ page }) => {
    for (const [w, h] of [
      [960, 800],
      [1400, 900],
    ])
      await sweep(page, w, h)
  })

  test.describe('iPhone の Chrome の UA', () => {
    test.use({ userAgent: IPHONE_CHROME_UA })
    test('960・1400px: ［追加の手順］の小さな画面は真ん中', async ({ page }) => {
      await installHelpSheet(page, 960, 800)
      await installHelpSheet(page, 1400, 900)
    })
  })
})

test.describe('横にスクロールしない・押せる所の大きさ（S）', { tag: ['@s'] }, () => {
  for (const width of [360, 390, 412]) {
    test(`${width}px: ログインの画面・トップ・設定で横にはみ出さない`, async ({ page }) => {
      await sweep(page, width, 780)
    })
  }

  test('指で押せる所は 34px 以上（ログインの画面・ヘッダー・設定）', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await touchTargets(page)
  })

  test.describe('iPhone の Chrome の UA', () => {
    test.use({ userAgent: IPHONE_CHROME_UA })
    test('360・412px: ［追加の手順］は下からのシートで、横にはみ出さない。案内のボタンも 34px 以上', async ({ page }) => {
      await installHelpSheet(page, 360, 780)
      await tapSize(page.getByTestId('login-install-help'), '［追加の手順］')
      await tapSize(page.getByTestId('login-stay-browser'), '［このまま Chrome で使う］', false)
      await installHelpSheet(page, 412, 860)
    })
  })
})

test.describe('横にスクロールしない・押せる所の大きさ（M）', { tag: ['@m'] }, () => {
  test('600・768px: ログインの画面・トップ・設定で横にはみ出さない（600px は S と M の境）', async ({ page }) => {
    await sweep(page, 600, 960)
    await sweep(page, 768, 1024)
  })

  test('指で押せる所は 34px 以上（ログインの画面・ヘッダー・設定）', async ({ page }) => {
    await touchTargets(page)
  })

  test.describe('iPhone の Chrome の UA', () => {
    test.use({ userAgent: IPHONE_CHROME_UA })
    test('600・768px: ［追加の手順］は下からのシート', async ({ page }) => {
      await installHelpSheet(page, 600, 960)
      await installHelpSheet(page, 768, 1024)
    })
  })
})
