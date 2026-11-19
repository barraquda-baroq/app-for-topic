// トップの状態の1行の E2E（docs/SPEC.md の 4.7・7.2・7.8・16.6 の 57。設計: 段階2の 1.7・4.2）。時刻を決めて（e2e/helpers.ts の openTop）、
// 作り物の版の場面（extras・withholdNewest・onlyNewest。src/features/login/testAuth.ts）で開く:
// - 作れなかった（20:40・failsNext）→「20:00版は作れませんでした（使用量の上限）」
// - まだ届いていない（20:40。枠の30分後から。20:20 はまだ出さない）→「20:00版はまだ届いていません」
// - 待っている（withholdNewest）→「11/15（日）12:00版を受け取っています…」
// - いちばん新しい枠が新しい形の記録（newerEdition）→「12:00版は新しい形の記録です（アプリを更新してください）」
// - 版が無い時（top-empty）と、出せる版が無く待つ時（onlyNewest＋withholdNewest: 20。top-waiting）は1行を出さない
// - 版の記録が新しい形の物だけ（onlyNewest＋newerEdition。出せる版が無い）の時は「まだ版はありません」を出さず、1行で新しい形の記録と言う
// - 同期の表示が null・offline の時は「まだ届いていません」を出さない（落ち着いてから出す）
import { expect, test } from '@playwright/test'
import { collectDiagnosticsOnFailure, openTop, setSyncView } from './helpers'

collectDiagnosticsOnFailure()

/** 2026-11-15（日）20:40 日本時間（いちばん新しい枠は 20:00。その枠の30分後より後） */
const LATE = '2026-11-15T20:40:00+09:00'
/** いちばん新しい版を 11/15 12:00版にする（20:00 の枠には版を作らない） */
const UNTIL_NOON = { until: '2026-11-15', untilSlot: '12' } as const

test.describe('トップの状態の1行', { tag: ['@s'] }, () => {
  test('いちばん新しい枠が作れなかった時は「20:00版は作れませんでした（使用量の上限）」（前の版を出したまま）', async ({
    page,
  }) => {
    await openTop(page, '/', { now: LATE, editions: { ...UNTIL_NOON, extras: ['failsNext'] } })
    const status = page.getByTestId('edition-status')
    await expect(status).toHaveText('20:00版は作れませんでした（使用量の上限）')
    await expect(status).toHaveAttribute('data-kind', 'failed')
    await expect(status).not.toHaveAttribute('role', /.+/)
    await expect(page.getByTestId('top-edition')).toHaveAttribute('data-edition-id', '2026-11-15-12')
  })

  test('枠の30分後から、版も印も無ければ「20:00版はまだ届いていません」（20:20 はまだ出さない）', async ({ page }) => {
    await openTop(page, '/', { now: '2026-11-15T20:20:00+09:00', editions: UNTIL_NOON })
    await expect(page.getByTestId('top-card').first()).toBeVisible()
    await expect(page.getByTestId('edition-status')).toHaveCount(0)
    await openTop(page, '/', { now: LATE, editions: UNTIL_NOON })
    const status = page.getByTestId('edition-status')
    await expect(status).toHaveText('20:00版はまだ届いていません')
    await expect(status).toHaveAttribute('data-kind', 'not-arrived')
  })

  test('同期の表示がまだ分からない（null）・オフラインの間は「まだ届いていません」を出さず、落ち着いてから出す', async ({
    page,
  }) => {
    await openTop(page, '/', { now: LATE, editions: UNTIL_NOON, sync: null })
    await expect(page.getByTestId('top-card').first()).toBeVisible()
    await expect(page.getByTestId('edition-status')).toHaveCount(0)
    await setSyncView(page, 'offline')
    await expect(page.getByTestId('edition-status')).toHaveCount(0)
    await setSyncView(page, 'downloading')
    await expect(page.getByTestId('edition-status')).toHaveCount(0)
    await setSyncView(page, 'pending')
    await expect(page.getByTestId('edition-status')).toHaveText('20:00版はまだ届いていません')
  })

  test('いちばん新しい版の話題がそろうのを待っている時は「11/15（日）12:00版を受け取っています…」（前の版を出したまま）', async ({
    page,
  }) => {
    await openTop(page, '/', { editions: { withholdNewest: 3 }, expect: 'shown' })
    await expect(page.getByTestId('top-edition')).toHaveAttribute('data-edition-id', '2026-11-14-20')
    const status = page.getByTestId('edition-status')
    await expect(status).toHaveText('11/15（日）12:00版を受け取っています…')
    await expect(status).toHaveAttribute('data-kind', 'waiting')
  })

  test('いちばん新しい枠の版が新しい形の記録の時は「12:00版は新しい形の記録です（アプリを更新してください）」', async ({
    page,
  }) => {
    await openTop(page, '/', { editions: { extras: ['newerEdition'] }, expect: 'shown' })
    await expect(page.getByTestId('top-edition')).toHaveAttribute('data-edition-id', '2026-11-14-20')
    const status = page.getByTestId('edition-status')
    await expect(status).toHaveText('12:00版は新しい形の記録です（アプリを更新してください）')
    await expect(status).toHaveAttribute('data-kind', 'newer')
  })

  test('版が1つも無い時は「まだ版はありません」だけで、1行を出さない', async ({ page }) => {
    await openTop(page, '/', { now: LATE, editions: null })
    await expect(page.getByTestId('top-empty')).toBeVisible()
    await expect(page.getByTestId('edition-status')).toHaveCount(0)
    await expect(page.getByTestId('catch-up-band')).toHaveCount(0)
  })

  // 設計: 段階2の 1.7 の 0. が1行を出さないのは、版の記録が1つも無い時と待っている時だけ。新しい形の版の記録が届いていれば、
  // 「まだ版はありません」「ここに届きます」と事実と違う事を言わず、アプリの更新が要る事を言う（1.7 の 3.・1.21）
  test('版の記録が新しい形の物だけの時は「まだ版はありません」を出さず「12:00版は新しい形の記録です（アプリを更新してください）」', async ({
    page,
  }) => {
    await openTop(page, '/', {
      editions: { ...UNTIL_NOON, onlyNewest: true, extras: ['newerEdition'] },
      expect: { testId: 'edition-status' },
    })
    const status = page.getByTestId('edition-status')
    await expect(status).toHaveText('12:00版は新しい形の記録です（アプリを更新してください）')
    await expect(status).toHaveAttribute('data-kind', 'newer')
    await expect(page.getByTestId('top-empty')).toHaveCount(0)
    await expect(page.getByTestId('top-waiting')).toHaveCount(0)
    await expect(page.getByTestId('top-edition')).toHaveCount(0)
  })

  test('出せる版が1つも無く待っている時は「版を受け取っています…」だけで、1行を出さない', async ({ page }) => {
    await openTop(page, '/', { now: LATE, editions: { ...UNTIL_NOON, onlyNewest: true, withholdNewest: 20 }, expect: 'waiting' })
    await expect(page.getByTestId('top-waiting')).toHaveText('版を受け取っています…')
    await expect(page.getByTestId('edition-status')).toHaveCount(0)
    await expect(page.getByTestId('top-empty')).toHaveCount(0)
  })
})
