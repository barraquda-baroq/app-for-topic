// ビルド・開発サーバーの環境変数（import.meta.env）の型。DS の src/env.d.ts をそのまま写した物（DS は NS の物から）

interface ImportMetaEnv {
  /**
   * 開発・テスト用: Firebase エミュレーターのホスト（例: 127.0.0.1）。設定すると、ログインをクラウドではなくエミュレーターにつなぐ
   * （src/sync/firebase.ts。公開するビルドでは読まない）
   */
  readonly VITE_FIREBASE_EMULATOR?: string
  /**
   * E2E 用: '1' なら、エミュレーターにつないだ開発サーバーでも本番と同じに持ち主を確かめる（e2e/owner-gate.sync.spec.ts。
   * playwright.sync.config.ts が立ち上げる開発サーバーだけ。src/sync/controller.ts の skipsOwnerCheck。公開するビルドでは読まない）
   */
  readonly VITE_E2E_OWNER_LOCK?: string
}

/**
 * ビルドの時に埋め込む値（vite.config.ts の define。NS の src/env.d.ts から）: Claude 用のコネクタの origin
 * （https://topic-studio-connector.….workers.dev。connector.local.json か VITE_CONNECTOR_ORIGIN。未設定は空）
 */
declare const __CONNECTOR_ORIGIN__: string
