// データと同期の E2E（docs/SPEC.md の 16.3 の「E2E」）。Firebase エミュレーターにつないだ開発サーバー（playwright.sync.config.ts。
// npm run test:e2e:sync）で、ブラウザの文脈を同じアカウントの端末に見立てる。持ち主の確かめは本番と同じに動かし（VITE_E2E_OWNER_LOCK=1）、
// アクセスルールも本番の firestore.rules にする。持ち主の記録 config/owner はテストが管理者の権限で作る。
// - 作り物の版を入れる: エミュレーターに入れる道具（scripts/seed-emulator.mjs。npm run seed:emu と同じ物）で35日分を過去の updated で入れ、
//   新しい端末が受け取ってトップ（PC は国内｜世界の2列。段階2）にカードが出る。32日より前の物・30日の境の外の版は端末に入らない（クラウドには全部ある）
// - 2つのブラウザで、片方の開発用のフック（window.__ts.markRead・know）で既読・知ってるにすると、もう片方に移る（既読はカードの data-read）
// - 初めの受け取りの途中に一瞬出た版は「見た」にならない: 受け取りが済んで（同期済み）3秒たつと出ている版だけが見たになり、クラウドの既読の
//   置き場（private）には、その版の記録しか無い（段階2の見たにする決まり。src/features/top/useSeenMark.ts。設計: 段階2の 1.6）
// 時刻は決めない（本物の時計。同期の時刻の見積もりを狂わせないように）。データは作り物だけ（アカウントはテストの回ごとに名前を替える）
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import { firstSyncSinceMs, isWithinRetention } from '../src/domain/jst'
import { adminCreateOwner, adminDocIds, adminGoogleUser, clearFirestore, useRules } from '../src/test/emulatorAdmin'
import { seedEmulator, seedPlan, seedWindow } from '../src/test/seedEmulator'
import { cardOf, signInSync, syncDevice } from './helpers'

const run = promisify(execFile)

test.beforeAll(async () => {
  await useRules(readFileSync('firestore.rules', 'utf8'))
})

test.beforeEach(async () => {
  // 持ち主の記録は1つだけなので、テストごとに消してから始める
  await clearFirestore()
})

// 端末に見立てて開いた文脈（syncDevice）は、テストごとに閉じる（前のテストのアカウントの同期が、次のテストの間も動き続けないように）
test.afterEach(async ({ browser }) => {
  await Promise.all(browser.contexts().map((c) => c.close()))
})

/** 持ち主のアカウント（エミュレーターの仮の Google アカウントを作り、持ち主の記録をそのアカウントにする） */
async function ownerAccount(name: string): Promise<{ sub: string; uid: string }> {
  const sub = `e2e-${name}-${Date.now()}`
  const uid = await adminGoogleUser(sub)
  await adminCreateOwner(uid)
  return { sub, uid }
}

/** 端末のストアの中（開発サーバーのモジュールをそのまま読む。アプリと同じ場所を読むので同じ物。src/store/appStore.ts の useApp） */
function storeOf(page: Page): Promise<{
  editions: string[]
  reads: Record<string, string[]>
  seen: string[]
  known: Record<string, boolean>
}> {
  return page.evaluate(async (file) => {
    const m = (await import(/* @vite-ignore */ file)) as typeof import('../src/store/appStore')
    const s = m.useApp.getState()
    return {
      editions: s.editions.map((e) => e.id),
      reads: Object.fromEntries(Object.entries(s.user.reads).map(([id, r]) => [id, r.topicIds])),
      seen: Object.entries(s.user.reads)
        .filter(([, r]) => r.seen)
        .map(([id]) => id)
        .sort(),
      known: Object.fromEntries(Object.entries(s.user.knownTerms).map(([id, k]) => [id, k.on])),
    }
  }, '/src/store/appStore.ts')
}

/** トップの一覧の外枠（出している版の id を data-edition-id に持つ） */
const editionList = (page: Page) => page.getByTestId('top-edition')

/** PC（L）の列の区切り（国内・世界・そのほか）の中の、畳んでいないカードの話題の id */
function cardIds(page: Page, section: 'jp' | 'world' | 'other'): Promise<string[]> {
  return page
    .locator(`[data-testid="top-section"][data-section="${section}"] [data-testid="top-card"]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-topic-id') ?? ''))
}

test(
  'npm run seed:emu で入れた35日分の作り物の版を、新しい端末が受け取り、トップにカードが出る。端末に入るのは30日の境の内の版だけで、見たになるのは受け取りの後に出ていた版だけ',
  { tag: ['@pc'] },
  async ({ browser }) => {
    test.setTimeout(180_000)
    const { sub, uid } = await ownerAccount('seed')
    // いちばん新しい版の枠は、ここで1回決めて道具に渡す（テストの側でも同じ作り物を作って比べる。枠の境で食い違わないように）
    const win = seedWindow(Date.now())
    const args = ['scripts/seed-emulator.mjs', '--days', '35', '--sub', sub, '--until', win.until, '--until-slot', win.untilSlot]
    const { stdout } = await run(process.execPath, args, { timeout: 90_000 })
    expect(stdout).toContain(`users/${uid}/records`)
    const plan = seedPlan({ days: 35, until: win.until, untilSlot: win.untilSlot })
    expect(plan.beforeFirstSync).toBeGreaterThan(0)
    // クラウドには35日分が全部ある（32日より前の物も）
    expect((await adminDocIds(uid, 'records')).sort()).toEqual(plan.docs.records.map((d) => `${d.table}:${d.id}`).sort())

    const page = await syncDevice(browser)
    await signInSync(page, sub)
    const newest = plan.month.editions[plan.month.editions.length - 1]
    await expect(editionList(page)).toHaveAttribute('data-edition-id', newest.edition.id, { timeout: 120_000 })
    // PC は国内｜世界の2列: 国内の列は国内の話題の order の順、世界の列は世界の話題の order の順。20本がどこかに1回ずつ
    // （地域の分からない話題は国内の列の下の「そのほか」）
    expect(await cardIds(page, 'jp')).toEqual(newest.topics.filter((t) => t.region === 'jp').map((t) => t.id))
    expect(await cardIds(page, 'world')).toEqual(newest.topics.filter((t) => t.region === 'world').map((t) => t.id))
    const shown = [...(await cardIds(page, 'jp')), ...(await cardIds(page, 'world')), ...(await cardIds(page, 'other'))]
    expect(shown.sort()).toEqual([...newest.edition.order].sort())
    await expect(cardOf(page, newest.topics[0].id).getByRole('button')).toHaveText(newest.topics[0].headline)
    await expect(page.getByTestId('sync-indicator')).toHaveText(/同期済み/, { timeout: 60_000 })

    // 端末に入ったのは30日の境の内の版だけで、その版は全部ある（32日より前に作った版は、初めての受け取りの窓の外なので届かない。
    // 30日の境の外の版は、届いても反映の前に落とす。docs/SPEC.md の 7.8 の「版と話題を受け取る」。窓の外の物を読まない事と読んだ文書の数は
    // src/sync/sync.emu.test.ts で数えて確かめる）
    const now = Date.now()
    const kept = plan.month.editions.filter((e) => isWithinRetention(e.edition.date, now)).map((e) => e.edition.id)
    expect(plan.month.editions.some((e) => e.edition.createdAt < firstSyncSinceMs(now))).toBe(true)
    await expect.poll(async () => (await storeOf(page)).editions, { timeout: 60_000 }).toEqual(kept)

    // 受け取りの途中に一瞬出た版（付いていく版は、届いた分の版を順に出す）は見たにならない。受け取りが済んで3秒たつと、出ている
    // いちばん新しい版だけが見たになり、クラウドの既読の置き場にもその版の記録だけが届く
    await expect.poll(async () => (await storeOf(page)).seen, { timeout: 15_000 }).toEqual([newest.edition.id])
    await expect.poll(() => adminDocIds(uid, 'private'), { timeout: 30_000 }).toEqual([`reads:${newest.edition.id}`])
  },
)

test(
  '2つのブラウザで、片方の開発用のフックで既読・知ってるにすると、もう片方に移る（逆も同じで、既読の並びは足し合わせ）',
  { tag: ['@pc'] },
  async ({ browser }) => {
    test.setTimeout(120_000)
    const { sub, uid } = await ownerAccount('data')
    // 作り物の版（3日分）を、エミュレーターに入れる道具の中身（src/test/seedEmulator.ts）で直接入れる
    const plan = await seedEmulator(uid, { days: 3 })
    const newest = plan.month.editions[plan.month.editions.length - 1]
    const a = await syncDevice(browser)
    const b = await syncDevice(browser)
    await signInSync(a, sub)
    await signInSync(b, sub)
    for (const p of [a, b]) {
      await expect(editionList(p)).toHaveAttribute('data-edition-id', newest.edition.id, { timeout: 60_000 })
      await expect(p.getByTestId('sync-indicator')).toHaveText(/同期済み/, { timeout: 60_000 })
    }

    // A で既読にする → A の行にすぐ印が付き、B に届く
    const first = newest.topics[3].id
    expect(await a.evaluate((id) => window.__ts.markRead(id), first)).toMatchObject({ ok: true, changed: true })
    await expect(cardOf(a, first)).toHaveAttribute('data-read', 'true')
    await expect(cardOf(b, first)).toHaveAttribute('data-read', 'true', { timeout: 30_000 })
    await expect(b.locator('[data-testid="top-card"][data-read="true"]')).toHaveCount(1)
    // 既読は Claude が読めない置き場（private）にだけある（D21・docs/SPEC.md の 7.7）。受け取りが済んで3秒たった後も、初めの受け取りの
    // 途中に出た版の記録は無い（見たになるのは、受け取りの後に出ていたいちばん新しい版だけ）
    for (const p of [a, b])
      await expect.poll(async () => (await storeOf(p)).seen, { timeout: 15_000 }).toEqual([newest.edition.id])
    await expect.poll(() => adminDocIds(uid, 'private'), { timeout: 30_000 }).toEqual([`reads:${newest.edition.id}`])
    expect((await adminDocIds(uid, 'records')).some((id) => id.startsWith('reads:'))).toBe(false)

    // B で別の話題を既読にする → A に届き、既読の並びは両方の話題になる（足し合わせ。docs/SPEC.md の 7.8）
    const second = newest.topics[7].id
    expect(await b.evaluate((id) => window.__ts.markRead(id), second)).toMatchObject({ ok: true, changed: true })
    await expect(cardOf(a, second)).toHaveAttribute('data-read', 'true', { timeout: 30_000 })
    await expect(cardOf(a, first)).toHaveAttribute('data-read', 'true')
    await expect.poll(async () => (await storeOf(b)).reads[newest.edition.id]).toEqual([first, second])
    expect((await storeOf(a)).reads[newest.edition.id]).toEqual([first, second])

    // A で語を「知ってる」にする → B に届く（知ってるは records に置く。Claude に渡すため。7.4）
    const term = newest.topics.flatMap((t) => t.terms)[0]
    expect(await a.evaluate((id) => window.__ts.know(id), term.termId)).toMatchObject({
      ok: true,
      record: { id: term.termId, term: term.term, asOf: term.asOf, on: true },
    })
    await expect.poll(async () => (await storeOf(b)).known[term.termId], { timeout: 30_000 }).toBe(true)
    expect(await adminDocIds(uid, 'records')).toContain(`knownTerms:${term.termId}`)
  },
)
