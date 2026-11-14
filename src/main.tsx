// アプリの入り口。DS の段階0の src/main.tsx から（DS は NS の物から、iPhone / Android のアプリ（Capacitor）と Claude 連携の部分を外した）。
// 起動の順: 端末の中の保存先（Dexie）を開く → ログインの状態を確かめる → 最初の画面が出たら起動アニメーションに「準備ができた」と知らせる
// （docs/SPEC.md の 14.4・14.6）。
// 等幅の英数字の書体（Roboto Mono。latin の 300・400・500・600 だけ。アプリに同梱し、オフラインでも出る。docs/SPEC.md の 14.3）
import '@fontsource/roboto-mono/latin-300.css'
import '@fontsource/roboto-mono/latin-400.css'
import '@fontsource/roboto-mono/latin-500.css'
import '@fontsource/roboto-mono/latin-600.css'
// 共通スタイルを先に読み込み、各画面の CSS で上書きできるようにする
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { afterNextPaint, notifyAppReady } from './launch/launchHook'
import { initStore } from './store/appStore'
import { installLeaveHandlers } from './store/lifecycle'
import { useAppUpdate } from './store/uiStore'
import { fakeSignInForTest, initSync, signInForTest, useSync, whenAuthKnown } from './sync/controller'

// 端末内のデータが勝手に消されないよう、永続ストレージを要求する（対応ブラウザのみ）
void navigator.storage?.persist?.().catch(() => undefined)

// 画面を閉じる・裏に回る時は、保留中の変更をすぐ保存する（段階0は保存する物が無い。段階1でデータの保存を足す）
installLeaveHandlers()

// 新しい版の知らせ（サービスワーカー）。更新は「更新する」を押した時だけ（docs/SPEC.md の 14.6）。
// 保存は、帯の［更新する］（src/ui/Layout.tsx の UpdateBanner）がしてから apply を呼ぶ（保存は1か所だけ）
if (import.meta.env.PROD) {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      useAppUpdate.setState({ ready: true, apply: () => updateSW(true) })
    },
  })
}

// E2E テストから操作するための開発用フック（本番ビルドには含まれない。DS の window.__ds と同じ。docs/SPEC.md の 14.7）
if (import.meta.env.DEV) {
  /** showUpdateBanner で出した帯の［更新する］が押されたか */
  let updateApplied = false
  ;(window as unknown as { __ts: unknown }).__ts = {
    /** エミュレーターにつないでいる時だけ: 仮のアカウントでログインする */
    signInForTest,
    /** 画面のテスト用: Firebase を使わずにログインした状態にする */
    fakeSignIn: () => fakeSignInForTest(),
    /** ログインしているアカウント（持ち主の関所のテスト用） */
    syncUid: () => useSync.getState().user?.uid ?? null,
    /** 画面のテスト用: 新しい版を受け取った時の帯（本物の UpdateBanner）を出す。［更新する］を押すと updateApplied() が true になる */
    showUpdateBanner: () => {
      updateApplied = false
      useAppUpdate.setState({
        ready: true,
        apply: async () => {
          updateApplied = true
        },
      })
    },
    updateApplied: () => updateApplied,
  }
}

// 端末の中の保存先を開き、ログインの状態を確かめ始める（ログインしていなければログインの画面、この端末で持ち主だと確かめた
// アカウントならトップ画面。docs/SPEC.md の 14.4）
const storeReady = initStore()
void storeReady.then(() => initSync())
// 起動アニメーション（index.html に埋め込んだ src/launch/launch.js）に、最初の画面（読み込み中…ではなく、ログインの画面か
// トップ画面）が出たことを知らせる。アニメーションも終わっていれば、それで消える
void storeReady.then(() => whenAuthKnown()).then(() => afterNextPaint(notifyAppReady))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
