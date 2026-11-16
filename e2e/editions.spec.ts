// 版の一覧（#/editions）と追いつき（#/catch-up）の E2E（docs/SPEC.md の 9.・4.7。■8 の A。設計: 段階2の 1.8・1.9・4.2）。Firebase 無しで、
// 時刻を決め（既定 2026-11-15（日）14:10）、テスト用のログインと作り物の版（e2e/helpers.ts の openTop）で開く。作り物の版はテストの側でも
// 同じ作り方で作って比べる（中身はすべて作り物。docs/SPEC.md の 3.）。
// - 版の一覧: 枠を新しい順に1行ずつ（作れなかった枠と理由の文・届いていない枠・受け取り中・新しい形の記録）。押せる行を押すと
//   #/e/{版の id} へ移る（前の版の中身はトップの塊、ヘッダーの表示は塊 6 で確かめる）。記録が1つも無ければ「まだ版はありません」
// - 追いつき: 行き先を直に開いた並び（top-card の data-topic-id の順を、テストの側で catchUpTargetIds・catchUpItems を同じ作り物で
//   計算して比べる）・開いた後にその版の seen が付く・0本の時の文・列が無いので L でも詳細は真ん中の小さな画面（履歴の state の side は null）
import { expect, test, type Page } from '@playwright/test'
import { catchUpItems, catchUpTargetIds } from '../src/domain/catchUp'
import { editionRowFailedText, editionNameOfId } from '../src/features/top/texts'
import { makeFakeMonth } from '../src/test/fixtures/fakeEditions'
import { collectDiagnosticsOnFailure, noHorizontalScroll, openTop, setSyncView, type ResolvedEditions } from './helpers'

collectDiagnosticsOnFailure()

/** テストの側で、端末に入れたのと同じ作り物の版を作る */
function monthOf(editions: ResolvedEditions | null) {
  if (!editions) throw new Error('作り物の版を入れていません')
  return makeFakeMonth({ ...editions, seed: editions.seed ?? 'fake-month' })
}

/** 版の一覧の行の [data-edition-id, data-kind] */
function rowsOf(page: Page): Promise<[string | null, string | null][]> {
  return page
    .getByTestId('editions-row')
    .evaluateAll((els) =>
      els.map((e) => [e.getAttribute('data-edition-id'), e.getAttribute('data-kind')] as [string | null, string | null]),
    )
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

/** 追いつきの画面のカードの話題の id（上から） */
function catchUpCardIds(page: Page): Promise<(string | null)[]> {
  return page
    .getByTestId('catch-up-page')
    .getByTestId('top-card')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-topic-id')))
}

test.describe('版の一覧', { tag: ['@pc', '@s'] }, () => {
  test('枠を新しい順に1行ずつ（作れなかった枠と理由の文）。押せる行を押すと前の版 #/e/{id}、上の「いちばん新しい版を見る」でトップへ', async ({
    page,
  }) => {
    const { editions } = await openTop(page, '/editions', { expect: { testId: 'editions-page' } })
    const month = monthOf(editions)
    const editionIds = month.editions.map((e) => e.edition.id)
    const failIds = month.editionFails.map((f) => f.editionId)
    // いちばん古い記録の枠（11/13 12:00）から、いちばん新しい枠（11/15 12:00）まで。11/14 12:00 は作れなかった印だけ
    const expected = [...editionIds, ...failIds]
      .sort()
      .reverse()
      .map((id) => [id, failIds.includes(id) ? 'failed' : 'edition'])
    expect(expected.map(([id]) => id)).toEqual([
      '2026-11-15-12',
      '2026-11-14-20',
      '2026-11-14-12',
      '2026-11-13-20',
      '2026-11-13-12',
    ])
    await expect(page.getByTestId('editions-row')).toHaveCount(expected.length)
    expect(await rowsOf(page)).toEqual(expected)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('版の一覧')

    // 作れなかった枠: 理由の種類の言葉と、短い理由の文（記録のまま）。押せない
    const fail = month.editionFails[0]
    const failRow = page.locator(`[data-testid="editions-row"][data-edition-id="${fail.editionId}"]`)
    await expect(failRow).toContainText(`${editionNameOfId(fail.editionId)}${editionRowFailedText(fail.reasonKind)}`)
    await expect(failRow).toContainText(fail.reason)
    await expect(failRow.getByRole('link')).toHaveCount(0)

    // 版の記録がある行は押せて、その版の名前だけ（受け取り中ではない）
    const target = '2026-11-14-20'
    const row = page.locator(`[data-testid="editions-row"][data-edition-id="${target}"]`)
    await expect(row).toHaveText(editionNameOfId(target)!)
    await row.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`#/e/${target}$`))

    await page.goBack()
    await expect(page.getByTestId('editions-page')).toBeVisible()
    await page.getByRole('link', { name: 'いちばん新しい版を見る' }).click()
    await expect(page).toHaveURL(/#\/$/)
  })

  test('話題がまだそろわない版は「受け取り中」を添え、押せる', async ({ page }) => {
    const { newestEditionId } = await openTop(page, '/editions', {
      editions: { withholdNewest: 2 },
      expect: { testId: 'editions-page' },
    })
    const row = page.locator(`[data-testid="editions-row"][data-edition-id="${newestEditionId}"]`)
    await expect(row).toHaveAttribute('data-kind', 'receiving')
    await expect(row).toHaveText(`${editionNameOfId(newestEditionId!)}受け取り中`)
    // ほかの版は受け取り中ではない
    await expect(page.locator('[data-testid="editions-row"][data-kind="receiving"]')).toHaveCount(1)
    await row.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`#/e/${newestEditionId}$`))
  })

  test('版の記録が新しい形の枠は「新しい形の記録（アプリを更新してください）」で、押せない', async ({ page }) => {
    const { newestEditionId } = await openTop(page, '/editions', {
      editions: { extras: ['newerEdition'] },
      expect: { testId: 'editions-page' },
    })
    const row = page.locator(`[data-testid="editions-row"][data-edition-id="${newestEditionId}"]`)
    await expect(row).toHaveAttribute('data-kind', 'newer')
    await expect(row).toHaveText(`${editionNameOfId(newestEditionId!)}新しい形の記録（アプリを更新してください）`)
    await expect(row.getByRole('link')).toHaveCount(0)
  })

  test('版も印も無いいちばん新しい枠は、枠の時刻の30分後から、同期が落ち着いている時だけ「届いていません」', async ({ page }) => {
    const editions = { until: '2026-11-15', untilSlot: '12' as const }
    const missing = '[data-testid="editions-row"][data-edition-id="2026-11-15-20"]'
    // 20:20（30分の前）は、同期が済んでいても出さない
    await openTop(page, '/editions', { now: '2026-11-15T20:20:00+09:00', editions, expect: { testId: 'editions-page' } })
    await expect(page.getByTestId('editions-row')).toHaveCount(5)
    await expect(page.locator(missing)).toHaveCount(0)
    // 20:40 でも、受け取り中（落ち着いていない）の間は出さず、済むと出す
    await openTop(page, '/editions', {
      now: '2026-11-15T20:40:00+09:00',
      editions,
      sync: 'downloading',
      expect: { testId: 'editions-page' },
    })
    await expect(page.getByTestId('editions-row')).toHaveCount(5)
    await expect(page.locator(missing)).toHaveCount(0)
    await setSyncView(page, 'synced')
    await expect(page.getByTestId('editions-row')).toHaveCount(6)
    expect((await rowsOf(page))[0]).toEqual(['2026-11-15-20', 'missing'])
    await expect(page.locator(missing)).toHaveText('11/15（日）20:00版届いていません')
    await expect(page.locator(missing).getByRole('link')).toHaveCount(0)
    await setSyncView(page, 'offline')
    await expect(page.locator(missing)).toHaveCount(0)
  })

  test('記録が1つも無ければ「まだ版はありません」。360px で横にはみ出さない', async ({ page }) => {
    await openTop(page, '/editions', { editions: null, expect: { testId: 'editions-page' } })
    await expect(page.getByTestId('editions-page').getByText('まだ版はありません')).toBeVisible()
    await expect(page.getByTestId('editions-row')).toHaveCount(0)
    await page.setViewportSize({ width: 360, height: 760 })
    await noHorizontalScroll(page)
  })
})

test.describe('追いつき', { tag: ['@pc', '@s'] }, () => {
  test('直に開くと、最後に見た版より後の版の話題を並べる（続報は最新の1本・重大印 → 順位 → 新しい版）。開いた後にその版が見たになる', async ({
    page,
  }) => {
    const seen = ['2026-11-13-12']
    const { now, editions, newestEditionId } = await openTop(page, '/catch-up', {
      seen,
      expect: { testId: 'catch-up-page' },
    })
    const month = monthOf(editions)
    const byId = new Map(month.editions.map((e) => [e.edition.id, e]))
    const newest = byId.get(newestEditionId!)!
    const targets = catchUpTargetIds({
      now,
      editionIds: month.editions.map((e) => e.edition.id),
      seen: Object.fromEntries(seen.map((id) => [id, { seen: true }])),
      shownId: newestEditionId,
    })
    expect(targets).toEqual(['2026-11-14-20', '2026-11-13-20'])
    const items = catchUpItems(
      targets.map((id) => ({ editionId: id, order: byId.get(id)!.edition.order, topics: byId.get(id)!.topics })),
      { editionId: newest.edition.id, topics: newest.topics },
    )
    // 続報の鎖（いちばん新しい1本が今の版にある）は入らない
    expect(items.some((it) => month.scenes.chain.includes(it.topic.id))).toBe(false)

    const main = page.getByTestId('catch-up-page')
    await expect(main).toHaveAttribute('data-edition-ids', targets.join(' '), { timeout: 15_000 })
    await expect(main.getByTestId('top-card')).toHaveCount(items.length)
    await expect(main).not.toHaveAttribute('aria-busy', 'true')
    expect(await catchUpCardIds(page)).toEqual(items.map((it) => it.topic.id))
    // カードの頭の行に版の名前
    await expect(main.getByTestId('top-card').first()).toContainText(editionNameOfId(items[0].editionId)!)
    await expect(main.getByTestId('top-card').last()).toContainText(editionNameOfId(items[items.length - 1].editionId)!)
    await expect(main.getByText('見た版は、ここに出なくなります')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('追いつき')
    // 開いた後に、追いつく版が見たになる（今の版と、前から見た版はそのまま）
    for (const id of targets) await expect.poll(async () => (await readOf(page, id))?.seen ?? false, { message: id }).toBe(true)
    expect((await readOf(page, newestEditionId!))?.seen ?? false).toBe(false)
    await noHorizontalScroll(page)
  })

  test('追いつく版が無ければ「追いつく版はありません」（最後に見た版の後は今の版だけ）', async ({ page }) => {
    const { newestEditionId } = await openTop(page, '/catch-up', {
      seen: ['2026-11-14-20'],
      expect: { testId: 'catch-up-page' },
    })
    const main = page.getByTestId('catch-up-page')
    await expect(main).toHaveAttribute('data-edition-ids', '', { timeout: 15_000 })
    await expect(main.getByText('追いつく版はありません')).toBeVisible()
    await expect(main.getByTestId('top-card')).toHaveCount(0)
    expect((await readOf(page, newestEditionId!))?.seen ?? false).toBe(false)
  })

  test('カードを押すと詳細。列が無いので、L でも真ん中の小さな画面（履歴の state の side は null）', async ({ page }) => {
    await openTop(page, '/catch-up', { seen: ['2026-11-13-12'], expect: { testId: 'catch-up-page' } })
    const main = page.getByTestId('catch-up-page')
    await expect(main).toHaveAttribute('data-edition-ids', /.+/, { timeout: 15_000 })
    const card = main.getByTestId('top-card').nth(1)
    const id = await card.getAttribute('data-topic-id')
    await card.getByRole('button').click()
    await expect(page).toHaveURL(/#\/catch-up$/)
    expect(await sheetInHistory(page)).toEqual({ kind: 'topic', id, side: null })
    const detail = page.locator('.modal [data-testid="topic-detail"]')
    await expect(detail).toBeVisible()
    await expect(detail).toHaveAttribute('data-topic-id', id!)
    await expect(detail).toHaveAttribute('data-mode', 'sheet')
    await expect(page.getByTestId('panel-slot')).toHaveCount(0)
    // 閉じると、追いつきの画面のまま（並びは変えず、開いた話題は淡く）
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
    await expect(main.locator(`[data-testid="top-card"][data-topic-id="${id}"]`)).toHaveAttribute('data-read', 'true')
    expect((await catchUpCardIds(page))[1]).toBe(id)
  })
})
