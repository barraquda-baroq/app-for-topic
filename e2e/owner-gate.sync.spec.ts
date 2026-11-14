// 持ち主の関所の E2E（docs/SPEC.md の 14.4・14.7。DS の e2e/owner-gate.sync.spec.ts から、段階0の形にした物）。Firebase エミュレーターに
// つないだ開発サーバー（playwright.sync.config.ts。npm run test:e2e:sync）で、本番と同じに持ち主を確かめさせて（VITE_E2E_OWNER_LOCK=1。
// 開発サーバーだけ）動かす。持ち主の記録 config/owner はテストが管理者の権限で作る（作者が Firebase の画面で作るのと同じ。
// アプリからは作れない）。段階0には端末のデータが無いので、「出ない」ことは、トップ・設定の画面とヘッダーが一度も描かれないことで確かめる。
// - 作者の段階0の流れ: 記録が無い間は「持ち主の記録がまだありません（docs/DEPLOY.md の 3）」と［ログアウト］だけ。作者が記録を作って
//   アプリの窓を選ぶと、読み込み直さずにトップが出る。次は電波が無くてもトップが開く
// - 別のアカウントでログインすると「このアカウントは Topic Studio の持ち主ではありません」と［ログアウト］だけ
// - まだ持ち主だと確かめていないアカウントは、電波が無い間は「ネットにつながっていません。…」のまま。つながると確かめ直す
// アカウントは作り物だけ（テストの回ごとに名前を替える）
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { adminCreateOwner, adminGoogleUser, clearFirestore, useRules } from '../src/test/emulatorAdmin'
import { signInSync, syncDevice } from './helpers'

const MISSING = '持ち主の記録がまだありません（docs/DEPLOY.md の 3）'
const MISMATCH = 'このアカウントは Topic Studio の持ち主ではありません'
const OFFLINE = 'ネットにつながっていません。最初の1回はネットにつないでログインしてください。'

test.beforeAll(async () => {
  await useRules(readFileSync('firestore.rules', 'utf8'))
})

test.beforeEach(async () => {
  // 持ち主の記録は1つだけなので、テストごとに消してから始める
  await clearFirestore()
})

// 端末に見立てて開いた文脈（syncDevice）は、テストごとに閉じる
test.afterEach(async ({ browser }) => {
  await Promise.all(browser.contexts().map((c) => c.close()))
})

/**
 * この後ずっと、トップ・設定の画面とヘッダーが一度でも描かれたかを覚えておく（読むのは shown）。
 * 確かめている間に一瞬だけ出て消える、ということも見落とさないように
 */
async function watchShown(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __shown: string[] }
    w.__shown = []
    const check = () => {
      for (const id of ['top-page', 'app-settings', 'app-header'])
        if (document.querySelector(`[data-testid="${id}"]`)) w.__shown.push(id)
    }
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true })
  })
}

const shown = (page: Page) => page.evaluate(() => (window as unknown as { __shown: string[] }).__shown)

/** ログインの画面のままで、トップ・設定は出ていない。設定の行き先を開いても、ログインの画面へ戻される */
async function gateHolds(page: Page) {
  await expect(page.getByTestId('login-page')).toBeVisible()
  await expect(page.getByTestId('top-page')).toHaveCount(0)
  await page.evaluate(() => {
    window.location.hash = '/settings'
  })
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/login')
  await expect(page.getByTestId('app-settings')).toHaveCount(0)
  expect(await shown(page)).toEqual([])
}

test('作者の段階0の流れ: 記録が無い間は案内と［ログアウト］だけ。記録を作って窓を選ぶとトップが出て、次は電波が無くても開く', async ({
  browser,
}) => {
  const author = `e2e-author-${Date.now()}`
  const uid = await adminGoogleUser(author)
  const page = await syncDevice(browser)
  await watchShown(page)

  await signInSync(page, author, { shown: false })
  await expect(page.getByTestId('login-owner')).toHaveText(MISSING, { timeout: 20_000 })
  await expect(page.getByTestId('login-sign-out')).toBeVisible()
  await expect(page.getByTestId('login-google')).toHaveCount(0)
  await gateHolds(page)

  // 作者が Firebase の画面で持ち主の記録を作り、アプリの窓を選ぶ（読み込み直さない）
  await adminCreateOwner(uid)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByTestId('top-page')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('top-empty')).toContainText('まだ版はありません')

  // 次に開いた時は、電波が無くても（Firestore に届かなくても）この端末の印でトップが開く
  const context = page.context()
  await context.route('http://127.0.0.1:8080/**', (route) => route.abort('internetdisconnected'))
  await page.reload()
  await expect(page.getByTestId('top-page')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('login-page')).toHaveCount(0)
  await context.unroute('http://127.0.0.1:8080/**')
})

test('持ち主でないアカウントでログインすると、ログインの画面に「持ち主ではありません」と［ログアウト］だけで、トップは一度も出ない', async ({
  browser,
}) => {
  const stamp = Date.now()
  const owner = `e2e-owner-${stamp}`
  const other = `e2e-other-${stamp}`
  await adminCreateOwner(await adminGoogleUser(owner))
  const page = await syncDevice(browser)

  // 共用の PC で、持ち主がログインしてから設定の［ログアウト］で戻った後
  await signInSync(page, owner)
  await page.getByTestId('open-settings').click()
  await page.getByTestId('sign-out').click()
  await expect(page.getByTestId('login-page')).toBeVisible()

  await watchShown(page)
  await signInSync(page, other, { shown: false })
  await expect(page.getByTestId('login-owner')).toHaveText(MISMATCH, { timeout: 20_000 })
  await expect(page.getByTestId('login-sign-out')).toBeVisible()
  await expect(page.getByTestId('login-google')).toHaveCount(0)
  // 窓を選んで確かめ直しても同じ
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByTestId('login-owner')).toHaveText(MISMATCH)
  await gateHolds(page)
})

test('まだ持ち主だと確かめていないアカウントは、電波が無い間は「ネットにつながっていません」のまま。つながると確かめ直す', async ({
  browser,
}) => {
  const stamp = Date.now()
  const owner = `e2e-owner-${stamp}`
  const other = `e2e-unverified-${stamp}`
  await adminCreateOwner(await adminGoogleUser(owner))
  const page = await syncDevice(browser)

  // クラウドの保存先（エミュレーターの Firestore）へ届かなくする。ログイン（エミュレーターの Authentication）は通す。
  // ログインした後に端末ごと電波を切る（共用の PC でログインした直後に電波が切れた、と同じ）
  const context = page.context()
  await context.route('http://127.0.0.1:8080/**', (route) => route.abort('internetdisconnected'))
  await watchShown(page)
  // 持ち主を確かめる部品（src/sync/owner.ts・firestore.ts と、その先の Firestore の部品）を読み込み終えてから電波を切る。公開した
  // アプリでは部品はサービスワーカーの事前キャッシュから出るので電波が無くても読めるが、開発サーバーにはサービスワーカーが無い
  // （読み込みに一度失敗した部品は、ブラウザが失敗を覚えて、読み込み直すまで読めない）。アプリと同じ場所を読むので、同じ部品になる
  await page.evaluate(
    (files) => Promise.all(files.map((f) => import(/* @vite-ignore */ f))),
    ['/src/sync/owner.ts', '/src/sync/firestore.ts'],
  )
  await signInSync(page, other, { shown: false })
  await context.setOffline(true)
  const gate = page.getByTestId('login-owner-checking')
  await expect(gate).toHaveText(OFFLINE, { timeout: 20_000 })
  await expect(page.locator('.login-actions')).toContainText(`${other}@example.com`)
  await expect(page.getByTestId('login-sign-out')).toBeVisible()
  await gateHolds(page)

  // つながると確かめ直す: 持ち主でないので「持ち主ではありません」。この間もトップは出ない
  await context.unroute('http://127.0.0.1:8080/**')
  await context.setOffline(false)
  await expect(page.getByTestId('login-owner')).toHaveText(MISMATCH, { timeout: 20_000 })
  await gateHolds(page)
})
