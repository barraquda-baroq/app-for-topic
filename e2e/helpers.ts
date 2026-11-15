// E2E テスト用のヘルパー。DS の e2e/helpers.ts から、段階0の画面に要る物だけを写した物（DS のデータを置く・カレンダーの操作・
// 履歴・指の操作の部分は外した）。開発サーバーでは window.__ts（src/main.tsx）からログインの状態などを使える。
// アカウントは作り物だけを使う（個人の情報を入れない）
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { KnownTerm, ReadMark } from '../src/domain/types'
import type { TestEditionsOptions, TestEditionsResult } from '../src/features/login/testAuth'
import type { EditResult } from '../src/store/appStore'

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
  /** 段階1の既読: 話題を読んだにする（src/store/devActions.ts。画面の操作は段階2） */
  markRead: (topicId: string) => EditResult<ReadMark>
  /** 段階1の「知ってる」: 開いている版の話題の用語から、語を「知ってる」にする */
  know: (termId: string) => EditResult<KnownTerm>
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
