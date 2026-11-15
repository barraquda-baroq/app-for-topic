// 同期の部品（docs/SPEC.md の 7.7・7.8・7.9・16.3）: codec の置き場の割り当て（reads は必ず private、ほか（corrections も）は records）と
// 外側の文書の形（8つの欄・分けた文書と削除の印を使わない・指紋が合わない時）、送る物の選び方（アプリの表の local が null の行と Claude の記録は
// 書かずに送り終わり・30日の外の既読は送らない・上限・消さない表を作り直す）、同期の表示の8つ（syncView。エンジンの状態と持ち主の確かめから
// 決める表示・言葉・幅の狭い画面の短い言葉・色の段・無料枠が戻る時刻）
import { describe, expect, it } from 'vitest'
import { nextQuotaResetMs, quotaResumeAt } from '../domain/dates'
import { stableStringify } from '../domain/equal'
import { hashJson, recordHash } from '../domain/hash'
import { editionIdOf, termIdOf } from '../domain/ids'
import { pressKnownTerm, unpressKnownTerm } from '../domain/known'
import { RECORD_LIMITS } from '../domain/limits'
import { CONNECTOR_DEVICE, TABLE_NAMES, type ReadMark, type TableName } from '../domain/types'
import {
  EXPIRE_BATCH_DOCS,
  EXPIRE_DAILY_DOCS,
  FIRESTORE_MAX_WRITES,
  SEND_LIMITS,
  decideBatch,
  expiredBeforeSend,
  isAppTable,
  nothingToSend,
  selectBatch,
  type SendItem,
} from './batch'
import {
  PLACES,
  decodeDoc,
  docIdOf,
  docPathOf,
  encodeDoc,
  encodeRecord,
  hashRecord,
  placeOf,
  placePath,
  recordDocOf,
  splitDocId,
  type Rec,
} from './codec'
import type { SyncStatus } from './engine'
import { OWNER_MISSING_REASON, syncLabel, syncShortLabel, syncTone, syncViewOf, type OwnerState, type SyncView } from './syncView'

const T0 = Date.UTC(2026, 10, 15, 3, 0)
const editionId = editionIdOf('2026-11-15', '12')

function readMark(p: Partial<ReadMark> = {}): ReadMark {
  return { id: editionId, v: 1, createdAt: T0, updatedAt: T0, by: 'user', ai: null, editionId, topicIds: [], seen: false, ...p }
}

const known = pressKnownTerm(null, { termId: termIdOf('与党（日本）'), term: '与党', asOf: '2026-11' }, T0)

function item(p: Partial<SendItem> & Pick<SendItem, 'table' | 'id'>): SendItem {
  return { k: `${p.table}/${p.id}`, base: null, noHistory: false, local: { id: p.id }, ...p }
}

describe('置き場の割り当て（codec の placeOf。7.7）', () => {
  it('reads は必ず private、ほか（corrections も）は records', () => {
    expect(Object.fromEntries(TABLE_NAMES.map((t) => [t, placeOf(t)]))).toEqual({
      editions: 'records',
      topics: 'records',
      corrections: 'records',
      termPacks: 'records',
      editionFails: 'records',
      knownTerms: 'records',
      reads: 'private',
    })
    expect(PLACES).toEqual(['records', 'private'])
  })
  it('書く道は置き場の割り当てを通る（既読を Claude が読める置き場に書かない）', () => {
    expect(docPathOf('u1', 'reads', editionId)).toEqual(['users', 'u1', 'private', `reads:${editionId}`])
    expect(docPathOf('u1', 'knownTerms', known.id)).toEqual(['users', 'u1', 'records', `knownTerms:${known.id}`])
    expect(docPathOf('u1', 'corrections', `${editionId}-aaaaaaa1-bbbbbbb1`)[2]).toBe('records')
    expect(placePath('u1', 'private')).toEqual(['users', 'u1', 'private'])
  })
  it('置き場の決まっていない表（後の版が足した表の名前など）は、置き場を決めずに止める', () => {
    expect(() => placeOf('saves' as TableName)).toThrow('置き場の決まっていない表です: saves')
  })
})

describe('外側の文書の形（codec。7.7）', () => {
  const meta = { device: 'device-1', updated: 'SERVER_TIME' }
  it('8つの欄だけ。chunks は 0、deleted は false、json はキーの順にそろえた JSON、hash はその指紋（recordHash と同じ）', () => {
    const doc = encodeDoc('reads', readMark({ topicIds: ['b', 'a'] }), meta)
    expect(Object.keys(doc).sort()).toEqual(['chunks', 'deleted', 'device', 'hash', 'id', 'json', 'table', 'updated'])
    expect(doc).toMatchObject({
      table: 'reads',
      id: editionId,
      chunks: 0,
      deleted: false,
      device: 'device-1',
      updated: 'SERVER_TIME',
    })
    expect(doc.json).toBe(stableStringify(readMark({ topicIds: ['b', 'a'] })))
    expect(doc.hash).toBe(hashJson(doc.json))
    expect(doc.hash).toBe(recordHash(readMark({ topicIds: ['b', 'a'] })))
    expect(doc.hash).toBe(hashRecord(readMark({ topicIds: ['b', 'a'] })))
    expect(recordDocOf('reads', editionId, encodeRecord(readMark({ topicIds: ['b', 'a'] })), meta)).toEqual(doc)
    expect(hashRecord(null)).toBe('')
  })
  it('受け取ったまま戻す（知らない値・知らない欄も消さない）。コネクタの書いた文書も同じ形', () => {
    const rec = { ...known, extra: { a: [1, 2] }, on: 'maybe' }
    const doc = encodeDoc('knownTerms', rec, meta)
    expect(decodeDoc(doc, { docId: docIdOf('knownTerms', known.id), place: 'records' })).toEqual({
      ok: true,
      table: 'knownTerms',
      id: known.id,
      record: rec,
      hash: doc.hash,
      device: 'device-1',
      updated: 'SERVER_TIME',
    })
    const edition = { id: editionId, v: 1, by: 'connector', ai: 'claude', date: '2026-11-15', slot: '12', order: [] }
    const fromConnector = encodeDoc('editions', edition, { device: CONNECTOR_DEVICE, updated: null })
    expect(decodeDoc(fromConnector)).toMatchObject({ ok: true, table: 'editions', record: edition, device: 'claude-connector' })
  })
  it('TS が書く形でない文書は使わない（理由を返す）', () => {
    const doc = encodeDoc('reads', readMark(), meta)
    const reason = (d: unknown, expect?: Parameters<typeof decodeDoc>[1]) => {
      const r = decodeDoc(d, expect)
      return r.ok ? 'ok' : r.reason
    }
    expect(reason(null)).toBe('shape')
    expect(reason([doc])).toBe('shape')
    expect(reason({ ...doc, json: null })).toBe('shape')
    expect(reason({ ...doc, id: '' })).toBe('shape')
    // private は表を絞らずに購読するので、後の版が足した表も届く
    expect(reason({ ...doc, table: 'saves' })).toBe('table')
    expect(reason(doc, { docId: `reads:${editionIdOf('2026-11-15', '20')}` })).toBe('docId')
    expect(reason(doc, { place: 'records' })).toBe('place')
    // 分けた文書・削除の印は使わない
    expect(reason({ ...doc, chunks: 1 })).toBe('chunks')
    expect(reason({ ...doc, deleted: true })).toBe('deleted')
    expect(reason({ ...doc, hash: 'x' })).toBe('hash')
    const broken = (json: string) => ({ ...doc, json, hash: hashJson(json) })
    expect(reason(broken('{壊れた'))).toBe('json')
    expect(reason(broken('[1]'))).toBe('json')
    expect(reason(broken('null'))).toBe('json')
    expect(reason(broken(stableStringify({ ...readMark(), id: '2026-11-14-20' })))).toBe('id')
    expect(reason(doc, { docId: `reads:${editionId}`, place: 'private' })).toBe('ok')
  })
  it('文書の id と表', () => {
    expect(docIdOf('corrections', `${editionId}-aaaaaaa1-bbbbbbb1`)).toBe(`corrections:${editionId}-aaaaaaa1-bbbbbbb1`)
    expect(splitDocId(`reads:${editionId}`)).toEqual({ table: 'reads', id: editionId })
    expect(splitDocId('reads')).toEqual({ table: 'reads', id: '' })
  })
})

describe('送る物の選び方（batch）', () => {
  it('アプリが書く表は知ってる・既読だけ', () => {
    expect(TABLE_NAMES.filter(isAppTable)).toEqual(['knownTerms', 'reads'])
  })
  it('アプリの表で local が null の行は、書かずに送り終わり（削除の印を書かない。返事を受け取っていない行も）', () => {
    const gone = item({ table: 'reads', id: editionId, base: readMark(), local: null })
    expect(nothingToSend(gone)).toBe(true)
    expect(nothingToSend({ ...gone, unconfirmed: true })).toBe(true)
    expect(nothingToSend({ ...gone, noHistory: true })).toBe(true)
    expect(selectBatch([gone], SEND_LIMITS)).toEqual([])
  })
  it('アプリが書かない表（Claude の記録）の行は送らない（ルールで断られて、ほかの記録まで止めない）', () => {
    const rows = (['editions', 'topics', 'corrections', 'termPacks', 'editionFails'] as const).map((table) =>
      item({ table, id: editionId, local: { id: editionId, x: 1 } as Rec }),
    )
    expect(rows.every((r) => nothingToSend(r))).toBe(true)
    expect(selectBatch(rows, SEND_LIMITS)).toEqual([])
  })
  it('base と同じ行は送らない。返事を受け取っていない行・共通の履歴が無い行は、同じでも送る（クラウドを読んで確かめる）', () => {
    const same = item({ table: 'knownTerms', id: known.id, base: known, local: { ...known } })
    expect(nothingToSend(same)).toBe(true)
    expect(nothingToSend({ ...same, unconfirmed: true })).toBe(false)
    expect(nothingToSend({ ...same, noHistory: true })).toBe(false)
    const changed = { ...same, local: { ...known, on: false } }
    expect(nothingToSend(changed)).toBe(false)
  })
  it('30日の外の既読は送らない（サーバーの時刻の見積もりで、日本時間の 0時をまたいだ時から）。知ってるは日付で捨てない', () => {
    const oldId = editionIdOf('2026-10-16', '20')
    const old = item({ table: 'reads', id: oldId, local: readMark({ id: oldId, editionId: oldId, topicIds: ['x'] }) })
    // 10/16 の版は、日本時間の 11/15 0時（UTC の 11/14 15:00）に30日を過ぎる
    const before = Date.UTC(2026, 10, 14, 14, 59, 59)
    const after = Date.UTC(2026, 10, 14, 15, 0)
    expect(expiredBeforeSend(old, before)).toBe(false)
    expect(expiredBeforeSend(old, after)).toBe(true)
    expect(nothingToSend(old, before)).toBe(false)
    expect(nothingToSend(old, after)).toBe(true)
    // 見積もりがまだ無い時は守らない（呼ぶ側が決める）
    expect(nothingToSend(old, null)).toBe(false)
    expect(nothingToSend(old)).toBe(false)
    const term = item({ table: 'knownTerms', id: known.id, local: known })
    expect(nothingToSend(term, after + 400 * 86_400_000)).toBe(false)
    expect(selectBatch([old, term], { ...SEND_LIMITS, serverNow: after }).map((e) => e.it.id)).toEqual([known.id])
    expect(selectBatch([old, term], { ...SEND_LIMITS, serverNow: before }).map((e) => e.it.id)).toEqual([oldId, known.id])
  })
  it('readOutbox の順に、上限（文書の数・字数）に収まるだけ取る。1件で上限を超える時はそれだけ', () => {
    const rows = Array.from({ length: 5 }, (_, i) => item({ table: 'reads', id: `2026-11-1${i}-12` }))
    expect(selectBatch(rows, { maxChars: 1_000_000, maxDocs: 3 }).map((e) => e.it.id)).toEqual([
      '2026-11-10-12',
      '2026-11-11-12',
      '2026-11-12-12',
    ])
    const size = encodeRecord({ id: '2026-11-10-12' }).size
    expect(selectBatch(rows, { maxChars: size * 2, maxDocs: 400 })).toHaveLength(2)
    expect(selectBatch(rows, { maxChars: size * 2 - 1, maxDocs: 400 })).toHaveLength(1)
    expect(selectBatch(rows, { maxChars: 1, maxDocs: 400 }).map((e) => e.it.id)).toEqual(['2026-11-10-12'])
  })
  it('書く json は local、比べる指紋は base（呼ぶ側の行の型をそのまま返す）', () => {
    const base = readMark()
    const local = readMark({ topicIds: ['x'], updatedAt: T0 + 1 })
    const row = { ...item({ table: 'reads', id: editionId, base, local }), tx: 't1' }
    const [e] = selectBatch([row], SEND_LIMITS)
    expect(e.it.tx).toBe('t1')
    expect(e.enc).toEqual(encodeRecord(local))
    expect(e.baseHash).toBe(hashRecord(base))
  })
  it('Firestore の1回の書き込みの上限（500）の手前: 送る1回は 400文書・150万字、30日の削除は 450件ずつ・1日 2,000件まで（7.8・7.9）', () => {
    expect(FIRESTORE_MAX_WRITES).toBe(500)
    expect(SEND_LIMITS).toEqual({ maxChars: 1_500_000, maxDocs: 400 })
    expect(EXPIRE_BATCH_DOCS).toBe(450)
    expect(EXPIRE_DAILY_DOCS).toBe(2_000)
    // 30本を読んだ版の既読（いちばん大きいアプリの記録）でも上限の内で、400件が送る1回の字数に入る（ふだんは文書の数で決まる）
    const ids = Array.from({ length: 30 }, (_, i) => `${editionId}-${String(i).padStart(8, 'a')}`)
    const full = encodeRecord(readMark({ topicIds: ids, seen: true })).size
    expect(full).toBeLessThanOrEqual(1_000)
    expect(full).toBeLessThanOrEqual(RECORD_LIMITS.json.reads)
    expect(SEND_LIMITS.maxDocs * full).toBeLessThanOrEqual(SEND_LIMITS.maxChars)
    expect(encodeRecord(known).size).toBeLessThanOrEqual(RECORD_LIMITS.json.knownTerms)
  })
})

describe('書く物の決め方（batch の decideBatch）', () => {
  const base = readMark()
  const local = readMark({ topicIds: ['x'] })
  it('base の指紋がクラウドと同じ時だけ書く。違えば書かずに、受け取りで base が新しくなってから送り直す', () => {
    const batch = selectBatch(
      [
        item({ table: 'reads', id: 'a', base, local }),
        item({ table: 'reads', id: 'b', base, local }),
        item({ table: 'reads', id: 'c', local }),
      ],
      SEND_LIMITS,
    )
    const d = decideBatch(batch, [
      { exists: true, hash: hashRecord(base) },
      { exists: true, hash: 'other' },
      { exists: false, hash: '' },
    ])
    expect(d.write).toEqual([true, false, true])
    expect(d.conflicts.map((x) => x.id)).toEqual(['b'])
  })
  it('共通の履歴が無い物は、クラウドに何も無い時だけ書く', () => {
    const batch = selectBatch([item({ table: 'knownTerms', id: known.id, local: known, noHistory: true })], SEND_LIMITS)
    expect(decideBatch(batch, [{ exists: true, hash: hashRecord(known) }]).write).toEqual([false])
    expect(decideBatch(batch, [{ exists: false, hash: '' }]).write).toEqual([true])
  })
  it('クラウドに無くて base がある時: 知ってるは作り直す（共通の履歴が無い物として）。既読は作り直さない（30日で消えた物）', () => {
    const term = item({ table: 'knownTerms', id: known.id, base: known, local: unpressKnownTerm(known, T0 + 1) })
    const read = item({ table: 'reads', id: editionId, base, local })
    const batch = selectBatch([term, read], SEND_LIMITS)
    const d = decideBatch(batch, [
      { exists: false, hash: '' },
      { exists: false, hash: '' },
    ])
    expect(d.write).toEqual([true, false])
    expect(d.conflicts.map((x) => x.table)).toEqual(['reads'])
    // クラウドにある時は、ふつうに base と比べる
    expect(
      decideBatch(batch, [
        { exists: true, hash: 'other' },
        { exists: true, hash: hashRecord(base) },
      ]).write,
    ).toEqual([false, true])
  })
})

describe('同期の表示の8つ（docs/SPEC.md の 7.8 の「部品」の syncView.ts）', () => {
  const st = (patch: Partial<SyncStatus> = {}): SyncStatus => ({
    phase: 'synced',
    pending: 0,
    lastSyncedAt: T0,
    error: null,
    ...patch,
  })
  const view = (status: SyncStatus | null, owner: OwnerState = 'ok') => syncViewOf({ status, owner }, T0)

  it('エンジンの状態から8つのどれかを決める（DS と同じ順: 要更新 → オフライン → 誤り → 受け取り中 → 送信中 → 未送信 → 同期済み）', () => {
    expect(view(st())).toEqual({ kind: 'synced' })
    expect(view(st({ phase: 'uploading', pending: 2 }))).toEqual({ kind: 'sending' })
    expect(view(st({ pending: 3 }))).toEqual({ kind: 'pending', count: 3 })
    expect(view(st({ phase: 'starting' }))).toEqual({ kind: 'downloading' })
    expect(view(st({ phase: 'downloading', pending: 1 }))).toEqual({ kind: 'downloading' })
    expect(view(st({ phase: 'offline', errorCode: 'offline', pending: 4 }))).toEqual({ kind: 'offline' })
    expect(view(st({ phase: 'error', errorCode: 'quota' }))).toEqual({ kind: 'quota', resumeAt: quotaResumeAt(T0) })
    expect(view(st({ outdated: { model: 2, appVersion: '0.2' }, phase: 'offline' }))).toEqual({ kind: 'outdated' })
    expect(view(st({ phase: 'error', errorCode: 'permission-denied', error: '長い言葉' }))).toEqual({
      kind: 'error',
      reason: 'アクセスが拒否されました',
    })
    expect(view(st({ phase: 'error', errorCode: 'failed-precondition' }))).toEqual({
      kind: 'error',
      reason: 'クラウドの索引がまだありません',
    })
    expect(view(st({ phase: 'error', errorCode: 'internal', error: 'クラウドとの差を解消できませんでした' }))).toEqual({
      kind: 'error',
      reason: 'クラウドとの差を解消できませんでした',
    })
    // まだ同期を始めていない（受け持たない画面に状態が届く前も）は出さない
    expect(view(null)).toBeNull()
  })

  it('持ち主の記録が無い時は、エンジンが動く前・止まった後でも「同期できません（持ち主の記録がまだありません）」（14.8 の 4）', () => {
    const missing: SyncView = { kind: 'error', reason: OWNER_MISSING_REASON }
    expect(view(null, 'missing')).toEqual(missing)
    expect(view(st({ phase: 'error', errorCode: 'owner-missing', error: '長い言葉' }))).toEqual(missing)
    expect(view(st(), 'missing')).toEqual(missing)
    expect(syncLabel(missing)).toBe('同期できません（持ち主の記録がまだありません）')
  })

  it('8つの言葉（DS と同じ。無料枠は戻る時刻を添える）と、幅の狭い画面の短い言葉・色の段', () => {
    const cases: [SyncView, string, string, string][] = [
      [{ kind: 'synced' }, '同期済み', '同期済み', 'ok'],
      [{ kind: 'sending' }, '送信中…', '送信中…', 'busy'],
      [{ kind: 'pending', count: 3 }, '未送信 3件', '未送信 3件', 'busy'],
      [{ kind: 'downloading' }, '受け取り中…', '受け取り中…', 'busy'],
      [{ kind: 'offline' }, 'オフライン（端末に保存しています）', 'オフライン', 'warn'],
      [
        { kind: 'quota', resumeAt: '17:00' },
        '今日の無料枠を使い切りました（17:00 ごろに戻ります）',
        '無料枠を使い切りました',
        'warn',
      ],
      [{ kind: 'outdated' }, '要更新（アプリを更新してください）', '要更新', 'warn'],
      [
        { kind: 'error', reason: 'アクセスが拒否されました' },
        '同期できません（アクセスが拒否されました）',
        '同期できません',
        'warn',
      ],
    ]
    expect(cases).toHaveLength(8)
    for (const [v, label, short, tone] of cases) {
      expect(syncLabel(v)).toBe(label)
      expect(syncShortLabel(v)).toBe(short)
      expect(syncTone(v)).toBe(tone)
    }
  })

  it('無料枠が戻る時刻は太平洋時間の 0時（日本では 17:00、米国の夏時間の間は 16:00）', () => {
    // 米国の冬時間（2026-11-15）: 太平洋時間の 0時 = 日本の 17:00
    expect(quotaResumeAt(Date.UTC(2026, 10, 15, 3, 0), 'Asia/Tokyo')).toBe('17:00')
    // 米国の夏時間（2026-07-15）: 日本の 16:00
    expect(quotaResumeAt(Date.UTC(2026, 6, 15, 3, 0), 'Asia/Tokyo')).toBe('16:00')
    // 戻る時刻は今より後（今がちょうど 0時なら次の日の 0時）
    const midnightPt = Date.UTC(2026, 10, 15, 8, 0)
    expect(nextQuotaResetMs(midnightPt)).toBe(midnightPt + 24 * 60 * 60 * 1000)
    expect(nextQuotaResetMs(midnightPt - 1)).toBe(midnightPt)
  })
})
