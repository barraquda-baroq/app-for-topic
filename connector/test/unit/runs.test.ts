// 回（vault/runs.ts・設計の 1.3）: 回の id・枠・窓・締め切り・期限、種類ごとにできる事の表、始める時に断る物（書き込みの許可・
// データの形の版・その枠の版がもうある・同じ枠の回が動いている・1日の数）、回の物を消す時（版か作れなかった印の後・期限・訂正だけの回の
// 控えの1時間）、alarm のやる事の表（候補集めの続き・毎日の決まりの読み・気象庁の見張り（data が 'ok' の時だけ）・回の期限・写しの続き）、
// topic_status(runId) の待ち、ホストごとの次に取ってよい時刻の予約
import { describe, expect, it } from 'vitest'
import { RUN_ID_RE } from '../../../src/domain/ids'
import { fakeRecordsOf, makeFakeEdition } from '../../../src/test/fixtures/fakeEditions'
import type { ToolCallContext, VaultCore } from '../../src/vault/core'
import {
  COLLECT_DAILY_LIMIT,
  finishRun,
  markMaterialRead,
  RUN_DAILY_LIMIT,
  RUN_KINDS,
  TOOL_RUN_KINDS,
  useRun,
  type FetchWork,
} from '../../src/vault/runs'
import { TOOL_DEFS } from '../../src/mcp/tools'
import { FakeFirebase } from '../support/fakeFirebase'
import { drainAlarms, pairedCore, seedRecords, type Clock } from '../support/harness'

/** 日本時間の時刻（2026-11-19） */
const jst = (h: number, m = 0, day = 19) => Date.UTC(2026, 10, day, h - 9, m, 0)
const MODEL = 'fake-writer-model'

async function setup(now: number, opts: Parameters<typeof pairedCore>[1] = {}) {
  const fake = new FakeFirebase()
  const made = await pairedCore(fake, { clock: { now }, ...opts })
  await drainAlarms(made.core, made.clock)
  made.clock.now = now
  return { fake, ...made }
}

async function begin(core: VaultCore, grant: unknown, args: Record<string, unknown>) {
  return core.callTool('topic_begin_run', { model: MODEL, ...args }, { grant: grant as never })
}

const runIdOf = (text: string) => /runId: (r\d{12}-[0-9a-z]{4})/.exec(text)![1]

describe('回を始める（topic_begin_run）', () => {
  it('版の回: runId・期限・枠・窓・締め切りを返し、答えの頭に締め切りまでの分。structuredContent に runId', async () => {
    const { core, grant } = await setup(jst(10, 16))
    const r = await begin(core, grant, { kind: 'edition' })
    expect(r.isError).toBeUndefined()
    const runId = runIdOf(r.text)
    expect(runId).toMatch(RUN_ID_RE)
    expect(runId).toBe('r202611191016-t000')
    expect(r.text).toMatch(/^いま 10:16（日本時間）・書く係の締め切りまで 90分・照合の打ち切りまで 150分\n/)
    expect(r.text).toContain('回の期限: 11/19 22:16')
    expect(r.text).toContain('枠: 11/19 12:00版（e:2026-11-19-12）')
    // 窓: 前の版が無いので前の枠の境（前の日の 18:00）から
    expect(r.text).toContain('候補を集める窓: 11/18 18:00 より後〜11/19 10:16')
    // 締め切り: 版の時刻の15分前（11:45）と始めて90分（11:46）の遅い方。照合は 12:45 と 12:46 の遅い方
    expect(r.text).toContain('書く係の締め切り: 11:46・照合の打ち切り: 12:46')
    expect(r.text).toContain('版の回は定期実行の依頼だけで使います')
    expect(r.structured).toEqual({ created: [{ id: runId, label: '版の回' }], skipped: [] })
    const run = core.store.getRun(runId)!
    expect(run).toMatchObject({ kind: 'edition', editionId: '2026-11-19-12', model: MODEL, done: false })
    expect(run.expires - run.started).toBe(12 * 3_600_000)
  })

  it('枠の境: 18:16 は その日の 20、9:59 は前の日の 20。昼過ぎのやり直しは始めてからの締め切り', async () => {
    const a = await setup(jst(18, 16))
    expect((await begin(a.core, a.grant, { kind: 'edition' })).text).toContain('枠: 11/19 20:00版')
    const b = await setup(jst(9, 59))
    expect((await begin(b.core, b.grant, { kind: 'edition' })).text).toContain('枠: 11/18 20:00版')
    const c = await setup(jst(14, 0))
    const r = await begin(c.core, c.grant, { kind: 'edition' })
    expect(r.text).toContain('枠: 11/19 12:00版')
    expect(r.text).toContain('書く係の締め切り: 15:30・照合の打ち切り: 16:30')
  })

  it('窓の始まりは、36時間より新しい直前の版の window.until（無ければ前の枠の境）', async () => {
    const fake = new FakeFirebase()
    const prev = makeFakeEdition({ date: '2026-11-18', slot: '20', seed: 'w' })
    const until = '2026-11-18T18:16:00+09:00'
    seedRecords(
      fake,
      fakeRecordsOf({ ...prev, edition: { ...prev.edition, window: { since: '2026-11-18T10:16:00+09:00', until } } }),
    )
    const { core, grant, clock } = await pairedCore(fake, { clock: { now: jst(10, 16) } })
    await drainAlarms(core, clock)
    clock.now = jst(10, 16)
    const r = await begin(core, grant, { kind: 'edition' })
    expect(r.text).toContain('候補を集める窓: 11/18 18:16 より後〜11/19 10:16')
    const run = core.store.getRun(runIdOf(r.text))!
    expect(run.sinceMs).toBe(Date.parse(until))
  })

  it('試しの回は始めて90分・150分。訂正だけの回は枠も締め切りも窓も持たず、候補を集めない', async () => {
    const { core, grant } = await setup(jst(14, 0))
    const t = await begin(core, grant, { kind: 'trial', probe: 'sources' })
    expect(t.text).toContain('書く係の締め切り: 15:30・照合の打ち切り: 16:30')
    expect(t.text).toContain('クラウドに何も書きません')
    expect(core.store.getRun(runIdOf(t.text))).toMatchObject({ probe: 'sources', collect: { state: 'collecting' } })
    const c = await begin(core, grant, { kind: 'correction' })
    expect(c.text).not.toContain('枠:')
    expect(c.text).not.toContain('締め切り')
    expect(c.text.split('\n')[0]).toBe('いま 14:00（日本時間）')
    const run = core.store.getRun(runIdOf(c.text))!
    expect(run).toMatchObject({ editionId: null, writerMs: null, checkerMs: null, sinceMs: null, collect: { state: 'none' } })
    expect(core.store.task(`collect:${run.runId}`)).toBeNull()
  })

  it('probe・skip は試しの回だけ。種類の値が違えば MCP の層の前でも断る', async () => {
    const { core, grant } = await setup(jst(14, 0))
    expect((await begin(core, grant, { kind: 'edition', probe: 'sources' })).text).toContain('試しの回（kind: trial）だけ')
    expect((await begin(core, grant, { kind: 'other' })).isError).toBe(true)
    expect((await begin(core, grant, { kind: 'trial', model: '' })).isError).toBe(true)
  })

  it('版の回・訂正だけの回は、書き込みの許可がオフ・データの形の版が違うと断る（試しの回は始められる）', async () => {
    const off = await setup(jst(10, 16), { writes: false })
    expect((await begin(off.core, off.grant, { kind: 'edition' })).text).toContain('書き込みは停止中です')
    expect((await begin(off.core, off.grant, { kind: 'correction' })).text).toContain('書き込みは停止中です')
    expect((await begin(off.core, off.grant, { kind: 'trial' })).isError).toBeUndefined()
    const old = await setup(jst(10, 16), { model: 1 })
    expect((await begin(old.core, old.grant, { kind: 'edition' })).text).toContain('アプリの版が古いまま')
  })

  it('その枠の版がもうあれば断る。同じ枠の版の回が10分以内に動いていれば断り、10分たてば始められる', async () => {
    const fake = new FakeFirebase()
    const e = makeFakeEdition({ date: '2026-11-19', slot: '12', seed: 'taken' })
    seedRecords(fake, fakeRecordsOf(e))
    const taken = await pairedCore(fake, { clock: { now: jst(10, 16) } })
    await drainAlarms(taken.core, taken.clock)
    taken.clock.now = jst(10, 16)
    const r = await begin(taken.core, taken.grant, { kind: 'edition' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('この枠の版はもうあります（e:2026-11-19-12')
    // 試しの回は始められる
    expect((await begin(taken.core, taken.grant, { kind: 'trial' })).isError).toBeUndefined()

    const { core, grant, clock } = await setup(jst(10, 16))
    const first = runIdOf((await begin(core, grant, { kind: 'edition' })).text)
    clock.now += 4 * 60_000
    await core.callTool('topic_list_drafts', { runId: first }, { grant })
    clock.now += 9 * 60_000
    const busy = await begin(core, grant, { kind: 'edition' })
    expect(busy.text).toContain('同じ枠の回が動いています（最後の呼び出しは 9分前）')
    clock.now += 60_000
    expect((await begin(core, grant, { kind: 'edition' })).isError).toBeUndefined()
  })

  it('1日の回の数は種類を分けない合計で30、候補を集める回は8。断る答えに種類ごとの数を出さない', async () => {
    const { core, grant, clock } = await setup(jst(10, 0))
    for (let i = 0; i < COLLECT_DAILY_LIMIT; i++) {
      clock.now += 60_000
      expect((await begin(core, grant, { kind: 'trial' })).isError).toBeUndefined()
    }
    const collect = await begin(core, grant, { kind: 'trial' })
    expect(collect.text).toContain(`候補を集める回をこれ以上始められません（1日${COLLECT_DAILY_LIMIT}回まで）`)
    for (let i = COLLECT_DAILY_LIMIT; i < RUN_DAILY_LIMIT; i++)
      expect((await begin(core, grant, { kind: 'correction' })).isError).toBeUndefined()
    const all = await begin(core, grant, { kind: 'correction' })
    expect(all.text).toContain(`これ以上回を始められません（1日${RUN_DAILY_LIMIT}回まで）`)
    for (const t of [collect.text, all.text]) {
      expect(t).not.toMatch(/訂正だけの回|試しの回|版の回/)
      expect(t).not.toMatch(/\d+回(を|始め)/)
    }
    // 日本時間の次の日は始められる
    clock.now = jst(10, 0, 20)
    expect((await begin(core, grant, { kind: 'correction' })).isError).toBeUndefined()
  })
})

describe('回を使う（種類・期限・終わった回）', () => {
  it('道具ごとの種類の表: 訂正だけの回で候補・下書き・話題・版・作れなかった印は使えない。試しの回で作れなかった印は使えない', async () => {
    const { core, grant } = await setup(jst(10, 16))
    const corr = runIdOf((await begin(core, grant, { kind: 'correction' })).text)
    const trial = runIdOf((await begin(core, grant, { kind: 'trial' })).text)
    for (const tool of [
      'topic_list_candidates',
      'topic_list_drafts',
      'topic_add_topics',
      'topic_add_edition',
      'topic_add_edition_fail',
    ]) {
      const r = await core.callTool(tool, { runId: corr }, { grant })
      expect(r.text, tool).toContain('この回（訂正だけの回）では使えません')
    }
    expect((await core.callTool('topic_add_edition_fail', { runId: trial }, { grant })).text).toContain(
      'この回（試しの回）では使えません',
    )
    // 種類が合えば中身へ（中身はまだ無い道具でも、種類は先に確かめる）
    expect((await core.callTool('topic_read_article', { runId: corr }, { grant })).text).not.toContain('では使えません')
    expect((await core.callTool('topic_add_correction', { runId: corr }, { grant })).text).not.toContain('では使えません')
  })

  it('種類の表はどの道具にもあり、runId を必ず受ける道具は入力の形でも runId が要る', () => {
    for (const d of TOOL_DEFS) expect(Object.hasOwn(TOOL_RUN_KINDS, d.name), d.name).toBe(true)
    for (const kinds of Object.values(TOOL_RUN_KINDS)) for (const k of kinds ?? []) expect(RUN_KINDS).toContain(k)
  })

  it('知らない回・期限を過ぎた回・終わった回は断る（回を始め直す）', async () => {
    const { core, grant, clock } = await setup(jst(10, 16))
    expect((await core.callTool('topic_list_drafts', { runId: 'r202611190000-zzzz' }, { grant })).text).toContain(
      'この回は見つかりません',
    )
    const runId = runIdOf((await begin(core, grant, { kind: 'edition' })).text)
    finishRun(core.store, runId)
    expect((await core.callTool('topic_list_drafts', { runId }, { grant })).text).toContain('この回は終わりました')
    const other = runIdOf((await begin(core, grant, { kind: 'trial' })).text)
    clock.now += 12 * 3_600_000
    expect((await core.callTool('topic_list_drafts', { runId: other }, { grant })).text).toContain('古い回です')
    // 期限の片付けで覚え書きごと消える（D21: どの回が訂正だけの回だったかを残さない）
    await drainAlarms(core, clock)
    expect(core.store.getRun(other)).toBeNull()
    expect(core.store.getRun(runId)).toBeNull()
    expect((await core.callTool('topic_list_drafts', { runId: other }, { grant })).text).toContain('この回は見つかりません')
  })

  it('回の道具の呼び出しを数える（回を始めた呼び出しも1回。1つの呼び出しで回を何度読んでも1回。runId を渡さない呼び出し・断った呼び出しは数えない）', async () => {
    const { core, grant } = await setup(jst(10, 16))
    const runId = runIdOf((await begin(core, grant, { kind: 'correction' })).text)
    expect(core.store.runCount(runId, 'calls')).toBe(1)
    // topic_status(runId)・topic_lookup_terms(runId) は回を読む
    await core.callTool('topic_status', { runId }, { grant })
    await core.callTool('topic_lookup_terms', { runId, words: ['作り物の語'] }, { grant })
    expect(core.store.runCount(runId, 'calls')).toBe(3)
    // runId を取らない道具・種類で断った呼び出し（訂正だけの回の下書きの一覧）は数えない
    await core.callTool('topic_list_recent', {}, { grant })
    expect((await core.callTool('topic_list_drafts', { runId }, { grant })).isError).toBe(true)
    expect(core.store.runCount(runId, 'calls')).toBe(3)
    // 1つの呼び出し（同じ ctx）の中で回を何度読んでも1回
    const ctx = { tool: 'topic_read_article', now: jst(10, 20) } as unknown as ToolCallContext
    useRun(core.store, ctx, runId)
    useRun(core.store, ctx, runId)
    expect(core.store.runCount(runId, 'calls')).toBe(4)
  })

  it('版か作れなかった印の後（finishRun）は、候補・控え・下書き・数え・新しい語・probe を消し、覚え書きだけ残す', async () => {
    const { core, grant } = await setup(jst(10, 16))
    const runId = runIdOf((await begin(core, grant, { kind: 'trial', probe: 'sources' })).text)
    const s = core.store
    s.putCandidates([
      {
        runId,
        cid: 'c0001',
        source: 'fake',
        url: 'https://example.com/a',
        title: '題',
        published: null,
        atMs: null,
        tags: [],
        readable: true,
      },
    ])
    s.putMaterial({
      runId,
      url: 'https://example.com/a',
      source: 'fake',
      title: '題',
      published: null,
      publishedNote: null,
      author: null,
      via: null,
      body: 'あ'.repeat(300),
      bodyChars: 300,
      cut: false,
      fetched: 1,
      readAt: 2,
    })
    s.putDraft({
      runId,
      draftId: 'd:01',
      seq: 1,
      rank: 1,
      model: MODEL,
      input: '{}',
      status: 'pending',
      rejectReason: null,
      created: 1,
      updated: 1,
      readAt: null,
      verifiedAt: null,
      checks: 0,
      claims: null,
      fixed: null,
      checkModel: null,
      topicId: null,
    })
    s.addRunCount(runId, 'why:number', 2)
    s.putRunTerm(
      runId,
      { termId: 't000000000000', key: '〇〇法', term: '〇〇法', aliases: [], explanation: '作り物の説明', asOf: null, rev: 1 },
      'd:01',
    )
    s.putProbe({ runId, source: 'fake', data: { items: 3 }, text: null })
    // 候補集めの様子に置いた取る物の URL（collector.ts の jobs の形の作り物）も、状態だけを残して消す
    s.setRunCollect(runId, {
      state: 'collecting',
      progress: { done: 1, total: 2 },
      jobs: [{ url: 'https://example.com/a' }],
    } as never)
    finishRun(s, runId)
    expect(s.getRun(runId)!.collect).toEqual({ state: 'done' })
    expect(JSON.stringify(s.getRun(runId))).not.toContain('example.com')
    expect(s.candidates(runId)).toEqual([])
    expect(s.materials(runId)).toEqual([])
    expect(s.drafts(runId)).toEqual([])
    expect(s.runCounts(runId)).toEqual({})
    expect(s.runTerms(runId)).toEqual([])
    expect(s.probes(runId)).toEqual([])
    expect(s.getRun(runId)!.done).toBe(true)
    expect(s.task(`collect:${runId}`)).toBeNull()
  })

  it('訂正だけの回の資料の控えは、最後に読んでから1時間で消す', async () => {
    const { core, grant, clock } = await setup(jst(10, 16))
    const runId = runIdOf((await begin(core, grant, { kind: 'correction' })).text)
    const mat = {
      runId,
      url: 'https://example.com/b',
      source: 'fake',
      title: '題',
      published: null,
      publishedNote: null,
      author: null,
      via: null,
      body: 'い'.repeat(300),
      bodyChars: 300,
      cut: false,
      fetched: clock.now,
      readAt: null,
    }
    core.store.putMaterial(mat)
    // 読んだ（B4 の topic_read_article が markMaterialRead を呼ぶ）: 最後に読んでから1時間で消すやる事が置かれる
    markMaterialRead(core.store, core.store.getRun(runId)!, mat.url, clock.now)
    expect(core.store.task('expire')!.at).toBe(clock.now + 3_600_000)
    clock.now += 30 * 60_000
    markMaterialRead(core.store, core.store.getRun(runId)!, mat.url, clock.now)
    clock.now += 31 * 60_000
    await core.alarm()
    expect(core.store.material(runId, mat.url)).not.toBeNull()
    clock.now += 30 * 60_000
    await core.alarm()
    expect(core.store.material(runId, mat.url)).toBeNull()
    expect(core.store.getRun(runId)).not.toBeNull()
  })
})

/** 作り物の取りに行く中身（2歩で候補集めが終わる・決まりの読み・気象庁の見張り） */
function fakeWork(opts: { jma?: boolean; steps?: number } = {}) {
  const calls: string[] = []
  let left = opts.steps ?? 2
  const work: FetchWork = {
    sources: [],
    async collectStep(core, runId, now) {
      calls.push(`collect:${runId}`)
      left -= 1
      if (left > 0) {
        core.store.setRunCollect(runId, { state: 'collecting', progress: { done: 1, total: 2 } })
        return { done: false, next: now + 5_000 }
      }
      core.store.putCandidates([
        {
          runId,
          cid: 'c0001',
          source: 'fake',
          url: 'https://example.com/1',
          title: '題1',
          published: null,
          atMs: now,
          tags: [],
          readable: true,
        },
        {
          runId,
          cid: 'c0002',
          source: 'fake',
          url: 'https://example.com/2',
          title: '題2',
          published: null,
          atMs: now,
          tags: [],
          readable: false,
        },
      ])
      core.store.setRunCollect(runId, { state: 'done' })
      return { done: true }
    },
    async rulesStep() {
      calls.push('rules')
      return { done: true }
    },
    jmaWatchEnabled: () => opts.jma === true,
    async jmaWatchStep() {
      calls.push('jma')
      return { done: true }
    },
  }
  return { work, calls }
}

describe('alarm のやる事の表', () => {
  it('候補集めの続きは、回を始めた時に置き、終わるまで続ける。topic_status(runId) は集め終わるまで待ち、読める候補の数だけを返す', async () => {
    const { work, calls } = fakeWork()
    const { core, grant, clock } = await setup(jst(10, 16), { fetchWork: work })
    const runId = runIdOf((await begin(core, grant, { kind: 'edition' })).text)
    expect(core.store.task(`collect:${runId}`)).not.toBeNull()
    // 時計を進める待ち（20秒まで）。待つ間に候補集めのやる事が来れば、ここで1歩進める
    const sleeping = { clock }
    const status = await core.callTool('topic_status', { runId }, { grant })
    void sleeping
    expect(status.text).toContain(`回: ${runId}`)
    expect(status.text).toMatch(/候補集め: (集めています|終わりました)/)
    await drainAlarms(core, clock)
    const done = await core.callTool('topic_status', { runId }, { grant })
    expect(done.text).toContain('候補集め: 終わりました（読める候補 1件）')
    expect(done.text).not.toContain('題1')
    expect(calls.filter((c) => c.startsWith('collect:'))).toHaveLength(2)
    expect(core.store.task(`collect:${runId}`)).toBeNull()
  })

  it('topic_status(runId) の待ちの間に、時刻の来た候補集めを進める（alarm が遅れても）', async () => {
    const { work } = fakeWork({ steps: 1 })
    const clock: Clock = { now: jst(10, 16) }
    const { core, grant } = await setup(jst(10, 16), { fetchWork: work, clock })
    const runId = runIdOf((await begin(core, grant, { kind: 'trial' })).text)
    const r = await core.callTool('topic_status', { runId }, { grant })
    expect(r.text).toContain('候補集め: 終わりました（読める候補 1件）')
  })

  it('毎日の決まりの読み: 夜の仕事が置き、済むと今日の印。cron が動かなかった日は、その日の最初の回が置く', async () => {
    const { work, calls } = fakeWork()
    const { core, grant, clock } = await setup(jst(10, 16), { fetchWork: work })
    calls.length = 0
    await begin(core, grant, { kind: 'correction' })
    expect(core.store.task('rules')).not.toBeNull()
    await drainAlarms(core, clock)
    expect(calls).toContain('rules')
    expect(core.store.getMeta('rulesDay')).toBe('2026-11-19')
    calls.length = 0
    await begin(core, grant, { kind: 'correction' })
    expect(core.store.task('rules')).toBeNull()
    clock.now = jst(4, 23, 20)
    expect(await core.nightly()).toBe('ok')
    await drainAlarms(core, clock, { n: 5 })
    expect(calls).toContain('rules')
  })

  it('気象庁の見張りは data が ok の時だけ置き（3時間ごと）、ok でなければ置かない・外す', async () => {
    const off = fakeWork({ jma: false })
    const a = await setup(jst(10, 16), { fetchWork: off.work })
    await a.core.nightly()
    expect(a.core.store.task('jma')).toBeNull()
    await drainAlarms(a.core, a.clock)
    expect(off.calls).not.toContain('jma')

    const on = fakeWork({ jma: true })
    const b = await setup(jst(10, 16), { fetchWork: on.work })
    const t = b.core.store.task('jma')
    expect(t).not.toBeNull()
    await b.core.alarm()
    expect(on.calls).toContain('jma')
    expect(b.core.store.task('jma')!.at).toBe(b.clock.now + 3 * 3_600_000)
  })

  it('出どころへ取りに行くやる事（候補集め・決まりの読み・気象庁の見張り）は、1回の alarm で1つだけ。残りはすぐ次の alarm で', async () => {
    const { work, calls } = fakeWork({ jma: true, steps: 1 })
    const { core, grant, clock } = await setup(jst(10, 16), { fetchWork: work })
    const runId = runIdOf((await begin(core, grant, { kind: 'edition' })).text)
    core.store.putTask('rules', clock.now)
    core.store.putTask('jma', clock.now)
    calls.length = 0
    // 1回目: 時刻の来た3つのうち1つだけ。次の alarm の時刻は今（すぐ）
    expect(await core.alarm()).toBeLessThanOrEqual(clock.now)
    expect(calls).toHaveLength(1)
    expect(await core.alarm()).toBeLessThanOrEqual(clock.now)
    expect(calls).toHaveLength(2)
    await core.alarm()
    expect([...calls].sort()).toEqual([`collect:${runId}`, 'jma', 'rules'].sort())
  })

  it('alarm は1つ: いちばん早いやる事の時刻に置き直す（連携の後は写しの取り込みを now+500 に）', async () => {
    const fake = new FakeFirebase()
    const { core, scheduled, clock } = await pairedCore(fake, { clock: { now: jst(10, 16) } })
    expect(core.store.task('mirror')!.at).toBe(clock.now + 500)
    expect(scheduled[scheduled.length - 1]).toBe(clock.now + 500)
    core.store.putTask('expire', clock.now + 10_000)
    expect(await core.alarm()).toBe(clock.now + 500)
  })
})

describe('ホストごとの次に取ってよい時刻（予約）', () => {
  it('同じホストへ同時に3つ: どの2つの間も間（gap）以上あく。別のホストは待たない', async () => {
    const { core } = await setup(jst(10, 16))
    const now = jst(10, 16)
    const waits = [0, 1, 2].map(() => core.store.reserveHost('www.example.com', now, 1_000))
    expect(waits).toEqual([0, 1_000, 2_000])
    expect(core.store.reserveHost('other.example.com', now, 10_000)).toBe(0)
    // 時刻が進めば、残りの分だけ待つ
    expect(core.store.reserveHost('www.example.com', now + 2_500, 1_000)).toBe(500)
  })
})
