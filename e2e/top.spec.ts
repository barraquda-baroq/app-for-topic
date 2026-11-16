// トップの E2E（docs/SPEC.md の 9.。設計: 段階2の 1.3〜1.8・4.2）。Firebase 無しで、時刻を決め（2026-11-15（日）14:10）、テスト用のログインと
// 作り物の版（e2e/helpers.ts の openTop）で開く。作り物の版はテストの側でも同じ作り方で作って比べる（中身はすべて作り物。docs/SPEC.md の 3.）。
// - S・M: 総合が order の順に20本・ジャンルの区切り（知らないジャンルは総合だけ）・切り替えの列を押すとその区切りの見出しが列の下に来て
//   aria-current（M も同じ1列）
// - L: 国内と世界の列（それぞれ地域の話題が order の順）・国内の列の下の「そのほか」（新しい形の記録の話題）
// - カードを押すと、今の行き先のまま履歴の state に詳細の印（sheet の id と side）が積まれる（詳細の中身は詳細の塊、つなぎは塊 6）
// - 既読は開発用のフック（window.__ts.markRead）で付け、その場では淡くするだけ。読み込み直すと「既読 n件」に沈み、開くと出る
// - 見たにする: 同期の表示が受け取り中（downloading）の間は3秒たっても seen が付かず、落ち着いて（synced）から3秒で付く
// - 追いつきの帯（seen で作った並び。最後に見た版の後が1版だけの並びでは出ない）・［×］で消える・［追いつく］の行き先が #/catch-up
import { expect, test, type Page } from '@playwright/test'
import { GENRE_VALUES } from '../src/domain/types'
import { makeFakeMonth } from '../src/test/fixtures/fakeEditions'
import { cardOf, collectDiagnosticsOnFailure, noHorizontalScroll, openTop, setSyncView, type ResolvedEditions } from './helpers'

collectDiagnosticsOnFailure()

/** テストの側で、端末に入れたのと同じ作り物の版を作る（いちばん新しい版） */
function newestOf(editions: ResolvedEditions | null) {
  if (!editions) throw new Error('作り物の版を入れていません')
  const month = makeFakeMonth({ ...editions, seed: editions.seed ?? 'fake-month' })
  return { month, newest: month.editions[month.editions.length - 1] }
}

/** 区切り（data-section）の中の、畳んでいないカードの話題の id */
function openCardIds(page: Page, section: string) {
  return page
    .locator(`[data-testid="top-section"][data-section="${section}"] > .top-cards [data-testid="top-card"]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-topic-id')))
}

/** 端末のストアの、その版の既読の記録（開発サーバーのモジュールをそのまま読むので、アプリと同じ物） */
function readOf(page: Page, editionId: string): Promise<{ topicIds: string[]; seen: boolean } | null> {
  return page.evaluate(
    async ({ file, id }) => {
      const m = (await import(/* @vite-ignore */ file)) as typeof import('../src/store/appStore')
      const r = m.useApp.getState().user.reads[id]
      return r ? { topicIds: r.topicIds, seen: r.seen } : null
    },
    { file: '/src/store/appStore.ts', id: editionId },
  )
}

/** 履歴の state の詳細の印（React Router のハッシュの履歴は history.state.usr に置く） */
function sheetInHistory(page: Page): Promise<unknown> {
  return page.evaluate(() => (window.history.state as { usr?: { sheet?: unknown } } | null)?.usr?.sheet ?? null)
}

test.describe('S・M: 総合とジャンルの区切り', { tag: ['@s', '@m'] }, () => {
  test('総合が order の順に20本、その下にジャンルの区切り（知らないジャンルは総合だけ）。横にはみ出さない', async ({ page }) => {
    const { editions } = await openTop(page)
    const { newest } = newestOf(editions)
    const edition = page.getByTestId('top-edition')
    await expect(edition).toHaveAttribute('data-layout', 'stack')
    expect(await openCardIds(page, 'all')).toEqual(newest.edition.order)
    await expect(page.locator('[data-testid="top-section"]')).toHaveCount(1 + GENRE_VALUES.length)
    for (const g of GENRE_VALUES) {
      expect(await openCardIds(page, g), g).toEqual(newest.topics.filter((t) => t.genre === g).map((t) => t.id))
    }
    const novel = newest.topics.find((t) => !(GENRE_VALUES as readonly string[]).includes(t.genre))!
    await expect(page.locator(`[data-testid="top-card"][data-topic-id="${novel.id}"]`)).toHaveCount(1)
    // 総合の頭は重大印のカード（見出し・要約・下の行）
    const first = cardOf(page, newest.edition.order[0])
    await expect(first).toHaveAttribute('data-major', 'true')
    await expect(first.getByRole('button')).toHaveText(newest.topics[0].headline)
    await expect(page.getByTestId('top-switcher-tab')).toHaveText([
      '総合',
      '政治',
      '経済',
      'テック',
      'AI',
      '事件',
      'スポーツ',
      'エンタメ',
    ])
    await expect(page.getByTestId('choice-note')).toBeVisible()
    await noHorizontalScroll(page)
    await page.setViewportSize({ width: 360, height: 760 })
    await noHorizontalScroll(page)
    // 切り替えの列の8つが 360px に収まる（列の中で切れない）
    const tabs = await page.getByTestId('top-switcher-tab').evaluateAll((els) =>
      els.map((e) => {
        const name = e.querySelector('.top-switcher-name') as HTMLElement
        return name.scrollWidth <= name.clientWidth
      }),
    )
    expect(tabs).toEqual(Array(8).fill(true))
  })

  test('切り替えの列を押すと、その区切りの見出しが列のすぐ下に来て、押した物が今の区切り（aria-current）', async ({ page }) => {
    await openTop(page)
    const tab = page.getByTestId('top-switcher-tab').filter({ hasText: '経済' })
    await tab.click()
    await expect(tab).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('[data-testid="top-switcher-tab"][aria-current="true"]')).toHaveCount(1)
    const heading = page.locator('[data-testid="top-section"][data-section="economy"] h2')
    await expect(heading).toBeFocused()
    // なめらかなスクロールが終わると、見出しの上の端が切り替えの列の下（＋12px）に来る
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const head = document
              .querySelector('[data-testid="top-section"][data-section="economy"]')!
              .getBoundingClientRect().top
            const bar = document.querySelector('[data-testid="top-switcher"]')!.getBoundingClientRect().bottom
            return Math.round(head - bar)
          }),
        { timeout: 5000 },
      )
      .toBe(12)
    // 総合へ戻る
    const all = page.getByTestId('top-switcher-tab').filter({ hasText: '総合' })
    await all.click()
    await expect(all).toHaveAttribute('aria-current', 'true')
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 }).toBeLessThan(200)
  })

  test('カードを押すと、今の行き先のまま履歴の state に詳細の印（side なし）が積まれる', async ({ page }) => {
    const { editions } = await openTop(page)
    const { newest } = newestOf(editions)
    const id = newest.edition.order[3]
    await cardOf(page, id).getByRole('button').click()
    await expect.poll(() => sheetInHistory(page)).toEqual({ kind: 'topic', id, side: null })
    expect(await page.evaluate(() => window.location.hash)).toBe('#/')
  })
})

test.describe('L: 国内｜世界の2列', { tag: ['@pc'] }, () => {
  test('国内と世界の列に、それぞれの地域の話題が order の順に。新しい形の記録の話題は国内の列の下の「そのほか」', async ({
    page,
  }) => {
    const { editions } = await openTop(page, '/', { editions: { extras: ['newerTopic'] } })
    const { month, newest } = newestOf(editions)
    const newerId = month.scenes.extras!.newerTopic!
    await expect(page.getByTestId('top-edition')).toHaveAttribute('data-layout', 'wide')
    const rest = newest.topics.filter((t) => t.id !== newerId)
    expect(await openCardIds(page, 'jp')).toEqual(rest.filter((t) => t.region === 'jp').map((t) => t.id))
    expect(await openCardIds(page, 'world')).toEqual(rest.filter((t) => t.region === 'world').map((t) => t.id))
    expect(await openCardIds(page, 'other')).toEqual([newerId])
    await expect(cardOf(page, newerId)).toHaveText('新しい形の記録（アプリを更新してください）')
    await expect(page.getByTestId('top-switcher')).toHaveCount(0)
    await expect(page.getByTestId('panel-slot')).toHaveCount(2)
    // ページ全体はスクロールせず、列の中だけ
    await noHorizontalScroll(page)
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true)
  })

  test('カードを押すと、反対の列に重ねる印（国内 → 世界・世界 → 国内）が履歴の state に積まれる', async ({ page }) => {
    const { editions } = await openTop(page)
    const { newest } = newestOf(editions)
    const jp = newest.topics.find((t) => t.region === 'jp')!
    await cardOf(page, jp.id).getByRole('button').click()
    await expect.poll(() => sheetInHistory(page)).toEqual({ kind: 'topic', id: jp.id, side: 'world' })
    // 世界のカードは国内の列に（詳細が開いていれば置き換え。閉じてから押しても同じ）
    await page.evaluate(() => window.history.back())
    await expect.poll(() => sheetInHistory(page)).toBeNull()
    const world = newest.topics.find((t) => t.region === 'world')!
    await cardOf(page, world.id).getByRole('button').click()
    await expect.poll(() => sheetInHistory(page)).toEqual({ kind: 'topic', id: world.id, side: 'jp' })
  })
})

test.describe('既読・見た版・追いつきの帯', { tag: ['@pc', '@s', '@m'] }, () => {
  test('既読はその場では淡くするだけで、読み込み直すと「既読 n件」に沈み、開くと出る', async ({ page }) => {
    const { editions } = await openTop(page)
    const { newest } = newestOf(editions)
    const topic = newest.topics[4]
    expect(await page.evaluate((id) => window.__ts.markRead(id), topic.id)).toMatchObject({ ok: true, changed: true })
    const card = cardOf(page, topic.id)
    await expect(card).toHaveAttribute('data-read', 'true')
    await expect(card).toBeVisible()
    await expect(page.getByTestId('top-read-fold')).toHaveCount(0)

    // 端末に保存してから開き直す（作り物の版は同じ物を入れ直すだけ）
    expect(await page.evaluate(async (f) => (await import(/* @vite-ignore */ f)).flushNow(), '/src/store/appStore.ts')).toBe(true)
    await openTop(page)
    const section = page.locator(
      `[data-testid="top-section"][data-section="${topic.region === 'jp' ? 'jp' : 'world'}"], [data-testid="top-section"][data-section="all"]`,
    )
    const fold = section.getByTestId('top-read-fold')
    await expect(fold).toHaveCount(1)
    await expect(fold.getByRole('button', { name: '既読 1件' })).toHaveAttribute('aria-expanded', 'false')
    await expect(cardOf(page, topic.id)).toBeHidden()
    expect(await openCardIds(page, (await section.getAttribute('data-section'))!)).not.toContain(topic.id)
    await fold.getByRole('button', { name: '既読 1件' }).click()
    await expect(fold.getByRole('button', { name: '既読 1件' })).toHaveAttribute('aria-expanded', 'true')
    await expect(cardOf(page, topic.id)).toBeVisible()
    await expect(cardOf(page, topic.id)).toHaveAttribute('data-read', 'true')
  })

  test('受け取りの途中（downloading）は3秒たっても見たにならず、落ち着いて（synced）から3秒で見たになる', async ({ page }) => {
    const { newestEditionId } = await openTop(page, '/', { sync: 'downloading' })
    const id = newestEditionId!
    await page.waitForTimeout(4000)
    expect(await readOf(page, id)).toBeNull()
    await setSyncView(page, 'synced')
    await page.waitForTimeout(1500)
    expect(await readOf(page, id)).toBeNull()
    await expect.poll(() => readOf(page, id), { timeout: 5000 }).toEqual({ topicIds: [], seen: true })
  })

  test('一覧を操作すると、落ち着く前でもすぐ見たになる', async ({ page }) => {
    const { newestEditionId } = await openTop(page, '/', { sync: null })
    await page.getByTestId('top-edition').getByRole('heading', { level: 2 }).first().click()
    await expect.poll(() => readOf(page, newestEditionId!), { timeout: 3000 }).toEqual({ topicIds: [], seen: true })
  })

  test('最後に見た版の後に2つ見ていない版があると追いつきの帯。［×］で消え、版を見たにする', async ({ page }) => {
    await openTop(page, '/', { seen: ['2026-11-13-12'] })
    const band = page.getByTestId('catch-up-band')
    await expect(band).toContainText('見ていない版が 2つあります（11/13（金）20:00版から）')
    await band.getByRole('button', { name: '追いつきの知らせを閉じる' }).click()
    await expect(band).toHaveCount(0)
    for (const id of ['2026-11-13-20', '2026-11-14-20']) expect((await readOf(page, id))?.seen, id).toBe(true)
  })

  test('［追いつく］は #/catch-up へ', async ({ page }) => {
    await openTop(page, '/', { seen: ['2026-11-13-12'] })
    await page.getByTestId('catch-up-band').getByRole('link', { name: '追いつく' }).click()
    await expect(page).toHaveURL(/#\/catch-up$/)
  })

  test('最後に見た版の後が1版だけ（夜だけ開く並び）・見た版が無い時は、帯を出さない', async ({ page }) => {
    await openTop(page, '/', { seen: ['2026-11-13-20'] })
    await expect(page.getByTestId('top-card').first()).toBeVisible()
    await expect(page.getByTestId('catch-up-band')).toHaveCount(0)
    await openTop(page)
    await expect(page.getByTestId('top-card').first()).toBeVisible()
    await expect(page.getByTestId('catch-up-band')).toHaveCount(0)
  })
})

test.describe('前の版', { tag: ['@pc', '@s'] }, () => {
  test('#/e/{id} はその版の一覧と「前の版を見ています ［いちばん新しい版へ］」。押すとトップへ戻り、いちばん新しい版に付いていく', async ({
    page,
  }) => {
    const { editions } = await openTop(page, '/e/2026-11-14-20', { expect: 'shown' })
    const { newest } = newestOf(editions)
    await expect(page.getByTestId('top-edition')).toHaveAttribute('data-edition-id', '2026-11-14-20')
    const status = page.getByTestId('edition-status')
    await expect(status).toHaveAttribute('data-kind', 'past')
    await expect(status).toContainText('前の版を見ています')
    await status.getByRole('link', { name: 'いちばん新しい版へ' }).click()
    await expect(page).toHaveURL(/#\/$/)
    await expect(page.getByTestId('top-edition')).toHaveAttribute('data-edition-id', newest.edition.id)
    await expect(page.getByTestId('edition-status')).toHaveCount(0)
  })
})
