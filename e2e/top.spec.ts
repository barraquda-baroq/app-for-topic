// トップの仮の一覧の E2E（docs/SPEC.md の 16.2 の 8・16.3 の「開発サーバー」）。Firebase 無しで、テスト用のログインの印と作り物の版の印
// （topic-studio:test-auth・topic-studio:test-editions。src/features/login/testAuth.ts）で、作り物の版を端末（Dexie）に入れて開く。
// いちばん新しい版の見出しが順位の順に並び、どの幅でも横にはみ出さない。開発用のフックの既読（window.__ts.markRead）は端末に残る。
// 見た目（カード・既読を沈める・ヘッダーの版の表示）は段階2なので、ここでは見出しの並びと既読の印だけを見る。
// 作り物の版は、テストの側でも同じ作り方（同じ種・日付・枠）で作って、見出しを比べる（中身はすべて作り物。docs/SPEC.md の 3.）
import { expect, test, type Page } from '@playwright/test'
import { latestSlotAt } from '../src/domain/jst'
import { makeFakeMonth } from '../src/test/fixtures/fakeEditions'
import { collectDiagnosticsOnFailure, noHorizontalScroll, openApp } from './helpers'

collectDiagnosticsOnFailure()

/** 作り物の版の作り方（日付の境で変わらないよう、テストの初めに1回決める） */
function fakeOptions() {
  const s = latestSlotAt(Date.now())
  return { days: 3, seed: 'e2e-top', until: s.date, untilSlot: s.slot }
}

/** その作り方の、いちばん新しい版 */
function newestOf(opts: ReturnType<typeof fakeOptions>) {
  const month = makeFakeMonth(opts)
  return month.editions[month.editions.length - 1]
}

/** ログインの印と作り物の版の印を置いてから開く（読み込み直しても印は残る） */
async function openWithEditions(page: Page, opts: ReturnType<typeof fakeOptions>) {
  await page.addInitScript((o) => {
    localStorage.setItem('topic-studio:test-auth', '1')
    localStorage.setItem('topic-studio:test-editions', JSON.stringify(o))
  }, opts)
  await page.goto('/#/')
}

test.describe('トップの仮の一覧（作り物の版・Firebase 無し）', { tag: ['@pc', '@s', '@m'] }, () => {
  test('印を置いて開くと、いちばん新しい版の見出しが順位の順に20本並び、横にはみ出さない', async ({ page }) => {
    const opts = fakeOptions()
    const newest = newestOf(opts)
    await openWithEditions(page, opts)
    const list = page.getByTestId('top-headlines')
    await expect(list).toHaveAttribute('data-edition-id', newest.edition.id, { timeout: 15_000 })
    await expect(page.getByTestId('top-headline')).toHaveText(newest.topics.map((t) => t.headline))
    await expect(page.getByTestId('top-empty')).toHaveCount(0)
    // 見出しだけ（リンク・ボタンは無い）
    await expect(list.getByRole('link')).toHaveCount(0)
    await expect(list.getByRole('button')).toHaveCount(0)
    await noHorizontalScroll(page)
  })

  test('開発用のフックで既読にすると見出しの行に印が付き、読み込み直しても残る。知ってるも付けられる', async ({ page }) => {
    const opts = fakeOptions()
    const month = makeFakeMonth(opts)
    const newest = month.editions[month.editions.length - 1]
    await openApp(page, '/', { signedIn: false })
    // window.__ts.fakeSignIn に作り方を渡しても、作り物の版を入れられる（入れ終えるまで待ち、入れた数を返す）
    const put = await page.evaluate((o) => window.__ts.fakeSignIn({ editions: o }), opts)
    expect(put).toMatchObject({
      newestEditionId: newest.edition.id,
      editions: month.editions.length,
      topics: month.editions.length * 20,
      editionFails: 1,
      corrections: 4,
    })
    await expect(page.getByTestId('top-headlines')).toHaveAttribute('data-edition-id', newest.edition.id)

    const topic = newest.topics[4]
    expect(await page.evaluate((id) => window.__ts.markRead(id), topic.id)).toMatchObject({ ok: true, changed: true })
    const row = page.locator(`[data-testid="top-headline"][data-topic-id="${topic.id}"]`)
    await expect(row).toHaveAttribute('data-read', 'true')
    await expect(page.locator('[data-testid="top-headline"][data-read="true"]')).toHaveCount(1)
    expect(await page.evaluate(() => window.__ts.markRead('2026-11-15-12'))).toEqual({ ok: false, reason: 'invalid' })

    const term = newest.topics.flatMap((t) => t.terms)[0]
    expect(await page.evaluate((id) => window.__ts.know(id), term.termId)).toMatchObject({
      ok: true,
      record: { id: term.termId, term: term.term, asOf: term.asOf, on: true },
    })
    expect(await page.evaluate(() => window.__ts.know('t000000000000'))).toEqual({ ok: false, reason: 'missing' })

    // 端末に保存されている: 保存を待ってから（ストアの flushNow。開発サーバーのモジュールをそのまま読むので、アプリと同じ物）、印を置いて
    // 開き直す（作り物の版は同じ物を入れ直すだけ）と、既読が残っている
    expect(await page.evaluate(async (f) => (await import(/* @vite-ignore */ f)).flushNow(), '/src/store/appStore.ts')).toBe(true)
    await openWithEditions(page, opts)
    await expect(row).toHaveAttribute('data-read', 'true', { timeout: 15_000 })
  })
})
