// 端末の中の保存（docs/SPEC.md の 7.8・16.3 の persistence.test.ts の行。fake-indexeddb）: v1 の _meta はそのままで v2 の表を足す事、
// 段階0（v1 だけの DB）から上がっても ownerSeen が残る事、端末への書き込みと送信待ちへの積み込みが同じトランザクションである事、
// 受け取った位置を置き場ごとに書く事、expireBefore がデータの行（訂正も）と送信待ちの行を一緒に消し、送信待ちに積まない事を確かめる。
// 記録は作り物の小さな物（形だけ。中身の決まりは src/domain のテスト）
import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'
import { retentionBoundary } from '../domain/jst'
import { TABLE_NAMES, USER_TABLES } from '../domain/types'
import {
  CONNECTOR_LOCAL_TABLES,
  DEFAULT_DB_NAME,
  LOCAL_TABLES,
  META_KEYS,
  V1_SCHEMA,
  V2_ADDED,
  createPersistence,
  emptyUserRecords,
  syncMerge,
  type AnyRecord,
  type Change,
  type MergeRecord,
  type Persistence,
  type PersistenceOptions,
  type UserRecords,
} from './persistence'

let seq = 0
const uniqueName = () => `persistence-${++seq}-${Math.random().toString(36).slice(2)}`
const fresh = (opts?: PersistenceOptions) => createPersistence(uniqueName(), opts)

/** 受け取ったままの記録（知らない欄も持てる形） */
type Raw = AnyRecord & Record<string, unknown>
const rec = (id: string, fields: Record<string, unknown> = {}): Raw => ({ id, ...fields }) as Raw

// 作り物の記録（id の形は docs/SPEC.md の 7.7 の「名札」のとおり）
const edition = (id: string, order: string[] = []) => rec(id, { date: id.slice(0, 10), slot: id.slice(11), order })
const topic = (id: string, fields: Record<string, unknown> = {}) =>
  rec(id, { editionId: id.slice(0, 13), threadId: id, headline: `〇〇市の話題 ${id.slice(-8)}`, ...fields })
const correction = (id: string) =>
  rec(id, {
    topicId: id.slice(0, 22),
    editionId: id.slice(0, 13),
    text: '新しい橋の歩道の幅は 2メートルではなく 3メートルでした',
  })
const editionFail = (id: string) => rec(id, { editionId: id.slice(0, 13), reasonKind: 'quota', reason: null })
const known = (id: string, fields: Record<string, unknown> = {}) =>
  rec(id, { term: '与党', asOf: null, on: true, by: 'user', ai: null, updatedAt: 1, ...fields })
const read = (id: string, fields: Record<string, unknown> = {}) =>
  rec(id, { editionId: id, topicIds: [], seen: false, by: 'user', ai: null, updatedAt: 1, ...fields })

const users = (knownTerms: Raw[] = [], reads: Raw[] = []): UserRecords => ({
  knownTerms: Object.fromEntries(knownTerms.map((r) => [r.id, r])),
  reads: Object.fromEntries(reads.map((r) => [r.id, r])),
})

/** 保存して、送り終えた状態（送信待ち無し。端末の中 = クラウド）にする */
async function seed(p: Persistence, data: UserRecords): Promise<void> {
  await p.save(emptyUserRecords(), data)
  const sent: Change[] = []
  for (const it of await p.readOutbox(10_000)) sent.push({ table: it.table, id: it.id, record: it.local })
  await p.completeUpload(sent)
  expect(await p.outboxCount()).toBe(0)
}

/** 端末の DB の形（版・表・主キー・索引）を、Dexie に表を教えずに開いて読む */
async function schemaOf(name: string) {
  const raw = new Dexie(name)
  await raw.open()
  const tables = Object.fromEntries(
    raw.tables.map((t) => [t.name, { primKey: t.schema.primKey.name, indexes: t.schema.indexes.map((i) => i.name).sort() }]),
  )
  const verno = raw.verno
  raw.close()
  return { verno, tables }
}

/** 表の一覧の書き方（'id, date'）を、主キーと索引に分ける */
const parseSchema = (schema: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(schema).map(([t, s]) => {
      const [primKey, ...indexes] = s.split(',').map((x) => x.trim())
      return [t, { primKey, indexes: indexes.sort() }]
    }),
  )

/** 段階0の端末の DB（v1 の _meta だけを知る版のアプリ） */
class StageZeroDB extends Dexie {
  constructor(name: string) {
    super(name)
    this.version(1).stores(V1_SCHEMA)
  }
}

describe('Dexie の表（v1 と v2。docs/SPEC.md の 7.8 の「端末の表」）', () => {
  it('DB の名前は topic-studio、v1 の表は _meta だけ（段階0のまま変えない）', () => {
    expect(DEFAULT_DB_NAME).toBe('topic-studio')
    expect(V1_SCHEMA).toEqual({ _meta: 'key' })
  })

  it('v2 で足す表と索引は固定の一覧。辞書の束（termPacks）は入れない', () => {
    expect(V2_ADDED).toEqual({
      editions: 'id, date',
      topics: 'id, editionId, threadId',
      corrections: 'id, topicId, editionId',
      editionFails: 'id, editionId',
      knownTerms: 'id',
      reads: 'id',
      _outbox: 'k',
    })
    expect([...LOCAL_TABLES]).toEqual(Object.keys(V2_ADDED).filter((t) => t !== '_outbox'))
    expect([...LOCAL_TABLES].sort()).toEqual(TABLE_NAMES.filter((t) => t !== 'termPacks').sort())
    expect([...CONNECTOR_LOCAL_TABLES, ...USER_TABLES].sort()).toEqual([...LOCAL_TABLES].sort())
    expect(META_KEYS).toEqual([
      'ownerSeen',
      'deviceId',
      'uid',
      'uidEmail',
      'cursor',
      'caughtUpAt',
      'firstSync',
      'syncSchema',
      'lastMaintainDay',
    ])
  })

  it('新しく作った DB は v2 で、表・主キー・索引が一覧のとおり', async () => {
    const name = uniqueName()
    const p = createPersistence(name)
    await p.setMeta('deviceId', 'dev-a')
    p.close()
    const s = await schemaOf(name)
    expect(s.verno).toBe(2)
    expect(s.tables).toEqual(parseSchema({ ...V1_SCHEMA, ...V2_ADDED }))
  })
})

describe('段階0（v1 だけの DB）から v2 への上がり', () => {
  it('v1 の _meta.ownerSeen が残り、足した表は空で使える', async () => {
    const name = uniqueName()
    const v1 = new StageZeroDB(name)
    await v1.table('_meta').put({ key: 'ownerSeen', value: 'uid-a' })
    v1.close()
    expect((await schemaOf(name)).verno).toBe(1)

    const p = createPersistence(name)
    expect(await p.getMeta<string>('ownerSeen')).toBe('uid-a')
    expect(await p.loadUserRecords()).toEqual(emptyUserRecords())
    expect(await p.listEditions()).toEqual([])
    expect(await p.outboxCount()).toBe(0)
    // 足した表に書ける（送信待ちにも積める）
    await p.save(emptyUserRecords(), users([known('t3f9a2c1b7d0e')]))
    expect(await p.outboxCount()).toBe(1)
    p.close()

    const s = await schemaOf(name)
    expect(s.verno).toBe(2)
    expect(s.tables).toEqual(parseSchema({ ...V1_SCHEMA, ...V2_ADDED }))
    // 開き直しても ownerSeen は残る
    const again = createPersistence(name)
    expect(await again.getMeta<string>('ownerSeen')).toBe('uid-a')
    again.close()
  })
})

describe('覚え書き（_meta）', () => {
  it('覚え書きを書いて読める。開き直しても残る', async () => {
    const name = uniqueName()
    const p = createPersistence(name)
    expect(await p.getMeta('ownerSeen')).toBeUndefined()
    await p.setMeta('ownerSeen', 'uid-a')
    expect(await p.getMeta<string>('ownerSeen')).toBe('uid-a')
    p.close()
    const again = createPersistence(name)
    expect(await again.getMeta<string>('ownerSeen')).toBe('uid-a')
    // 消す時は null を書く
    await again.setMeta('ownerSeen', null)
    expect(await again.getMeta('ownerSeen')).toBeNull()
    again.close()
  })

  it('受け取った位置は置き場（records・private）ごとに書き、ほかの置き場の位置は変えない', async () => {
    const p = fresh()
    await p.setCursor('records', { s: 10, n: 1 })
    await p.setCursor('private', { s: 20, n: 2 })
    expect(await p.getMeta('cursor')).toEqual({ records: { s: 10, n: 1 }, private: { s: 20, n: 2 } })
    // 反映と一緒に、records の位置だけを進める
    await p.applyRemote([{ table: 'editions', id: '2026-11-15-12', record: edition('2026-11-15-12') }], {
      cursor: { place: 'records', at: { s: 30, n: 0 } },
    })
    expect(await p.getMeta('cursor')).toEqual({ records: { s: 30, n: 0 }, private: { s: 20, n: 2 } })
    await p.setCursor('records', null)
    expect(await p.getMeta('cursor')).toEqual({ private: { s: 20, n: 2 } })
    await p.setCursor('private', null)
    expect(await p.getMeta('cursor')).toBeNull()
    p.close()
  })
})

describe('保存と送信待ち（端末への書き込みと積み込みは同じトランザクション）', () => {
  it('書いた記録は送信待ちに積まれ、base は書く前の端末の中身（初めてなら null）', async () => {
    const p = fresh()
    const t1 = known('t3f9a2c1b7d0e')
    const r1 = read('2026-11-15-12', { topicIds: ['2026-11-15-12-k3f9a2bq'] })
    const out = await p.save(emptyUserRecords(), users([t1], [r1]))
    expect(out.written.map((c) => `${c.table}/${c.id}`)).toEqual(['knownTerms/t3f9a2c1b7d0e', 'reads/2026-11-15-12'])
    const rows = await p.readOutbox(10)
    expect(rows.map((r) => [r.k, r.base, r.local, r.noHistory])).toEqual([
      ['knownTerms/t3f9a2c1b7d0e', null, t1, false],
      ['reads/2026-11-15-12', null, r1, false],
    ])
    expect(await p.loadUserRecords()).toEqual(users([t1], [r1]))
    p.close()
  })

  it('途中で書けなかったら、記録も送信待ちも1つも書かない', async () => {
    const p = fresh()
    // knownTerms の記録と送信待ちを書いた後に、reads の記録が書けない（IndexedDB に入れられない値）
    const broken = read('2026-11-15-12', { seen: () => true })
    await expect(p.save(emptyUserRecords(), users([known('t3f9a2c1b7d0e')], [broken]))).rejects.toThrow()
    expect(await p.loadUserRecords()).toEqual(emptyUserRecords())
    expect(await p.outboxCount()).toBe(0)
    p.close()
  })

  it('送信待ちのある記録をまた直しても、base は最後に知ったクラウドの中身のまま', async () => {
    const p = fresh()
    const v1 = known('t3f9a2c1b7d0e')
    await seed(p, users([v1]))
    const v2 = { ...v1, on: false, updatedAt: 2 }
    const v3 = { ...v1, on: true, asOf: '2026-11', updatedAt: 3 }
    await p.save(users([v1]), users([v2]))
    await p.save(users([v2]), users([v3]))
    const [row] = await p.readOutbox(10)
    expect(row.base).toEqual(v1)
    expect(row.local).toEqual(v3)
    expect(await p.outboxCount()).toBe(1)
    p.close()
  })

  it('別のタブが先に書き換えていた記録は、渡した merge で合わせて書く', async () => {
    const calls: unknown[][] = []
    const merge: MergeRecord = (table, base, mine, theirs, opts) => {
      calls.push([table, base, mine, theirs, opts])
      return { ...theirs, ...mine, topicIds: ['a', 'b'], seen: true } as AnyRecord
    }
    const p = fresh({ merge })
    const r0 = read('2026-11-15-12')
    await seed(p, users([], [r0]))
    // 別のタブが b を読み、版の一覧を見た
    const other = { ...r0, topicIds: ['b'], seen: true, updatedAt: 2 }
    await p.save(users([], [r0]), users([], [other]))
    // このタブは古い表示のまま a を読んだ
    const mine = { ...r0, topicIds: ['a'], updatedAt: 3 }
    const out = await p.save(users([], [r0]), users([], [mine]))
    expect(calls).toEqual([['reads', r0, mine, other, {}]])
    expect(out.merged.reads).toEqual([{ ...mine, topicIds: ['a', 'b'], seen: true }])
    expect((await p.loadUserRecords()).reads['2026-11-15-12']).toMatchObject({ topicIds: ['a', 'b'], seen: true })
    // 送信待ちの base は、最初の保存の前の中身（クラウドで最後に知った中身）のまま
    expect((await p.readOutbox(10))[0].base).toEqual(r0)
    p.close()
  })

  it('このタブが新しく作ったつもりの記録が保存先にもうあったら、base を null として合わせる', async () => {
    const calls: unknown[][] = []
    const merge: MergeRecord = (table, base, mine, theirs) => {
      calls.push([table, base])
      return { ...theirs, on: (mine as { on?: boolean }).on } as AnyRecord
    }
    const p = fresh({ merge })
    const theirs = known('t3f9a2c1b7d0e', { asOf: '2026-11' })
    await p.save(emptyUserRecords(), users([theirs]))
    const mine = known('t3f9a2c1b7d0e', { on: false, updatedAt: 5 })
    const out = await p.save(emptyUserRecords(), users([mine]))
    expect(calls).toEqual([['knownTerms', null]])
    expect(out.merged.knownTerms).toEqual([{ ...theirs, on: false }])
    p.close()
  })

  it('merge を渡さない時は同期と同じ mergeRemote（syncMerge）: このタブが変えた欄を重ね、表の決まりも当てる（7.8）', async () => {
    const p = fresh()
    const v1 = known('t3f9a2c1b7d0e')
    await seed(p, users([v1]))
    await p.save(users([v1]), users([{ ...v1, asOf: '2026-11', updatedAt: 2 }]))
    await p.save(users([v1]), users([{ ...v1, on: false, updatedAt: 3 }]))
    expect((await p.loadUserRecords()).knownTerms['t3f9a2c1b7d0e']).toEqual({
      ...v1,
      asOf: '2026-11',
      on: false,
      updatedAt: 3,
    })
    // 2つのタブがどちらも既読を新しく作った（base が null）: 版の一覧を見た（seen: true）のは消えず、読んだ話題も残る
    const seenTab = read('2026-11-15-12', { seen: true, updatedAt: 2 })
    await p.save(emptyUserRecords(), users([], [seenTab]))
    const readTab = read('2026-11-15-12', { topicIds: ['2026-11-15-12-k3f9a2bq'], updatedAt: 3 })
    const out = await p.save(emptyUserRecords(), users([], [readTab]))
    expect(out.merged.reads).toEqual([{ ...readTab, seen: true }])
    expect((await p.loadUserRecords()).reads['2026-11-15-12']).toEqual({ ...readTab, seen: true })
    // 共通の履歴が無い時はクラウドを正とする
    expect(syncMerge('knownTerms', null, known('x', { on: false }), known('x'), { noHistory: true })).toEqual(known('x'))
    p.close()
  })

  it('next に無い記録は消さない（削除の印を積まない）', async () => {
    const p = fresh()
    const t1 = known('t3f9a2c1b7d0e')
    await seed(p, users([t1]))
    const out = await p.save(users([t1]), emptyUserRecords())
    expect(out.written).toEqual([])
    expect((await p.loadUserRecords()).knownTerms['t3f9a2c1b7d0e']).toEqual(t1)
    expect(await p.outboxCount()).toBe(0)
    p.close()
  })

  it('別のタブが期限で消した既読は、古い表示から直しても戻さない', async () => {
    const p = fresh()
    const r1 = read('2026-10-01-12')
    await seed(p, users([], [r1]))
    await p.expireBefore('2026-10-17')
    const out = await p.save(users([], [r1]), users([], [{ ...r1, seen: true, updatedAt: 2 }]))
    expect(out.dropped.reads).toEqual(['2026-10-01-12'])
    expect(out.written).toEqual([])
    expect(await p.loadUserRecords()).toEqual(emptyUserRecords())
    expect(await p.outboxCount()).toBe(0)
    p.close()
  })
})

describe('反映（applyRemote）', () => {
  it('コネクタの記録は受け取ったまま（知らない欄・v: 2 も）入れ、送信待ちに積まない', async () => {
    const p = fresh()
    const e = { ...edition('2026-11-15-12', ['2026-11-15-12-k3f9a2bq']), futureField: { x: 1 } } as AnyRecord
    const t = topic('2026-11-15-12-k3f9a2bq', { v: 2, genre: 'novel', newPart: ['…'] })
    const c = correction('2026-11-15-12-k3f9a2bq-c1a2b3c4')
    const f = editionFail('2026-11-15-20-f8d1k2s9')
    const changes: Change[] = [
      { table: 'editions', id: e.id, record: e },
      { table: 'topics', id: t.id, record: t },
      { table: 'corrections', id: c.id, record: c },
      { table: 'editionFails', id: f.id, record: f },
    ]
    const written = await p.applyRemote(changes)
    expect(written).toEqual(changes)
    expect(await p.listEditions()).toEqual([e])
    expect(await p.getTopics([t.id])).toEqual([t])
    expect(await p.listCorrections()).toEqual([c])
    expect(await p.listEditionFails()).toEqual([f])
    expect(await p.outboxCount()).toBe(0)
    // 同じ物がもう一度届いても書かない
    expect(await p.applyRemote(changes)).toEqual([])
    p.close()
  })

  it('辞書の束・知らない表・id が文書と違う記録は端末に入れない（ほかの記録は入れる）', async () => {
    const p = fresh()
    const e = edition('2026-11-15-12')
    const written = await p.applyRemote([
      { table: 'termPacks', id: '2026-11-15-12-p0m4x7c2', record: rec('2026-11-15-12-p0m4x7c2', { entries: [] }) },
      { table: 'novel' as never, id: 'x', record: rec('x') },
      { table: 'topics', id: '2026-11-15-12-k3f9a2bq', record: topic('2026-11-15-12-zzzzzzzz') },
      { table: 'editions', id: e.id, record: e },
    ])
    expect(written.map((c) => `${c.table}/${c.id}`)).toEqual(['editions/2026-11-15-12'])
    expect(await p.getTopics(['2026-11-15-12-k3f9a2bq', '2026-11-15-12-zzzzzzzz'])).toEqual([null, null])
    p.close()
  })

  it('送信待ちの無いアプリの記録は、クラウドの内容にする', async () => {
    const p = fresh()
    const t1 = known('t3f9a2c1b7d0e')
    await seed(p, users([t1]))
    const theirs = { ...t1, on: false, updatedAt: 9 }
    await p.applyRemote([{ table: 'knownTerms', id: t1.id, record: theirs }])
    expect((await p.loadUserRecords()).knownTerms[t1.id]).toEqual(theirs)
    expect(await p.outboxCount()).toBe(0)
    p.close()
  })

  it('送信待ちのあるアプリの記録は3者マージし、クラウドと同じになったら送信待ちを外す', async () => {
    const p = fresh()
    const r0 = read('2026-11-15-12')
    await seed(p, users([], [r0]))
    await p.save(users([], [r0]), users([], [{ ...r0, topicIds: ['a'], updatedAt: 2 }]))
    // ほかの端末が版の一覧を見た
    const theirs = { ...r0, seen: true, updatedAt: 3 }
    await p.applyRemote([{ table: 'reads', id: r0.id, record: theirs }])
    const merged = (await p.loadUserRecords()).reads[r0.id]
    expect(merged).toMatchObject({ topicIds: ['a'], seen: true, updatedAt: 3 })
    const [row] = await p.readOutbox(10)
    expect(row.base).toEqual(theirs)
    // 合わせた結果がクラウドに届いた
    await p.applyRemote([{ table: 'reads', id: r0.id, record: merged }])
    expect(await p.outboxCount()).toBe(0)
    p.close()
  })

  it('共通の履歴が無い送信待ちは、noHistory を付けて merge に渡す', async () => {
    const calls: unknown[] = []
    const merge: MergeRecord = (_t, _b, mine, _theirs, opts) => {
      calls.push(opts)
      return mine
    }
    const p = fresh({ merge })
    const t1 = known('t3f9a2c1b7d0e', { on: false })
    await p.save(emptyUserRecords(), users([t1]))
    await p.markAllDirty()
    await p.applyRemote([{ table: 'knownTerms', id: t1.id, record: known(t1.id) }])
    expect(calls).toEqual([{ noHistory: true }])
    // 合わせた結果がクラウドと違うので、クラウドの内容を base にして、共通の履歴が無い印は外す
    const [row] = await p.readOutbox(10)
    expect(row).toMatchObject({ base: known(t1.id), noHistory: false, local: t1 })
    p.close()
  })

  it('自分の書き込みの返事（own）は base だけ進める', async () => {
    const p = fresh()
    const t1 = known('t3f9a2c1b7d0e')
    await seed(p, users([t1]))
    const latest = { ...t1, on: true, asOf: '2026-11', updatedAt: 3 }
    await p.save(users([t1]), users([latest]))
    const halfway = { ...t1, on: false, updatedAt: 2 }
    await p.applyRemote([{ table: 'knownTerms', id: t1.id, record: halfway, own: true }])
    expect((await p.loadUserRecords()).knownTerms[t1.id]).toEqual(latest)
    expect((await p.readOutbox(10))[0].base).toEqual(halfway)
    await p.applyRemote([{ table: 'knownTerms', id: t1.id, record: latest, own: true }])
    expect(await p.outboxCount()).toBe(0)
    p.close()
  })

  it('クラウドに無い（null）アプリの記録は端末から消さず、知ってるの送信待ちは共通の履歴が無い物として作り直す', async () => {
    const p = fresh()
    const t1 = known('t3f9a2c1b7d0e')
    const t2 = known('t000000000002')
    await seed(p, users([t1, t2]))
    const changed = { ...t1, on: false, updatedAt: 2 }
    await p.save(users([t1, t2]), users([changed, t2]))
    await p.markUnconfirmed([{ key: `knownTerms/${t1.id}`, record: changed }], 'tx-1')
    const written = await p.applyRemote([
      { table: 'knownTerms', id: t1.id, record: null },
      { table: 'knownTerms', id: t2.id, record: null },
    ])
    expect(written).toEqual([])
    expect(await p.loadUserRecords()).toEqual(users([changed, t2]))
    const rows = await p.readOutbox(10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ k: `knownTerms/${t1.id}`, base: null, noHistory: true, local: changed })
    expect(rows[0].unconfirmed).toBeUndefined()
    expect(rows[0].tx).toBeUndefined()
    p.close()
  })

  it('クラウドに無い（null）既読は作り直さない（送る前の守りと expireBefore で捨てる。docs/SPEC.md の 7.8）', async () => {
    const p = fresh()
    const r0 = read('2026-11-15-12')
    await seed(p, users([], [r0]))
    const changed = { ...r0, seen: true, updatedAt: 2 }
    await p.save(users([], [r0]), users([], [changed]))
    expect(await p.applyRemote([{ table: 'reads', id: r0.id, record: null }])).toEqual([])
    expect((await p.loadUserRecords()).reads[r0.id]).toEqual(changed)
    const [row] = await p.readOutbox(10)
    expect(row).toMatchObject({ k: `reads/${r0.id}`, base: r0, noHistory: false, local: changed })
    p.close()
  })

  it('コネクタの記録が null で届いたら端末から消す（端末の中はいつもクラウドと同じ）', async () => {
    const p = fresh()
    const e = edition('2026-11-15-12')
    await p.applyRemote([{ table: 'editions', id: e.id, record: e }])
    expect(await p.applyRemote([{ table: 'editions', id: e.id, record: null }])).toEqual([
      { table: 'editions', id: e.id, record: null },
    ])
    expect(await p.listEditions()).toEqual([])
    p.close()
  })

  it('位置と _meta（caughtUpAt・firstSync）を反映と一緒に書く。届いた記録が0件でも位置を進められる', async () => {
    const p = fresh()
    await p.setMeta('firstSync', { knownAt: 100 })
    await p.applyRemote([], {
      cursor: { place: 'records', at: { s: 1_760_000_000, n: 0 } },
      meta: { caughtUpAt: 200, firstSync: null },
    })
    expect(await p.getMeta('cursor')).toEqual({ records: { s: 1_760_000_000, n: 0 } })
    expect(await p.getMeta('caughtUpAt')).toBe(200)
    expect(await p.getMeta('firstSync')).toBeNull()
    p.close()
  })

  it('途中で書けなかったら、記録も位置も _meta も書かない（同じトランザクション）', async () => {
    const p = fresh()
    const e = edition('2026-11-15-12')
    const broken = topic('2026-11-15-12-k3f9a2bq', { headline: () => '〇〇市' })
    await expect(
      p.applyRemote(
        [
          { table: 'editions', id: e.id, record: e },
          { table: 'topics', id: broken.id, record: broken },
        ],
        { cursor: { place: 'records', at: { s: 5, n: 0 } }, meta: { caughtUpAt: 300 } },
      ),
    ).rejects.toThrow()
    expect(await p.listEditions()).toEqual([])
    expect(await p.getMeta('cursor')).toBeUndefined()
    expect(await p.getMeta('caughtUpAt')).toBeUndefined()
    p.close()
  })
})

describe('開く分だけ読む（話題と訂正は版ごと・話題ごと。アプリの記録と版の一覧は全部）', () => {
  it('版ごと・話題ごと・続報のつながりごとに読める', async () => {
    const p = fresh()
    const a1 = topic('2026-11-15-12-aaaaaaa1')
    const a2 = topic('2026-11-15-12-aaaaaaa2')
    const b1 = topic('2026-11-16-20-bbbbbbb1', { threadId: a1.id })
    const ca = correction(`${a1.id}-c1a2b3c4`)
    const ca2 = correction(`${a1.id}-c5d6e7f8`)
    const cb = correction(`${b1.id}-c1a2b3c4`)
    await p.applyRemote(
      [
        edition('2026-11-16-20', [b1.id]),
        edition('2026-11-15-12', [a2.id, a1.id]),
        editionFail('2026-11-15-20-f8d1k2s9'),
        a1,
        a2,
        b1,
        ca,
        ca2,
        cb,
      ].map((r): Change => {
        const table = 'order' in r ? 'editions' : 'reasonKind' in r ? 'editionFails' : 'text' in r ? 'corrections' : 'topics'
        return { table, id: r.id, record: r }
      }),
    )
    await p.save(emptyUserRecords(), users([known('t3f9a2c1b7d0e')], [read('2026-11-15-12')]))

    expect((await p.listEditions()).map((r) => r.id)).toEqual(['2026-11-15-12', '2026-11-16-20'])
    expect((await p.listEditionFails()).map((r) => r.id)).toEqual(['2026-11-15-20-f8d1k2s9'])
    expect((await p.topicsOfEdition('2026-11-15-12')).map((r) => r.id)).toEqual([a1.id, a2.id])
    expect(await p.topicsOfEdition('2026-11-17-12')).toEqual([])
    expect((await p.topicsOfThread(a1.id)).map((r) => r.id)).toEqual([a1.id, b1.id])
    // 版の order の並びで読み、端末に無い話題は null
    expect(await p.getTopics([a2.id, '2026-11-15-12-zzzzzzzz', a1.id])).toEqual([a2, null, a1])
    expect(await p.getTopics([])).toEqual([])
    expect((await p.correctionsOfTopic(a1.id)).map((r) => r.id)).toEqual([ca.id, ca2.id])
    expect((await p.correctionsOfEdition('2026-11-16-20')).map((r) => r.id)).toEqual([cb.id])
    expect((await p.listCorrections()).length).toBe(3)
    const mine = await p.loadUserRecords()
    expect(Object.keys(mine.knownTerms)).toEqual(['t3f9a2c1b7d0e'])
    expect(Object.keys(mine.reads)).toEqual(['2026-11-15-12'])
    p.close()
  })
})

describe('presentTopicIds（端末にある話題の id。鍵だけを読む。段階2の版の一覧の「受け取り中」）', () => {
  it('渡した id のうち端末にある物だけを返し、話題の中身を読まない', async () => {
    const p = fresh()
    const a = topic('2026-11-15-12-aaaaaaa1')
    const b = topic('2026-11-15-12-aaaaaaa2')
    await p.applyRemote([a, b].map((r): Change => ({ table: 'topics', id: r.id, record: r })))
    // 話題の中身を読む道（値のカーソル・まとめて読む・1件読む）を見張る。鍵だけの道（openKeyCursor・getAllKeys）は数えない
    const reads: string[] = []
    const watch = <T extends object>(proto: T, names: (keyof T & string)[]) =>
      names.map((name) => {
        const orig = proto[name] as unknown as (...args: unknown[]) => unknown
        ;(proto as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
          reads.push(name)
          return orig.apply(this, args)
        }
        return () => ((proto as Record<string, unknown>)[name] = orig)
      })
    const restore = [
      ...watch(IDBObjectStore.prototype, ['get', 'getAll', 'openCursor']),
      ...watch(IDBIndex.prototype, ['get', 'getAll', 'openCursor']),
    ]
    try {
      const got = await p.presentTopicIds([b.id, '2026-11-15-12-zzzzzzzz', a.id, a.id])
      expect(got).toEqual(new Set([a.id, b.id]))
      expect(reads).toEqual([])
      // 見張りが効いている事（中身を読む getTopics は数える）
      await p.getTopics([a.id])
      expect(reads.length).toBeGreaterThan(0)
    } finally {
      for (const r of restore) r()
    }
    expect(await p.presentTopicIds([])).toEqual(new Set())
    expect(await p.presentTopicIds(['2026-11-16-12-zzzzzzzz'])).toEqual(new Set())
    p.close()
  })
})

describe('送る（readOutbox・completeUpload・返事を受け取れなかった書き込み）', () => {
  it('readOutbox は limit 件まで。completeUpload は、送った後に変わっていなければ外し、変わっていれば送った内容を base にする', async () => {
    const p = fresh()
    const a = known('t00000000000a')
    const b = known('t00000000000b')
    const c = known('t00000000000c')
    await p.save(emptyUserRecords(), users([a, b, c]))
    expect((await p.readOutbox(2)).map((r) => r.id)).toEqual([a.id, b.id])
    // a・b を送った後に、b だけまた直した
    await p.save(users([a, b, c]), users([a, { ...b, on: false, updatedAt: 2 }, c]))
    await p.completeUpload([
      { table: 'knownTerms', id: a.id, record: a },
      { table: 'knownTerms', id: b.id, record: b },
    ])
    const left = await p.readOutbox(10)
    expect(left.map((r) => [r.id, r.base])).toEqual([
      [b.id, b],
      [c.id, null],
    ])
    expect(await p.outboxKeys()).toEqual(new Set([`knownTerms/${b.id}`, `knownTerms/${c.id}`]))
    p.close()
  })

  it('送る前に id と送る内容を覚え、届いていたと分かったら送った内容を base にする（その後に変わっていなければ送り終わり）', async () => {
    const p = fresh()
    const a = known('t00000000000a')
    const b = known('t00000000000b')
    await seed(p, users([a, b]))
    const sentA = { ...a, on: false, updatedAt: 2 }
    const sentB = { ...b, on: false, updatedAt: 2 }
    await p.save(users([a, b]), users([sentA, sentB]))
    await p.markUnconfirmed(
      [
        { key: `knownTerms/${a.id}`, record: sentA },
        { key: `knownTerms/${b.id}`, record: sentB },
      ],
      'tx-1',
    )
    // 送った後に、b だけまた直した
    const laterB = { ...sentB, asOf: '2026-11', updatedAt: 3 }
    await p.save(users([sentA, sentB]), users([sentA, laterB]))
    expect(await p.unconfirmedTx([`knownTerms/${a.id}`, `knownTerms/${b.id}`, 'knownTerms/x'])).toEqual(new Set(['tx-1']))
    expect((await p.readOutbox(10))[0]).toMatchObject({ unconfirmed: true, tx: 'tx-1', sent: sentA, base: a })
    // 別の id の書き込みが届いていても、この行は変えない
    await p.confirmLanded('tx-0')
    expect(await p.outboxCount()).toBe(2)
    await p.confirmLanded('tx-1')
    const left = await p.readOutbox(10)
    expect(left.map((r) => r.id)).toEqual([b.id])
    expect(left[0].base).toEqual(sentB)
    expect(left[0].unconfirmed).toBeUndefined()
    expect(left[0].tx).toBeUndefined()
    expect(await p.unconfirmedTx([`knownTerms/${b.id}`])).toEqual(new Set())
    p.close()
  })

  it('クラウドの内容から base を書き直したら（受け取った反映）、返事待ちの印と送った内容も外す', async () => {
    const p = fresh()
    const r0 = read('2026-11-15-12')
    await seed(p, users([], [r0]))
    const mine = { ...r0, topicIds: ['a'], updatedAt: 2 }
    await p.save(users([], [r0]), users([], [mine]))
    await p.markUnconfirmed([{ key: `reads/${r0.id}`, record: mine }], 'tx-1')
    const theirs = { ...r0, seen: true, updatedAt: 3 }
    await p.applyRemote([{ table: 'reads', id: r0.id, record: theirs }])
    const [row] = await p.readOutbox(10)
    expect(row.base).toEqual(theirs)
    expect(row.unconfirmed).toBeUndefined()
    expect(row.tx).toBeUndefined()
    expect(row.sent).toBeUndefined()
    p.close()
  })
})

describe('アカウントの切り替え（markAllDirty）', () => {
  it('アプリの記録を全部「共通の履歴が無い」送信待ちにし、Claude の記録の写しと位置を消す。ownerSeen は残す', async () => {
    const p = fresh()
    await p.setMeta('ownerSeen', 'uid-a')
    const t1 = known('t00000000000a')
    const t2 = known('t00000000000b')
    const r1 = read('2026-11-15-12')
    await seed(p, users([t1], [r1]))
    await p.save(users([t1], [r1]), users([t1, t2], [r1]))
    await p.markUnconfirmed([{ key: `knownTerms/${t2.id}`, record: t2 }], 'tx-old')
    await p.applyRemote(
      [
        { table: 'editions', id: '2026-11-15-12', record: edition('2026-11-15-12') },
        { table: 'topics', id: '2026-11-15-12-k3f9a2bq', record: topic('2026-11-15-12-k3f9a2bq') },
        {
          table: 'corrections',
          id: '2026-11-15-12-k3f9a2bq-c1a2b3c4',
          record: correction('2026-11-15-12-k3f9a2bq-c1a2b3c4'),
        },
        { table: 'editionFails', id: '2026-11-15-20-f8d1k2s9', record: editionFail('2026-11-15-20-f8d1k2s9') },
      ],
      { cursor: { place: 'records', at: { s: 1, n: 0 } }, meta: { caughtUpAt: 5, firstSync: { knownAt: 4 } } },
    )
    await p.markAllDirty()

    const rows = await p.readOutbox(10)
    expect(rows.map((r) => [r.k, r.base, r.noHistory])).toEqual([
      [`knownTerms/${t1.id}`, null, true],
      [`knownTerms/${t2.id}`, null, true],
      [`reads/${r1.id}`, null, true],
    ])
    expect(rows.some((r) => r.tx || r.unconfirmed)).toBe(false)
    expect(await p.loadUserRecords()).toEqual(users([t1, t2], [r1]))
    expect(await p.listEditions()).toEqual([])
    expect(await p.getTopics(['2026-11-15-12-k3f9a2bq'])).toEqual([null])
    expect(await p.listCorrections()).toEqual([])
    expect(await p.listEditionFails()).toEqual([])
    expect(await p.getMeta('cursor')).toBeNull()
    expect(await p.getMeta('caughtUpAt')).toBeNull()
    expect(await p.getMeta('firstSync')).toBeNull()
    expect(await p.getMeta('ownerSeen')).toBe('uid-a')
    p.close()
  })
})

describe('30日で消す（expireBefore。docs/SPEC.md の 7.8 の「端末の中で消す」）', () => {
  const oldTopic = '2026-11-15-12-k3f9a2bq'
  const keptTopic = '2026-11-16-12-m2n8c4d1'

  async function seedMonth(): Promise<Persistence> {
    const p = fresh()
    const connector: AnyRecord[][] = [
      [edition('2026-11-15-12', [oldTopic]), edition('2026-11-15-20'), edition('2026-11-16-12', [keptTopic])],
      [topic(oldTopic), topic('2026-11-15-20-aaaaaaaa'), topic(keptTopic, { threadId: oldTopic })],
      [correction(`${oldTopic}-c1a2b3c4`), correction(`${oldTopic}-c5d6e7f8`), correction(`${keptTopic}-c1a2b3c4`)],
      [editionFail('2026-11-15-20-f8d1k2s9'), editionFail('2026-11-16-20-f8d1k2s9')],
    ]
    const tables = ['editions', 'topics', 'corrections', 'editionFails'] as const
    await p.applyRemote(tables.flatMap((table, i) => connector[i].map((record) => ({ table, id: record.id, record }))))
    // 既読: 11/15 の物は送り終わり、11/15 の 20:00版と 11/16 の物は電波の無い間に読んだまま送信待ち
    const sent = read('2026-11-15-12', { seen: true })
    await seed(p, users([known('t3f9a2c1b7d0e')], [sent]))
    await p.save(
      users([known('t3f9a2c1b7d0e')], [sent]),
      users(
        [known('t3f9a2c1b7d0e', { on: false, updatedAt: 2 })],
        [sent, read('2026-11-15-20', { topicIds: ['2026-11-15-20-aaaaaaaa'] }), read('2026-11-16-12')],
      ),
    )
    return p
  }

  it('境より前の版・話題・訂正（話題と同じ日）・作れなかった印・既読と、同じ鍵の送信待ちを一緒に消し、送信待ちに積まない', async () => {
    const p = await seedMonth()
    expect(await p.outboxCount()).toBe(3)
    // 12/15 の 0時（日本時間）からは 11/15 の版が消え、11/16〜12/15 の30日分が残る
    const boundary = retentionBoundary(Date.parse('2026-12-15T00:00:00+09:00')).firstKeptDate
    expect(boundary).toBe('2026-11-16')
    const out = await p.expireBefore(boundary)

    expect(out.removed.map((c) => `${c.table}/${c.id}`).sort()).toEqual(
      [
        'editions/2026-11-15-12',
        'editions/2026-11-15-20',
        `topics/${oldTopic}`,
        'topics/2026-11-15-20-aaaaaaaa',
        `corrections/${oldTopic}-c1a2b3c4`,
        `corrections/${oldTopic}-c5d6e7f8`,
        'editionFails/2026-11-15-20-f8d1k2s9',
        'reads/2026-11-15-12',
        'reads/2026-11-15-20',
      ].sort(),
    )
    expect(out.removed.every((c) => c.record === null)).toBe(true)
    expect(out.outbox).toEqual(['reads/2026-11-15-20'])

    expect((await p.listEditions()).map((r) => r.id)).toEqual(['2026-11-16-12'])
    expect(await p.getTopics([oldTopic, keptTopic])).toEqual([null, topic(keptTopic, { threadId: oldTopic })])
    expect((await p.listCorrections()).map((r) => r.id)).toEqual([`${keptTopic}-c1a2b3c4`])
    expect((await p.listEditionFails()).map((r) => r.id)).toEqual(['2026-11-16-20-f8d1k2s9'])
    // 知ってるは消さない。30日の内の既読と、その送信待ちは残る
    const mine = await p.loadUserRecords()
    expect(Object.keys(mine.knownTerms)).toEqual(['t3f9a2c1b7d0e'])
    expect(Object.keys(mine.reads)).toEqual(['2026-11-16-12'])
    // 消した分の送信待ち（削除の印）を積まない
    expect([...(await p.outboxKeys())].sort()).toEqual(['knownTerms/t3f9a2c1b7d0e', 'reads/2026-11-16-12'])
    expect((await p.readOutbox(10)).every((r) => r.local !== null)).toBe(true)

    // もう一度呼んでも何も消さない
    expect(await p.expireBefore(boundary)).toEqual({ removed: [], outbox: [] })
    p.close()
  })

  it('日本時間の 0時の前は、まだ消さない', async () => {
    const p = await seedMonth()
    const boundary = retentionBoundary(Date.parse('2026-12-14T23:59:59.999+09:00')).firstKeptDate
    expect(boundary).toBe('2026-11-15')
    expect(await p.expireBefore(boundary)).toEqual({ removed: [], outbox: [] })
    expect((await p.listEditions()).length).toBe(3)
    expect(await p.outboxCount()).toBe(3)
    p.close()
  })

  it('境の形が違う時は断り、何も消さない', async () => {
    const p = await seedMonth()
    for (const bad of ['', '2026-11', '2026-11-16-12', '9999', '2026-02-30']) {
      await expect(p.expireBefore(bad)).rejects.toThrow()
    }
    expect((await p.listEditions()).length).toBe(3)
    expect(await p.outboxCount()).toBe(3)
    p.close()
  })
})
