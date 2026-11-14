import { defineConfig, devices } from '@playwright/test'

// 持ち主の関所の E2E テスト（docs/SPEC.md の 14.4・14.7）。Firebase エミュレーターにつなぐ開発サーバーで、ブラウザを動かす。
// `npm run test:e2e:sync` で、エミュレーターを立ち上げてから実行する（DS の playwright.sync.config.ts から。段階0は
// e2e/owner-gate.sync.spec.ts だけ。段階1で2つのブラウザでの同期のテストを同じ所に足す）。
// エミュレーターにつないだ開発サーバーはふだん持ち主を確かめないので、ここでは VITE_E2E_OWNER_LOCK=1（開発サーバーだけ。
// src/sync/controller.ts）で本番と同じに確かめさせ、持ち主の記録 config/owner はテストが管理者の権限で作る
// （src/test/emulatorAdmin.ts）。持ち主の記録は1つだけなので、テストは1つずつ流す。
// エミュレーターのアカウントはテストごとに名前を替える（前の回と混ざらないように）。アカウントは作り物だけ。
// 入っている Chromium を使う時は PW_CHROMIUM_PATH にその場所を入れる（playwright.config.ts と同じ）
const port = Number(process.env.E2E_SYNC_PORT ?? 5180)
const chromium = process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.sync.spec.ts',
  outputDir: './e2e/artifacts/sync-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    env: {
      VITE_FIREBASE_EMULATOR: '127.0.0.1',
      VITE_E2E_OWNER_LOCK: '1',
    },
    url: `http://localhost:${port}`,
    // CI では必ず上の環境変数で立ち上げる。手元では、同じ2つの環境変数で先に立ち上げた開発サーバーを使ってもよい
    // （ふつうの開発サーバーを使うと、ログインできない・持ち主を確かめないので、テストが落ちて分かる）
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 }, ...chromium },
    },
  ],
})
