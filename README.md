# Topic Studio

個人用のニュースアプリ（Web アプリ・PWA）。ニュースの一覧が最初から AI の要約になっていて、「だから何？」・AI の見解と対立見解・小学生にも分かる用語の注釈が付く。

- 仕様書: [docs/SPEC.md](docs/SPEC.md)
- 公開の準備と手順: [docs/DEPLOY.md](docs/DEPLOY.md)（作者はまずここ）
- 構成は Novel Studio・Diary Studio と同じ（React・TypeScript・Vite・Dexie・Firebase）。ニュースを集めて書くのは claude.ai の定期実行で、Claude 用のコネクタからアプリに足す。

このリポジトリには、集めた記事・書いた要約などのニュースの中身は入れない（仕様書の 3.）。

## 今の状態

**段階2（画面）**: 段階1（データと同期。段階0の土台に、データの型と部品・同期のエンジン・端末の保存（Dexie v2）・アクセスルール・作り物の版・開発の道具）に、
版を読む画面を足した。トップ（スマホは総合とジャンルの区切り・PC は国内｜世界の2列・一覧のカード・既読 n件・状態の1行・追いつきの帯）、
話題の詳細（スマホは下からのシート・PC は列に重ねるパネル。本文の強調と用語の印・［知ってる］・訂正・続報・［クリップ］）、版の一覧と前の版・追いつきの画面、
ヘッダーの版の表示と同期の表示、設定の文字の大きさと「知ってる」にした語、見本を撮る道具。見本は作者に送り、答えをもらった（2026-11-19。見た目はすべて今の決め方のまま。仕様書の 17.1）。
Claude 用のコネクタは段階3で作る（作る順番は仕様書の 11.、段階0で作った物は 14.、段階1は 16.、段階2は 17.。見本の問いは [docs/STAGE2-LOOKS.md](docs/STAGE2-LOOKS.md)）。

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
npm run samples       # 段階2の見本を撮って見本のページを作る（開発サーバーと作り物の版だけ。SAMPLES_OUT=/どこか で出し先。無ければ e2e/artifacts/samples）
npm run build         # dist/ に本番ビルド（PWA）
npm run format        # Prettier で整形
npm run deploy        # Firebase Hosting とアクセスルール・索引を公開（docs/DEPLOY.md）
```

CI（`.github/workflows/ci.yml`）は、ブランチ `main`・`master`・`claude/**`・`ccr-**` への push と、pull request のたびに 型・整形・端末の印・単体テスト（`scripts/` のテストも）・
エミュレーターのテスト（持ち主の関所・アクセスルール・2台の同期・段階0からの上がり）・ビルド・ビルドにテスト用の入口（ログインの印・`window.__ts` とその関数）と作り物の版・
作り物の社の一覧が無いことの確かめ・E2E（PC・Android・タブレットの Chromium と、iPhone の WebKit）と、持ち主の関所と同期の E2E（作り物の版がトップに出る・
2つのブラウザで既読と「知ってる」が移る）を動かす。見本（`npm run samples`）は CI では流さない。

## 構成

```
src/domain/    純粋な計算（テスト済み）
src/db/        端末の中の保存（Dexie v2。Claude の記録の写し・アプリの記録・送信待ち・_meta）
src/sync/      ログインと持ち主の関所・同期のエンジンと司令塔・同期の表示（Firebase）
src/store/     状態（Zustand）
src/ui/        共通の部品（ヘッダーと版の表示・同期の表示・ダイアログ・小窓・アイコンなど）
src/features/  各画面（top: トップと前の版・topic: 話題の詳細・editions: 版の一覧と追いつき・login: ログイン・appSettings: 設定）
src/launch/    起動アニメーションと最初の描画の前の外観（launch.js。ビルドの時に index.html へ埋め込む）
scripts/       公開（deploy.mjs）・アイコン（icon-art.mjs・render-icons.mjs）・エミュレーターに作り物の版を入れる（seed-emulator.mjs）・見本の案と見本のページ（sample-variants.mjs・sample-sheet.mjs）スクリプト
e2e/           Playwright の E2E テスト（e2e/samples/ は見本を撮る物）
```
