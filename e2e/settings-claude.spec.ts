// 設定の「Claude との連携」と連携の画面（#/claude/connect）の E2E（段階3の設計の 3.1・7. の「E2E（Firebase なし）」）。Firebase 無しで、
// テスト用のログインの印（localStorage の topic-studio:test-auth）で開く。テストの印の時は、連携の状態を読まず、連携の画面もクラウドと
// コネクタに問い合わせない（テストからネットへ出ない）。コネクタの場所（__CONNECTOR_ORIGIN__）は開発サーバーのビルドの時に決まる
// （connector.local.json か VITE_CONNECTOR_ORIGIN。CI には無いので「まだ用意されていません」。手元で用意してあれば URL とコピー）。
// 連携の流れの全部（接続 → 同意 → 許可 → トークン → 道具）は、エミュレーターとコネクタの Worker を使う e2e/pairing.sync.spec.ts（B8）
import { expect, test, type Page } from '@playwright/test'
import { CLAUDE_CAN, CLAUDE_CANNOT, CLAUDE_TOOLS, TOOL_ALLOW_NOTES } from '../src/features/claude/claudeUi'
import { collectDiagnosticsOnFailure, noHorizontalScroll } from './helpers'

collectDiagnosticsOnFailure()

const TEST_AUTH_KEY = 'topic-studio:test-auth'

/** テスト用のログインの印を置いて、その行き先を開く（Firebase は使わない） */
async function openSignedIn(page: Page, hash: string) {
  await page.addInitScript((key) => localStorage.setItem(key, '1'), TEST_AUTH_KEY)
  await page.goto(`/#${hash}`)
}

test.describe('設定の「Claude との連携」（Firebase 無し）', { tag: ['@pc', '@s'] }, () => {
  test('コネクタの URL（無ければ「まだ用意されていません」）・手順書・できる事とできない事・ツールの許可の案内。横にはみ出さない', async ({
    page,
  }) => {
    await openSignedIn(page, '/settings')
    const claude = page.getByTestId('claude-settings')
    await expect(claude).toBeVisible()
    await expect(claude.getByRole('heading', { level: 2 })).toHaveText('Claude との連携')
    // 「『知ってる』にした語」の下、「アカウント」の上
    const order = await page
      .getByTestId('app-settings')
      .locator(':scope > section')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
    expect(order.indexOf('claude-settings')).toBe(order.indexOf('known-terms') + 1)
    expect(order.indexOf('account-settings')).toBe(order.indexOf('claude-settings') + 1)

    const url = claude.getByTestId('claude-connector-url')
    if (await url.count()) {
      await expect(url).toHaveText(/^https?:\/\/[^/]+\/mcp$/)
      await expect(claude.getByTestId('claude-copy-url')).toBeVisible()
    } else {
      await expect(claude.getByTestId('claude-connector-unset')).toHaveText(
        'コネクタはまだ用意されていません（docs/CONNECTOR.md）',
      )
      await expect(claude.getByTestId('claude-copy-url')).toHaveCount(0)
    }
    const guide = claude.getByTestId('claude-guide')
    await expect(guide).toHaveAttribute('href', /\/docs\/CONNECTOR\.md$/)
    await expect(guide).toHaveAttribute('target', '_blank')
    await expect(guide).toHaveAttribute('rel', 'noopener noreferrer')

    // テストの印でログインした時は、連携の状態を読まない（クラウドに問い合わせない）
    await expect(claude.getByTestId('claude-pairing-test')).toHaveText('テスト用のログインでは、連携の状態を読みません。')

    await expect(claude.getByTestId('claude-can').locator('li')).toHaveText([...CLAUDE_CAN])
    await expect(claude.getByTestId('claude-cannot').locator('li')).toHaveText([...CLAUDE_CANNOT])
    const tools = claude.getByTestId('claude-tools')
    await expect(tools).toContainText('claude.ai のツールの許可は、全部「常に許可」にします')
    for (const note of TOOL_ALLOW_NOTES) await expect(tools).toContainText(note)
    // ツールの名前は畳んである。開くと全部が出る
    const names = tools.getByTestId('claude-tools-names')
    await expect(names).toBeHidden()
    await tools.locator('summary').click()
    await expect(names.locator('li')).toHaveText(CLAUDE_TOOLS.map((t) => `${t.name}（${t.title}）`))
    await noHorizontalScroll(page)
  })
})

test.describe('連携の画面（Firebase 無し）', { tag: ['@pc', '@s'] }, () => {
  test('連携の画面は、コネクタの場所がビルドに無ければ「コネクタ未設定」、テストの印ではクラウドに問い合わせない', async ({
    page,
  }) => {
    await openSignedIn(page, '/claude/connect?s=e2e-state-0123')
    const connect = page.getByTestId('connect-page')
    await expect(connect).toBeVisible()
    await expect(connect.getByRole('heading', { level: 1 })).toHaveText('Claude（claude.ai）との連携')
    await expect(page).toHaveTitle('Claude との連携 — Topic Studio')
    await expect(page.getByTestId('app-header')).toBeVisible()
    const unconfigured = page.getByTestId('connect-unconfigured')
    const testAuth = page.getByTestId('connect-test-auth')
    await expect(unconfigured.or(testAuth)).toBeVisible()
    if (await unconfigured.count()) await expect(unconfigured).toContainText('コネクタ未設定')
    // ［許可する］は出ない（連携の記録を書かない）
    await expect(page.getByTestId('connect-approve')).toHaveCount(0)
    await noHorizontalScroll(page)
  })

  test('ログインしていないブラウザで開くとログインの画面へ移り、ログインした後に連携の画面（同じ印）へ戻る', async ({ page }) => {
    await page.goto('/#/claude/connect?s=e2e-state-0123')
    await expect(page.getByTestId('login-page')).toBeVisible()
    await expect(page).toHaveURL(/#\/login$/)
    // テスト用のログイン（クラウドに問い合わせないように、テストの印も置く）
    await page.waitForFunction(() => Boolean(window.__ts))
    await page.evaluate((key) => {
      localStorage.setItem(key, '1')
      return window.__ts.fakeSignIn()
    }, TEST_AUTH_KEY)
    await expect(page.getByTestId('connect-page')).toBeVisible()
    await expect(page).toHaveURL(/#\/claude\/connect\?s=e2e-state-0123$/)
    // 戻した後は覚えを消す（次のログインはトップへ）
    expect(await page.evaluate(() => sessionStorage.getItem('topic-studio:connect-return'))).toBeNull()
  })
})
