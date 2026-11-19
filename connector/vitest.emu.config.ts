// コネクタの結合テスト（Firebase エミュレーターが要る）: リポジトリの直下で npm run test:connector:emu
// アプリの端末（../src の同期・端末内の保存。Dexie は fake-indexeddb）と、コネクタの Vault の中身を一緒に動かす（テストは B3 以降で足す。
// まだ無い間も通る: passWithNoTests）。test/support/netGuard.ts: エミュレーター（127.0.0.1）のほかへの fetch はテストを落とす
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/emu/**/*.emu.test.ts'],
    setupFiles: ['fake-indexeddb/auto', 'test/support/netGuard.ts'],
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    passWithNoTests: true,
  },
})
