// コネクタの単体テスト（Node。fetch はテストの中で差し替える）: npm --prefix connector run test:unit
// test/support/netGuard.ts: テストの fetch が、手元のエミュレーターのほかへ出たらテストを落とす（府省・庁などのサイトへ出ない）
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['test/support/netGuard.ts'],
    testTimeout: 30_000,
  },
})
