// E2E のテストの入口（B8。段階3の設計の 7. の「E2E」・6.1 の B8。connector/wrangler.e2e.jsonc の main）。連携の通しの E2E
// （e2e/pairing.sync.spec.ts）が wrangler の createTestHarness で、この入口の Worker を立ち上げる（workerd。Durable Object・KV も本物）。
// - Worker の口（OAuth・連携・/mcp・cron）は本番の src/index.ts をそのまま使う。本番の入口と wrangler.jsonc には切り替えを持たせない
// - Durable Object の Vault だけを、本番の src/vault/Vault.ts の子の型にする。替えるのは VaultCore に渡す物（static coreDeps）のうち
//   作り物の社（src/test/fixtures/fakeOutlets.ts の FAKE_OUTLETS）・作り物の出どころの data（test/support/fakeNews.ts の FAKE_SOURCES・
//   FAKE_PENDING。HTML は本番と同じ HTMLRewriter で読む）・作り物の出どころの fetch（FakeNews。日付は今の時刻から数える
//   test/e2e/freshNews.ts）の3つだけ。殻（RPC の口と alarm）・SQL の口・ほかに渡す物は本番の物をそのまま使う（test/unit/e2eEntry.test.ts が
//   確かめる）
// - この Worker の中のグローバルの fetch は、手元のエミュレーター（127.0.0.1・localhost）のほかへは出さない（府省・庁や Global Voices の
//   サイト・本物の Firebase へは出ない。出ようとしたら送らずに失敗する。test/e2e/loopbackFetch.ts。test/support/netGuard.ts と同じ決まり）
// 公開する形（npm --prefix connector run bundle-check）は本番の wrangler.jsonc だけをまとめるので、この入口は入らない（connector/test/ が
// 入っていないことも確かめる）
import { FAKE_OUTLETS } from '../../../src/test/fixtures/fakeOutlets'
import type { Env } from '../../src/env'
import { DEFAULT_FETCH_ENV } from '../../src/fetch/article'
import worker from '../../src/index'
import type { VaultDeps } from '../../src/vault/core'
import { createFetchWork } from '../../src/vault/tools/fetch'
import { Vault as ProdVault } from '../../src/vault/Vault'
import { FAKE_PENDING, FAKE_SOURCES, FakeNews } from '../support/fakeNews'
import { seedFreshNews } from './freshNews'
import { loopbackOnly } from './loopbackFetch'

// ---------- 外へ出ない fetch（手元のエミュレーターのほかへは送らない） ----------

globalThis.fetch = loopbackOnly(globalThis.fetch.bind(globalThis))

// ---------- 作り物の出どころで動く Vault ----------

/** E2E の Vault（本番の Vault の子の型。VaultCore に渡す物に、作り物の社・出どころの3つだけを足す） */
export class Vault extends ProdVault {
  static override coreDeps(ctx: DurableObjectState, env: Env): VaultDeps {
    // 作り物の出どころの中身（呼ばれた時の時刻から数えた日付。本物の時計で動くので、いつ流しても窓の中に候補がそろう）
    const news = seedFreshNews(
      new FakeNews({
        get now() {
          return Date.now()
        },
      }),
      () => Date.now(),
    )
    return {
      ...super.coreDeps(ctx, env),
      outlets: FAKE_OUTLETS,
      fetchWork: createFetchWork({ ...DEFAULT_FETCH_ENV, sources: FAKE_SOURCES, pending: FAKE_PENDING }),
      sourceFetch: news.fetch as typeof fetch,
    }
  }
}

// Worker の口は本番のまま（src/index.ts の fetch・scheduled）
export default worker
