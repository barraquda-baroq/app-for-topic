// 話題の詳細の E2E（docs/SPEC.md の 9. の「詳細」・14.5。設計: 段階2の 4.2 の塊 2）。Firebase 無しで、テスト用のログインと作り物の版を
// 決めた時刻で入れて開き（e2e/helpers.ts の openTop）、トップのカードを待たずに開発用のフック（window.__ts.openTopic）で詳細を開く
// （side を渡さないので、L も真ん中の小さな画面。L の列に重ねるパネルは、塊をまたぐ e2e/flows.spec.ts）。
// S・M は下からのシート。［×］・Esc・戻るで閉じる・読み込み直すと開き直す・強調（.emph の数が作り物の強調と同じ）・用語の印を押すと
// 説明の箱・箱の中の Esc で箱だけ閉じる・［知ってる］→［取り消す］→閉じても記録が変わらない・［知ってる］→閉じると記録が付き、
// 開き直すと語が出ない・訂正が見出しの上に足した順・前の話題へのリンク（履歴を増やさない）・元記事のリンクの数（◇◇日報の URL は文）・
// 長い話題をシートの中だけで下まで送れる。作り物の版はテストの側でも同じ作り方で作って比べる（中身はすべて作り物）
import { expect, test, type Page } from '@playwright/test'
import { repairTopic, type ShownTopic } from '../src/domain/repair'
import { detailTextFields, findTermHits, hitsOf, richSegments } from '../src/domain/termMarks'
import { FAKE_TOPIC_SCENES, makeFakeMonth, type FakeMonth } from '../src/test/fixtures/fakeEditions'
import { FAKE_OUTLETS } from '../src/test/fixtures/fakeOutlets'
import { collectDiagnosticsOnFailure, noHorizontalScroll, openTop, type OpenTopOptions } from './helpers'

collectDiagnosticsOnFailure()

/** 開いた版の作り物（テストの側で同じ作り方で作った物）と、いちばん新しい版 */
interface Opened {
  month: FakeMonth
  newest: FakeMonth['editions'][number]
}

/**
 * 決めた時刻（既定 2026-11-15 14:10）で作り物の版を入れてトップを開き、ストアのいちばん新しい出せる版が開くまで待つ（トップの画面の
 * カード（塊 1）を待たない。ページの中で開発サーバーのストアのモジュールを読む）
 */
async function openForDetail(page: Page, options: OpenTopOptions = {}): Promise<Opened> {
  const r = await openTop(page, '/', { ...options, expect: { testId: 'top-page' } })
  if (!r.editions || !r.newestEditionId) throw new Error('作り物の版を入れていません')
  await expect
    .poll(
      () =>
        page.evaluate(async (file) => {
          const m = (await import(/* @vite-ignore */ file)) as typeof import('../src/store/appStore')
          const v = m.useApp.getState().opened.view
          return v?.kind === 'ready' ? v.editionId : null
        }, '/src/store/appStore.ts'),
      { timeout: 15_000 },
    )
    .toBe(r.newestEditionId)
  const month = makeFakeMonth(r.editions)
  return { month, newest: month.editions[month.editions.length - 1] }
}

/** 開発用のフックで詳細を開き、出るまで待つ（side は渡さない = S・M はシート、L は真ん中の小さな画面） */
async function openDetail(page: Page, topicId: string) {
  expect(await page.evaluate((id) => window.__ts.openTopic(id), topicId)).toBe(true)
  const detail = page.getByTestId('topic-detail')
  await expect(detail).toHaveAttribute('data-topic-id', topicId)
  return detail
}

/** 履歴の state の詳細の印（React Router の history.state.usr.sheet） */
function sheetInHistory(page: Page) {
  return page.evaluate(() => (window.history.state as { usr?: { sheet?: unknown } } | null)?.usr?.sheet ?? null)
}

/** ストアの「知ってる」の写し（その語。無ければ null） */
function knownRecord(page: Page, termId: string) {
  return page.evaluate(
    async ({ file, termId }) => {
      const m = (await import(/* @vite-ignore */ file)) as typeof import('../src/store/appStore')
      const r = m.useApp.getState().user.knownTerms[termId]
      return r ? { on: r.on, asOf: r.asOf } : null
    },
    { file: '/src/store/appStore.ts', termId },
  )
}

function shown(raw: unknown): ShownTopic {
  const r = repairTopic(raw, { outlets: FAKE_OUTLETS })
  if (r.kind !== 'ok') throw new Error('作り物の話題を写しにできません')
  return r.value
}

/** 作り物の話題を id で（版をまたいで） */
function topicOf(month: FakeMonth, id: string): ShownTopic {
  const raw = month.editions.flatMap((e) => e.topics).find((t) => t.id === id)
  if (!raw) throw new Error(`作り物の話題 ${id} がありません`)
  return shown(raw)
}

test.describe('詳細のシート（作り物の版・Firebase 無し）', { tag: ['@pc', '@s', '@m'] }, () => {
  test(
    '開くとシート（題は版の行・見出しへフォーカス）。［×］・Esc・戻るのどれでも閉じる',
    { tag: ['@ios'] },
    async ({ page }) => {
      const { newest } = await openForDetail(page)
      const id = newest.topics[FAKE_TOPIC_SCENES.major - 1].id
      const url = page.url()

      let detail = await openDetail(page, id)
      await expect(detail).toHaveAttribute('data-mode', 'sheet')
      const sheet = page.locator('.modal.topic-sheet')
      await expect(sheet.getByRole('heading', { level: 2 })).toHaveText('11/15（日）12:00版・国内・テクノロジー')
      await expect(detail.locator('.topic-title')).toBeFocused()
      expect(await sheetInHistory(page)).toMatchObject({ kind: 'topic', id, side: null })
      // 詳細は行き先にしない（URL は変わらない）
      expect(page.url()).toBe(url)
      await sheet.getByTestId('modal-close').click()
      await expect(detail).toHaveCount(0)
      expect(await sheetInHistory(page)).toBeNull()

      detail = await openDetail(page, id)
      await page.keyboard.press('Escape')
      await expect(detail).toHaveCount(0)

      detail = await openDetail(page, id)
      await page.goBack()
      await expect(detail).toHaveCount(0)
      expect(page.url()).toBe(url)
      await expect(page.getByTestId('top-page')).toBeVisible()
    },
  )

  test('読み込み直すと、開いていた話題を開き直す', async ({ page }) => {
    const { newest } = await openForDetail(page)
    const id = newest.topics[FAKE_TOPIC_SCENES.jpRulingParty - 1].id
    await openDetail(page, id)
    await page.reload()
    await expect(page.getByTestId('topic-detail')).toHaveAttribute('data-topic-id', id, { timeout: 15_000 })
    // 開き直した後も、閉じれば印が外れる
    await page.locator('.modal.topic-sheet').getByTestId('modal-close').click()
    await expect(page.getByTestId('topic-detail')).toHaveCount(0)
    expect(await sheetInHistory(page)).toBeNull()
  })

  test(
    '強調の数が作り物の強調と同じ。用語の印を押すと段落の下に説明の箱、箱の中の Esc は箱だけ閉じる',
    { tag: ['@ios'] },
    async ({ page }) => {
      const { newest } = await openForDetail(page)
      const topic = shown(newest.topics[FAKE_TOPIC_SCENES.jpRulingParty - 1])
      const detail = await openDetail(page, topic.id)
      // 強調は、用語の印の境で分かれる所も1つずつ数える（src/features/topic/RichText.tsx と同じ区切り）
      const fields = detailTextFields(topic)
      const hits = findTermHits(fields, topic.terms)
      const strong = fields.reduce(
        (n, f) => n + richSegments(f.text, topic.emphasis[f.key] ?? [], hitsOf(hits, f.key)).filter((s) => s.strong).length,
        0,
      )
      expect(strong).toBeGreaterThan(0)
      await expect(detail.locator('strong.emph')).toHaveCount(strong)
      await expect(detail.getByTestId('term-mark')).toHaveCount(hits.length)

      const mark = detail.getByTestId('term-mark').first()
      const termId = (await mark.getAttribute('data-term-id'))!
      await mark.click()
      const box = detail.getByTestId('term-note')
      await expect(box).toBeVisible()
      await expect(box).toHaveAttribute('data-term-id', termId)
      await expect(mark).toHaveAttribute('aria-expanded', 'true')
      await expect(box).toContainText(topic.terms.find((t) => t.termId === termId)!.explanation)
      await box.getByTestId('term-known').focus()
      await page.keyboard.press('Escape')
      await expect(box).toHaveCount(0)
      await expect(detail).toBeVisible()
      await expect(mark).toBeFocused()
      // もう一度 Esc でシートが閉じる
      await page.keyboard.press('Escape')
      await expect(detail).toHaveCount(0)
    },
  )

  test('［知ってる］→［取り消す］→閉じても記録は変わらない。［知ってる］→閉じると記録が付き、開き直すと語が出ない', async ({
    page,
  }) => {
    const { newest } = await openForDetail(page)
    const id = newest.topics[FAKE_TOPIC_SCENES.jpRulingParty - 1].id
    let detail = await openDetail(page, id)
    const termId = (await detail.getByTestId('term-mark').first().getAttribute('data-term-id'))!
    const row = () => page.locator(`.topic-term[data-term-id="${termId}"]`)

    await row().getByTestId('term-known').click()
    await expect(row()).toContainText('知ってるにしました')
    await row().getByRole('button', { name: '取り消す' }).click()
    await expect(row().getByTestId('term-known')).toBeVisible()
    await page.locator('.modal.topic-sheet').getByTestId('modal-close').click()
    await expect(detail).toHaveCount(0)
    expect(await knownRecord(page, termId)).toBeNull()

    detail = await openDetail(page, id)
    await row().getByTestId('term-known').click()
    // 押しただけでは書かない（閉じるまで［取り消す］で戻せる）
    expect(await knownRecord(page, termId)).toBeNull()
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
    await expect.poll(() => knownRecord(page, termId)).toMatchObject({ on: true })

    detail = await openDetail(page, id)
    await expect(detail.locator(`[data-testid="term-mark"][data-term-id="${termId}"]`)).toHaveCount(0)
    await expect(row()).toHaveCount(0)
  })

  test('訂正は見出しの上に、足した順に「訂正: …」', async ({ page }) => {
    const { month } = await openForDetail(page)
    const id = month.scenes.corrections.twice
    const detail = await openDetail(page, id)
    const texts = month.corrections.filter((c) => c.topicId === id).map((c) => `訂正: ${c.text}`)
    expect(texts).toHaveLength(2)
    await expect(detail.getByTestId('topic-correction')).toHaveText(texts)
    const above = await detail.evaluate((root) => {
      const box = root.querySelector('[data-testid="topic-correction"]')!
      const title = root.querySelector('.topic-title')!
      return Boolean(box.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(above).toBe(true)
  })

  test('前の話題へのリンクで、同じシートの中身が替わる（履歴を増やさない）。閉じると1回で戻る', async ({ page }) => {
    const { month } = await openForDetail(page)
    const [, second, third] = month.scenes.chain
    const detail = await openDetail(page, third)
    const length = await page.evaluate(() => window.history.length)
    const prev = detail.getByRole('button', { name: /^前の話題:/ })
    await expect(prev).toContainText(topicOf(month, second).headline)
    await prev.click()
    await expect(detail).toHaveAttribute('data-topic-id', second)
    await expect(page.locator('.modal.topic-sheet').getByRole('heading', { level: 2 })).toHaveText(
      '11/14（土）20:00版・国内・経済',
    )
    expect(await page.evaluate(() => window.history.length)).toBe(length)
    expect(await sheetInHistory(page)).toMatchObject({ id: second })
    // 続報の話題: 頭の行に「続報」・もっと新しい続報へのリンク
    await expect(detail.locator('.topic-head')).toContainText('続報')
    await expect(detail.getByRole('button', { name: /^この話題には続報があります:/ })).toContainText(
      topicOf(month, third).headline,
    )
    await page.locator('.modal.topic-sheet').getByTestId('modal-close').click()
    await expect(detail).toHaveCount(0)
    expect(await sheetInHistory(page)).toBeNull()
  })

  test('元記事: リンクにする出典だけ新しいタブのリンク、一覧に無い社（◇◇日報）の URL は文で出す', async ({ page }) => {
    const { newest } = await openForDetail(page)
    const topic = shown(newest.topics[FAKE_TOPIC_SCENES.newerValues - 1])
    const detail = await openDetail(page, topic.id)
    const sources = detail.locator('.topic-sources')
    const linked = topic.sources.filter((s) => s.link)
    expect(linked.length).toBeGreaterThan(0)
    await expect(sources.locator('a')).toHaveCount(linked.length)
    for (const [i, s] of linked.entries()) {
      const a = sources.locator('a').nth(i)
      await expect(a).toHaveAttribute('href', s.link!)
      await expect(a).toHaveAttribute('target', '_blank')
      await expect(a).toHaveAttribute('rel', 'noopener noreferrer')
    }
    const plain = topic.sources.find((s) => !s.link)!
    expect(plain.outlet).toBe('◇◇日報')
    await expect(sources.locator('.topic-url')).toHaveText([plain.url])
    await noHorizontalScroll(page)
  })
})

test.describe('長い話題（作り物の版・Firebase 無し）', { tag: ['@s'] }, () => {
  test(
    '上限いっぱいの話題も、シートの中だけで下まで送れる（後ろのページは動かない・横にはみ出さない）',
    { tag: ['@ios'] },
    async ({ page }) => {
      const { newest } = await openForDetail(page)
      const detail = await openDetail(page, newest.topics[FAKE_TOPIC_SCENES.maxLength - 1].id)
      const body = page.locator('.modal.topic-sheet .modal-body')
      const before = await page.evaluate(() => window.scrollY)
      await body.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
      await expect(detail.locator('.topic-foot')).toBeInViewport()
      expect(await page.evaluate(() => window.scrollY)).toBe(before)
      await noHorizontalScroll(page)
      const [scroll, width] = await body.evaluate((el) => [el.scrollWidth, el.clientWidth])
      expect(scroll).toBeLessThanOrEqual(width)
    },
  )
})
