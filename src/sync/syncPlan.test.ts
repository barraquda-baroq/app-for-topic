// 同期の決まりの部品（src/sync/syncPlan.ts。docs/SPEC.md の 7.8）。エンジンと偽のクラウドが同じ物を使うので、ここで境目を確かめる
import { describe, expect, it } from 'vitest'
import { editionIdOf, termIdOf } from '../domain/ids'
import { addDaysToDate, jstStartOfDayMs, ONE_DAY_MS } from '../domain/jst'
import { CONNECTOR_DEVICE, EXPIRING_TABLES, TABLE_NAMES } from '../domain/types'
import { encodeDoc } from './codec'
import {
  EXPIRE_ORDER,
  PRIVATE_SUBSCRIBED_TABLES,
  RECORDS_SUBSCRIBED_TABLES,
  asCursor,
  asFirstSync,
  cursorOfMs,
  expirableIds,
  firstSyncSince,
  goneFromCloud,
  isSubscribedTable,
  laterCursor,
  localExpiryDate,
  maxCursor,
  msOfCursor,
  needsFirstSync,
  needsKnownRead,
  privateStart,
  remoteChangeOf,
  sendGuardTime,
  snapshotAdvance,
} from './syncPlan'

const DAY = ONE_DAY_MS
const TODAY = '2026-11-15'
/** 11/15 の 21:00（日本時間） */
const NOW = jstStartOfDayMs(TODAY) + 21 * 60 * 60 * 1000

describe('購読する表（docs/SPEC.md の 7.8 の「購読」）', () => {
  it('records は辞書の束を受け取らず、訂正を受け取る。private は既読だけ。どの表もどちらか1つの置き場だけ', () => {
    expect(RECORDS_SUBSCRIBED_TABLES).toEqual(['editions', 'topics', 'corrections', 'editionFails', 'knownTerms'])
    expect(PRIVATE_SUBSCRIBED_TABLES).toEqual(['reads'])
    for (const t of TABLE_NAMES) {
      const places = (['records', 'private'] as const).filter((p) => isSubscribedTable(p, t))
      expect(places.length, t).toBe(t === 'termPacks' ? 0 : 1)
    }
    expect(isSubscribedTable('private', 'saves')).toBe(false)
  })

  it('30日の手入れは30日で消す表を全部、版の記録から消す', () => {
    expect([...EXPIRE_ORDER].sort()).toEqual([...EXPIRING_TABLES].sort())
    expect(EXPIRE_ORDER[0]).toBe('editions')
  })
})

describe('受け取った位置', () => {
  it('ミリ秒と秒・ナノ秒を行き来でき、比べられる', () => {
    const c = cursorOfMs(NOW + 123)
    expect(c).toEqual({ s: Math.floor((NOW + 123) / 1000), n: 123_000_000 })
    expect(msOfCursor(c)).toBe(NOW + 123)
    expect(laterCursor(cursorOfMs(NOW + 1), cursorOfMs(NOW))).toBe(true)
    expect(laterCursor(cursorOfMs(NOW), cursorOfMs(NOW))).toBe(false)
    expect(laterCursor(cursorOfMs(NOW), null)).toBe(true)
    expect(maxCursor(cursorOfMs(NOW), cursorOfMs(NOW + 5))).toEqual(cursorOfMs(NOW + 5))
    expect(maxCursor(null, null)).toBeNull()
    expect(asCursor({ s: 1, n: 2 })).toEqual({ s: 1, n: 2 })
    expect(asCursor({ s: '1', n: 2 })).toBeNull()
    expect(asCursor(null)).toBeNull()
  })

  it('知らせを反映した後は、届いたいちばん新しい時刻まで進め、戻さない', () => {
    const at = cursorOfMs(NOW)
    expect(snapshotAdvance(null, at)).toEqual(at)
    expect(snapshotAdvance(at, cursorOfMs(NOW - 1))).toBeNull()
    expect(snapshotAdvance(at, null)).toBeNull()
  })

  it('初めての受け取りの 2. の最初の知らせは、届いた記録が0件でも、購読を始めた位置まで進める', () => {
    const since = firstSyncSince(NOW)
    expect(snapshotAdvance(null, null, since)).toEqual(since)
    // 届いた記録が購読を始めた位置より新しければ、そこまで
    expect(snapshotAdvance(null, cursorOfMs(NOW - DAY), since)).toEqual(cursorOfMs(NOW - DAY))
    // 前の位置（時計が戻った端末など）より戻さない
    expect(snapshotAdvance(cursorOfMs(NOW), null, since)).toBeNull()
  })
})

describe('初めての受け取り（docs/SPEC.md の 7.8 の「版と話題を受け取る」）', () => {
  const cursor = cursorOfMs(NOW - 40 * DAY)

  it('records の位置が無ければ入る', () => {
    expect(needsFirstSync({ recordsCursor: null, caughtUpAt: NOW }, NOW)).toBe(true)
  })

  it('入るかは caughtUpAt で決める: 31日ちょうどは入らず、31日より前なら入る（位置が40日前でも、そろった時刻が新しければ入らない）', () => {
    expect(needsFirstSync({ recordsCursor: cursor, caughtUpAt: NOW - DAY }, NOW)).toBe(false)
    expect(needsFirstSync({ recordsCursor: cursor, caughtUpAt: NOW - 31 * DAY }, NOW)).toBe(false)
    expect(needsFirstSync({ recordsCursor: cursor, caughtUpAt: NOW - 31 * DAY - 1 }, NOW)).toBe(true)
  })

  it('そろった時刻を知らない・時計が1日より多く戻った時は、位置と端末の時計で決める', () => {
    expect(needsFirstSync({ recordsCursor: cursor, caughtUpAt: null }, NOW)).toBe(true)
    expect(needsFirstSync({ recordsCursor: cursorOfMs(NOW - DAY), caughtUpAt: null }, NOW)).toBe(false)
    expect(needsFirstSync({ recordsCursor: cursor, caughtUpAt: NOW + 2 * DAY }, NOW)).toBe(true)
    expect(needsFirstSync({ recordsCursor: cursorOfMs(NOW - DAY), caughtUpAt: NOW + 2 * DAY }, NOW)).toBe(false)
  })

  it('1. は firstSync があれば読み直さない。1. の後に32日より長く閉じていた時だけ読み直す', () => {
    expect(needsKnownRead(null, NOW)).toBe(true)
    expect(needsKnownRead({ knownAt: NOW - DAY }, NOW)).toBe(false)
    expect(needsKnownRead({ knownAt: NOW - 32 * DAY }, NOW)).toBe(false)
    expect(needsKnownRead({ knownAt: NOW - 32 * DAY - 1 }, NOW)).toBe(true)
    expect(asFirstSync({ knownAt: NOW })).toEqual({ knownAt: NOW })
    expect(asFirstSync({ knownAt: 'x' })).toBeNull()
  })

  it('records の 2. と、位置の無い private は端末の時計 − 32日から。private は位置があればその位置から', () => {
    expect(msOfCursor(firstSyncSince(NOW))).toBe(NOW - 32 * DAY)
    expect(privateStart(null, NOW)).toEqual(firstSyncSince(NOW))
    expect(privateStart(cursor, NOW)).toEqual(cursor)
  })
})

describe('受け取った文書を反映の1件にする', () => {
  const edition = editionIdOf(TODAY, '12')
  const read = {
    id: edition,
    v: 1,
    createdAt: NOW,
    updatedAt: NOW,
    by: 'user',
    ai: null,
    editionId: edition,
    topicIds: [],
    seen: true,
  }
  const doc = (table: Parameters<typeof encodeDoc>[0], rec: { id: string }, device = CONNECTOR_DEVICE) =>
    encodeDoc(table, rec, { device, updated: NOW })
  const ctx = (docId: string, place: 'records' | 'private' = 'records') => ({ docId, place, deviceId: 'pc', deviceNow: NOW })

  it('受け取ったまま記録にし、自分の書いた文書には own の印を付ける', () => {
    const r = remoteChangeOf(doc('reads', read, 'pc'), ctx(`reads:${edition}`, 'private'))
    expect(r).toEqual({ ok: true, change: { table: 'reads', id: edition, record: read, own: true }, hash: expect.any(String) })
    const other = remoteChangeOf(doc('reads', read, 'phone'), ctx(`reads:${edition}`, 'private'))
    expect(other.ok && other.change.own).toBeUndefined()
  })

  it('辞書の束・置き場の違う文書・知らない表は記録にしない', () => {
    const pack = { id: `${edition}-p0m4x7c2`, editionId: edition, entries: [] }
    expect(remoteChangeOf(doc('termPacks', pack), ctx(`termPacks:${pack.id}`))).toEqual({ ok: false, reason: 'not-subscribed' })
    expect(remoteChangeOf(doc('reads', read), ctx(`reads:${edition}`, 'records'))).toEqual({ ok: false, reason: 'place' })
    const saves = { ...doc('reads', read), table: 'saves' }
    expect(remoteChangeOf(saves, ctx(`saves:${edition}`, 'private'))).toEqual({ ok: false, reason: 'table' })
  })

  it('端末の時計で30日の外の物は落とす（初めての受け取りの32日の窓の前の2日分）。消さない表（知ってる）は落とさない', () => {
    const old = editionIdOf(addDaysToDate(TODAY, -30), '20')
    const ed = { id: old, date: old.slice(0, 10), slot: '20', order: [`${old}-k3f9a2bq`] }
    expect(remoteChangeOf(doc('editions', ed), ctx(`editions:${old}`))).toEqual({ ok: false, reason: 'expired' })
    const kept = editionIdOf(addDaysToDate(TODAY, -29), '12')
    expect(remoteChangeOf(doc('editions', { ...ed, id: kept }), ctx(`editions:${kept}`)).ok).toBe(true)
    const known = { id: termIdOf('〇〇法'), term: '〇〇法', asOf: null, on: true }
    expect(
      remoteChangeOf(doc('knownTerms', known, 'phone'), { ...ctx(`knownTerms:${known.id}`), deviceNow: NOW + 400 * DAY }).ok,
    ).toBe(true)
  })
})

describe('30日で消す・送る前の守り（docs/SPEC.md の 7.8）', () => {
  it('端末の中で消す境は、残る版のいちばん古い日付', () => {
    expect(localExpiryDate(NOW)).toBe(addDaysToDate(TODAY, -29))
  })

  it('クラウドで消すのは表ごとの id の形で30日を過ぎた物だけ（形の違う物を混ぜない）', () => {
    const d30 = addDaysToDate(TODAY, -30)
    const ids = [
      `editions:${d30}-12`,
      `editions:${d30}-12-abcdefgh`,
      `topics:${d30}-12-aaaaaaaa`,
      `topics:${d30}-12`,
      `corrections:${d30}-12-aaaaaaaa-bbbbbbbb`,
      `reads:${d30}-20`,
      `topics:${addDaysToDate(TODAY, -29)}-12-aaaaaaaa`,
    ]
    expect(expirableIds(ids, NOW)).toEqual([
      `editions:${d30}-12`,
      `topics:${d30}-12-aaaaaaaa`,
      `corrections:${d30}-12-aaaaaaaa-bbbbbbbb`,
      `reads:${d30}-20`,
    ])
  })

  it('送る前の守りはサーバーの時刻の見積もりで、まだ見積もりが無い時は端末の時計', () => {
    expect(sendGuardTime(NOW - 5, NOW)).toBe(NOW - 5)
    expect(sendGuardTime(null, NOW)).toBe(NOW)
  })

  it('クラウドで消えていた既読（base がある）は作り直さない。知ってる・共通の履歴の無い行・まだ送っていない行は当たらない', () => {
    const base = { id: editionIdOf(TODAY, '12') }
    expect(goneFromCloud({ table: 'reads', base, noHistory: false }, false)).toBe(true)
    expect(goneFromCloud({ table: 'reads', base, noHistory: false }, true)).toBe(false)
    expect(goneFromCloud({ table: 'reads', base: null, noHistory: false }, false)).toBe(false)
    expect(goneFromCloud({ table: 'reads', base, noHistory: true }, false)).toBe(false)
    expect(goneFromCloud({ table: 'knownTerms', base: { id: termIdOf('〇〇法') }, noHistory: false }, false)).toBe(false)
  })
})
