# Topic Studio

個人用のニュースアプリ（Web アプリ・PWA）。ニュースの一覧が最初から AI の要約になっていて、「だから何？」・AI の見解と対立見解・小学生にも分かる用語の注釈が付く。

- 仕様書: [docs/SPEC.md](docs/SPEC.md)
- 公開の準備と手順: [docs/DEPLOY.md](docs/DEPLOY.md)（作者はまずここ）
- 構成は Novel Studio・Diary Studio と同じ（React・TypeScript・Vite・Dexie・Firebase）。ニュースを集めて書くのは claude.ai の定期実行で、Claude 用のコネクタからアプリに足す。

このリポジトリには、集めた記事・書いた要約などのニュースの中身は入れない（仕様書の 3.）。

## 今の状態

**段階0（土台）**: 起動アニメーション（オレンジの点の新聞と「Topic Studio」）→ ログインの画面 → 持ち主の確かめ → 空のトップ画面（「まだ版はありません」）と設定（外観4つ・ログアウト・ホーム画面に追加の手順・このアプリについて）。
版（ニュースの一覧）・データと同期・コネクタは、次の段階から作る（作る順番は仕様書の 11.、段階0で作った物は 14.）。

## 使い方（開発）

Node.js 24 LTS（22 以上なら動く）。

```bash
npm ci
npm run dev           # http://localhost:5173 で起動
npm run typecheck     # 型の確かめ
npm test              # 単体テスト（Vitest。scripts/ のテストも）
npm run test:sync     # 持ち主の関所とアクセスルールのテスト（Firebase エミュレーター。Java 21 以上）
npm run test:e2e      # E2E テスト（Playwright。PC・スマホ・タブレットの Chromium。E2E_WEBKIT=1 で iPhone 14 も）
npm run test:e2e:sync # 持ち主の関所の E2E（Firebase エミュレーター）
npm run e2e:tags      # E2E のテストに端末の印（@pc・@s・@m・@ios）があるかの確かめ
npm run build         # dist/ に本番ビルド（PWA）
npm run format        # Prettier で整形
npm run deploy        # Firebase Hosting とアクセスルールを公開（docs/DEPLOY.md）
```

CI（`.github/workflows/ci.yml`）は、ブランチ `main`・`master`・`claude/**`・`ccr-**` への push と、pull request のたびに 型・整形・端末の印・単体テスト・エミュレーターのテスト・ビルド・ビルドにテスト用の入口（ログインの印・`window.__ts`）が無いことの確かめ・E2E（Chromium と iPhone の WebKit）と、持ち主の関所の E2E を動かす。

## 構成

```
src/domain/    純粋な計算（テスト済み）
src/db/        端末の中の保存（Dexie。段階0は持ち主だと確かめた印だけ）
src/sync/      ログインと持ち主の関所（Firebase。同期は段階1から）
src/store/     状態（Zustand）
src/ui/        共通の部品（ヘッダー・ダイアログ・アイコンなど）
src/features/  各画面（トップ・ログイン・設定）
src/launch/    起動アニメーションと最初の描画の前の外観（launch.js。ビルドの時に index.html へ埋め込む）
scripts/       公開（deploy.mjs）・アイコン（icon-art.mjs・render-icons.mjs）のスクリプト
e2e/           Playwright の E2E テスト
```
