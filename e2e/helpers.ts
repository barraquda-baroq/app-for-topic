// E2E テスト用のヘルパー。DS の e2e/helpers.ts から、段階0の画面に要る物だけを写した物（DS のデータを置く・カレンダーの操作・
// 履歴・指の操作の部分は外した）。開発サーバーでは window.__ts（src/main.tsx）からログインの状態などを使える。
// アカウントは作り物だけを使う（個人の情報を入れない）。
// 段階2で、時刻・外観・字の大きさ・作り物の版・同期の表示を決めてトップなどを開く openTop と、総合（L は列）の中のカード cardOf を
// 足した（DS の openCalendar にならう。設計: 段階2の 4.2）。開発用のフックの見た版（markSeen）・詳細を開く（openTopic）と、openTop の
// 見た版（seen）も足した（設計: 段階2の 4.2・6.1）
import { expect, test, type Locator, type Page } from '@playwright/test'
import { editionIdOf } from '../src/domain/ids'
import { latestSlotAt } from '../src/domain/jst'
import type { KnownTerm, ReadMark } from '../src/domain/types'
import type { TestEditionsOptions, TestEditionsResult } from '../src/features/login/testAuth'
import type { PanelSide } from '../src/features/topic/sheets'
import type { EditResult } from '../src/store/appStore'
import type { AppearanceMode, TextSize } from '../src/store/uiStore'
import type { SyncView } from '../src/sync/syncView'

/**
 * 落ちた時の手がかりを残す（CI の WebKit でだけ時々ログインの画面が出ないことがあり、その時に何が起きていたかを見るため）。
 * テストの間、ブラウザの console・ページのエラー・失敗した通信・終わっていない通信を集め、落ちた時だけ「page-diagnostics」として
 * 添付する（line reporter はこの文を CI のログにそのまま出す。ただし初めの 300字だけなので、ページの様子を1行目に置く）。
 * DS の e2e/helpers.ts から（DS の押した所の控え pressLog はカレンダーの操作の物なので外した）。ファイルの先頭で1回呼ぶ
 */
export function collectDiagnosticsOnFailure(): void {
  interface Rec {
    nav: string[]
    errors: string[]
    beats: string[]
    other: string[]
    pending: Map<string, number>
    t0: number
  }
  const logs = new WeakMap<Page, Rec>()
  test.beforeEach(async ({ page, context }) => {
    // E2E_LAUNCH_RENDERER=page の時（CI の iPhone の WebKit。.github/workflows/ci.yml）: 起動アニメーションを
    // Worker ではなくページの中で描かせる（OffscreenCanvas の無いブラウザと同じにする。e2e/launch.spec.ts の「ページの中で描く時」と同じ）。
    // CI の WebKit（Linux 版）は、Worker で描いた絵を画面に渡す所で時々ページごと落ちる・固まるため（DS で分かった事）。
    // テストの中で開いた新しいタブ（context.newPage）も同じにするため、context にも置く（page だけだと、新しいタブは Worker で描いて
    // 時々固まり、読み込みが終わる前に起動アニメーションが消えて「新しいタブでは出る」の確かめが落ちていた。DS の CI）
    if (process.env.E2E_LAUNCH_RENDERER === 'page') {
      const inPage = () => {
        delete (window as { OffscreenCanvas?: unknown }).OffscreenCanvas
        Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
          value: undefined,
          configurable: true,
        })
      }
      await context.addInitScript(inPage)
      await page.addInitScript(inPage)
    }
    const rec: Rec = { nav: [], errors: [], beats: [], other: [], pending: new Map(), t0: Date.now() }
    logs.set(page, rec)
    const at = () => `@${Date.now() - rec.t0}`
    page.on('console', (m) => {
      const text = m.text()
      if (text.startsWith('[diag]')) rec.beats.push(`${text.slice(7)}${at()}`)
      else if (m.type() === 'error' || m.type() === 'warning')
        rec.errors.push(`console.${m.type()}${at()}: ${text.slice(0, 160)}`)
      // 毎回出るだけの物（開発サーバーの接続・React の案内）は省く
      else if (!text.startsWith('[vite]') && !text.includes('React DevTools'))
        rec.other.push(`console.${m.type()}${at()}: ${text.slice(0, 120)}`)
    })
    page.on('pageerror', (e) => rec.errors.push(`pageerror${at()}: ${e.message.slice(0, 200)}`))
    page.on('request', (r) => rec.pending.set(r.url(), Date.now() - rec.t0))
    page.on('requestfinished', (r) => rec.pending.delete(r.url()))
    page.on('requestfailed', (r) => {
      rec.pending.delete(r.url())
      rec.errors.push(`requestfailed${at()}: ${r.url()} ${r.failure()?.errorText ?? ''}`)
    })
    // 読み込み直し（開発サーバーの「依存を作り直したので再読み込み」など）が途中で起きていないかを見る
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) rec.nav.push(`navigated${at()}: ${f.url()}`)
    })
    page.on('load', () => rec.nav.push(`load${at()}`))
    // テストが時間切れで終わるとページが閉じられ、後から様子を読めないので、2秒ごとにページの様子を console に残す
    await page.addInitScript(() => {
      const beat = () => {
        const overlay = document.getElementById('ts-launch')
        const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 80)
        console.debug(
          `[diag] ready=${document.readyState} overlay=${overlay ? (overlay.getAttribute('data-launch-end') ?? 'shown') : 'none'} body=${text}`,
        )
      }
      setInterval(beat, 2000)
    })
  })
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return
    const rec = logs.get(page)
    if (!rec) return
    const pending = [...rec.pending].map(([url, since]) => `pending(since @${since}): ${url}`)
    const state = await page
      .evaluate(() => {
        const overlay = document.getElementById('ts-launch')
        const attrs = overlay ? [...overlay.attributes].map((a) => `${a.name}=${a.value}`).join(' ') : 'none'
        const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 200)
        return `url=${location.href} overlay=${attrs} body=${text}`
      })
      .catch((e: unknown) => `（ページは閉じられていた: ${String(e).slice(0, 60)}）`)
    // CI のログは長い添付の後ろを切るので、手がかりの大きい物から並べる
    await testInfo.attach('page-diagnostics', {
      body: [state, ...rec.nav, ...rec.errors, ...pending, ...rec.beats.slice(-5).map((b) => `beat ${b}`), ...rec.other]
        .filter(Boolean)
        .join('\n'),
      contentType: 'text/plain',
    })
  })
}

export interface DevHook {
  /** エミュレーターにつないでいる時だけ: 仮のアカウントでログインする */
  signInForTest: (sub: string) => Promise<void>
  /** 画面のテスト用: Firebase を使わずにログインした状態にする（editions を渡すと、作り物の版も端末に入れ終えるまで待つ） */
  fakeSignIn: (opts?: { editions?: TestEditionsOptions | true }) => Promise<TestEditionsResult | null> | undefined
  /** 作り物の版を端末（Dexie）に入れる（受け取った物として。src/features/login/testAuth.ts の putFakeEditions） */
  putFakeEditions: (opts?: TestEditionsOptions) => Promise<TestEditionsResult>
  /** 段階1の既読: 話題を読んだにする（src/store/devActions.ts。画面の操作（詳細を開く）は段階2で作った。フックは場面を作るのに使う） */
  markRead: (topicId: string) => EditResult<ReadMark>
  /** 段階1の「知ってる」: 開いている版の話題の用語から、語を「知ってる」にする */
  know: (termId: string) => EditResult<KnownTerm>
  /** 段階2の見た版: 版の一覧を見たにする（ストアの markSeen。30日の内の版だけ・戻さない） */
  markSeen: (editionId: string) => EditResult<ReadMark>
  /**
   * 段階2の詳細: 今の行き先のまま履歴の state に詳細の印を積んで開く（もう開いていれば置き換え。side は L で重ねる列で、渡さなければ null =
   * L は真ん中の小さな画面。ルーターがまだ無い・id が空なら false）
   */
  openTopic: (topicId: string, side?: PanelSide | null) => boolean
  /** ログインしているアカウント（持ち主の関所のテスト用） */
  syncUid: () => string | null
  /** 新しい版を受け取った時の帯（本物の UpdateBanner）を出す */
  showUpdateBanner: () => void
  /** showUpdateBanner で出した帯の［更新する］が押されたか */
  updateApplied: () => boolean
}

declare global {
  interface Window {
    __ts: DevHook
  }
}

/**
 * アプリを開き、最初の画面が出るまで待つ。signedIn ならログインした状態にして（Firebase は使わない）、その行き先を開く。
 * そうでなければ、ログインしていないのでログインの画面が出る
 */
export async function openApp(page: Page, hash = '/', { signedIn = true }: { signedIn?: boolean } = {}): Promise<void> {
  await page.goto(`/#${hash}`)
  await page.waitForFunction(() => Boolean(window.__ts))
  if (signedIn) {
    await page.evaluate(() => window.__ts.fakeSignIn())
    // ログインの画面へ置き換えられていたら、元の行き先へ戻す
    await page.evaluate((h) => {
      if (window.location.hash !== `#${h}`) window.location.hash = h
    }, hash)
  }
  await expect(page.getByText('読み込み中…')).toHaveCount(0)
}

// ---------- 段階2の画面を開く（作り物の版・決めた時刻。設計: 段階2の 4.2） ----------

/** テスト用のログインの印・作り物の版の印・端末の表示の設定（src/features/login/testAuth.ts・src/store/uiStore.ts と同じ名前） */
const TEST_AUTH_KEY = 'topic-studio:test-auth'
const TEST_EDITIONS_KEY = 'topic-studio:test-editions'
const PREFS_KEY = 'topic-studio:prefs'

/**
 * 段階2の E2E の既定の時刻（2026-11-15（日）14:10 日本時間。いちばん新しい版は 11/15 12:00版で、その作り物の訂正（版の 40分後・
 * 90分後）より後。見本の時刻と同じ。設計: 段階2の 5.3）
 */
export const E2E_NOW = '2026-11-15T14:10:00+09:00'

/** 作り物の版の、端末に入れる作り方（日付・枠・日数を決めた物。テストの側でも同じ作り方で作って比べる） */
export type ResolvedEditions = TestEditionsOptions & Required<Pick<TestEditionsOptions, 'days' | 'until' | 'untilSlot'>>

export interface OpenTopOptions {
  /** 時刻（page.clock.setFixedTime。既定 E2E_NOW）。時計は止めたまま、タイマーは動く */
  now?: number | string | Date
  /** 外観（既定 'white'） */
  appearance?: AppearanceMode
  /** 記事の字の大きさ（既定 'm'） */
  textSize?: TextSize
  /**
   * 作り物の版の作り方（src/features/login/testAuth.ts の TestEditionsOptions をそのまま渡す。既定 {} = 3日分・いちばん新しい版は
   * now のいちばん新しい枠）。null は版を入れない（新しいページなら「まだ版はありません」。同じページで開き直した時は、前に入れた版が
   * 端末（Dexie）に残っている）
   */
  editions?: TestEditionsOptions | null
  /**
   * 同期の表示（ページの中で useSyncView.setState。作り物の版では同期を始めないので、落ち着いた状態を入れる。docs/SPEC.md の 7.8）。
   * 既定 'synced'。null は入れない（ログインの直後と同じ「まだ分からない」）
   */
  sync?: SyncView | SyncView['kind'] | null
  /**
   * 見たにしておく版の id（window.__ts.markSeen。追いつきの帯・追いつきの画面の並びを作る）。端末の中を読み終えた所で、画面を待つ前に
   * 付ける（追いつきの画面は開いた時に追いつく版を決めるため）。どれかが付けられない（形の違う id・30日の外）時は落ちる
   */
  seen?: readonly string[]
  /**
   * 何が出るまで待つか（来ない物を待って時間切れにならないように、場面ごとに渡す）。既定は、版を入れる時 'newest'、入れない時 'empty'。
   * 'newest' = 一覧（top-edition）の data-edition-id がいちばん新しい作り物の版になる、
   * 'shown' = どれかの版が出る（前の版・いちばん新しい版の話題を入れない時）、'empty' = top-empty、'waiting' = top-waiting、
   * { testId } = その testid（#/editions・#/catch-up・#/settings）
   */
  expect?: 'newest' | 'shown' | 'empty' | 'waiting' | { testId: string }
}

export interface OpenTopResult {
  /** 止めた時刻（ミリ秒） */
  now: number
  /** 入れた作り物の版の作り方（入れない時は null） */
  editions: ResolvedEditions | null
  /** いちばん新しい作り物の版の id（入れない時は null） */
  newestEditionId: string | null
}

/** 開き直すたびに URL の印を替える（同じ URL のハッシュだけの移動では読み込み直さないので。DS の ?e2e-open=n と同じ） */
const openCount = new WeakMap<Page, number>()

/** 同期の表示の種類だけを渡した時の中身（未送信は 2件・無料枠は 17:00 ごとに戻る・止まった理由は不明） */
function syncViewOfKind(kind: SyncView['kind']): SyncView {
  switch (kind) {
    case 'pending':
      return { kind, count: 2 }
    case 'quota':
      return { kind, resumeAt: '17:00' }
    case 'error':
      return { kind, reason: '不明なエラー' }
    default:
      return { kind }
  }
}

/**
 * ヘッダーの同期の表示（src/sync/syncView.ts の useSyncView）を、ページの中で入れる（開発サーバーのモジュールをそのまま読むので、
 * アプリと同じ物。作り物の版ではエンジンを動かさないので、入れた物がそのまま残る）。null は「まだ分からない」
 */
export async function setSyncView(page: Page, sync: SyncView | SyncView['kind'] | null): Promise<void> {
  const view = typeof sync === 'string' ? syncViewOfKind(sync) : sync
  await page.evaluate(
    async ({ file, view }) => {
      const m = (await import(/* @vite-ignore */ file)) as typeof import('../src/sync/syncView')
      m.useSyncView.setState({ view })
    },
    { file: '/src/sync/syncView.ts', view },
  )
}

/**
 * 時刻・外観・字の大きさ・作り物の版を決めて、その行き先を開く（ログインした状態。Firebase は使わない）。
 * page.clock.setFixedTime → 起動前の印（テスト用のログイン・作り物の版・表示の設定）→ goto → 見た版（seen）を付ける → expect まで待つ →
 * 同期の表示を入れる。
 * 同じページで2回呼ぶと読み込み直す（印は後に置いた物が効く）
 */
export async function openTop(page: Page, hash = '/', options: OpenTopOptions = {}): Promise<OpenTopResult> {
  const nowMs = new Date(options.now ?? E2E_NOW).getTime()
  const latest = latestSlotAt(nowMs)
  const given = options.editions === undefined ? {} : options.editions
  // 作り方の省いた所は、端末に入れる側（putFakeEditions）と同じ既定にして、テストの側でも同じ版を作れるようにする
  const editions: ResolvedEditions | null = given
    ? {
        ...given,
        days: given.days ?? 3,
        until: given.until ?? latest.date,
        untilSlot: given.untilSlot ?? (given.until ? '20' : latest.slot),
      }
    : null
  const newestEditionId = editions ? editionIdOf(editions.until, editions.untilSlot) : null
  const prefs = { v: 1, appearance: options.appearance ?? 'white', launchAnimation: false, textSize: options.textSize ?? 'm' }

  await page.clock.setFixedTime(nowMs)
  await page.addInitScript(
    ({ keys, editions, prefs }) => {
      localStorage.setItem(keys.auth, '1')
      if (editions) localStorage.setItem(keys.editions, JSON.stringify(editions))
      else localStorage.removeItem(keys.editions)
      localStorage.setItem(keys.prefs, JSON.stringify(prefs))
    },
    { keys: { auth: TEST_AUTH_KEY, editions: TEST_EDITIONS_KEY, prefs: PREFS_KEY }, editions, prefs },
  )
  const n = (openCount.get(page) ?? 0) + 1
  openCount.set(page, n)
  await page.goto(`/?e2e-open=${n}#${hash}`)

  // 見た版: 端末の中を読み終えたら（それまでは not-ready）付ける。同じ版にもう一度付けても変わらない
  const seen = options.seen ?? []
  if (seen.length) {
    await page.waitForFunction(
      (ids) =>
        Boolean(window.__ts) &&
        ids.every((id) => {
          const r = window.__ts.markSeen(id)
          if (!r.ok && r.reason !== 'not-ready') throw new Error(`見たにできません: ${id}（${r.reason}）`)
          return r.ok
        }),
      [...seen],
      { timeout: 15_000 },
    )
  }

  const wait = options.expect ?? (editions ? 'newest' : 'empty')
  // 版の一覧の外枠（top-edition。data-edition-id を持つ。段階1の仮の一覧 top-headlines は段階2で無くなった）
  const edition = page.getByTestId('top-edition')
  if (wait === 'newest') {
    if (!newestEditionId) throw new Error("expect: 'newest' は作り物の版を入れる時だけ使えます")
    await expect(edition).toHaveAttribute('data-edition-id', newestEditionId, { timeout: 15_000 })
  } else if (wait === 'shown') await expect(edition).toHaveAttribute('data-edition-id', /.+/, { timeout: 15_000 })
  else if (wait === 'empty') await expect(page.getByTestId('top-empty')).toBeVisible({ timeout: 15_000 })
  else if (wait === 'waiting') await expect(page.getByTestId('top-waiting')).toBeVisible({ timeout: 15_000 })
  else await expect(page.getByTestId(wait.testId)).toBeVisible({ timeout: 15_000 })

  // 同期の表示は、ログインと作り物の版を入れ終えた後に入れる（ログインの時に司令塔が null に戻すため）。それまでは null（落ち着いていない）
  const sync = options.sync === undefined ? 'synced' : options.sync
  if (sync !== null) await setSyncView(page, sync)
  return { now: nowMs, editions, newestEditionId }
}

/**
 * 一覧のカード（話題の id で）。S・M は同じ話題が総合とジャンルの区切りに2回出るので、総合（data-section="all"）の中で絞る
 * （.first() で取らない）。L は国内・世界の列と、国内の列の下の「そのほか」の中（設計: 段階2の 4.2・4.3）
 */
export function cardOf(page: Page, topicId: string): Locator {
  const sections = ['all', 'jp', 'world', 'other'].map((s) => `[data-testid="top-section"][data-section="${s}"]`).join(', ')
  return page.locator(`:is(${sections}) [data-testid="top-card"][data-topic-id="${topicId}"]`)
}

/**
 * ビルドした物（dist/）を出す vite preview の URL（E2E_PREVIEW=1 の時だけ playwright.config.ts が立ち上げる）。
 * ポートは開発サーバー（E2E_PORT、無ければ 5174）の +100
 */
export function previewURL(): string | null {
  if (!process.env.E2E_PREVIEW) return null
  return `http://localhost:${Number(process.env.E2E_PORT ?? 5174) + 100}`
}

/** 横にはみ出していない（横スクロールが出ない） */
export async function noHorizontalScroll(page: Page): Promise<void> {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
  expect(scroll).toBeLessThanOrEqual(width)
}

/** 'rgb(r, g, b)' の相対輝度 */
export function luminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** ディープダーク: 選んだ要素の背景がほぼ黒（白い面が出ない。透明は飛ばす） */
export async function darkSurfaces(page: Page, selectors: string[]): Promise<void> {
  for (const sel of selectors) {
    const els = page.locator(sel)
    const n = await els.count()
    for (let i = 0; i < n; i++) {
      const bg = await els.nth(i).evaluate((e) => getComputedStyle(e).backgroundColor)
      if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue
      expect(luminance(bg), `${sel} ${bg}`).toBeLessThan(0.05)
    }
  }
}

/** 押す所の大きさ（34px 以上。width も見る時は both） */
export async function tapSize(target: Locator, label: string, both = true): Promise<void> {
  await expect(target).toBeVisible()
  const box = await target.boundingBox()
  expect(box?.height, label).toBeGreaterThanOrEqual(34)
  if (both) expect(box?.width, label).toBeGreaterThanOrEqual(34)
}

// ---------- 持ち主の関所の E2E（playwright.sync.config.ts。Firebase エミュレーター） ----------

/**
 * 持ち主の関所の E2E の1台の端末: 新しいブラウザの文脈（保存も Firebase のログインの状態も別）でアプリを開き、ログインの画面が出るまで待つ
 * （テスト用の印 topic-studio:test-auth は置かない。ログインはエミュレーターの本物の流れ。signInSync）
 */
export async function syncDevice(browser: { newContext: () => Promise<{ newPage: () => Promise<Page> }> }): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto('/#/')
  await page.waitForFunction(() => Boolean(window.__ts))
  await expect(page.getByTestId('login-page')).toBeVisible()
  return page
}

/**
 * エミュレーターの仮の Google アカウント（sub）でログインする（window.__ts.signInForTest。開発サーバーだけ）。トップの画面まで
 * 進むと決まっている時（持ち主の記録 config/owner がこのアカウント）は shown で、トップの画面まで待つ
 */
export async function signInSync(page: Page, sub: string, { shown = true }: { shown?: boolean } = {}): Promise<void> {
  await page.evaluate((s) => window.__ts.signInForTest(s), sub)
  if (!shown) return
  await expect(page.getByTestId('top-page')).toBeVisible({ timeout: 20_000 })
}
