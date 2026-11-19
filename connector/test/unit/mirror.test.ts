// 写し（vault/mirror.ts・設計の 1.9）: 問い合わせの形が CONNECTOR_QUERIES の一覧の形だけ（table in・count は table ==・名前で読み直す）・
// 表ごとの軽い行（話題の出典の URL）・辞書の束を辞書の今の形に当てる・30日で消す・作業の字数で区切る・持ち主が変わったら消す・
// 消えないはずの表の数を比べて読み直す・書いた記録を読み直さずに写しへ入れる。作り物の1か月分の版（src/test/fixtures/fakeEditions.ts）で
import { describe, expect, it } from 'vitest'
import { findConnectorQuery, type ConnectorQueryMethod } from '../../../src/test/connectorQueries'
import { fakeRecordsOf, makeFakeMonth, makeFakeEdition } from '../../../src/test/fixtures/fakeEditions'
import { termIdOf, termPackIdOf } from '../../../src/domain/ids'
import { dictionaryOf, liveTerms } from '../../../src/domain/terms'
import { CLAUDE_READ_TABLES, type TermEntry, type TermPack } from '../../../src/domain/types'
import { mirrorQueries, MIRROR_EXPIRING_TABLES } from '../../src/vault/mirror'
import { DAILY_ROW_BUDGET, nextUtcMidnight } from '../../src/vault/store'
import { prepareWrite } from '../../src/vault/writer'
import { FakeFirebase } from '../support/fakeFirebase'
import { drainAlarms, OWNER, pairedCore, seedRecords } from '../support/harness'

const NOW = Date.UTC(2026, 10, 19, 3, 0, 0) // 2026-11-19 12:00（日本時間）

/** Firestore の問い合わせを見張る fetch（組んだ structuredQuery を取っておく） */
function spyQueries(fake: FakeFirebase) {
  const seen: { method: ConnectorQueryMethod; q: unknown }[] = []
  const spyFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    if (url.endsWith(':runQuery')) seen.push({ method: 'runQuery', q: body.structuredQuery })
    if (url.endsWith(':runAggregationQuery'))
      seen.push({ method: 'count', q: (body.structuredAggregationQuery as { structuredQuery: unknown }).structuredQuery })
    return fake.fetch(input as never, init)
  }) as typeof fetch
  return { fetch: spyFetch, seen }
}

async function month(days = 32) {
  const fake = new FakeFirebase()
  const m = makeFakeMonth({ until: '2026-11-19', days, untilSlot: '12' })
  seedRecords(fake, fakeRecordsOf(m))
  const spy = spyQueries(fake)
  const made = await pairedCore(fake, { clock: { now: NOW }, fetch: spy.fetch })
  return { fake, m, ...made, seen: spy.seen }
}

describe('問い合わせの形（src/test/connectorQueries.ts の CONNECTOR_QUERIES）', () => {
  it('組む関数の出力は、どれも一覧の形（写しの差分・表の数・名前で読み直す）', () => {
    const cursor = {
      ts: '2026-11-19T00:00:00.000001Z',
      name: 'projects/p/databases/(default)/documents/users/u/records/topics:x',
    }
    expect(findConnectorQuery('runQuery', mirrorQueries.delta(null, 50))?.label).toContain('写しの差分')
    expect(findConnectorQuery('runQuery', mirrorQueries.delta(cursor, 5))?.label).toContain('写しの差分')
    expect(findConnectorQuery('count', mirrorQueries.count('termPacks'))?.label).toContain('消えないはずの表の数')
    expect(findConnectorQuery('runQuery', mirrorQueries.byName('knownTerms', null, 50))?.label).toContain('名前で読み直す')
    expect(findConnectorQuery('runQuery', mirrorQueries.byName('termPacks', cursor.name, 50))?.label).toContain('名前で読み直す')
  })

  it('写しの差分は table in [読ませる6つ]、続きは [updated, 名前] の後ろから（before: false）。名前で読み直すのは [名前] の後ろから', () => {
    const q = mirrorQueries.delta({ ts: 'T', name: 'N' }, 7) as {
      where: { fieldFilter: { op: string; value: { arrayValue: { values: { stringValue: string }[] } } } }
      orderBy: { field: { fieldPath: string } }[]
      startAt: { values: unknown[]; before: boolean }
      limit: number
    }
    expect(q.where.fieldFilter.op).toBe('IN')
    expect(q.where.fieldFilter.value.arrayValue.values.map((v) => v.stringValue)).toEqual([...CLAUDE_READ_TABLES])
    expect(q.orderBy.map((o) => o.field.fieldPath)).toEqual(['updated', '__name__'])
    expect(q.startAt).toEqual({ values: [{ timestampValue: 'T' }, { referenceValue: 'N' }], before: false })
    expect(q.limit).toBe(7)
    const b = mirrorQueries.byName('termPacks', 'N', 3) as { startAt: unknown; orderBy: { field: { fieldPath: string } }[] }
    expect(b.startAt).toEqual({ values: [{ referenceValue: 'N' }], before: false })
    expect(b.orderBy.map((o) => o.field.fieldPath)).toEqual(['__name__'])
    // count は table == だけ（並び・件数・位置を持たない）
    expect(Object.keys(mirrorQueries.count('knownTerms')).sort()).toEqual(['from', 'where'])
  })

  it('取り込み・読むツール・回の始め・夜の仕事で送った問い合わせは、どれも一覧の形', async () => {
    const { core, clock, grant, seen } = await month(5)
    await drainAlarms(core, clock)
    await core.callTool('topic_list_recent', {}, { grant })
    await core.callTool('topic_begin_run', { kind: 'trial', model: 'fake-writer-model' }, { grant })
    await core.nightly()
    await drainAlarms(core, clock)
    expect(seen.length).toBeGreaterThan(3)
    for (const s of seen) expect(findConnectorQuery(s.method, s.q), JSON.stringify(s.q)).not.toBeNull()
  })
})

describe('取り込み', () => {
  it('読ませる6つの表の軽い行を持ち、全文は持たない。話題の軽い行に出典の URL', async () => {
    const { core, clock, m } = await month(5)
    await drainAlarms(core, clock)
    expect(core.mirror.warm().done).toBe(true)
    const counts = core.mirror.counts()
    const topics = m.editions.flatMap((e) => e.topics)
    expect(counts.topics).toBe(topics.length)
    expect(counts.editions).toBe(m.editions.length)
    expect(counts.termPacks).toBe(m.editions.length)
    const t = topics[0]
    const lite = core.mirror.get('topics', t.id)!
    expect(lite).toMatchObject({
      editionId: t.editionId,
      threadId: t.threadId,
      region: t.region,
      genre: t.genre,
      headline: t.headline,
    })
    expect(lite.urls).toEqual(t.sources.map((s) => s.url))
    expect(Array.from(lite.summaryHead).length).toBeLessThanOrEqual(40)
    // 全文（要約の全部・当事者など）は持たない
    const row = core.store.getMirror(`topics:${t.id}`)!
    expect(row.lite).not.toContain(t.summary.length > 40 ? t.summary : '\u0000')
    expect(JSON.parse(row.lite)).not.toHaveProperty('stakeholders')
    const ed = core.mirror.get('editions', m.editions[0].edition.id)!
    expect(ed.order).toEqual(m.editions[0].edition.order)
  })

  it('辞書の束は辞書の今の形に当てる（語ごとに rev の最大。束の中身は写しに持たない）', async () => {
    const { core, clock, m } = await month(5)
    await drainAlarms(core, clock)
    const want = liveTerms(dictionaryOf(m.editions.map((e) => e.termPack)))
    const got = core.store.allTerms().filter((e) => e.retired !== true)
    expect(got.map((e) => [e.termId, e.rev])).toEqual(
      want.map((e) => [e.termId, e.rev]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    )
    const pack = core.store.getMirror(`termPacks:${m.editions[0].termPack.id}`)!
    expect(JSON.parse(pack.lite)).toEqual({
      editionId: m.editions[0].termPack.editionId,
      n: m.editions[0].termPack.entries.length,
    })
  })

  it('30日を過ぎた版・話題・訂正・作れなかった印は取り込まない。日が変わると写しから消す', async () => {
    const { core, clock, m } = await month(32)
    await drainAlarms(core, clock)
    const oldest = m.editions[0].edition.id
    expect(oldest < '2026-10-21').toBe(true)
    expect(core.mirror.has('editions', oldest)).toBe(false)
    const kept = m.editions.find((e) => e.edition.id >= '2026-10-21')!.edition.id
    expect(core.mirror.has('editions', kept)).toBe(true)
    // 日をまたぐと、その日の境で消える（読むツールの前）
    clock.now = Date.UTC(2026, 10, 25, 3, 0, 0)
    core.mirror.expire(clock.now)
    for (const t of MIRROR_EXPIRING_TABLES)
      for (const r of core.mirror.rows(t)) expect(r.id.slice(0, 10) >= '2026-10-27', `${t} ${r.id}`).toBe(true)
    // 辞書の束と知ってるは消さない
    expect(core.mirror.counts().termPacks).toBe(m.editions.length)
  })

  it('作業の字数で区切り、続きは alarm で（初めての取り込みの間は「取り込み中」）', async () => {
    const fake = new FakeFirebase()
    seedRecords(fake, fakeRecordsOf(makeFakeMonth({ until: '2026-11-19', days: 5 })))
    const { core, clock, grant } = await pairedCore(fake, { clock: { now: NOW }, config: { workBudgetChars: 20_000 } })
    const first = await core.callTool('topic_list_recent', {}, { grant })
    expect(first.isError).toBe(true)
    expect(first.text).toContain('初回の取り込み中')
    expect(core.mirror.warm().done).toBe(false)
    await drainAlarms(core, clock)
    expect(core.mirror.warm().done).toBe(true)
    expect((await core.callTool('topic_list_recent', {}, { grant })).isError).toBeUndefined()
  })

  it('持ち主が変わったら、写し・辞書・回の物を消して取り込み直す', async () => {
    const { core, clock, fake, uid } = await month(3)
    await drainAlarms(core, clock)
    expect(core.mirror.counts().topics).toBeGreaterThan(0)
    expect(core.store.termCount()).toBeGreaterThan(0)
    fake.setOwner('owner-uid-2')
    fake.setAppModel('owner-uid-2', 2)
    const { pairingHash } = await import('../../src/vault/crypto')
    const hash = await pairingHash('state-new', 'k'.repeat(43))
    fake.addConnection({ uid, cid: 'c2', name: '接続2', pairing: hash, pairedAt: clock.now })
    const r = await core.verifyPairing(hash)
    expect(r.ok).toBe(true)
    expect(core.mirror.counts()).toEqual({})
    expect(core.store.termCount()).toBe(0)
    expect(core.mirror.warm().done).toBe(false)
  })
})

describe('消えないはずの表（数を比べて読み直す）', () => {
  it('知ってるが減ったら、名前で読み直して写しから外す', async () => {
    const fake = new FakeFirebase()
    const e = makeFakeEdition({ date: '2026-11-18', slot: '20', seed: 's' })
    seedRecords(fake, [{ table: 'termPacks', record: e.termPack }])
    const known = e.termPack.entries.slice(0, 3).map((t, i) => ({
      id: t.termId,
      v: 1,
      createdAt: NOW - 1000 + i,
      updatedAt: NOW - 1000 + i,
      by: 'user',
      ai: null,
      term: t.term,
      asOf: t.asOf,
      on: true,
    }))
    for (const k of known) fake.putRecord(OWNER, 'knownTerms', k)
    const { core, clock } = await pairedCore(fake, { clock: { now: NOW } })
    await drainAlarms(core, clock)
    expect(core.mirror.counts().knownTerms).toBe(3)
    fake.docs.delete(fake.name(`users/${OWNER}/records/knownTerms:${known[1].id}`))
    const tables = await core.mirror.recount(() => true)
    expect(tables).toEqual(['knownTerms'])
    core.mirror.startRecheck(tables)
    const out = await core.mirror.recheckStep({ maxPages: 10, workBudget: 300_000, takeReads: () => true })
    expect(out.done).toBe(true)
    expect(
      core.mirror
        .rows('knownTerms')
        .map((k) => k.id)
        .sort(),
    ).toEqual([known[0].id, known[2].id].sort())
    expect(core.dictionary.rebuilding()).toBe(false)
  })

  it('辞書の束が減ったら、読み直した後に辞書を作り直す（作り直しの間は今の表で引ける）', async () => {
    const fake = new FakeFirebase()
    const m = makeFakeMonth({ until: '2026-11-19', days: 3, untilSlot: '12' })
    seedRecords(fake, fakeRecordsOf(m))
    const { core, clock } = await pairedCore(fake, { clock: { now: NOW } })
    await drainAlarms(core, clock)
    const gone = m.editions[m.editions.length - 1].termPack
    const before = core.store.termCount()
    fake.docs.delete(fake.name(`users/${OWNER}/records/termPacks:${gone.id}`))
    core.mirror.startRecheck(await core.mirror.recount(() => true))
    await core.mirror.recheckStep({ maxPages: 10, workBudget: 300_000, takeReads: () => true })
    expect(core.mirror.has('termPacks', gone.id)).toBe(false)
    expect(core.dictionary.rebuilding()).toBe(true)
    // 作り直しの間も今の表で引ける
    expect(core.store.termCount()).toBe(before)
    const step = await core.mirror.rebuildStep({ maxPages: 10, workBudget: 300_000, takeReads: () => true })
    expect(step.done).toBe(true)
    expect(core.dictionary.rebuilding()).toBe(false)
    const want = liveTerms(dictionaryOf(m.editions.filter((e) => e.termPack.id !== gone.id).map((e) => e.termPack)))
    expect(
      core.store
        .allTerms()
        .filter((t) => t.retired !== true)
        .map((t) => t.termId)
        .sort(),
    ).toEqual(want.map((t) => t.termId).sort())
  })
})

describe('書いた記録を写しへ（putOwn）', () => {
  it('書いた版・束を読み直さずに写しに入れ、束の語は辞書に当てる', async () => {
    const fake = new FakeFirebase()
    const { core } = await pairedCore(fake, { clock: { now: NOW } })
    const e = makeFakeEdition({ date: '2026-11-19', slot: '12', seed: 'own' })
    const prepared = [
      prepareWrite(core.fs, OWNER, { table: 'termPacks', record: e.termPack }),
      prepareWrite(core.fs, OWNER, { table: 'editions', record: e.edition }),
    ]
    const t = '2026-11-19T03:00:00.000001Z'
    core.mirror.putOwn(prepared, {
      writeResults: prepared.map(() => ({ updateTime: t, transformResults: [{ timestampValue: t }] })),
      commitTime: t,
    })
    expect(core.mirror.has('editions', e.edition.id)).toBe(true)
    expect(core.store.getMirror(`editions:${e.edition.id}`)!.device).toBe('claude-connector')
    expect(core.dictionary.get(e.termPack.entries[0].termId)).toMatchObject({ termId: e.termPack.entries[0].termId })
  })
})

/** 大きな作り物の辞書の束（1つに200語・別名5つ。1つの束で約1,400行を書く。中身は作り物の文字だけ） */
function bigPacks(count: number): TermPack[] {
  const base = makeFakeEdition({ date: '2026-11-19', slot: '12', seed: 'big' }).termPack
  const packs: TermPack[] = []
  for (let k = 0; k < count; k++) {
    const entries: TermEntry[] = []
    for (let i = 0; i < 200; i++) {
      const key = `作り物の大きな語${k}-${i}`
      entries.push({
        termId: termIdOf(key),
        key,
        term: key,
        aliases: [1, 2, 3, 4, 5].map((j) => `${key}の別名${j}`),
        explanation: `作り物の説明 ${key}`,
        asOf: '2026-11',
        rev: 1,
      })
    }
    packs.push({ ...base, id: termPackIdOf(base.editionId, entries), entries })
  }
  return packs
}

describe('1日の行の予算と大きな辞書の束', () => {
  const opts = { maxPages: 10, workBudget: 300_000, takeReads: () => true }

  it('初めての取り込み: 1つのページの束が1日の予算に入らない時は、小さなページで読み直して日ごとに進む', async () => {
    const fake = new FakeFirebase()
    const packs = bigPacks(32)
    seedRecords(
      fake,
      packs.map((record) => ({ table: 'termPacks' as const, record })),
    )
    const { core, clock } = await pairedCore(fake, { clock: { now: NOW } })
    let days = 0
    while (!core.mirror.warm().done) {
      await drainAlarms(core, clock, { n: 20 })
      expect(core.store.rowsUsed()).toBeLessThanOrEqual(DAILY_ROW_BUDGET)
      if (core.mirror.warm().done) break
      days += 1
      expect(days).toBeLessThan(4)
      clock.now = nextUtcMidnight(clock.now) + 60_000
      core.store.putTask('mirror', clock.now)
    }
    expect(days).toBeGreaterThanOrEqual(1)
    expect(core.store.termCount()).toBe(32 * 200)
  }, 60_000)

  it('作り直し: 差分のページが大きく戻っても、束は束の大きさのページで読み、日ごとに予算の中で進む（戻したページの行は数えない）', async () => {
    const fake = new FakeFirebase()
    const packs = bigPacks(32)
    seedRecords(
      fake,
      packs.map((record) => ({ table: 'termPacks' as const, record })),
    )
    const { core, clock } = await pairedCore(fake, { clock: { now: NOW } })
    for (let d = 0; d < 4 && !core.mirror.warm().done; d++) {
      await drainAlarms(core, clock, { n: 20 })
      clock.now = nextUtcMidnight(clock.now) + 60_000
      core.store.putTask('mirror', clock.now)
    }
    expect(core.mirror.warm().done).toBe(true)
    // 束が1つ消えた → 読み直し → 作り直し
    fake.docs.delete(fake.name(`users/${OWNER}/records/termPacks:${packs[0].id}`))
    clock.now = nextUtcMidnight(clock.now) + 60_000
    core.mirror.startRecheck(await core.mirror.recount(() => true))
    let rechecked = await core.mirror.recheckStep(opts)
    for (let d = 0; d < 4 && !rechecked.done; d++) {
      clock.now = nextUtcMidnight(clock.now) + 60_000
      rechecked = await core.mirror.recheckStep(opts)
    }
    expect(rechecked.done).toBe(true)
    expect(core.dictionary.rebuilding()).toBe(true)
    // 小さな記録の差分を読む（差分のページの大きさは小さな文書に合わせて戻る）
    seedRecords(fake, [{ table: 'editions', record: makeFakeEdition({ date: '2026-11-19', slot: '20', seed: 'small' }).edition }])
    expect((await core.mirror.sync(opts)).done).toBe(true)
    // 今日の残りを少なくしておく（束1つ分ほど）
    clock.now = nextUtcMidnight(clock.now) + 60_000
    core.store.takeRows(core.store.rowsLeft() - 2_000)
    let days = 0
    let first = true
    for (let i = 0; i < 40; i++) {
      const before = core.store.rowsUsed()
      const step = await core.mirror.rebuildStep(opts)
      expect(core.store.rowsUsed()).toBeLessThanOrEqual(DAILY_ROW_BUDGET)
      if (step.done) break
      // 作業の字数で区切った（同じ日に続ける）
      if (!step.outOfRows) continue
      // 予算に入らずに戻したページの行は数えない（その日に当てた束の分だけ増える）
      if (first) {
        expect(core.store.rowsUsed() - before).toBeLessThanOrEqual(2_000)
        // 残りの少ない日も、入る分の束（ここでは1つ）は当てて進める
        expect(core.store.termCount(true)).toBe(200)
      }
      first = false
      // 途中も今の表で引ける
      expect(core.dictionary.idsOfForm(packs[5].entries[0].term)).toEqual([packs[5].entries[0].termId])
      days += 1
      expect(days).toBeLessThan(5)
      clock.now = nextUtcMidnight(clock.now) + 60_000
    }
    expect(core.dictionary.rebuilding()).toBe(false)
    expect(core.store.termCount()).toBe(31 * 200)
    expect(core.dictionary.idsOfForm(packs[0].entries[0].term)).toEqual([])
  }, 60_000)
})
