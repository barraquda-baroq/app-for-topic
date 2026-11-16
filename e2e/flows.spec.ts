// 塊をまたぐ通しの E2E（docs/SPEC.md の 9.・14.5。設計: 段階2の 4.2 の塊 6）。トップ・詳細・版の一覧と追いつき・ヘッダーと設定の
// 部品が、設計の 1.〜4. のとおりにつながっているかを、画面の操作だけで確かめる（開発用のフックは、見た版の並びを作る seen と、
// 前の版を待たずに古い話題を開く所だけに使う）。Firebase 無しで、時刻を決め（2026-11-15（日）14:10）、テスト用のログインと作り物の版
// （e2e/helpers.ts の openTop）で開く。作り物の版はテストの側でも同じ作り方で作って比べる（中身はすべて作り物。docs/SPEC.md の 3.）。
// - カードを押す → 詳細 → 閉じるとカードは淡く（その場では沈めない）、フォーカスはカードへ戻る → 次にトップを出した時に「既読 n件」へ沈む
// - S・M: ジャンルの区切りから開いた詳細を閉じると、そのカードへ戻る（Safari の押し方・クリップの窓を開いたままの戻る・幅の往復でも）
// - L のパネル: 国内のカードは世界の列、世界のカードは国内の列に重なる・重ねた列の一覧は inert・開いた列の次のカードを続けて開ける・
//   幅を変えるとシートと入れ替わる（フォーカスを失わない）・パネルの上のクリップの窓の Esc は窓だけ閉じる・説明の箱の Esc は箱だけ・
//   閉じずに次のカードへ替えても、前の話題で押した［知ってる］の語は次の話題に出ない
// - 説明の箱が開いている時の Esc は、フォーカスが中身の外（［クリップ］の後・本文の字を押した後）でも箱だけを閉じる
// - ヘッダーの版の表示 → 版の一覧 → 前の版（版の表示が替わる・続報あり → 続報のリンク）→［いちばん新しい版へ］
// - 追いつきの帯 →［追いつく］→ 追いつきの画面（L も真ん中の小さな画面）→ 戻ると帯が消える
// - 文字の大きさ（設定 → トップのカード・詳細の字が替わり、ヘッダーの字は替わらない）
// - ［知ってる］→ 設定の一覧で［戻す］→ 詳細に語が戻る
// - 時期で変わる語（7.4）: 古い話題で［知ってる］→ 新しい説明の話題で［知ってる］→［取り消す］→ 古い話題でも語が出ないまま
import { expect, test, type Locator, type Page } from '@playwright/test'
import { FAKE_TOPIC_SCENES, makeFakeMonth } from '../src/test/fixtures/fakeEditions'
import { cardOf, collectDiagnosticsOnFailure, openTop, type ResolvedEditions } from './helpers'

collectDiagnosticsOnFailure()

/** テストの側で、端末に入れたのと同じ作り物の版を作る（いちばん新しい版も） */
function monthOf(editions: ResolvedEditions | null) {
  if (!editions) throw new Error('作り物の版を入れていません')
  const month = makeFakeMonth({ ...editions, seed: editions.seed ?? 'fake-month' })
  return { month, newest: month.editions[month.editions.length - 1] }
}

/** L（幅 900px から。国内｜世界の2列とパネル） */
function isWide(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= 900
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

/** ストアの「知ってる」の記録（その語。無ければ null。押す前と後で1字も違わないかを見るため、記録の欄を全部返す） */
function knownRecord(page: Page, termId: string): Promise<Record<string, unknown> | null> {
  return page.evaluate(
    async ({ file, termId }) => {
      const m = (await import(/* @vite-ignore */ file)) as typeof import('../src/store/appStore')
      const r = m.useApp.getState().user.knownTerms[termId]
      return r ? (JSON.parse(JSON.stringify(r)) as Record<string, unknown>) : null
    },
    { file: '/src/store/appStore.ts', termId },
  )
}

/** 履歴の state の詳細の印（React Router のハッシュの履歴は history.state.usr に置く） */
function sheetInHistory(page: Page): Promise<unknown> {
  return page.evaluate(() => (window.history.state as { usr?: { sheet?: unknown } } | null)?.usr?.sheet ?? null)
}

/** 今フォーカスのある所が、その要素の中か */
function focusInside(target: Locator): Promise<boolean> {
  return target.evaluate((el) => el.contains(document.activeElement) && document.activeElement !== document.body)
}

/** その列（L の 'jp'・'world'）の一覧の箱（差し込み口の兄弟。パネルを重ねている間は inert） */
function columnList(page: Page, side: 'jp' | 'world'): Locator {
  return page
    .locator('.top-column')
    .filter({ has: page.locator(`[data-testid="panel-slot"][data-side="${side}"]`) })
    .locator('.top-column-list')
}

/** カードの見出しの外（要約）を押して詳細を開き、出るまで待つ（カードのどこを押しても見出しのボタンと同じ） */
async function openFromCard(page: Page, card: Locator, topicId: string): Promise<Locator> {
  await card.locator('.top-card-summary').click()
  const detail = page.getByTestId('topic-detail')
  await expect(detail).toHaveAttribute('data-topic-id', topicId)
  return detail
}

/** 開いている詳細を［×］で閉じる（L のパネルは頭の行の topic-close、シート・真ん中の小さな画面は Modal の modal-close） */
async function closeDetail(page: Page): Promise<void> {
  const panel = page.locator('.topic-panel')
  if (await panel.count()) await panel.getByTestId('topic-close').click()
  else await page.locator('.modal.topic-sheet').getByTestId('modal-close').click()
  await expect(page.getByTestId('topic-detail')).toHaveCount(0)
}

/** 「既読 n件」に沈んだカードを出す（その区切りの畳む所を開く。S・M は総合、L は国内・世界の列） */
async function unfold(page: Page, section: string): Promise<void> {
  const button = page
    .locator(`[data-testid="top-section"][data-section="${section}"]`)
    .getByTestId('top-read-fold')
    .locator('.top-read-fold-btn')
  if ((await button.getAttribute('aria-expanded')) === 'false') await button.click()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
}

/** 歯車で設定を開き、［‹ 戻る］でトップへ戻る（トップの画面を出し直す） */
async function viaSettings(page: Page, inSettings?: () => Promise<void>): Promise<void> {
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('app-settings')).toBeVisible()
  if (inSettings) await inSettings()
  await page.getByTestId('settings-back').click()
  await expect(page.getByTestId('top-edition')).toBeVisible()
}

test.describe('カード → 詳細 → 既読', { tag: ['@pc', '@s', '@m'] }, () => {
  test('カードを押すと詳細。閉じるとカードは淡くなり（その場では沈めない）、フォーカスはカードへ戻る。次にトップを出した時に「既読 1件」へ沈む', async ({
    page,
  }) => {
    const { editions } = await openTop(page)
    const { newest } = monthOf(editions)
    const wide = isWide(page)
    const topic = newest.topics.find((t) => t.region === 'jp' && !t.major && t.genre === 'economy')!
    const other = newest.topics.find((t) => t.region === 'jp' && !t.major && t.id !== topic.id)!
    const card = cardOf(page, topic.id)

    const detail = await openFromCard(page, card, topic.id)
    await expect(detail).toHaveAttribute('data-mode', wide ? 'panel' : 'sheet')
    await expect(detail.locator('.topic-title')).toHaveText(topic.headline)
    // 開いた時に、その話題を既読に・その版を見たにする（1回で書く）
    await expect.poll(() => readOf(page, newest.edition.id)).toEqual({ topicIds: [topic.id], seen: true })

    await closeDetail(page)
    await expect(card).toHaveAttribute('data-read', 'true')
    await expect(card).toBeVisible()
    await expect(card.locator('.top-card-open')).toBeFocused()
    await expect(page.getByTestId('top-read-fold')).toHaveCount(0)
    // 見出しは淡い字（読んでいないカードと違う色）
    const headColor = (l: Locator) => l.locator('.top-card-head').evaluate((e) => getComputedStyle(e).color)
    expect(await headColor(card)).not.toBe(await headColor(cardOf(page, other.id)))

    // ほかの画面から戻ると、沈める並びを取り直す（総合・ジャンルの区切り。L は国内の列）
    await viaSettings(page)
    const sections = wide ? ['jp'] : ['all', 'economy']
    for (const s of sections) {
      const fold = page.locator(`[data-testid="top-section"][data-section="${s}"]`).getByTestId('top-read-fold')
      await expect(fold.getByRole('button', { name: '既読 1件' }), s).toHaveAttribute('aria-expanded', 'false')
      await expect(fold.locator(`[data-testid="top-card"][data-topic-id="${topic.id}"]`), s).toBeHidden()
    }
    await expect(cardOf(page, other.id)).toBeVisible()
    await unfold(page, sections[0])
    await expect(cardOf(page, topic.id)).toBeVisible()
    // 沈んだカードからも開ける
    await openFromCard(page, cardOf(page, topic.id), topic.id)
    await closeDetail(page)
    await expect(cardOf(page, topic.id).locator('.top-card-open')).toBeFocused()
  })
})

// S・M は同じ話題が総合とジャンルの区切りに2回出る。閉じた時は開いたカード（ジャンルの区切りの方）へ戻し、画面の外の総合のカードへ
// 飛ばない（設計: 段階2の 2. の「閉じた時は開いたカードの見出しのボタンへ戻す」）。シートが開いた所へ戻せない道（Safari の押し方・
// クリップの窓を開いたままの戻る・幅の往復）でも同じ
test.describe('S・M: ジャンルの区切りから開いた詳細を閉じる', { tag: ['@s', '@m'] }, () => {
  /** 経済の区切りのカード（総合にも同じ話題がある） */
  async function economyCard(page: Page): Promise<{ id: string; card: Locator }> {
    const { editions } = await openTop(page)
    const { newest } = monthOf(editions)
    const topic = newest.topics.find((t) => t.genre === 'economy' && !t.major)!
    const card = page.locator(
      `[data-testid="top-section"][data-section="economy"] [data-testid="top-card"][data-topic-id="${topic.id}"]`,
    )
    await expect(cardOf(page, topic.id)).toHaveCount(1)
    await card.scrollIntoViewIfNeeded()
    return { id: topic.id, card }
  }
  /** フォーカスがその区切りのカードの見出しのボタンにあり、画面の中に見えている */
  async function expectFocusBack(card: Locator): Promise<void> {
    await expect(card.locator('.top-card-open')).toBeFocused()
    await expect(card.locator('.top-card-open')).toBeInViewport()
  }

  test('Safari のように押したボタンへフォーカスが移らなくても、［×］で閉じるとそのカードへ戻る', async ({ page }) => {
    const { id, card } = await economyCard(page)
    // Safari は押したボタンへフォーカスを移さない（mousedown の既定の動きを止めると Chromium も同じになる）
    await page.evaluate(() => {
      document.addEventListener(
        'mousedown',
        (e) => {
          if (e.target instanceof Element && e.target.closest('.top-card-open')) e.preventDefault()
        },
        true,
      )
    })
    await card.locator('.top-card-open').click()
    await expect(page.getByTestId('topic-detail')).toHaveAttribute('data-topic-id', id)
    await closeDetail(page)
    await expectFocusBack(card)
  })

  test('クリップの窓を開いたまま「戻る」で閉じても、そのカードへ戻る', async ({ page }) => {
    await page.addInitScript(() => {
      const deny = () => Promise.reject(new DOMException('書き込みは許可されていません', 'NotAllowedError'))
      if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { value: deny, configurable: true })
      else Object.defineProperty(navigator, 'clipboard', { value: { writeText: deny }, configurable: true })
    })
    const { id, card } = await economyCard(page)
    await openFromCard(page, card, id)
    await page.locator('.modal.topic-sheet').getByTestId('topic-clip').click()
    await expect(page.getByTestId('clip-dialog')).toBeVisible()
    await page.goBack()
    await expect(page.getByTestId('topic-detail')).toHaveCount(0)
    await expect(page.getByTestId('clip-dialog')).toHaveCount(0)
    await expectFocusBack(card)
  })

  test('開いたまま幅を L へ広げて戻してから［×］で閉じても、そのカードへ戻る', async ({ page }) => {
    const { id, card } = await economyCard(page)
    const size = page.viewportSize()!
    await openFromCard(page, card, id)
    await page.setViewportSize({ width: 1024, height: 768 })
    await expect(page.getByTestId('top-edition')).toHaveAttribute('data-layout', 'wide')
    await page.setViewportSize(size)
    await expect(page.getByTestId('top-edition')).toHaveAttribute('data-layout', 'stack')
    await expect(page.getByTestId('topic-detail')).toHaveAttribute('data-mode', 'sheet')
    await card.scrollIntoViewIfNeeded()
    await closeDetail(page)
    await expectFocusBack(card)
  })
})

test.describe('L のパネル', { tag: ['@pc'] }, () => {
  test('国内のカードは世界の列に重ね、重ねた列の一覧だけ inert。開いた列の次のカードも続けて開け（履歴は増えない）、1回閉じれば戻る', async ({
    page,
  }) => {
    const { editions } = await openTop(page)
    const { newest } = monthOf(editions)
    const [first, second] = newest.topics.filter((t) => t.region === 'jp' && !t.major)
    const url = page.url()

    let detail = await openFromCard(page, cardOf(page, first.id), first.id)
    await expect(detail).toHaveAttribute('data-mode', 'panel')
    const slot = page.locator('[data-testid="panel-slot"][data-side="world"]')
    await expect(slot.locator('.topic-panel')).toBeVisible()
    await expect(slot.getByTestId('topic-detail')).toHaveCount(1)
    expect(await sheetInHistory(page)).toEqual({ kind: 'topic', id: first.id, side: 'world' })
    expect(await columnList(page, 'world').evaluate((e) => (e as HTMLElement).inert)).toBe(true)
    expect(await columnList(page, 'jp').evaluate((e) => (e as HTMLElement).inert)).toBe(false)
    // パネルは右の列の上にちょうど重なる（後ろの一覧は使えるまま。#root を inert にしない）
    const [panelBox, listBox] = [await slot.locator('.topic-panel').boundingBox(), await columnList(page, 'world').boundingBox()]
    expect(panelBox && listBox && Math.abs(panelBox.x - listBox.x) <= 1 && Math.abs(panelBox.width - listBox.width) <= 1).toBe(
      true,
    )
    expect(await page.evaluate(() => document.getElementById('root')?.inert)).toBe(false)
    await expect(page.locator('.modal-backdrop')).toHaveCount(0)
    // 開いた時は詳細の見出しへフォーカス
    await expect(detail.locator('.topic-title')).toBeFocused()
    // Tab で進んでも、重ねた列のカードには入らない
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      expect(await focusInside(columnList(page, 'world')), `Tab ${i + 1}`).toBe(false)
    }

    // 同じ列の次のカードは見えたままで、押すとパネルの中身が替わる（置き換え。履歴を増やさない）
    const length = await page.evaluate(() => window.history.length)
    detail = await openFromCard(page, cardOf(page, second.id), second.id)
    await expect(page.locator('.topic-panel')).toHaveCount(1)
    expect(await page.evaluate(() => window.history.length)).toBe(length)
    expect(await sheetInHistory(page)).toEqual({ kind: 'topic', id: second.id, side: 'world' })

    await closeDetail(page)
    expect(await sheetInHistory(page)).toBeNull()
    expect(page.url()).toBe(url)
    expect(await columnList(page, 'world').evaluate((e) => (e as HTMLElement).inert)).toBe(false)
    await expect(cardOf(page, second.id).locator('.top-card-open')).toBeFocused()
    // どちらも既読（その場では淡くするだけ）
    for (const t of [first, second]) await expect(cardOf(page, t.id)).toHaveAttribute('data-read', 'true')
  })

  test('世界のカードは国内の列に重ねる（読んでいる世界の列は見えたまま）。Esc で閉じるとカードへ戻る', async ({ page }) => {
    const { editions } = await openTop(page)
    const { newest } = monthOf(editions)
    const world = newest.topics.find((t) => t.region === 'world')!
    const detail = await openFromCard(page, cardOf(page, world.id), world.id)
    await expect(page.locator('[data-testid="panel-slot"][data-side="jp"]').getByTestId('topic-detail')).toHaveCount(1)
    await expect(detail).toHaveAttribute('data-mode', 'panel')
    expect(await columnList(page, 'jp').evaluate((e) => (e as HTMLElement).inert)).toBe(true)
    expect(await columnList(page, 'world').evaluate((e) => (e as HTMLElement).inert)).toBe(false)
    await expect(cardOf(page, world.id)).toBeInViewport()
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
    expect(await columnList(page, 'jp').evaluate((e) => (e as HTMLElement).inert)).toBe(false)
    await expect(cardOf(page, world.id).locator('.top-card-open')).toBeFocused()
  })

  test('幅を変えると、同じ詳細のままパネルとシートが入れ替わる（フォーカスは詳細の中のまま）。閉じると同じ話題のカードへ戻る', async ({
    page,
  }) => {
    const { editions } = await openTop(page)
    const { newest } = monthOf(editions)
    const topic = newest.topics.find((t) => t.region === 'jp' && !t.major)!
    await openFromCard(page, cardOf(page, topic.id), topic.id)
    const panel = page.locator('.topic-panel')
    await expect(panel).toBeVisible()

    // M（向きを変えたタブレット）: 下からのシート
    await page.setViewportSize({ width: 800, height: 900 })
    const sheet = page.locator('.modal.topic-sheet')
    await expect(sheet.getByTestId('topic-detail')).toHaveAttribute('data-topic-id', topic.id)
    await expect(sheet.getByTestId('topic-detail')).toHaveAttribute('data-mode', 'sheet')
    await expect(panel).toHaveCount(0)
    await expect.poll(() => focusInside(sheet)).toBe(true)
    expect(await sheetInHistory(page)).toEqual({ kind: 'topic', id: topic.id, side: 'world' })

    // L へ戻すと、またパネル
    await page.setViewportSize({ width: 1400, height: 900 })
    await expect(panel.getByTestId('topic-detail')).toHaveAttribute('data-topic-id', topic.id)
    await expect(sheet).toHaveCount(0)
    await expect.poll(() => focusInside(panel)).toBe(true)
    expect(await page.evaluate(() => document.getElementById('root')?.inert)).toBe(false)

    await closeDetail(page)
    expect(await sheetInHistory(page)).toBeNull()
    await expect(cardOf(page, topic.id).locator('.top-card-open')).toBeFocused()
  })

  test('パネルの上のクリップの窓で Esc を押すと窓だけ閉じ、フォーカスは［クリップ］へ。もう一度 Esc でパネルが閉じる', async ({
    page,
  }) => {
    // クリップボードに書けない時の窓の道を通す（許可されない・古いブラウザの代わり）
    await page.addInitScript(() => {
      const deny = () => Promise.reject(new DOMException('書き込みは許可されていません', 'NotAllowedError'))
      if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { value: deny, configurable: true })
      else Object.defineProperty(navigator, 'clipboard', { value: { writeText: deny }, configurable: true })
    })
    const { editions } = await openTop(page)
    const { newest } = monthOf(editions)
    const topic = newest.topics.find((t) => t.region === 'world')!
    const detail = await openFromCard(page, cardOf(page, topic.id), topic.id)
    const panel = page.locator('.topic-panel')
    const clip = panel.getByTestId('topic-clip')
    await clip.click()
    const dialog = page.getByTestId('clip-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('textbox')).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(detail).toBeVisible()
    await expect(detail).toHaveAttribute('data-mode', 'panel')
    await expect(clip).toBeFocused()
    expect(await sheetInHistory(page)).toMatchObject({ id: topic.id })

    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
    await expect(cardOf(page, topic.id).locator('.top-card-open')).toBeFocused()
  })

  test('パネルの中の説明の箱で Esc を押すと箱だけ閉じ、語のボタンへ戻る', async ({ page }) => {
    const { editions } = await openTop(page)
    const { newest } = monthOf(editions)
    const topic = newest.topics[FAKE_TOPIC_SCENES.jpRulingParty - 1]
    const detail = await openFromCard(page, cardOf(page, topic.id), topic.id)
    const mark = detail.getByTestId('term-mark').first()
    await mark.click()
    const box = detail.getByTestId('term-note')
    await expect(box).toBeVisible()
    await box.getByTestId('term-known').focus()
    await page.keyboard.press('Escape')
    await expect(box).toHaveCount(0)
    await expect(detail).toBeVisible()
    await expect(mark).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
  })

  // 閉じずに同じ列の次のカードへ替えると、前の話題で押した［知ってる］は前の部品が消える時に書く。次の話題はその前に描くので、
  // まだ書いていない押した語も数えて出さない（設計: 段階2の 1.13 の「次に開いた時から出さない（本文の印も付けない）」・docs/SPEC.md の 5.8）
  test('パネルで［知ってる］を押し、閉じずに同じ列の次のカードを開くと、その語は次の話題の一覧にも本文の印にも出ない', async ({
    page,
  }) => {
    const { editions } = await openTop(page)
    const { newest } = monthOf(editions)
    // 同じ列（国内）の2本で、a で押すと b でも「知ってる」になる語（b の説明の時点が a の時点以前）を持つ組
    const jp = newest.topics.filter((t) => t.region === 'jp')
    let pair: { a: string; b: string; termId: string } | null = null
    for (const a of jp)
      for (const b of jp) {
        if (pair || a.id === b.id) continue
        const t = a.terms.find((x) => {
          const bt = b.terms.find((y) => y.termId === x.termId)
          return bt && (bt.asOf == null || (x.asOf != null && bt.asOf <= x.asOf))
        })
        if (t) pair = { a: a.id, b: b.id, termId: t.termId }
      }
    if (!pair) throw new Error('同じ列に、同じ語を持つ話題の組がありません')
    const { a, b, termId } = pair
    const inDetail = (detail: Locator) => detail.locator(`[data-term-id="${termId}"]`)

    // 押す前の b には、その語が一覧に出る
    let detail = await openFromCard(page, cardOf(page, b), b)
    await expect(detail.locator(`.topic-term[data-term-id="${termId}"]`)).toHaveCount(1)
    detail = await openFromCard(page, cardOf(page, a), a)
    await expect(detail).toHaveAttribute('data-mode', 'panel')
    await detail.locator(`.topic-term[data-term-id="${termId}"]`).getByTestId('term-known').click()
    expect(await knownRecord(page, termId)).toBeNull()

    detail = await openFromCard(page, cardOf(page, b), b)
    await expect.poll(async () => (await knownRecord(page, termId))?.on ?? null).toBe(true)
    // 一覧（語・説明・［知ってる］）にも、本文の印にも出ない
    await expect(inDetail(detail)).toHaveCount(0)
  })
})

// 説明の箱が開いている時の Esc は、フォーカスが詳細の中身の外（シートの下の帯・パネルの頭の行の［クリップ］、本文の字を押した後の
// body）にあっても、箱だけを閉じる（設計: 段階2の 1.12 の「Esc で閉じる」・2. の「先に箱だけを閉じて止める」）
test.describe('説明の箱と Esc', { tag: ['@pc', '@s'] }, () => {
  test('［クリップ］の後・本文の字を押した後の Esc は箱だけを閉じて語のボタンへ戻り、次の Esc で詳細を閉じる', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const ok = () => Promise.resolve()
      if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { value: ok, configurable: true })
      else Object.defineProperty(navigator, 'clipboard', { value: { writeText: ok }, configurable: true })
    })
    const { editions } = await openTop(page)
    const { newest } = monthOf(editions)
    const topic = newest.topics[FAKE_TOPIC_SCENES.jpRulingParty - 1]
    const detail = await openFromCard(page, cardOf(page, topic.id), topic.id)
    const mark = detail.getByTestId('term-mark').first()
    const box = detail.getByTestId('term-note')

    // ［クリップ］（シートの下の帯・パネルの頭の行。詳細の中身の外）を押した後
    await mark.click()
    await expect(box).toBeVisible()
    await page.getByTestId('topic-clip').click()
    await expect(page.getByText('クリップボードにコピーしました')).toBeVisible()
    await expect(page.getByTestId('topic-clip')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(box).toHaveCount(0)
    await expect(detail).toBeVisible()
    await expect(mark).toBeFocused()

    // 本文の押せない字（小見出し）を押して、フォーカスが body に落ちた後
    await mark.click()
    await expect(box).toBeVisible()
    await detail.locator('h4').first().click()
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(box).toHaveCount(0)
    await expect(detail).toBeVisible()
    await expect(mark).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
  })
})

test.describe('ヘッダーの版の表示 → 版の一覧 → 前の版', { tag: ['@pc', '@s', '@m'] }, () => {
  test('前の版を開くとヘッダーの版の表示がその版に替わり、続報ありの話題から続報へ移れる。［いちばん新しい版へ］で戻る', async ({
    page,
  }) => {
    const { editions } = await openTop(page)
    const { month, newest } = monthOf(editions)
    const label = page.getByTestId('edition-label')
    await expect(label).toHaveText('11/15（日）12:00版')

    await label.click()
    await expect(page).toHaveURL(/#\/editions$/)
    await expect(page.getByTestId('editions-page')).not.toHaveAttribute('aria-busy', 'true')
    // 版の一覧は開いている版を変えない
    await expect(label).toHaveText('11/15（日）12:00版')
    const past = '2026-11-14-20'
    await page.locator(`[data-testid="editions-row"][data-edition-id="${past}"]`).getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`#/e/${past}$`))
    await expect(page.getByTestId('top-edition')).toHaveAttribute('data-edition-id', past)
    await expect(label).toHaveText('11/14（土）20:00版')
    await expect(label).toHaveAttribute('data-edition-id', past)
    await expect(label).toHaveAttribute('aria-label', '11月14日（土）20:00版（版の一覧へ）')
    await expect(page.getByTestId('edition-status')).toHaveAttribute('data-kind', 'past')
    await expect(page.getByTestId('catch-up-band')).toHaveCount(0)

    // 続報の鎖の2本目（この版の話題）には、もっと新しい続報が端末にある
    const [, second, third] = month.scenes.chain
    const card = cardOf(page, second)
    await expect(card.locator('.top-card-meta')).toContainText('続報あり')
    const detail = await openFromCard(page, card, second)
    const newer = detail.getByRole('button', { name: /^この話題には続報があります:/ })
    await expect(newer).toBeVisible()
    await newer.click()
    await expect(detail).toHaveAttribute('data-topic-id', third)
    await closeDetail(page)
    await expect(page).toHaveURL(new RegExp(`#/e/${past}$`))
    // 前の版の話題を開いた既読はその版に付く
    expect((await readOf(page, past))?.topicIds).toContain(second)

    // 前の版を見たまま版の一覧へ行っても、その版のまま
    await label.click()
    await expect(page.getByTestId('editions-page')).not.toHaveAttribute('aria-busy', 'true')
    await expect(label).toHaveText('11/14（土）20:00版')
    await page.goBack()
    await expect(page.getByTestId('top-edition')).toHaveAttribute('data-edition-id', past)

    await page.getByTestId('edition-status').getByRole('link', { name: 'いちばん新しい版へ' }).click()
    await expect(page).toHaveURL(/#\/$/)
    await expect(page.getByTestId('top-edition')).toHaveAttribute('data-edition-id', newest.edition.id)
    await expect(label).toHaveText('11/15（日）12:00版')
    await expect(page.getByTestId('edition-status')).toHaveCount(0)
  })
})

test.describe('追いつきの帯 → 追いつき → 戻る', { tag: ['@pc', '@s', '@m'] }, () => {
  test('帯の［追いつく］で追いつきの画面。カードは真ん中の小さな画面かシートで開き、戻ると帯は消えている', async ({ page }) => {
    await openTop(page, '/', { seen: ['2026-11-13-12'] })
    const band = page.getByTestId('catch-up-band')
    await expect(band).toContainText('見ていない版が 2つあります（11/13（金）20:00版から）')
    await band.getByRole('link', { name: '追いつく' }).click()
    await expect(page).toHaveURL(/#\/catch-up$/)
    const catchUp = page.getByTestId('catch-up-page')
    await expect(catchUp).toHaveAttribute('data-edition-ids', '2026-11-14-20 2026-11-13-20')
    await expect(catchUp).not.toHaveAttribute('aria-busy', 'true')
    // 追いつきの画面でも、ヘッダーはいちばん新しい版
    await expect(page.getByTestId('edition-label')).toHaveText('11/15（日）12:00版')
    // 並べた後に、追いつく版を見たにする
    for (const id of ['2026-11-14-20', '2026-11-13-20'])
      await expect.poll(async () => (await readOf(page, id))?.seen, id).toBe(true)

    const card = catchUp.getByTestId('top-card').first()
    const id = (await card.getAttribute('data-topic-id'))!
    await expect(card.locator('.top-card-meta')).toContainText(/\d+\/\d+（.）\d+:00版/)
    const detail = await openFromCard(page, card, id)
    // 列の無い画面なので、L でも真ん中の小さな画面（side は null）
    await expect(page.locator('.modal.topic-sheet')).toBeVisible()
    await expect(detail).toHaveAttribute('data-mode', 'sheet')
    expect(await sheetInHistory(page)).toEqual({ kind: 'topic', id, side: null })
    await closeDetail(page)
    await expect(card.locator('.top-card-open')).toBeFocused()
    await expect(card).toHaveAttribute('data-read', 'true')

    await page.goBack()
    await expect(page).toHaveURL(/#\/$/)
    await expect(page.getByTestId('top-edition')).toBeVisible()
    await expect(page.getByTestId('top-card').first()).toBeVisible()
    await expect(page.getByTestId('catch-up-band')).toHaveCount(0)
  })
})

test.describe('文字の大きさ', { tag: ['@pc', '@s'] }, () => {
  test('設定で［大］にすると、トップのカードと詳細の字が大きくなり、ヘッダーの字は替わらない。［小］で小さくなる', async ({
    page,
  }) => {
    const { editions } = await openTop(page)
    const { newest } = monthOf(editions)
    const topic = newest.topics.find((t) => t.region === 'jp' && !t.major)!
    const card = cardOf(page, topic.id)
    const size = (l: Locator) => l.evaluate((e) => getComputedStyle(e).fontSize)
    expect([await size(card.locator('.top-card-head')), await size(card.locator('.top-card-summary'))]).toEqual(['17px', '16px'])
    const labelSize = await size(page.getByTestId('edition-label'))

    await viaSettings(page, async () => {
      await page.getByTestId('text-size-l').click()
      await expect(page.locator('html')).toHaveAttribute('data-text-size', 'l')
    })
    expect([await size(card.locator('.top-card-head')), await size(card.locator('.top-card-summary'))]).toEqual(['19px', '18px'])
    expect(await size(page.getByTestId('edition-label'))).toBe(labelSize)
    const detail = await openFromCard(page, card, topic.id)
    expect([await size(detail), await size(detail.locator('.topic-title'))]).toEqual(['18px', '22px'])
    await closeDetail(page)

    await viaSettings(page, async () => {
      await page.getByTestId('text-size-s').click()
      await expect(page.locator('html')).toHaveAttribute('data-text-size', 's')
    })
    expect([await size(card.locator('.top-card-head')), await size(card.locator('.top-card-summary'))]).toEqual(['16px', '15px'])
    expect(await size(page.getByTestId('edition-label'))).toBe(labelSize)
  })
})

test.describe('「知ってる」', { tag: ['@pc', '@s', '@m'] }, () => {
  test('詳細で［知ってる］にした語は次から出ない。設定の一覧で［戻す］と、次に開いた詳細にまた出る', async ({ page }) => {
    const { editions } = await openTop(page)
    const { newest } = monthOf(editions)
    const topic = newest.topics[FAKE_TOPIC_SCENES.jpRulingParty - 1]
    const card = cardOf(page, topic.id)
    let detail = await openFromCard(page, card, topic.id)
    const termId = (await detail.getByTestId('term-mark').first().getAttribute('data-term-id'))!
    const term = topic.terms.find((t) => t.termId === termId)!
    const row = () => page.locator(`.topic-term[data-term-id="${termId}"]`)
    const mark = () => page.locator(`[data-testid="term-mark"][data-term-id="${termId}"]`)
    await row().getByTestId('term-known').click()
    await expect(row()).toContainText('知ってるにしました')
    await closeDetail(page)
    await expect.poll(() => knownRecord(page, termId)).toMatchObject({ on: true })

    detail = await openFromCard(page, card, topic.id)
    await expect(mark()).toHaveCount(0)
    await expect(row()).toHaveCount(0)
    await closeDetail(page)

    await viaSettings(page, async () => {
      const list = page.getByTestId('known-terms')
      const item = list.locator(`[data-term-id="${termId}"]`)
      await expect(item).toContainText(term.term)
      await item.getByRole('button', { name: `「${term.term}」を戻す` }).click()
      await expect(item).toHaveCount(0)
      await expect(list.getByTestId('known-terms-empty')).toHaveText('まだありません')
    })
    await expect.poll(() => knownRecord(page, termId)).toMatchObject({ on: false })

    // 開いた話題は既読なので、トップを出し直すと「既読 1件」に沈んでいる
    await unfold(page, isWide(page) ? 'jp' : 'all')
    detail = await openFromCard(page, card, topic.id)
    await expect(mark()).toHaveCount(1)
    await expect(row().getByTestId('term-known')).toBeVisible()
  })

  test('時期で変わる語: 古い説明の話題で［知ってる］にした後、新しい説明の話題で［知ってる］→［取り消す］しても、古い話題には語が出ないまま', async ({
    page,
  }) => {
    const { editions } = await openTop(page)
    const { month, newest } = monthOf(editions)
    const { termId, asOfBefore, asOfAfter, changedIn } = month.scenes.changingTerm
    const oldEdition = month.editions[0]
    expect(oldEdition.edition.id < changedIn).toBe(true)
    const oldTopic = oldEdition.topics[FAKE_TOPIC_SCENES.jpRulingParty - 1]
    const newTopic = newest.topics[FAKE_TOPIC_SCENES.jpRulingParty - 1]
    expect(oldTopic.terms.find((t) => t.termId === termId)?.asOf).toBe(asOfBefore)
    expect(newTopic.terms.find((t) => t.termId === termId)?.asOf).toBe(asOfAfter)
    const row = () => page.locator(`.topic-term[data-term-id="${termId}"]`)

    // 古い版（前の版）の話題で［知ってる］→ 閉じると、古い説明の時点で書く
    await page.getByTestId('edition-label').click()
    await page.locator(`[data-testid="editions-row"][data-edition-id="${oldEdition.edition.id}"]`).getByRole('link').click()
    await expect(page.getByTestId('top-edition')).toHaveAttribute('data-edition-id', oldEdition.edition.id)
    await openFromCard(page, cardOf(page, oldTopic.id), oldTopic.id)
    await row().getByTestId('term-known').click()
    await closeDetail(page)
    await expect.poll(() => knownRecord(page, termId)).toMatchObject({ on: true, asOf: asOfBefore })
    const before = await knownRecord(page, termId)

    // いちばん新しい版の話題（新しい説明）では、語がもう一度出る。［知ってる］→［取り消す］→ 閉じても、記録は押す前のまま
    await page.getByTestId('edition-status').getByRole('link', { name: 'いちばん新しい版へ' }).click()
    await expect(page.getByTestId('top-edition')).toHaveAttribute('data-edition-id', newest.edition.id)
    await openFromCard(page, cardOf(page, newTopic.id), newTopic.id)
    await row().getByTestId('term-known').click()
    await row().getByRole('button', { name: '取り消す' }).click()
    await expect(row().getByTestId('term-known')).toBeVisible()
    await closeDetail(page)
    // 書く時（閉じた時）を過ぎても変わらない
    await page.waitForTimeout(500)
    expect(await knownRecord(page, termId)).toEqual(before)

    // 古い話題を開き直しても、語は出ない（押す前と同じ）
    expect(await page.evaluate((id) => window.__ts.openTopic(id), oldTopic.id)).toBe(true)
    const detail = page.getByTestId('topic-detail')
    await expect(detail).toHaveAttribute('data-topic-id', oldTopic.id)
    await expect(detail.locator('.topic-title')).toHaveText(oldTopic.headline)
    await expect(row()).toHaveCount(0)
    await expect(detail.locator(`[data-testid="term-mark"][data-term-id="${termId}"]`)).toHaveCount(0)
    await closeDetail(page)
  })
})
