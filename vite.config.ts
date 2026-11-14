/// <reference types="vitest/config" />
// 開発サーバー・ビルド・PWA・単体テストの設定。DS（Diary Studio）の vite.config.ts を写し、名前と manifest を TS の物にした
// （DS は NS の物から、ネイティブ用のビルドと Claude 用のコネクタの部分を外した。docs/SPEC.md の 3.・14.6）
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, transformWithEsbuild, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA, type ManifestOptions, type VitePWAOptions } from 'vite-plugin-pwa'

/** index.html の <script data-inline="ファイル">…</script> */
const INLINE_SCRIPT = /<script data-inline="([^"]+)">([\s\S]*?)<\/script>/g

/**
 * index.html の <script data-inline="ファイル">…</script> の先頭に、そのファイルの中身を埋め込む（src/launch/launch.js: 外観と起動アニメーション）。
 * 最初の描画の前に、アプリの本体の読み込みを待たずに動かすため（読み込みを1つも増やさない）。minify ではコメントを除いて縮める（ビルド）
 */
export async function inlineScripts(html: string, root: string, minify: boolean): Promise<string> {
  let out = ''
  let last = 0
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    const file = path.resolve(root, m[1])
    let code = readFileSync(file, 'utf8')
    // 古い端末でも動く書き方のまま縮める（埋め込むので Vite の変換を通らない）
    if (minify) code = (await transformWithEsbuild(code, file, { minify: true, target: 'es2020', legalComments: 'none' })).code
    if (/<\/script/i.test(code)) throw new Error(`${m[1]} に </script> があると埋め込めません`)
    out += `${html.slice(last, m.index)}<script>\n${code.trim()}\n${m[2].trim()}\n</script>`
    last = m.index + m[0].length
  }
  return out + html.slice(last)
}

/**
 * インストールした Web 版のアイコン（manifest の icons。画像は scripts/render-icons.mjs が public/ に書き出す。docs/SPEC.md の 14.2）。
 * any はふだんのアイコン（apple-touch-icon と同じ絵。インストールした Web 版のスタートメニュー・タスクバー・ウインドウ）。
 * 32px は favicon と同じ、小さくてもにじまない形（Windows のタスクバー・タイトルバー）。
 * maskable だけ、TS を小さめにして真ん中の 80% の円（丸などに切り抜かれる時の安全な範囲）に収めたもの
 */
export const PWA_ICONS = [
  { src: 'pwa-32.png', sizes: '32x32', type: 'image/png', purpose: 'any' },
  { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: 'pwa-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
]

/** インストールした Web 版の manifest（docs/SPEC.md の 14.2・14.6） */
export const PWA_MANIFEST = {
  name: 'Topic Studio',
  short_name: 'Topic Studio',
  // 説明の言葉は仮（作者に確かめる。docs/SPEC.md の 14.8）
  description: '知っておきたい世の中の話題を、1日2回の版で',
  lang: 'ja',
  // アイコン（黒地にオレンジの点の「TS」）と起動アニメーションのダークの地の色（NS・DS と同じ黒）。ホーム画面から開いた時に
  // 端末が一瞬出す無地の画面もこの色にして、アニメーションにつなげる（docs/SPEC.md の 14.2）。ウインドウの枠の色は、開いた後は外観に合わせる
  // （index.html の theme-color）
  theme_color: '#050607',
  background_color: '#050607',
  display: 'standalone',
  start_url: './',
  scope: './',
  // any はふだんのアイコン、maskable だけ TS を小さめにしたもの（PWA_ICONS）
  icons: PWA_ICONS,
} satisfies Partial<ManifestOptions>

/**
 * サービスワーカー（Workbox）の事前キャッシュと、オフラインの時にアプリの画面へ差し替える行き先の決まり（DS と同じ。docs/SPEC.md の 14.6）
 */
export const PWA_WORKBOX = {
  // 書体（Roboto Mono の woff2）も事前キャッシュに入れ、オフラインでも等幅の字で出す（既定は js・css・html だけ。
  // woff は古いブラウザ用なので入れない）。書体のライセンスの全文（public/licenses/。設定の「このアプリについて」の
  // 「全文へのリンク」。docs/SPEC.md の 14.5）も入れ、オフラインでも開けるようにする
  globPatterns: ['**/*.{js,css,html,woff2}', 'licenses/*.txt'],
  // 次の行き先はオフライン用のアプリの画面（index.html）に差し替えない: Firebase のログイン画面（/__/auth/…）と、
  // 書体のライセンスの全文（差し替えると全文ではなくアプリの画面が返り、相対パスの assets も読めずに白い画面になる）
  navigateFallbackDenylist: [/^\/__\//, /^\/licenses\//],
} satisfies VitePWAOptions['workbox']

function inlineLaunchScript(): Plugin {
  const root = fileURLToPath(new URL('.', import.meta.url))
  let minify = false
  return {
    name: 'topic-studio:inline-launch-script',
    configResolved(config) {
      minify = config.command === 'build'
    },
    configureServer(server) {
      // 開発中に書き換えたら読み込み直す（モジュールのつながりの外にあるので、Vite は見ていない）
      const file = path.resolve(root, 'src/launch/launch.js')
      server.watcher.add(file)
      server.watcher.on('change', (changed) => {
        if (path.resolve(changed) === file) server.ws.send({ type: 'full-reload' })
      })
    },
    transformIndexHtml: { order: 'pre', handler: (html) => inlineScripts(html, root, minify) },
  }
}

export default defineConfig({
  // 相対パスで出力しておくと、静的ホスティングにそのまま載せられる（HashRouter。docs/SPEC.md の 3.）
  base: './',
  // ログイン・持ち主の確かめ（Firebase）は使う時に読み込む。開発サーバーで途中に依存を最適化し直して再読み込みしないよう、先にまとめておく
  optimizeDeps: { include: ['firebase/app', 'firebase/auth', 'firebase/firestore'] },
  plugins: [
    react(),
    inlineLaunchScript(),
    VitePWA({
      // 読んでいる途中で勝手に再読み込みしないよう、更新はユーザーが「更新する」を押した時に適用する（docs/SPEC.md の 14.6）
      registerType: 'prompt',
      workbox: PWA_WORKBOX,
      includeAssets: ['favicon.svg', 'icon.svg', 'apple-touch-icon.png'],
      manifest: PWA_MANIFEST,
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // scripts/ はスクリプトの部品のテスト（Node の環境。各ファイルの先頭の @vitest-environment node）
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    // 持ち主の関所とアクセスルールのテストは Firebase エミュレーターの中で動かす（npm run test:sync。docs/SPEC.md の 14.7）
    exclude: ['src/**/*.emu.test.ts', 'node_modules/**'],
  },
})
