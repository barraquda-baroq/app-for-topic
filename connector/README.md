# Topic Studio コネクタ（Claude 用のリモート MCP サーバー）

Cloudflare Worker（無料プラン）で動く、Topic Studio 専用のコネクタです。claude.ai の定期実行（毎日 10:16・18:16）が、このコネクタの道具で
候補と資料を読み、下書き・照合を経て、版・話題・辞書・作れなかった印・訂正をアプリに足します（足すだけ。消す・直すはしません）。
NS（Novel Studio）のコネクタを写した形で、OAuth・連携・`/mcp`・身元・暗号・上限はそのまま、ツール・写し・回・下書きと照合・取りに行く所・
係ごとの決まりの文を TS の物にしました。

- 準備・使い方・止め方・つながらない時・出どころ: [../docs/CONNECTOR.md](../docs/CONNECTOR.md)（Windows でも Mac でも同じ手順）
- 定期実行の依頼文・作り方・報告の読み方・止め方: [../docs/SCHEDULE.md](../docs/SCHEDULE.md)
- 準備（初めての時に1回）: リポジトリの直下で `npm run connector:setup`
- 公開（更新）: リポジトリの直下で `npm run deploy`（アプリ・アクセスルールと一緒に）
- 確かめ: `npm run connector:check`
- テスト: `npm run test:connector`（単体・workerd・公開する形）、`npm run test:connector:emu`（Firebase エミュレーター）
- アプリとの連携の決まり（URL の形・k・指紋・15分・接続は2まで）は `../src/claude/pairing.ts`（アプリの連携の画面と同じファイル）
- 取りに行くのは、作者が許した出どころ（府省・庁の発表と Global Voices。`src/fetch/sources.ts` の data）だけ。名乗りを正直にし、
  robots.txt・規約・RSS の利用条件の断りをすり抜けない（docs/CONNECTOR.md の 8・9）
- テストは作り物だけを使い、外のサイトへは出ません（`test/support/netGuard.ts` が、手元のエミュレーターのほかへの fetch でテストを落とす）

部品の版は決めてあります（`package.json`。NS と同じ、公開から2週間以上たった版）。`npm --prefix connector ci` で入れてください。

| フォルダ       | 中身                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` | OAuth（`@cloudflare/workers-oauth-provider`）の設定・毎日の cron（OAuth の片付け・写しの数・古い回・robots.txt と AI の意思表示の読み・日曜は規約のページの見張り）                    |
| `src/auth/`    | 受け付けるクライアント・同意の画面・連携の確かめ（`/authorize`・`/pair/callback`・`/connect/identity`）                                                                                |
| `src/mcp/`     | MCP のサーバー（`@modelcontextprotocol/server`。状態を持たない）・ツールの一覧・入力の形（`schemas.ts` → `schemas.gen.ts`）・サーバーの説明                                            |
| `src/vault/`   | Vault（Durable Object）: 匿名の身元・写し・辞書の今の形・回・下書きと照合・書き込み・数の上限・ツールの結果                                                                            |
| `src/fetch/`   | 出どころの data・取りに行く時の決まり（名乗り・robots.txt・AI への意思表示・規約・URL・間）・RSS と Atom と HTML の一覧・本文・気象庁の電文・見張り                                    |
| `src/guide/`   | 係ごとの決まりの文（`topic_get_guide`。選ぶ係・書く係・照合の係・訂正）                                                                                                                |
| `scripts/`     | 準備・公開・確かめ・テスト・JSON Schema の作り直し・公開する形の確かめ（Node だけ。シェルを使わない）                                                                                  |
| `test/unit`    | 単体テスト（Node。Firebase は `test/support/fakeFirebase.ts`、出どころは `test/support/fakeNews.ts` の作り物）                                                                         |
| `test/worker`  | Workers の実行環境（`@cloudflare/vitest-pool-workers`）でのテスト                                                                                                                      |
| `test/emu`     | Firebase エミュレーターでの結合テスト（本番のアクセスルールと一緒に）                                                                                                                  |
| `test/e2e`     | ブラウザの E2E（`../e2e/pairing.sync.spec.ts`）が起こすテストの入口（`wrangler.e2e.jsonc`。本番の `src/index.ts` に、作り物の社・出どころの Vault を差し込む。公開する形には入らない） |
