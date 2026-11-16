// 画面の並べ方の E2E（docs/SPEC.md の 9.・14.5。DS の e2e/layout.spec.ts の確かめ方（横にスクロールする所を探す sideScrollers・
// 小さな画面の形 sheetShape・幅の並び）を、段階0の画面に当てた物）:
// - ログインの画面・トップ・設定が、幅 360・390・412（S）・600・768（M）・960・1400（L）のどれでも横にスクロールしない
//   （ページも、中のスクロールする所も）
// - ログインの画面の［追加の手順］の小さな画面は、L は真ん中（幅 520px まで・角丸 14px）、S・M は下からのシート
// - 指で操作する端末（S・M）では、押せる所が 34px 以上
// 段階2で、作り物の版を入れた画面（トップ・詳細のシートとパネル・クリップの窓・版の一覧・追いつきの画面と、その詳細）も、同じ7つの
// 幅で横にはみ出さない事・ヘッダーに版の表示が入る事（S は名前を出さない）・指の端末で押せる所が 34px 以上の事を足した（設計: 段階2の
// 4.2 の塊 6・8. の 3）。作り物の版の中身はすべて作り物
import { expect, test, type Locator, type Page } from '@playwright/test'
import { FAKE_TOPIC_SCENES, makeFakeMonth } from '../src/test/fixtures/fakeEditions'
import { cardOf, collectDiagnosticsOnFailure, openTop, tapSize } from './helpers'

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
  for (const t of ['s', 'm', 'l']) await tapSize(page.getByTestId(`text-size-${t}`), `文字の大きさ ${t}`)
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

// ---------- 段階2の画面（作り物の版を入れて。設計: 段階2の 4.2 の塊 6） ----------

/** 見ていない版を2つにする並び（追いつきの帯と追いつきの画面に話題が出る。e2e/top.spec.ts と同じ） */
const SEEN = ['2026-11-13-12']

/** クリップボードに書けない時の窓の道を通す（許可されない・古いブラウザの代わり。e2e/clip.spec.ts と同じ） */
async function denyClipboard(page: Page) {
  await page.addInitScript(() => {
    const deny = () => Promise.reject(new DOMException('書き込みは許可されていません', 'NotAllowedError'))
    if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { value: deny, configurable: true })
    else Object.defineProperty(navigator, 'clipboard', { value: { writeText: deny }, configurable: true })
  })
}

/** ヘッダーの中の物（アイコン・版の表示・同期の表示・歯車）が画面の中に並び、重ならない。S は名前を出さない */
async function headerFits(page: Page, label: string) {
  const width = page.viewportSize()?.width ?? 0
  const header = page.getByTestId('app-header')
  const boxes = []
  for (const id of ['brand', 'edition-label', 'sync-indicator', 'open-settings']) {
    const box = await header.getByTestId(id).boundingBox()
    expect(box, `${label}: ${id}`).not.toBeNull()
    expect(box!.x, `${label}: ${id} の左の端`).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width, `${label}: ${id} の右の端`).toBeLessThanOrEqual(width)
    boxes.push(box!)
  }
  for (let i = 1; i < boxes.length; i++)
    expect(boxes[i - 1].x + boxes[i - 1].width, `${label}: ヘッダーの ${i} 番目と次が重ならない`).toBeLessThanOrEqual(
      boxes[i].x + 0.5,
    )
  if (width < 600) await expect(header.locator('.brand-name'), `${label}: S は名前を出さない`).toBeHidden()
  else await expect(header.locator('.brand-name'), `${label}: 名前`).toBeVisible()
}

/** 開いている詳細の入れ物（L の列に重ねたパネルか、シート・真ん中の小さな画面） */
function detailBox(page: Page): Locator {
  return page.locator('.topic-panel, .modal.topic-sheet')
}

/** 開いている詳細を Esc で閉じる */
async function closeDetail(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('topic-detail')).toHaveCount(0)
}

/**
 * 作り物の版を入れたトップ → 詳細（シートかパネル）→ クリップの窓 → 版の一覧 → 追いつきの画面と、その詳細 → トップ（「既読 n件」）を、
 * その幅で開き、どこも横にはみ出さない事を見る。touch の時は押せる所の大きさも見る
 */
async function sweepScreens(page: Page, width: number, height: number, touch: boolean) {
  const label = `${width}px`
  await page.setViewportSize({ width, height })
  await denyClipboard(page)
  const { editions } = await openTop(page, '/', { seen: SEEN })
  if (!editions) throw new Error('作り物の版を入れていません')
  const month = makeFakeMonth(editions)
  const newest = month.editions[month.editions.length - 1]
  const wide = width >= 900

  // トップ（帯・状態の1行・カード・この版の選び方）
  await expect(page.getByTestId('catch-up-band')).toBeVisible()
  await noSideScroll(page, `${label} トップ`)
  await headerFits(page, `${label} トップ`)
  if (touch) {
    await tapSize(page.getByTestId('edition-label'), `${label} 版の表示`)
    if (width < 600) await tapSize(page.getByTestId('sync-indicator'), `${label} 同期の表示`)
    for (const tab of await page.getByTestId('top-switcher-tab').all()) await tapSize(tab, `${label} 切り替えの列`)
    const band = page.getByTestId('catch-up-band')
    await tapSize(band.getByRole('link', { name: '追いつく' }), `${label} ［追いつく］`)
    await tapSize(band.getByRole('button', { name: '追いつきの知らせを閉じる' }), `${label} 帯の［×］`)
    await tapSize(cardOf(page, newest.edition.order[1]), `${label} カード`, false)
    await tapSize(page.getByTestId('choice-note').locator('summary'), `${label} この版の選び方`, false)
  }

  // 詳細（一覧に無い社の長い URL を文で出す話題。L は列に重ねるパネル、S・M は下からのシート）
  const topic = newest.topics[FAKE_TOPIC_SCENES.newerValues - 1]
  await cardOf(page, topic.id).locator('.top-card-open').click()
  const detail = page.getByTestId('topic-detail')
  await expect(detail).toHaveAttribute('data-topic-id', topic.id)
  await expect(detail).toHaveAttribute('data-mode', wide ? 'panel' : 'sheet')
  const box = detailBox(page)
  await noSideScroll(page, `${label} 詳細`, box)
  if (!wide) await sheetShape(box, `${label} 詳細のシート`)
  if (touch) {
    await tapSize(box.getByTestId('modal-close'), `${label} 詳細の［×］`)
    await tapSize(box.getByTestId('topic-clip'), `${label} ［クリップ］`, false)
    await tapSize(box.getByTestId('term-known').first(), `${label} ［知ってる］`, false)
  }
  // 長い話題の下の端（元記事・下の細い字）まで送っても横にはみ出さない
  await detail.locator('.topic-foot').scrollIntoViewIfNeeded()
  await noSideScroll(page, `${label} 詳細の下の端`, box)

  // クリップの窓（詳細の上に重ねる小さな画面）
  await box.getByTestId('topic-clip').click()
  const dialog = page.getByTestId('clip-dialog')
  await expect(dialog).toBeVisible()
  await noSideScroll(page, `${label} クリップの窓`, dialog)
  await sheetShape(dialog, `${label} クリップの窓`)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await closeDetail(page)

  // 版の一覧
  await page.getByTestId('edition-label').click()
  const editionsPage = page.getByTestId('editions-page')
  await expect(editionsPage).toBeVisible()
  await expect(editionsPage).not.toHaveAttribute('aria-busy', 'true')
  await expect(page.getByTestId('editions-row').first()).toBeVisible()
  await noSideScroll(page, `${label} 版の一覧`)
  await headerFits(page, `${label} 版の一覧`)
  if (touch) {
    for (const link of await page.getByTestId('editions-row').getByRole('link').all())
      await tapSize(link, `${label} 版の一覧の行`, false)
    await tapSize(page.getByRole('link', { name: 'いちばん新しい版を見る' }), `${label} ［いちばん新しい版を見る］`, false)
  }

  // 追いつきの画面と、その詳細（列が無いので L も真ん中の小さな画面）
  await page.evaluate(() => {
    window.location.hash = '/catch-up'
  })
  const catchUp = page.getByTestId('catch-up-page')
  await expect(catchUp).toHaveAttribute('data-edition-ids', /.+/)
  await expect(catchUp).not.toHaveAttribute('aria-busy', 'true')
  const first = catchUp.getByTestId('top-card').first()
  await expect(first).toBeVisible()
  await noSideScroll(page, `${label} 追いつき`)
  if (touch) await tapSize(first, `${label} 追いつきのカード`, false)
  await first.locator('.top-card-open').click()
  await expect(detail).toHaveAttribute('data-mode', 'sheet')
  const sheet = page.locator('.modal.topic-sheet')
  await noSideScroll(page, `${label} 追いつきの詳細`, sheet)
  if (!wide) await sheetShape(sheet, `${label} 追いつきの詳細`)
  await closeDetail(page)

  // トップへ戻ると、開いた話題が「既読 n件」に沈んでいる
  await page.evaluate(() => {
    window.location.hash = '/'
  })
  const fold = page.getByTestId('top-read-fold').first()
  await expect(fold).toBeVisible()
  await noSideScroll(page, `${label} トップ（既読 n件）`)
  if (touch) await tapSize(fold.locator('.top-read-fold-btn'), `${label} 「既読 n件」`, false)
  await fold.locator('.top-read-fold-btn').click()
  await expect(fold.locator('.top-read-fold-btn')).toHaveAttribute('aria-expanded', 'true')
  await noSideScroll(page, `${label} トップ（既読 n件を開いた）`)
}

test.describe('横にスクロールしない（PC）', { tag: ['@pc'] }, () => {
  test('960・1400px: ログインの画面・トップ・設定で横にはみ出さない', async ({ page }) => {
    for (const [w, h] of [
      [960, 800],
      [1400, 900],
    ])
      await sweep(page, w, h)
  })

  for (const [width, height] of [
    [960, 800],
    [1400, 900],
  ]) {
    test(`${width}px: 作り物の版のトップ・詳細のパネル・クリップの窓・版の一覧・追いつきとその詳細で横にはみ出さない`, async ({
      page,
    }) => {
      await sweepScreens(page, width, height, false)
    })
  }

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

    test(`${width}px: 作り物の版のトップ・詳細のシート・クリップの窓・版の一覧・追いつきとその詳細で横にはみ出さず、押せる所は 34px 以上`, async ({
      page,
    }) => {
      await sweepScreens(page, width, 780, true)
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

  for (const [width, height] of [
    [600, 960],
    [768, 1024],
  ]) {
    test(`${width}px: 作り物の版のトップ・詳細のシート・クリップの窓・版の一覧・追いつきとその詳細で横にはみ出さず、押せる所は 34px 以上`, async ({
      page,
    }) => {
      await sweepScreens(page, width, height, true)
    })
  }

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
