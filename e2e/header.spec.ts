// ヘッダー・同期の表示・設定の E2E（docs/SPEC.md の 7.8・9.・14.5。設計: 段階2の 1.2・1.13・1.18・1.19・1.23・4.2）。
// 時刻・作り物の版・同期の表示を決めて開く（e2e/helpers.ts の openTop。同期の表示はページの中で useSyncView.setState）:
// - ヘッダーの版の表示「11/15（日）12:00版」（トップがどの形でも opened から出る）・押すと #/editions・版が無い時は出さない
// - 同期の表示の8つの言葉と色の段・止まっている時は斜線の雲・同期できない理由の言葉・role="status" が無い（M・L はアイコンと字）
// - S はアイコンだけのボタンで、押すと小窓に詳しい言葉（Esc・外を押すと閉じる）
// - 設定の文字の大きさ（<html data-text-size> と --read-size）・「知ってる」にした語の一覧（__ts.know で付けて［戻す］）
// - 幅 360px・600px でヘッダーがはみ出さない（S は名前を出さず、版の表示を出す）
// 詳細の中身・前の版の表示・設定の一覧と詳細のつなぎは、ほかの塊の E2E（e2e/topic.spec.ts・e2e/flows.spec.ts）
import { expect, test, type Page } from '@playwright/test'
import type { SyncView } from '../src/sync/syncView'
import { collectDiagnosticsOnFailure, noHorizontalScroll, openTop, setSyncView, tapSize } from './helpers'

collectDiagnosticsOnFailure()

/** 8つの状態（docs/SPEC.md の 7.8）と、出す言葉・色の段（src/sync/syncView.ts の syncLabel・syncTone のまま） */
const STATES: [SyncView, string, 'ok' | 'busy' | 'warn'][] = [
  [{ kind: 'synced' }, '同期済み', 'ok'],
  [{ kind: 'sending' }, '送信中…', 'busy'],
  [{ kind: 'pending', count: 2 }, '未送信 2件', 'busy'],
  [{ kind: 'downloading' }, '受け取り中…', 'busy'],
  [{ kind: 'offline' }, 'オフライン（端末に保存しています）', 'warn'],
  [{ kind: 'quota', resumeAt: '17:00' }, '今日の無料枠を使い切りました（17:00 ごろに戻ります）', 'warn'],
  [{ kind: 'outdated' }, '要更新（アプリを更新してください）', 'warn'],
  [{ kind: 'error', reason: '不明なエラー' }, '同期できません（不明なエラー）', 'warn'],
]

/** 同期できない理由の言葉（src/sync/syncView.ts の shortReason。エンジンの errorCode から決まる） */
const REASONS = [
  '持ち主の記録がまだありません',
  'このアカウントは持ち主ではありません',
  '前に別のアカウントで同期した端末です',
  'アクセスが拒否されました',
  'ログインし直してください',
  'クラウドの索引がまだありません',
]

/** 同期の表示の雲の線の数（雲は1本、止まっている時の斜線の雲は2本。src/ui/icons.tsx の CloudIcon・CloudOffIcon） */
async function cloudPaths(page: Page): Promise<number> {
  return page.getByTestId('sync-indicator').locator('svg.icon path').count()
}

/** ヘッダーの中の物が、ヘッダーと画面の右端からはみ出していない */
async function headerFits(page: Page): Promise<void> {
  await noHorizontalScroll(page)
  const width = page.viewportSize()?.width ?? 0
  const header = page.getByTestId('app-header')
  for (const id of ['brand', 'edition-label', 'sync-indicator', 'open-settings']) {
    const box = await header.getByTestId(id).boundingBox()
    expect(box, id).not.toBeNull()
    expect((box?.x ?? 0) + (box?.width ?? 0), id).toBeLessThanOrEqual(width)
    expect(box?.x ?? -1, id).toBeGreaterThanOrEqual(0)
  }
}

test.describe('ヘッダーの版の表示', { tag: ['@pc', '@s'] }, () => {
  test('出している版の名前「11/15（日）12:00版」を名前の右に出し、押すと版の一覧（#/editions）へ', async ({ page }) => {
    const { newestEditionId } = await openTop(page)
    const header = page.getByTestId('app-header')
    const label = header.getByTestId('edition-label')
    await expect(label).toHaveText('11/15（日）12:00版')
    await expect(label).toHaveAttribute('aria-label', '11月15日（日）12:00版（版の一覧へ）')
    await expect(label).toHaveAttribute('data-edition-id', newestEditionId ?? '')
    await tapSize(label, '版の表示')
    // アイコン（と名前）の右、歯車の左
    const brand = await header.getByTestId('brand').boundingBox()
    const box = await label.boundingBox()
    const gear = await header.getByTestId('open-settings').boundingBox()
    expect(brand && box && brand.x + brand.width <= box.x).toBe(true)
    expect(box && gear && box.x + box.width <= gear.x).toBe(true)

    await label.click()
    await expect(page).toHaveURL(/#\/editions$/)
    await expect(page.getByTestId('editions-page')).toBeVisible()
    // 版の一覧の画面でも、開いている版の名前を出したまま
    await expect(page.getByTestId('edition-label')).toHaveText('11/15（日）12:00版')
  })

  test('版が1つも無い時（まだ版はありません）は出さない', async ({ page }) => {
    await openTop(page, '/', { editions: null })
    await expect(page.getByTestId('top-empty')).toBeVisible()
    await expect(page.getByTestId('edition-label')).toHaveCount(0)
  })
})

test.describe('ヘッダーの同期の表示（M・L はアイコンと字）', { tag: ['@pc'] }, () => {
  test('8つの状態の言葉と色の段。止まっている時は斜線の雲。読み上げの live region（role="status"）にしない', async ({ page }) => {
    await openTop(page)
    const el = page.getByTestId('sync-indicator')
    for (const [view, label, tone] of STATES) {
      await setSyncView(page, view)
      await expect(el).toHaveText(`同期: ${label}`)
      await expect(el).toHaveAttribute('title', label)
      await expect(el).toHaveAttribute('data-tone', tone)
      await expect(el.locator('svg.icon')).toBeVisible()
      expect(await cloudPaths(page), view.kind).toBe(tone === 'warn' ? 2 : 1)
      // 字は見える所に出す（読み上げだけの「同期: 」の他に）
      await expect(el.locator('.sync-indicator-text')).toBeVisible()
      await expect(el).not.toHaveAttribute('role', /.+/)
      await expect(page.getByTestId('app-header').locator('[role="status"]')).toHaveCount(0)
      // 押せる物にしない（設定に「同期」の区切りは無い）
      expect(await el.evaluate((e) => e.tagName)).toBe('SPAN')
    }
    // 色の段: そろっている・動いている・止まっている で字の色が違う
    const colors: string[] = []
    for (const kind of ['synced', 'pending', 'offline'] as const) {
      await setSyncView(page, kind)
      await expect(el).toHaveAttribute('data-tone', kind === 'synced' ? 'ok' : kind === 'pending' ? 'busy' : 'warn')
      colors.push(await el.evaluate((e) => getComputedStyle(e).color))
    }
    expect(new Set(colors).size).toBe(3)
  })

  test('同期できない理由の言葉（持ち主の記録・持ち主でない・別のアカウントの端末・拒否・ログインし直し・索引）', async ({
    page,
  }) => {
    await openTop(page)
    const el = page.getByTestId('sync-indicator')
    for (const reason of REASONS) {
      await setSyncView(page, { kind: 'error', reason })
      await expect(el).toHaveText(`同期: 同期できません（${reason}）`)
      await expect(el).toHaveAttribute('data-tone', 'warn')
    }
  })

  test('同期を始めるまで（状態がまだ分からない）は何も出さない', async ({ page }) => {
    await openTop(page, '/', { sync: null })
    await expect(page.getByTestId('top-edition')).toBeVisible()
    await expect(page.getByTestId('sync-indicator')).toHaveCount(0)
    await setSyncView(page, 'downloading')
    await expect(page.getByTestId('sync-indicator')).toHaveText('同期: 受け取り中…')
  })
})

test.describe('ヘッダーの同期の表示（S はアイコンだけ）', { tag: ['@s'] }, () => {
  test('アイコンだけのボタンで、押すと小窓に詳しい言葉。Esc で閉じてボタンへフォーカスを戻し、外を押しても閉じる', async ({
    page,
  }) => {
    await openTop(page, '/', { sync: 'quota' })
    const full = '今日の無料枠を使い切りました（17:00 ごろに戻ります）'
    const button = page.getByTestId('sync-indicator')
    await expect(button).toHaveText('')
    await expect(button).toHaveAttribute('aria-label', `同期: ${full}`)
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(button).toHaveAttribute('data-tone', 'warn')
    expect(await cloudPaths(page)).toBe(2)
    await expect(button).not.toHaveAttribute('role', /.+/)
    await expect(page.getByTestId('app-header').locator('[role="status"]')).toHaveCount(0)
    await tapSize(button, '同期の表示')

    await button.click()
    const popup = page.getByTestId('sync-popup')
    await expect(popup).toBeVisible()
    await expect(popup.getByTestId('sync-popup-detail')).toHaveText(full)
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    // 小窓は画面の中に収まる（長い言葉は折り返す）
    const box = await popup.boundingBox()
    const width = page.viewportSize()?.width ?? 0
    expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true)
    await noHorizontalScroll(page)

    await page.keyboard.press('Escape')
    await expect(popup).toHaveCount(0)
    await expect(button).toBeFocused()

    // 開いている間に状態が替わると、小窓の言葉も替わる
    await button.click()
    await setSyncView(page, 'synced')
    await expect(page.getByTestId('sync-popup-detail')).toHaveText('同期済み')
    await expect(button).toHaveAttribute('data-tone', 'ok')
    expect(await cloudPaths(page)).toBe(1)
    // 外（ヘッダーの空き。版の表示と同期の表示の間）を押すと閉じる
    const spacer = await page.getByTestId('app-header').locator('.spacer').boundingBox()
    const header = await page.getByTestId('app-header').boundingBox()
    expect(spacer && header && spacer.width > 10).toBe(true)
    if (spacer && header) await page.mouse.click(spacer.x + spacer.width / 2, header.y + header.height / 2)
    await expect(page.getByTestId('sync-popup')).toHaveCount(0)
    await expect(button).toHaveAttribute('aria-expanded', 'false')
  })
})

test.describe('設定の文字の大きさ', { tag: ['@pc', '@s'] }, () => {
  test('［小｜中｜大］で <html data-text-size> と記事の字の大きさ（--read-size）が替わり、この端末に保存する', async ({
    page,
  }) => {
    await openTop(page, '/settings', { expect: { testId: 'app-settings' } })
    const group = page.getByTestId('text-size')
    await expect(group.getByRole('button')).toHaveText(['小', '中', '大'])
    await expect(page.getByTestId('text-size-m')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'm')
    const readSize = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--read-size').trim())
    expect(await readSize()).toBe('16px')
    // 設定・ボタン・ヘッダーの字は、記事の字の大きさで変えない（設計: 段階2の 1.18）
    const uiSizes = () =>
      Promise.all(
        [page.getByTestId('text-size-m'), page.getByTestId('settings-back'), page.getByTestId('edition-label')].map((l) =>
          l.evaluate((e) => getComputedStyle(e).fontSize),
        ),
      )
    const before = await uiSizes()
    for (const [value, size] of [
      ['l', '18px'],
      ['s', '15px'],
      ['m', '16px'],
    ] as const) {
      await page.getByTestId(`text-size-${value}`).click()
      await expect(page.locator('html')).toHaveAttribute('data-text-size', value)
      await expect(page.getByTestId(`text-size-${value}`)).toHaveAttribute('aria-pressed', 'true')
      expect(await readSize()).toBe(size)
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('topic-studio:prefs') ?? 'null'))
      expect(saved).toMatchObject({ v: 1, textSize: value })
    }
    await page.getByTestId('text-size-l').click()
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'l')
    expect(await uiSizes()).toEqual(before)
    await noHorizontalScroll(page)
  })

  test('保存した大きさで開き直すと、設定の画面で［大］が押された状態', async ({ page }) => {
    await openTop(page, '/settings', { expect: { testId: 'app-settings' }, textSize: 'l' })
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'l')
    await expect(page.getByTestId('text-size-l')).toHaveAttribute('aria-pressed', 'true')
  })

  // アプリが動いた後は src/ui/Layout.tsx の PrefsEffect も同じ属性を入れるので、アプリの入口（/src/main.tsx）を読ませずに開き、
  // index.html に埋め込んだ起動の処理（src/launch/launch.js の boot()）だけで入る事を見る（字が一瞬 中 → 大 と跳ばない。
  // 設計: 段階2の 1.1 の「boot() も最初の描画の前に同じ物を入れる」・1.18）
  test('保存した大きさは、アプリが動く前（起動の埋め込みだけ）で <html data-text-size> に入る', async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem(
        'topic-studio:prefs',
        JSON.stringify({ v: 1, appearance: 'white', launchAnimation: false, textSize: 'l' }),
      ),
    )
    await page.route(/\/src\/main\.tsx/, (route) => route.abort())
    await page.goto('/#/')
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'l')
    // アプリは動いていない（PrefsEffect が入れた物ではない）
    expect(await page.evaluate(() => typeof window.__ts)).toBe('undefined')
  })
})

test.describe('設定の「知ってる」にした語', { tag: ['@pc', '@s'] }, () => {
  test('「知ってる」にした語が並び、［戻す］で外す（記録は on: false で残る）。0語なら「まだありません」', async ({
    page,
    isMobile,
  }) => {
    await openTop(page)
    // 開いている版の話題の用語を1つ選んで「知ってる」にする（開発用のフック。画面の［知ってる］は詳細の塊）
    const term = await page.evaluate(async (file) => {
      const m = (await import(/* @vite-ignore */ file)) as typeof import('../src/store/appStore')
      const view = m.useApp.getState().opened.view
      const t = view?.kind === 'ready' ? view.topics.flatMap((x) => x.terms)[0] : undefined
      return t ? { termId: t.termId, term: t.term } : null
    }, '/src/store/appStore.ts')
    expect(term).not.toBeNull()
    if (!term) return
    expect(await page.evaluate((id) => window.__ts.know(id).ok, term.termId)).toBe(true)

    await page.getByTestId('open-settings').click()
    const section = page.getByTestId('known-terms')
    await expect(section).toBeVisible()
    await expect(section.getByRole('heading', { name: '「知ってる」にした語' })).toBeVisible()
    const row = section.locator(`li[data-term-id="${term.termId}"]`)
    await expect(row).toContainText(term.term)
    const undo = row.getByRole('button', { name: `「${term.term}」を戻す` })
    // 指で操作する端末では押せる所を 34px 以上に（PC のマウスでは .btn-sm の 30px。e2e/frame.spec.ts と同じ）
    if (isMobile) await tapSize(undo, '［戻す］', false)
    await undo.click()
    await expect(row).toHaveCount(0)
    await expect(section.getByTestId('known-terms-empty')).toHaveText('まだありません')
    const on = await page.evaluate(
      async ({ file, id }) => {
        const m = (await import(/* @vite-ignore */ file)) as typeof import('../src/store/appStore')
        return m.useApp.getState().user.knownTerms[id]?.on
      },
      { file: '/src/store/appStore.ts', id: term.termId },
    )
    expect(on).toBe(false)
    await noHorizontalScroll(page)
  })
})

test.describe('狭い幅のヘッダー', { tag: ['@pc', '@s'] }, () => {
  test('幅 360px でもヘッダーがはみ出さない（名前を出さず、アイコン・版の表示・同期・歯車）。600px は名前も出し、長い同期の言葉は省く', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 })
    await openTop(page, '/', { sync: 'quota' })
    const header = page.getByTestId('app-header')
    await expect(header.locator('.brand-name')).toBeHidden()
    await expect(header.getByTestId('edition-label')).toBeVisible()
    await headerFits(page)
    await tapSize(header.getByTestId('sync-indicator'), '同期の表示')
    await tapSize(header.getByTestId('open-settings'), '設定の歯車')

    await page.setViewportSize({ width: 599, height: 740 })
    await expect(header.locator('.brand-name')).toBeHidden()
    await headerFits(page)

    // M（600px から）: 名前・版の表示・同期の字が並ぶ。長い言葉は「…」で省き、全文は title
    await page.setViewportSize({ width: 600, height: 740 })
    await expect(header.locator('.brand-name')).toBeVisible()
    const text = header.getByTestId('sync-indicator').locator('.sync-indicator-text')
    await expect(text).toBeVisible()
    await headerFits(page)
    await expect(header.getByTestId('sync-indicator')).toHaveAttribute(
      'title',
      '今日の無料枠を使い切りました（17:00 ごろに戻ります）',
    )
  })
})
