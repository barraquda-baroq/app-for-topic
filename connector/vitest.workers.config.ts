// Workers の実行環境（workerd）でのテスト: npm --prefix connector run test:worker
// OAuth（ライブラリ）・同意の画面・連携の確かめ・/mcp・Durable Object を、wrangler.jsonc と同じ設定で動かす。
// Firebase は test/support/fakeFirebase.ts（fetch の差し替え）。test/support/netGuard.ts: 差し替えの外の fetch はテストを落とす
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // テストの workerd（@cloudflare/vitest-pool-workers 0.23.0 に入っているもの）が対応する最新の日付。
        // 公開する時は wrangler.jsonc の 2026-10-01（wrangler 4.151.0 の workerd）
        compatibilityDate: '2026-08-22',
        // Request.cf の見本を Cloudflare から取りに行かない（テストは外へ出ない。決まった仮の値を使う）
        cf: false,
        bindings: {
          TOKEN_ENC_KEY: 'workerd-test-secret-0123456789abcdef',
          PUBLIC_ORIGIN: 'https://connector.example',
          MCP_RESOURCE: 'https://connector.example/mcp',
          FIREBASE_EMULATOR_HOST: 'fake-firebase',
          // 作り物の Firebase のプロジェクト（test/support/fakeFirebase.ts の FAKE_PROJECT。本物のプロジェクトの名前で呼ばない）
          FIREBASE_PROJECT_ID: 'demo-topic-studio',
        },
      },
    }),
  ],
  test: {
    include: ['test/worker/**/*.test.ts'],
    setupFiles: ['test/support/netGuard.ts'],
    testTimeout: 30_000,
  },
})
