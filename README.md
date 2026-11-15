# Topic Studio

個人用のニュースアプリ（Web アプリ・PWA）。ニュースの一覧が最初から AI の要約になっていて、「だから何？」・AI の見解と対立見解・小学生にも分かる用語の注釈が付く。

- 仕様書: [docs/SPEC.md](docs/SPEC.md)
- 公開の準備と手順: [docs/DEPLOY.md](docs/DEPLOY.md)（作者はまずここ）
- 構成は Novel Studio・Diary Studio と同じ（React・TypeScript・Vite・Dexie・Firebase）。ニュースを集めて書くのは claude.ai の定期実行で、Claude 用のコネクタからアプリに足す。

このリポジトリには、集めた記事・書いた要約などのニュースの中身は入れない（仕様書の 3.）。

## 今の状態

**段階1（データと同期）**: 段階0（土台。起動アニメーション → ログインの画面 → 持ち主の確かめ → トップと設定）に、データの型と部品（名札・上限・強調・直し）、
同期のエンジン（版と話題を受け取る・既読と「知ってる」を送る・30日で消す）、端末の保存（Dexie v2）、アクセスルール・索引、作り物の版、開発の道具（エミュレーターに入れる道具・開発用のフック）、
トップの仮の一覧（見出しだけ）とヘッダーの同期の表示を足した。版の画面（一覧のカード・詳細など）は段階2、Claude 用のコネクタは段階3で作る（作る順番は仕様書の 11.、段階0で作った物は 14.、段階1は 16.）。

## 使い方（開発）

Node.js 24 LTS（22 以上なら動く）。

```bash
npm ci
npm run dev           # http://localhost:5173 で起動
npm run typecheck     # 型の確かめ
npm test              # 単体テスト（Vitest。scripts/ のテストも）
npm run test:sync     # 持ち主の関所・アクセスルール・同期のテスト（Firebase エミュレーター。Java 21 以上）
npm run test:e2e      # E2E テスト（Playwright。PC・スマホ・タブレットの Chromium。E2E_WEBKIT=1 で iPhone 14 も）
npm run test:e2e:sync # 持ち主の関所と同期の E2E（Firebase エミュレーター）
npm run seed:emu -- --days 35  # 動いているエミュレーターに作り物の版を入れる（docs/DEPLOY.md の 7）
npm run e2e:tags      # E2E のテストに端末の印（@pc・@s・@m・@ios）があるかの確かめ
npm run build         # dist/ に本番ビルド（PWA）
npm run format        # Prettier で整形
npm run deploy        # Firebase Hosting とアクセスルール・索引を公開（docs/DEPLOY.md）
```

CI（`.github/workflows/ci.yml`）は、ブランチ `main`・`master`・`claude/**`・`ccr-**` への push と、pull request のたびに 型・整形・端末の印・単体テスト・エミュレーターのテスト（持ち主の関所・アクセスルール・2台の同期・段階0からの上がり）・ビルド・ビルドにテスト用の入口（ログインの印・`window.__ts`）と作り物の版・作り物の社の一覧が無いことの確かめ・E2E（Chromium と iPhone の WebKit）と、持ち主の関所と同期の E2E（作り物の版がトップの仮の一覧に出る・2つのブラウザで既読と「知ってる」が移る）を動かす。

## 構成

```
src/domain/    純粋な計算（テスト済み）
src/db/        端末の中の保存（Dexie v2。Claude の記録の写し・アプリの記録・送信待ち・_meta）
src/sync/      ログインと持ち主の関所・同期のエンジンと司令塔・同期の表示（Firebase）
src/store/     状態（Zustand）
src/ui/        共通の部品（ヘッダー・ダイアログ・アイコンなど）
src/features/  各画面（トップ・ログイン・設定）
src/launch/    起動アニメーションと最初の描画の前の外観（launch.js。ビルドの時に index.html へ埋め込む）
scripts/       公開（deploy.mjs）・アイコン（icon-art.mjs・render-icons.mjs）・エミュレーターに作り物の版を入れる（seed-emulator.mjs）スクリプト
e2e/           Playwright の E2E テスト
```
