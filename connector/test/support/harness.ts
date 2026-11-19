// テスト用: 小さな Firebase（fakeFirebase.ts）につないだ Vault の中身と、連携の用意（NS の connector/test/support/harness.ts を写し、
// TS の接続の一覧の形（v2 だけ。接続は2まで）にした。写しの取り込み・記録の用意は B3 以降で足す）。
import type { VaultConfig } from '../../src/config'
import { CONNECTOR_MODEL } from '../../src/version'
import { VaultCore, type GrantProps } from '../../src/vault/core'
import { pairingHash } from '../../src/vault/crypto'
import { FakeFirebase } from './fakeFirebase'
import { nodeSql } from './nodeSql'

export const OWNER = 'owner-uid-1'
export const SECRET = 'test-secret-0123456789abcdef0123456789'

export function config(fake: FakeFirebase, over: Partial<VaultConfig> = {}): VaultConfig {
  return {
    projectId: fake.project,
    apiKey: 'test-api-key',
    identityUrl: fake.identityUrl,
    tokenUrl: fake.tokenUrl,
    firestoreUrl: fake.firestoreUrl,
    workBudgetChars: 300_000,
    dailyReadBudget: 15_000,
    dailyWriteBudget: 5_000,
    ...over,
  }
}

export interface Clock {
  now: number
}

export function makeCore(
  fake: FakeFirebase,
  opts: {
    clock?: Clock
    config?: Partial<VaultConfig>
    secret?: string
    sql?: ReturnType<typeof nodeSql>
    /** fake.fetch の代わり（答えを遅らせるテスト用） */
    fetch?: typeof fetch
    /** 1回の要求を待つ上限（ms。答えの来ない要求のテスト用） */
    timeoutMs?: number
  } = {},
) {
  const clock = opts.clock ?? { now: Date.UTC(2026, 10, 19, 3, 0, 0) }
  const sql = opts.sql ?? nodeSql()
  const scheduled: (number | null)[] = []
  const core = new VaultCore({
    sql,
    fetch: opts.fetch ?? (fake.fetch as typeof fetch),
    config: config(fake, opts.config),
    secret: opts.secret ?? SECRET,
    now: () => clock.now,
    sleep: async () => undefined,
    schedule: (at) => scheduled.push(at),
    timeoutMs: opts.timeoutMs,
  })
  return { core, sql, clock, scheduled }
}

/**
 * 連携した Vault（アプリの許可の接続の一覧の形。接続の id は cid・名前は name。既定は c1「接続1」）。grant はその許可の props。
 * model: null で meta/app を書かない（データの形の版が無い）
 */
export async function pairedCore(
  fake: FakeFirebase,
  opts: Parameters<typeof makeCore>[1] & { writes?: boolean; model?: number | null; cid?: string; name?: string } = {},
) {
  const made = makeCore(fake, opts)
  const { uid } = await made.core.connectIdentity()
  fake.setOwner(OWNER)
  if (opts.model !== null) fake.setAppModel(OWNER, opts.model ?? CONNECTOR_MODEL)
  const cid = opts.cid ?? 'c1'
  const hash = await pairingHash(`state-${cid}`, 'k'.repeat(43))
  fake.addConnection({
    uid,
    cid,
    name: opts.name ?? '接続1',
    pairing: hash,
    writes: opts.writes ?? true,
    pairedAt: made.clock.now,
  })
  const r = await made.core.verifyPairing(hash)
  if (!r.ok) throw new Error(`連携できません: ${r.reason}`)
  const grant: GrantProps = { ownerUid: r.ownerUid, gen: r.gen, cid: r.cid }
  return { ...made, uid, grant }
}

/** アプリでもう1つ接続を許可して、コネクタで確かめる（/pair/callback と同じ）。その許可の props を返す */
export async function addConnection(
  fake: FakeFirebase,
  core: VaultCore,
  uid: string,
  c: { cid: string; name?: string; pairedAt: number; replaceCid?: string; state?: string },
): Promise<GrantProps> {
  const hash = await pairingHash(c.state ?? `state-${c.cid}`, 'k'.repeat(43))
  fake.addConnection({ uid, cid: c.cid, name: c.name ?? c.cid, pairing: hash, pairedAt: c.pairedAt, replaceCid: c.replaceCid })
  const r = await core.verifyPairing(hash)
  if (!r.ok) throw new Error(`連携できません: ${r.reason}`)
  return { ownerUid: r.ownerUid, gen: r.gen, cid: r.cid }
}
