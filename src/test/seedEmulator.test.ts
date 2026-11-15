// エミュレーターに入れる道具の中身（src/test/seedEmulator.ts。docs/SPEC.md の 16.3 の「エミュレーターに入れる」）: コネクタと同じ外側の
// 文書になる・updated は作った時刻（過去）・32日より前の物も混ざる・今より後の updated を書かない・同じ種から同じ物。書く所は
// 管理者の道具（src/test/emulatorAdmin.ts）を差し替えて確かめる（エミュレーターに書く流れは e2e/data.sync.spec.ts）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stableStringify } from '../domain/equal'
import { editionIdOf } from '../domain/ids'
import { firstSyncSinceMs, isWithinRetention, slotTimeMs } from '../domain/jst'
import { CONNECTOR_DEVICE, docIdOf } from '../domain/types'
import { decodeDoc } from '../sync/codec'

const admin = vi.hoisted(() => ({
  adminWriteRecords: vi.fn(async () => {}),
  adminCreateOwner: vi.fn(async () => {}),
  adminGoogleUser: vi.fn(async (sub: string) => `uid-of-${sub}`),
}))
vi.mock('./emulatorAdmin', () => admin)

const { SEED_DEFAULTS, seedDocOf, seedEmulator, seedPlan, seedTargetUid, seedWindow } = await import('./seedEmulator')

/** 2026-11-15 14:30（日本時間） */
const NOW = Date.UTC(2026, 10, 15, 5, 30)
const HOUR = 60 * 60 * 1000

beforeEach(() => {
  for (const f of Object.values(admin)) f.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('いちばん新しい版の枠（seedWindow）', () => {
  it.each([
    ['14:30 → その日の 12:00版', Date.UTC(2026, 10, 15, 5, 30), '2026-11-15', '12'],
    ['13:59 → 前の日の 20:00版（12:00版は2時間より前に始まっていない）', Date.UTC(2026, 10, 15, 4, 59), '2026-11-14', '20'],
    ['22:00 → その日の 20:00版', Date.UTC(2026, 10, 15, 13, 0), '2026-11-15', '20'],
    ['21:59 → その日の 12:00版', Date.UTC(2026, 10, 15, 12, 59), '2026-11-15', '12'],
    ['0:30 → 前の日の 20:00版（日本時間の 0時をまたぐ）', Date.UTC(2026, 10, 14, 15, 30), '2026-11-14', '20'],
  ])('%s', (_, now, until, untilSlot) => {
    expect(seedWindow(now)).toEqual({ until, untilSlot })
    expect(slotTimeMs(until, untilSlot as '12' | '20')).toBeLessThanOrEqual(now - 2 * HOUR)
  })
})

describe('入れる物（seedPlan）', () => {
  const plan = seedPlan({ nowMs: NOW })
  const docs = plan.docs.records

  it('既定は35日分・種 fake-month・いちばん新しい版は2時間より前に始まった枠', () => {
    expect(SEED_DEFAULTS).toEqual({ days: 35, seed: 'fake-month', sub: 'dev-author' })
    expect(plan.until).toBe('2026-11-15')
    expect(plan.untilSlot).toBe('12')
    expect(plan.newestEditionId).toBe(editionIdOf('2026-11-15', '12'))
    // 35日 × 2枠 − 今日の 20:00版 − 作れなかった枠
    expect(plan.counts.editions).toBe(35 * 2 - 1 - 1)
    expect(plan.counts.topics).toBe(plan.counts.editions * 20)
    expect(plan.counts.termPacks).toBe(plan.counts.editions)
    expect(plan.counts.editionFails).toBe(1)
    expect(plan.counts.corrections).toBe(4)
    expect(plan.total).toBe(Object.values(plan.counts).reduce((a, b) => a + b, 0))
  })

  it('どれも Claude の記録なので records に書く（private には書かない）', () => {
    expect(docs).toHaveLength(plan.total)
    expect(plan.docs.private).toEqual([])
  })

  it('コネクタと同じ外側の文書: 戻すと同じ記録・device はコネクタ・updated は作った時刻', () => {
    const records = new Map(
      [
        ...plan.month.editions.flatMap((e) => [e.edition, e.termPack, ...e.topics]),
        ...plan.month.editionFails,
        ...plan.month.corrections,
      ].map((r) => [r.id, r]),
    )
    for (const d of docs) {
      const rec = records.get(d.id)!
      expect(d.device).toBeUndefined() // 既定（CONNECTOR_DEVICE）で書く
      expect(d.updated?.getTime()).toBe(rec.createdAt)
      const out = decodeDoc(
        {
          table: d.table,
          id: d.id,
          json: d.json,
          chunks: 0,
          deleted: false,
          hash: d.hash,
          updated: d.updated,
          device: CONNECTOR_DEVICE,
        },
        { docId: docIdOf(d.table as 'topics', d.id), place: 'records' },
      )
      expect(out.ok).toBe(true)
      if (out.ok) expect(stableStringify(out.record)).toBe(stableStringify(rec))
    }
    expect(seedDocOf({ table: 'editions', record: plan.month.editions[0].edition }).json).toBe(
      stableStringify(plan.month.editions[0].edition),
    )
  })

  it('作った時刻の順に並び、どれも今より前（購読の位置を先に進めない）', () => {
    const times = docs.map((d) => d.updated!.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(Math.max(...times)).toBeLessThan(NOW)
  })

  it('32日より前の物（新しい端末が受け取らない物）と、30日の境の外の物も混ざる', () => {
    const since = firstSyncSinceMs(NOW)
    expect(plan.beforeFirstSync).toBe(docs.filter((d) => d.updated!.getTime() < since).length)
    expect(plan.beforeFirstSync).toBeGreaterThan(0)
    expect(plan.outsideRetention).toBe(docs.filter((d) => !isWithinRetention(d.id.slice(0, 10), NOW)).length)
    expect(plan.outsideRetention).toBeGreaterThan(plan.beforeFirstSync)
    // 32日より前に作った版（初めての受け取りに入らない版）がある
    expect(plan.month.editions.some((e) => e.edition.createdAt < since)).toBe(true)
  })

  it('同じ種からは同じ物。種が違えば別の話題', () => {
    expect(seedPlan({ nowMs: NOW }).docs).toEqual(plan.docs)
    const other = seedPlan({ nowMs: NOW, seed: 'other' })
    expect(other.docs.records.find((d) => d.table === 'topics')?.id).not.toBe(docs.find((d) => d.table === 'topics')?.id)
  })

  it('日数・日付・枠を渡せる（日付だけ渡した時は 20:00版まで）', () => {
    const p = seedPlan({ nowMs: NOW, days: 3, until: '2026-11-14' })
    expect(p.until).toBe('2026-11-14')
    expect(p.untilSlot).toBe('20')
    expect(p.newestEditionId).toBe('2026-11-14-20')
    expect(p.counts.editions).toBe(3 * 2 - 1)
    expect(p.beforeFirstSync).toBe(0)
    expect(seedPlan({ nowMs: NOW, days: 3, until: '2026-11-14', untilSlot: '12' }).newestEditionId).toBe('2026-11-14-12')
  })

  it('今より後の updated になる時は、書く前に断る', () => {
    expect(() => seedPlan({ nowMs: NOW, days: 3, until: '2026-11-15', untilSlot: '20' })).toThrow(RangeError)
    // 12:00版の訂正は版の 85分後まで足すので、14:30 でもその日の 12:00版は入れられる
    expect(() => seedPlan({ nowMs: NOW, days: 3, until: '2026-11-15', untilSlot: '12' })).not.toThrow()
    expect(() => seedPlan({ nowMs: Date.UTC(2026, 10, 15, 3, 30), days: 3, until: '2026-11-15', untilSlot: '12' })).toThrow(
      /今より後/,
    )
  })

  it('日数が3より少ないと断る（続報の鎖に3日要る）', () => {
    expect(() => seedPlan({ nowMs: NOW, days: 2 })).toThrow(RangeError)
  })
})

describe('エミュレーターに書く（seedEmulator・seedTargetUid）', () => {
  it('管理者の道具で records にまとめて書く。owner の時だけ持ち主の記録も作る', async () => {
    const plan = await seedEmulator('u1', { nowMs: NOW, days: 3 })
    expect(admin.adminWriteRecords).toHaveBeenCalledTimes(1)
    expect(admin.adminWriteRecords).toHaveBeenCalledWith('u1', 'records', plan.docs.records)
    expect(admin.adminCreateOwner).not.toHaveBeenCalled()
    await seedEmulator('u2', { nowMs: NOW, days: 3, owner: true })
    expect(admin.adminCreateOwner).toHaveBeenCalledWith('u2')
  })

  it('今より後になる時は何も書かない', async () => {
    await expect(seedEmulator('u1', { nowMs: NOW, days: 3, until: '2026-11-16' })).rejects.toThrow(RangeError)
    expect(admin.adminWriteRecords).not.toHaveBeenCalled()
    expect(admin.adminCreateOwner).not.toHaveBeenCalled()
  })

  it('書く先: uid はそのまま、無ければ sub（既定 dev-author）の仮の Google アカウント', async () => {
    expect(await seedTargetUid({ uid: 'abc' })).toBe('abc')
    expect(admin.adminGoogleUser).not.toHaveBeenCalled()
    expect(await seedTargetUid({})).toBe('uid-of-dev-author')
    expect(await seedTargetUid({ sub: 'e2e-x' })).toBe('uid-of-e2e-x')
  })
})
