// 上限（設計の 1.6・1.9・1.11）: DO の SQLite の1日の行の予算（40,000。UTC の日）と、3年分の作り物の辞書の作り直しが1日の予算の中で
// 進み（日をまたいで続け）、その途中も今の表で引けること。書き込みの表と json の上限（作るだけ・表ごとの上限・id の形）・
// 100件ずつの組・答えの長さ（10万字・1回 12,000字）
import { describe, expect, it } from 'vitest'
import { termIdOf } from '../../../src/domain/ids'
import { RECORD_LIMITS } from '../../../src/domain/limits'
import { dictionaryOf, liveTerms } from '../../../src/domain/terms'
import type { TermEntry } from '../../../src/domain/types'
import { makeFakeEdition } from '../../../src/test/fixtures/fakeEditions'
import { TOOL_HANDLERS, type ToolHandler } from '../../src/vault/core'
import { Dictionary } from '../../src/vault/dictionary'
import { DAILY_ROW_BUDGET, MirrorStore, nextUtcMidnight } from '../../src/vault/store'
import { capText, DEFAULT_ITEM_BUDGET, ok, RESULT_LIMIT } from '../../src/vault/tools/common'
import { EncodeError, groups, prepareWrite, WRITABLE_TABLES } from '../../src/vault/writer'
import { FakeFirebase } from '../support/fakeFirebase'
import { drainAlarms, makeCore, OWNER, pairedCore } from '../support/harness'
import { nodeSql } from '../support/nodeSql'

const DAY = 24 * 3_600_000

describe('1日の行の予算（DO の SQLite）', () => {
  it('40,000 行まで数え、超える書き込みは断る。UTC の 0時に戻る。数は meta に書き戻す（作り直した DO も同じ数から）', () => {
    const clock = { now: Date.UTC(2026, 10, 19, 3, 0, 0) }
    const sql = nodeSql()
    const store = new MirrorStore(sql, () => clock.now)
    expect(DAILY_ROW_BUDGET).toBe(40_000)
    expect(store.takeRows(39_990)).toBe(true)
    expect(store.takeRows(11)).toBe(false)
    expect(store.takeRows(10)).toBe(true)
    expect(store.rowsLeft()).toBe(0)
    store.flushRows()
    const again = new MirrorStore(sql, () => clock.now)
    expect(again.rowsUsed()).toBe(40_000)
    clock.now = nextUtcMidnight(clock.now)
    expect(again.rowsLeft()).toBe(40_000)
    expect(nextUtcMidnight(Date.UTC(2026, 10, 19, 23, 59))).toBe(Date.UTC(2026, 10, 20))
  })
})

/** 3年分の作り物の辞書の束（1日2版・1版に新しい語 8・説明を新しくした語 1。中身は作り物の文字だけ） */
function threeYears(): { name: string; entries: TermEntry[] }[] {
  const packs: { name: string; entries: TermEntry[] }[] = []
  const revs = new Map<string, number>()
  let n = 0
  const start = Date.UTC(2023, 10, 20)
  for (let day = 0; day < 365 * 3; day++) {
    const date = new Date(start + day * DAY).toISOString().slice(0, 10)
    for (const slot of ['12', '20']) {
      const entries: TermEntry[] = []
      for (let i = 0; i < 8; i++) {
        const key = `作り物の語${(n++).toString(36)}`
        revs.set(key, 1)
        entries.push({
          termId: termIdOf(key),
          key,
          term: key,
          aliases: [`${key}の別名`],
          explanation: `作り物の説明 ${key}`,
          asOf: date.slice(0, 7),
          rev: 1,
        })
      }
      // 前に出た語の説明を新しくする
      const old = `作り物の語${Math.floor((n * 7919) % Math.max(1, n - 8)).toString(36)}`
      const rev = (revs.get(old) ?? 1) + 1
      revs.set(old, rev)
      entries.push({
        termId: termIdOf(old),
        key: old,
        term: old,
        aliases: [`${old}の別名`],
        explanation: `作り物の説明 ${old} 第${rev}版`,
        asOf: date.slice(0, 7),
        rev,
      })
      packs.push({ name: `termPacks:${date}-${slot}-${n.toString(36).padStart(8, '0')}`, entries })
    }
  }
  return packs
}

describe('3年分の作り物の辞書の作り直し', () => {
  it('作り直しは1日の予算の中で進み（日をまたいで続け）、その途中も今の表で引ける。終わると全部の束を重ねた今の形', () => {
    const packs = threeYears()
    expect(packs.length).toBe(365 * 3 * 2)
    const clock = { now: Date.UTC(2026, 10, 19, 3, 0, 0) }
    const store = new MirrorStore(nodeSql(), () => clock.now)
    const dict = new Dictionary(store)
    // 今の表（写しの取り込みで作った物。予算を見ずに当てる）
    for (let i = 0; i < packs.length; i += 100)
      dict.apply(
        packs.slice(i, i + 100).flatMap((p) => p.entries),
        false,
      )
    const probe = packs[10].entries[0]
    expect(dict.idsOfForm(probe.term)).toEqual([probe.termId])
    // 次の日（UTC）から作り直す
    clock.now = nextUtcMidnight(clock.now) + 60_000
    dict.startRebuild(clock.now)
    let i = 0
    let days = 0
    while (i < packs.length) {
      const page = packs.slice(i, i + 20)
      if (dict.rebuildApply(page, page[page.length - 1].name)) {
        i += page.length
        continue
      }
      // 予算を使い切った: その日の行は予算の中。途中も今の表で引ける
      expect(store.rowsUsed()).toBeLessThanOrEqual(DAILY_ROW_BUDGET)
      expect(dict.rebuilding()).toBe(true)
      expect(dict.idsOfForm(probe.term)).toEqual([probe.termId])
      expect(dict.get(probe.termId)).not.toBeNull()
      days += 1
      expect(days).toBeLessThan(5)
      clock.now = nextUtcMidnight(clock.now) + 60_000
    }
    expect(days).toBeGreaterThanOrEqual(1)
    expect(store.rowsUsed()).toBeLessThanOrEqual(DAILY_ROW_BUDGET)
    dict.finishRebuild()
    const want = liveTerms(dictionaryOf(packs))
    expect(store.termCount()).toBe(want.length)
    const got = new Map(store.allTerms().map((e) => [e.termId, e.rev]))
    for (const e of want) expect(got.get(e.termId), e.key).toBe(e.rev)
  }, 120_000)
})

describe('書き込み（作るだけ）', () => {
  it('書ける表はコネクタの5つだけ（知ってる・既読は書かない）。表ごとの json の上限と id の形を守る', async () => {
    expect([...WRITABLE_TABLES].sort()).toEqual(['editionFails', 'editions', 'corrections', 'termPacks', 'topics'].sort())
    const { core } = makeCore(new FakeFirebase())
    const e = makeFakeEdition({ date: '2026-11-19', slot: '12', seed: 'w' })
    const p = prepareWrite(core.fs, OWNER, { table: 'editions', record: e.edition })
    expect(p.write.currentDocument).toEqual({ exists: false })
    expect(p.write.updateTransforms).toEqual([{ fieldPath: 'updated', setToServerValue: 'REQUEST_TIME' }])
    expect(p.write.update!.name).toContain(`/users/${OWNER}/records/editions:${e.edition.id}`)
    expect(Object.keys(p.write.update!.fields).sort()).toEqual(['chunks', 'deleted', 'device', 'hash', 'id', 'json', 'table'])
    expect(() => prepareWrite(core.fs, OWNER, { table: 'knownTerms', record: { id: 't000000000000' } } as never)).toThrow(
      EncodeError,
    )
    expect(() => prepareWrite(core.fs, OWNER, { table: 'reads', record: { id: '2026-11-19-12' } } as never)).toThrow(EncodeError)
    expect(() => prepareWrite(core.fs, OWNER, { table: 'editions', record: { ...e.edition, id: 'not-an-id' } })).toThrow(
      'id が不正',
    )
    const big = {
      ...e.edition,
      notChosen: Array.from({ length: 200 }, () => ({ headline: 'あ'.repeat(120), whyNot: 'い'.repeat(150) })),
    }
    expect(() => prepareWrite(core.fs, OWNER, { table: 'editions', record: big })).toThrow(
      `上限は ${RECORD_LIMITS.json.editions.toLocaleString('ja-JP')}字`,
    )
  })

  it('100件ずつの組（最後の組が小さくならない）', () => {
    expect(groups(Array.from({ length: 101 })).map((g) => g.length)).toEqual([51, 50])
    expect(groups(Array.from({ length: 5 })).map((g) => g.length)).toEqual([5])
    expect(groups([])).toEqual([])
  })
})

describe('答えの長さ', () => {
  it('答えは10万字で行の切れ目で切る。1回に返す字数の既定は 12,000字', () => {
    expect(RESULT_LIMIT).toBe(100_000)
    expect(DEFAULT_ITEM_BUDGET).toBe(12_000)
    const long = Array.from({ length: 5_000 }, (_, i) => `行${i} ${'あ'.repeat(30)}`).join('\n')
    const cut = capText(long)
    expect(cut.length).toBeLessThanOrEqual(RESULT_LIMIT)
    expect(cut).toContain('cursor で続きを読んでください')
  })
})

/** 足す道具の中身を、テストの間だけ替える（B5 の中身の代わり。ctx.add の決まりを確かめる） */
async function withHandler<T>(name: string, h: ToolHandler, fn: () => Promise<T>): Promise<T> {
  const handlers = TOOL_HANDLERS as Record<string, ToolHandler>
  const keep = handlers[name]
  handlers[name] = h
  try {
    return await fn()
  } finally {
    handlers[name] = keep
  }
}

describe('足す（ctx.add。NS の #write・#commitPrepared の形）', () => {
  const NOW = Date.UTC(2026, 10, 19, 3, 0, 0)

  async function edition(over: Parameters<typeof pairedCore>[1] = {}) {
    const fake = new FakeFirebase()
    // 写しの位置ができるように、記録を1つ置いておく
    fake.putRecord(OWNER, 'editions', makeFakeEdition({ date: '2026-11-16', slot: '12', seed: 'seen' }).edition as never, {
      device: 'claude-connector',
    })
    const made = await pairedCore(fake, { clock: { now: NOW }, ...over })
    await drainAlarms(made.core, made.clock)
    const begun = await made.core.callTool(
      'topic_begin_run',
      { kind: 'edition', model: 'fake-writer-model' },
      { grant: made.grant },
    )
    const runId = /runId: (\S+)/.exec(begun.text)![1]
    return { fake, ...made, runId }
  }

  it('書いた記録は写しに入り、書き込みの日枠を数える。残しの分（reserve）に入らなければ、数を出さずに何も書かない', async () => {
    const { fake, core, grant, runId } = await edition({ config: { dailyWriteBudget: 31 } })
    const a = makeFakeEdition({ date: '2026-11-18', slot: '20', seed: 'add-a' })
    const add =
      (records: { table: 'editions'; record: typeof a.edition }[], reserve: number): ToolHandler =>
      async (_core, _args, ctx) => {
        const out = await ctx.add(() => ({ ok: true, records }), { reserve })
        return out.ok ? ok(`書きました ${[...out.created].join(',')}`) : out.result
      }
    const first = await withHandler('topic_add_edition', add([{ table: 'editions', record: a.edition }], 30), () =>
      core.callTool('topic_add_edition', { runId }, { grant }),
    )
    expect(first.text).toContain(`書きました editions:${a.edition.id}`)
    expect(core.mirror.has('editions', a.edition.id)).toBe(true)
    expect(fake.docs.has(fake.name(`users/${OWNER}/records/editions:${a.edition.id}`))).toBe(true)
    expect(core.quota().writes).toBe(1)
    // 残しの30を割る書き込み（話題・版・束）は断る。作れなかった印・訂正（reserve 0）は書ける
    const b = makeFakeEdition({ date: '2026-11-17', slot: '20', seed: 'add-b' })
    const refused = await withHandler('topic_add_edition', add([{ table: 'editions', record: b.edition }], 30), () =>
      core.callTool('topic_add_edition', { runId }, { grant }),
    )
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('書き込み枠が足りません')
    expect(refused.text).toContain('何も書いていません')
    expect(refused.text.replace(/日本時間\d+時(\d+分)?/g, '').replace(/^いま \d+:\d+（日本時間）.*\n/, '')).not.toMatch(/\d/)
    expect(core.mirror.has('editions', b.edition.id)).toBe(false)
    expect(core.quota().writes).toBe(1)
    const reserved = await withHandler('topic_add_edition', add([{ table: 'editions', record: b.edition }], 0), () =>
      core.callTool('topic_add_edition', { runId }, { grant }),
    )
    expect(reserved.text).toContain(`書きました editions:${b.edition.id}`)
  })

  it('「もうある」: 差分の読み取りで見えない文書も名前で確かめて写しに入れ、組み立て直す（build がもう一度呼ばれる）', async () => {
    const { fake, core, grant, runId } = await edition()
    const e = makeFakeEdition({ date: '2026-11-18', slot: '20', seed: 'exists' })
    // ほかの接続が先に書いた記録（updated が写しの位置より前なので、差分の読み取りには出てこない）
    fake.putRecord(OWNER, 'editions', e.edition as never, { device: 'claude-connector' })
    const doc = fake.docs.get(fake.name(`users/${OWNER}/records/editions:${e.edition.id}`))!
    doc.fields.updated = { timestampValue: '2026-01-01T00:00:00.000000Z' }
    const attempts: number[] = []
    const h: ToolHandler = async (c, _args, ctx) => {
      const out = await ctx.add((attempt) => {
        attempts.push(attempt)
        if (c.mirror.has('editions', e.edition.id)) return { ok: false, result: ok('もうあります') }
        return { ok: true, records: [{ table: 'editions', record: e.edition }] }
      })
      return out.ok ? ok(`書きました ${[...out.created].join(',')}`) : out.result
    }
    const r = await withHandler('topic_add_edition', h, () => core.callTool('topic_add_edition', { runId }, { grant }))
    expect(r.text).toContain('もうあります')
    expect(attempts).toEqual([0, 1])
    // 断られた分の書き込みは数えない
    expect(core.quota().writes).toBe(0)
  })
})
