// コネクタの結合テスト（Firebase エミュレーターが要る）: リポジトリの直下で npm run test:connector:emu
// アプリの端末（../src の同期・端末内の保存。Dexie は fake-indexeddb）と、コネクタの Vault の中身を一緒に動かす（test/emu の *.emu.test.ts。
// 写しを本番のルールで読む mirror.emu.test.ts など。道具は test/emu/harness.ts）。test/support/netGuard.ts: エミュレーター（127.0.0.1）の
// ほかへの fetch はテストを落とす。passWithNoTests は、ファイルを絞って流した時に当たる物が無くても落とさないため
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
