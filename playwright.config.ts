import { defineConfig, devices } from '@playwright/test'

// E2E テスト（docs/SPEC.md の 14.7）。`npm run test:e2e` で開発サーバーを立ち上げて実行する。DS の playwright.config.ts から
// （DS の見本の画面の部分を外した。DS は NS の物から）。
// 複数の作業を並行して走らせる時は E2E_PORT でポートを分ける。
// 入っている Chromium を使う時は PW_CHROMIUM_PATH にその場所を入れる（@playwright/test の版と入っているブラウザの版が違う環境）。
// 持ち主の関所と同期のテスト（エミュレーターにつないだ開発サーバー。*.sync.spec.ts）は playwright.sync.config.ts（npm run test:e2e:sync）。
//
// どの端末で流すかは、テストに付けた印（Playwright の tag）で決める（DS と同じ）:
//   @pc  = PC 1400×900・マウス（desktop）       @s   = スマホ Pixel 7・指（mobile）
//   @m   = 幅 600〜899px の 768×1024・指（tablet） @ios = iPhone 14・WebKit（iphone。E2E_WEBKIT の時だけ）
// 印の無いテストはどこでも流れないので、npm run e2e:tags（e2e/check-tags.mjs。CI でも流す）が見落としを止める。
// E2E_LIST_ALL=1 の時は印で絞らない（e2e/check-tags.mjs が全部のテストの印を読む時）
const port = Number(process.env.E2E_PORT ?? 5174)
// E2E_PREVIEW=1 の時だけ、ビルドした物（dist/。先に npm run build）を vite preview でも出し、オフラインの確かめ
// （サービスワーカーの事前キャッシュ。e2e/offline.spec.ts）に使う。ポートは開発サーバーの +100（e2e/helpers.ts の previewURL と同じ）
const previewPort = port + 100
const chromium = process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}

/** 端末の印でテストを絞る（E2E_LIST_ALL=1 の時は絞らない） */
const tagged = (tag: '@pc' | '@s' | '@m' | '@ios') => (process.env.E2E_LIST_ALL ? {} : { grep: new RegExp(`${tag}\\b`) })
/** 持ち主の関所と同期のテスト（*.sync.spec.ts。エミュレーターが要る）は、ふつうの E2E では流さない */
const IGNORE = ['**/*.sync.spec.ts']

export default defineConfig({
  testDir: './e2e',
  testIgnore: IGNORE,
  outputDir: './e2e/artifacts/results',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `npx vite --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    ...(process.env.E2E_PREVIEW
      ? [
          {
            command: `npx vite preview --port ${previewPort} --strictPort`,
            url: `http://localhost:${previewPort}`,
            reuseExistingServer: true,
            timeout: 60_000,
          },
        ]
      : []),
  ],
  projects: [
    {
      name: 'desktop',
      testIgnore: IGNORE,
      ...tagged('@pc'),
      use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 }, ...chromium },
    },
    { name: 'mobile', testIgnore: IGNORE, ...tagged('@s'), use: { ...devices['Pixel 7'], ...chromium } },
    // M（600〜899px。タブレットの縦向き）: 指で操作する 768×1024 の Chromium（下からのシート・幅の区分 M の確かめ）
    {
      name: 'tablet',
      testIgnore: IGNORE,
      ...tagged('@m'),
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 768, height: 1024 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        ...chromium,
      },
    },
    // iPhone と同じ WebKit。WebKit を入れた所（CI）だけで動かす: npx playwright install webkit のあと E2E_WEBKIT=1。
    // 流すのは @ios の印を付けたテストだけ（起動アニメーション・通しの確かめ。15 まで）。
    // CI の WebKit（Linux 版）は、起動アニメーションを Worker で描くと、その絵を画面に渡す所で時々ページごと落ちる（Target crashed）・
    // 固まる（DS で分かった事）。CI では起動アニメーションをページの中で描かせて流す（E2E_LAUNCH_RENDERER=page。
    // .github/workflows/ci.yml・e2e/helpers.ts）。それでも CI の WebKit はソフトウェアの描画でとても重いので、落ちた時だけ1回やり直す。
    // やり直して通ったテストは、一覧の最後に flaky として名前が出るので隠れない。毎回落ちる物は、やり直しても落ちる
    ...(process.env.E2E_WEBKIT
      ? [
          {
            name: 'iphone',
            testIgnore: IGNORE,
            ...tagged('@ios'),
            retries: process.env.CI ? 1 : 0,
            use: { ...devices['iPhone 14'] },
          },
        ]
      : []),
  ],
})
