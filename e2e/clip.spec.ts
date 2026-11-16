// ［クリップ］の E2E（D10・docs/SPEC.md の 7.6・9.。作者の答え A。設計: 段階2の 4.2 の塊 2）。Firebase 無しで、作り物の版を決めた時刻で
// 入れて開き（e2e/helpers.ts の openTop）、開発用のフック（window.__ts.openTopic）で続報の鎖の1本目（訂正1件・××ニュースで読んだ出典。
// 開いている版とは別の版の話題）の詳細を開く。
// @pc: クリップボードの許可を与え、コピーした文が、テストの側で同じ作り物から作った clipText と1字も違わない・お知らせが出る。
// @s・@ios: writeText を断るようにして、文を選んだ窓の欄にフォーカスがあり、全部が選ばれ、同じ文。Esc で窓だけ閉じ、フォーカスは
// ［クリップ］へ戻る（作り物の版の中身はすべて作り物）
import { expect, test, type Page } from '@playwright/test'
import { clipText } from '../src/domain/clipText'
import { repairTopic } from '../src/domain/repair'
import { makeFakeMonth } from '../src/test/fixtures/fakeEditions'
import { FAKE_OUTLETS } from '../src/test/fixtures/fakeOutlets'
import { collectDiagnosticsOnFailure, openTop } from './helpers'

collectDiagnosticsOnFailure()

/** 決めた時刻で作り物の版を入れて開き、続報の鎖の1本目の詳細を開く。返り値はその話題のクリップの文（テストの側で作った物） */
async function openChainFirst(page: Page): Promise<string> {
  const r = await openTop(page, '/', { expect: { testId: 'top-page' } })
  if (!r.editions) throw new Error('作り物の版を入れていません')
  const month = makeFakeMonth(r.editions)
  const id = month.scenes.chain[0]
  const raw = month.editions.flatMap((e) => e.topics).find((t) => t.id === id)
  const topic = repairTopic(raw, { outlets: FAKE_OUTLETS })
  if (topic.kind !== 'ok') throw new Error('作り物の話題を写しにできません')
  const corrections = month.corrections.filter((c) => c.topicId === id).sort((a, b) => a.createdAt - b.createdAt)
  expect(corrections).toHaveLength(1)
  // 端末の中を読み終えて、作り物の版が入るまで待ってから開く（開いた版とは別の版の話題なので、詳細が端末から読む）
  await expect
    .poll(
      () =>
        page.evaluate(async (file) => {
          const m = (await import(/* @vite-ignore */ file)) as typeof import('../src/store/appStore')
          return m.useApp.getState().opened.view?.kind ?? null
        }, '/src/store/appStore.ts'),
      { timeout: 15_000 },
    )
    .toBe('ready')
  expect(await page.evaluate((topicId) => window.__ts.openTopic(topicId), id)).toBe(true)
  await expect(page.getByTestId('topic-detail')).toHaveAttribute('data-topic-id', id)
  return clipText(topic.value, corrections)
}

test.describe('［クリップ］（クリップボードを使える時）', { tag: ['@pc'] }, () => {
  test('押すと、見出し・版・地域とジャンル・要約・訂正・元記事の文がクリップボードに入り、お知らせが出る', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const expected = await openChainFirst(page)
    expect(expected).toContain('\n\n訂正: ')
    expect(expected).toContain('（××ニュースで読んだ）')
    await page.getByTestId('topic-clip').click()
    await expect(page.getByRole('status').filter({ hasText: 'クリップボードにコピーしました' })).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected)
    await expect(page.getByTestId('clip-dialog')).toHaveCount(0)
  })
})

test.describe('［クリップ］（クリップボードに書けない時）', { tag: ['@s', '@ios'] }, () => {
  test('断られると文を選んだ窓を出す（欄にフォーカスし全部を選ぶ・同じ文）。Esc で窓だけ閉じ、［クリップ］へ戻る', async ({
    page,
  }) => {
    // どのブラウザでも同じ道を通るよう、書き込みを断るようにする（許可されない・古いブラウザの代わり）
    await page.addInitScript(() => {
      const deny = () => Promise.reject(new DOMException('書き込みは許可されていません', 'NotAllowedError'))
      if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { value: deny, configurable: true })
      else Object.defineProperty(navigator, 'clipboard', { value: { writeText: deny }, configurable: true })
    })
    const expected = await openChainFirst(page)
    const clip = page.getByTestId('topic-clip')
    await clip.click()
    const dialog = page.getByTestId('clip-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('選んでコピーしてください')
    const area = dialog.getByRole('textbox')
    await expect(area).toHaveValue(expected)
    await expect(area).toBeFocused()
    expect(await area.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, expected.length])
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('topic-detail')).toBeVisible()
    await expect(clip).toBeFocused()
  })
})
