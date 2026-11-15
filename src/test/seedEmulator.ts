// 作り物の版を Firebase エミュレーターに入れる道具の中身（docs/SPEC.md の 16.3 の「エミュレーターに入れる」）。scripts/seed-emulator.mjs
// （npm run seed:emu -- --days 35）が vite の runnerImport でこのファイルを読み込んで動かし、同期の E2E（e2e/data.sync.spec.ts）も
// 同じ物を使う（どちらも同じ形の文書になるように）。
// - 作り物の版は src/test/fixtures/fakeEditions.ts の makeFakeMonth から作り、fakeRecordsOf の順（作った時刻の順。辞書の束 → 話題 → 版）に書く
// - 書くのは管理者の権限（Authorization: Bearer owner。ルールを通らない。src/test/emulatorAdmin.ts の adminWriteRecords）で、
//   コネクタと同じ外側の8つの欄（chunks: 0・deleted: false・device: 'claude-connector'。src/sync/codec.ts の encodeRecord。7.7）
// - updated は記録の作った時刻（版の日時に合わせた過去の時刻）。日数を32日より多くすると、初めての受け取りの窓（端末の時計 − 32日。7.8）
//   より前の物も混ざり、新しい端末が受け取らない事を目で確かめられる
// - 今より後の updated は書かない（購読の位置が先に進み、その後にアプリが書いた記録を受け取れなくなるため）。いちばん新しい版の枠は、
//   既定では2時間より前に始まった枠（訂正は版の 85分後まで足すので、どの記録も今より前になる）
// エミュレーター（127.0.0.1:8080。プロジェクト demo-topic-studio）にだけ書く。本物のプロジェクトには届かない。
// Node（scripts/seed-emulator.mjs・Playwright の Node の側）で動くので、ブラウザ・Dexie・React に頼らない
import { firstSyncSinceMs, isWithinRetention, latestSlotAt } from '../domain/jst'
import { CONNECTOR_TABLES, type ConnectorTableName, type Place, type Slot } from '../domain/types'
import { encodeRecord, placeOf } from '../sync/codec'
import { adminCreateOwner, adminGoogleUser, adminWriteRecords, type AdminRecordDoc } from './emulatorAdmin'
import { fakeRecordsOf, makeFakeMonth, type FakeMonth, type FakeRecord } from './fixtures/fakeEditions'

/** 既定の値（npm run seed:emu の引数を省いた時） */
export const SEED_DEFAULTS = {
  /** 何日分か（32日より多くして、初めての受け取りの窓より前の物も混ぜる。16.3） */
  days: 35,
  /** 作り物の乱数の種（makeFakeMonth の既定と同じ） */
  seed: 'fake-month',
  /** エミュレーターの仮の Google アカウント（window.__ts.signInForTest と同じ sub。メールは '{sub}@example.com'） */
  sub: 'dev-author',
} as const

/** いちばん新しい版の枠を、今からこれより前に始まった枠にする（訂正は版の 85分後まで足すので、どの記録も今より前になる） */
export const SEED_LATEST_SLOT_AGO_MS = 2 * 60 * 60 * 1000

/** いちばん新しい版の枠の既定（2時間より前に始まった、いちばん新しい枠） */
export function seedWindow(nowMs: number): { until: string; untilSlot: Slot } {
  const s = latestSlotAt(nowMs - SEED_LATEST_SLOT_AGO_MS)
  return { until: s.date, untilSlot: s.slot }
}

export interface SeedOptions {
  /** 何日分か（3以上。makeFakeMonth の days） */
  days?: number
  /** 乱数の種 */
  seed?: string
  /** いちばん新しい版の日付（'YYYY-MM-DD'。日本時間。省くと seedWindow） */
  until?: string
  /** until の日の最後の枠（until を省いた時は seedWindow の枠。until だけ渡した時は '20'） */
  untilSlot?: Slot
  /** 今の時刻（既定は Date.now()。テストで決める） */
  nowMs?: number
}

/** 入れる物の見積もり（書く前に作る。書いた後もこれを返す） */
export interface SeedPlan {
  month: FakeMonth
  until: string
  untilSlot: Slot
  /** 書く文書（置き場ごと。並びは作った時刻の順） */
  docs: Record<Place, AdminRecordDoc[]>
  /** 表ごとの数 */
  counts: Record<ConnectorTableName, number>
  /** 合わせた数 */
  total: number
  /** いちばん新しい版の id */
  newestEditionId: string
  /** 初めての受け取りの窓（端末の時計 − 32日。src/domain/jst.ts の firstSyncSinceMs）より前の updated の文書の数 */
  beforeFirstSync: number
  /** 版の日付が30日の境の外の文書の数（クラウドの30日の手入れで消える物） */
  outsideRetention: number
}

/** 記録の版の日付（作り物の id はどれも 'YYYY-MM-DD-…' で始まる） */
const dateOfRecord = (r: FakeRecord): string => r.record.id.slice(0, 10)

/** 作り物の記録1件を、コネクタと同じ外側の文書にする（updated は作った時刻） */
export function seedDocOf(r: FakeRecord): AdminRecordDoc {
  const enc = encodeRecord(r.record)
  return { table: r.table, id: r.record.id, json: enc.json, hash: enc.hash, updated: new Date(r.record.createdAt) }
}

/** 入れる物を作る（書かない）。今より後の updated になる時は断る */
export function seedPlan(opts: SeedOptions = {}): SeedPlan {
  const nowMs = opts.nowMs ?? Date.now()
  const days = opts.days ?? SEED_DEFAULTS.days
  const auto = seedWindow(nowMs)
  const until = opts.until ?? auto.until
  const untilSlot = opts.untilSlot ?? (opts.until ? '20' : auto.untilSlot)
  const month = makeFakeMonth({ until, days, seed: opts.seed ?? SEED_DEFAULTS.seed, untilSlot })
  const records = fakeRecordsOf(month)
  const latest = Math.max(...records.map((r) => r.record.createdAt))
  if (latest > nowMs) {
    throw new RangeError(
      `いちばん新しい作り物の記録の時刻（${new Date(latest).toISOString()}）が今より後です。--until を前の日にするか、--until-slot を 12 にしてください`,
    )
  }
  const docs: Record<Place, AdminRecordDoc[]> = { records: [], private: [] }
  const counts = Object.fromEntries(CONNECTOR_TABLES.map((t) => [t, 0])) as Record<ConnectorTableName, number>
  const since = firstSyncSinceMs(nowMs)
  let beforeFirstSync = 0
  let outsideRetention = 0
  for (const r of records) {
    docs[placeOf(r.table)].push(seedDocOf(r))
    counts[r.table] += 1
    if (r.record.createdAt < since) beforeFirstSync += 1
    if (!isWithinRetention(dateOfRecord(r), nowMs)) outsideRetention += 1
  }
  return {
    month,
    until,
    untilSlot,
    docs,
    counts,
    total: records.length,
    newestEditionId: month.editions[month.editions.length - 1].edition.id,
    beforeFirstSync,
    outsideRetention,
  }
}

/** 書く先のアカウント（uid を渡せばそのまま。無ければ sub の仮の Google アカウントをエミュレーターに作る・入り直して uid を引く） */
export async function seedTargetUid(target: { uid?: string; sub?: string }): Promise<string> {
  if (target.uid) return target.uid
  return adminGoogleUser(target.sub ?? SEED_DEFAULTS.sub)
}

/**
 * 作り物の版をエミュレーターに書く（管理者の権限。作った時刻の順に、まとめて書く）。owner なら持ち主の記録 config/owner も
 * そのアカウントにする（VITE_E2E_OWNER_LOCK=1 の開発サーバーで開く時。ふだんのエミュレーターの開発サーバーは持ち主を確かめない）
 */
export async function seedEmulator(uid: string, opts: SeedOptions & { owner?: boolean } = {}): Promise<SeedPlan> {
  const plan = seedPlan(opts)
  if (opts.owner) await adminCreateOwner(uid)
  for (const place of ['records', 'private'] as const) {
    if (plan.docs[place].length) await adminWriteRecords(uid, place, plan.docs[place])
  }
  return plan
}
