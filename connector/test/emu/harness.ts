// エミュレーターの結合テストの用意（B3。NS の connector/test/emu/harness.ts の形を、TS のエミュレーターの道具 src/test/emulatorAdmin.ts の上に
// 作り直した）: コネクタの Vault の中身（node:sqlite・本物の fetch で Auth・Firestore のエミュレーターにつなぐ）と、本番のアクセスルール
// （firestore.rules）・管理者の権限での持ち主・連携の記録・記録の用意。
// - コネクタの用意は adminCreateOwner と adminWriteConnector(匿名の uid, { writes })、解除は adminDeleteConnector（連携の画面を通さない。
//   既定の cid は ADMIN_CONNECTION_ID、指紋は ADMIN_PAIRING）。/pair/callback の通しを試す時は、本物の指紋を pairing に渡す
// - 出どころへの取りに行きは、ここでは何もしない（既定は test/support/fakeNews.ts の idleFetchWork。作り物の出どころは同じファイルの
//   fakeFetchWork を fetchWork・sourceFetch で渡す）。テストの fetch は、エミュレーター（127.0.0.1）のほかへ出たら落ちる（test/support/netGuard.ts）
// アプリの同期のエンジンと一緒に動かす結合の場面（connector.emu.test.ts）は B8 が足す。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeRecord, type Rec } from '../../../src/sync/codec'
import type { Place, TableName } from '../../../src/domain/types'
import {
  ADMIN_CONNECTION_ID,
  ADMIN_PAIRING,
  adminCreateOwner,
  adminWriteConnector,
  adminWriteRecords,
  clearFirestore,
  emulatorRequest,
  EMU_PROJECT,
  useRules,
  type AdminConnectorOptions,
} from '../../../src/test/emulatorAdmin'
import type { VaultConfig } from '../../src/config'
import { CONNECTOR_MODEL } from '../../src/version'
import { VaultCore, type GrantProps, type VaultDeps } from '../../src/vault/core'
import { idleFetchWork } from '../support/fakeNews'
import { nodeSql } from '../support/nodeSql'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')

/** 本番のアクセスルール（firestore.rules）と、エミュレーター用のルール */
export const prodRules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8')
export const emuRules = fs.readFileSync(path.join(root, 'firestore.emu.rules'), 'utf8')

export { ADMIN_CONNECTION_ID, ADMIN_PAIRING, clearFirestore, EMU_PROJECT, useRules }

/** エミュレーターにつなぐ設定（キーは作り物。エミュレーターは何でも受け付ける） */
export function emuConfig(over: Partial<VaultConfig> = {}): VaultConfig {
  return {
    projectId: EMU_PROJECT,
    apiKey: 'emulator-key',
    identityUrl: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1',
    tokenUrl: 'http://127.0.0.1:9099/securetoken.googleapis.com/v1',
    firestoreUrl: 'http://127.0.0.1:8080/v1',
    workBudgetChars: 300_000,
    dailyReadBudget: 15_000,
    dailyWriteBudget: 5_000,
    ...over,
  }
}

/** テストごとに別の持ち主の uid（エミュレーターの文書が混ざらないように） */
export const ownerUid = () => `owner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export interface EmuVault {
  core: VaultCore
  clock: { now: number }
  /** 匿名のアカウント（コネクタの身元）の uid */
  uid: string
  owner: string
  grant: GrantProps
}

/** Vault の中身を作る（node:sqlite・本物の fetch。時計はテストが進める。alarm の予約は覚えるだけ） */
export function makeVault(
  opts: { now?: number; config?: Partial<VaultConfig> } & Partial<Pick<VaultDeps, 'fetchWork' | 'sourceFetch' | 'outlets'>> = {},
) {
  const clock = { now: opts.now ?? Date.now() }
  let seq = 0
  const core = new VaultCore({
    sql: nodeSql(),
    fetch: (input, init) => fetch(input, init),
    config: emuConfig(opts.config),
    secret: 'emu-test-secret-0123456789abcdef0123456789',
    now: () => clock.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
    schedule: () => undefined,
    fetchWork: opts.fetchWork ?? idleFetchWork(),
    sourceFetch: opts.sourceFetch,
    outlets: opts.outlets,
    random: () => `e${(seq++).toString(36).padStart(3, '0')}`,
  })
  return { core, clock }
}

/** アプリのデータの形の版（users/{owner}/meta/app の model。書き込みの前にコネクタが読む） */
export async function adminSetAppModel(owner: string, model: number = CONNECTOR_MODEL): Promise<void> {
  await emulatorRequest('PATCH', `/v1/projects/${EMU_PROJECT}/databases/(default)/documents/users/${owner}/meta/app`, {
    fields: {
      model: { integerValue: String(model) },
      appVersion: { stringValue: '0.1' },
      updatedAt: { timestampValue: new Date().toISOString() },
    },
  })
}

/**
 * 連携した Vault（持ち主の記録・連携の記録を管理者の権限で書き、コネクタの確かめ（verifyPairing）を通す）。
 * connector は adminWriteConnector の中身（writes など）。model: null でデータの形の版を書かない
 */
export async function pairedVault(
  opts: Parameters<typeof makeVault>[0] & { owner?: string; connector?: AdminConnectorOptions; model?: number | null } = {},
): Promise<EmuVault> {
  const { core, clock } = makeVault(opts)
  const owner = opts.owner ?? ownerUid()
  const { uid } = await core.connectIdentity()
  await adminCreateOwner(owner)
  if (opts.model !== null) await adminSetAppModel(owner, opts.model ?? CONNECTOR_MODEL)
  await adminWriteConnector(uid, { pairedAt: new Date(clock.now), ...opts.connector })
  const r = await core.verifyPairing(opts.connector?.pairing ?? ADMIN_PAIRING)
  if (!r.ok) throw new Error(`連携できません: ${r.reason}`)
  return { core, clock, uid, owner, grant: { ownerUid: r.ownerUid, gen: r.gen, cid: r.cid } }
}

/** 記録を、コネクタが書いた形（外側の8つの欄）で、並びの順に updated を進めて置く（管理者の権限） */
export async function seedRecords(
  owner: string,
  records: readonly { table: TableName; record: Rec }[],
  opts: { place?: Place; device?: string; startAt?: number } = {},
): Promise<void> {
  const start = opts.startAt ?? Date.now() - records.length * 1_000 - 60_000
  await adminWriteRecords(
    owner,
    opts.place ?? 'records',
    records.map((r, i) => {
      const enc = encodeRecord(r.record)
      return {
        table: r.table,
        id: r.record.id,
        json: enc.json,
        hash: enc.hash,
        device: opts.device,
        updated: new Date(start + i * 1_000),
      }
    }),
  )
}

/** alarm を、やる事が無くなるまで（か n 回まで）呼ぶ（写しの続きなど。時計は次のやる事の時刻まで、within の中だけ進める） */
export async function drainAlarms(v: { core: VaultCore; clock: { now: number } }, opts: { n?: number; within?: number } = {}) {
  const until = v.clock.now + (opts.within ?? 10 * 60_000)
  for (let i = 0; i < (opts.n ?? 50); i++) {
    const next = await v.core.alarm()
    if (next === null || next > until) return
    if (next > v.clock.now) v.clock.now = next
  }
}
