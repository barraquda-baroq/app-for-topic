// Vault の Durable Object（SQLite）。中身は core.ts の VaultCore。Worker からは RPC で呼ぶ（NS の connector/src/vault/Vault.ts を写した物）。
// 持ち主ごとに1つ（idFromName('owner')、locationHint 'apac'）。alarm は1つの DO に1つだけなので、やる事（候補集めの続き・決まりの読み・
// 気象庁の見張り・回の期限・写しの続き）は VaultCore のやる事の表（store.ts の tasks。鍵は runs.ts）に持ち、いちばん早い物の時刻に
// 置き直す（設計の 1.1 の「DO の殻」）
import { DurableObject } from 'cloudflare:workers'
import { vaultConfig, type Env } from '../env'
import { logError } from '../log'
import { VaultCore, type CallOptions, type GrantProps, type HealthState, type PairingCheck, type VaultDeps } from './core'
import { ConnectorError, MESSAGES } from './errors'
import type { RateKind, RateResult } from './ratelimit'
import type { SqlRunner, SqlValue } from './store'
import type { ToolResult } from './tools/common'

function doSql(storage: DurableObjectStorage): SqlRunner {
  return {
    all<T>(sql: string, ...params: SqlValue[]): T[] {
      return storage.sql.exec(sql, ...params).toArray() as T[]
    },
    run(sql: string, ...params: SqlValue[]): void {
      storage.sql.exec(sql, ...params)
    },
    transaction<T>(fn: () => T): T {
      return storage.transactionSync(fn)
    },
  }
}

export class Vault extends DurableObject<Env> {
  readonly #core: VaultCore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // 渡す物は、作った型（new.target）の coreDeps から（E2E のテストの入口の子の型が替える）
    this.#core = new VaultCore((new.target as typeof Vault).coreDeps(ctx, env))
  }

  /**
   * VaultCore に渡す物。本番は既定の社の一覧・出どころの data・グローバルの fetch を使う（outlets・fetchWork・sourceFetch を渡さない）。
   * E2E のテストの入口（test/e2e/worker.ts）は、この型の子の型でここだけを替え、作り物の社・出どころの3つを足す（設計の 7. の「E2E」）。
   * static にしたのは、RPC の口（型の関数）に出さないため
   */
  static coreDeps(ctx: DurableObjectState, env: Env): VaultDeps {
    return {
      sql: doSql(ctx.storage),
      fetch: (input, init) => fetch(input, init),
      config: vaultConfig(env),
      secret: env.TOKEN_ENC_KEY,
      schedule: (at) => {
        if (at === null) void ctx.storage.deleteAlarm()
        else void ctx.storage.setAlarm(at)
      },
    }
  }

  /** RPC では例外を投げず、結果で返す（workerd が「受け取られない例外」として記録しないように） */
  async connectIdentity(): Promise<
    { ok: true; uid: string; version: string; model: number } | { ok: false; code: string; message: string }
  > {
    try {
      return { ok: true, ...(await this.#core.connectIdentity()) }
    } catch (e) {
      if (e instanceof ConnectorError) return { ok: false, code: e.code, message: e.message }
      logError('identity_failed', e)
      return { ok: false, code: 'unavailable', message: MESSAGES.unavailable }
    }
  }

  health(): HealthState {
    return this.#core.health()
  }

  verifyPairing(hash: string): Promise<PairingCheck> {
    return this.#core.verifyPairing(hash)
  }

  pairingState(): 'paired' | 'unpaired' {
    return this.#core.pairingState()
  }

  /**
   * トークンの更新の前: OAuth の許可が、いまの連携（同じ持ち主・同じ代）の、接続の一覧にある接続のものか
   * （一時的に読めない時は true。解除された・一覧から外された接続は false）
   */
  checkGrant(props: GrantProps | null | undefined): Promise<boolean> {
    return this.#core.checkGrant(props)
  }

  callTool(name: string, args: Record<string, unknown>, opts: CallOptions): Promise<ToolResult> {
    return this.#core.callTool(name, args, opts)
  }

  takeRate(kind: RateKind, bucket?: string): RateResult {
    return this.#core.takeRate(kind, bucket)
  }

  /** 同意の承認を1回だけ通す（POST /authorize。KV に承認の後の取引を書く前） */
  claimConsent(key: string): boolean {
    return this.#core.claimConsent(key)
  }

  nightly(): Promise<'ok' | 'skipped'> {
    return this.#core.nightly()
  }

  /** 持ち主の uid（連携を解除した時の OAuth の許可の取り消しに使う） */
  ownerUid(): string | null {
    return this.#core.pairing().ownerUid
  }

  async alarm(): Promise<void> {
    try {
      const next = await this.#core.alarm()
      if (next !== null) await this.ctx.storage.setAlarm(next)
    } catch (e) {
      logError('alarm_failed', e)
    }
  }
}

/** Worker から Vault を呼ぶ（持ち主ごとに1つ） */
export function vault(env: Env): DurableObjectStub<Vault> {
  const ns = env.VAULT as DurableObjectNamespace<Vault>
  return ns.get(ns.idFromName('owner'), { locationHint: 'apac' })
}
