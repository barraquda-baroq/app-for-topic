// D21（個人に合わせない・読み手の情報を出さない。設計の 1.10・1.3・1.6・7.）: コネクタは既読の置き場 private を作らず読まない・
// どの答えにも記録の作った時刻・回・モデルを出さない・枠は数で出さない・回の1日の上限は種類を分けない合計で、断る答えに種類ごとの数が
// 出ない・回の覚え書きは期限で消える・ログに回の種類・回の id・モデルが出ない（event の名前も種類で分けない）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeRecordsOf, FAKE_MODEL, makeFakeMonth } from '../../../src/test/fixtures/fakeEditions'
import { FakeFirebase } from '../support/fakeFirebase'
import { drainAlarms, OWNER, pairedCore, seedRecords } from '../support/harness'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(here, '../../src')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name)
    return d.isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : []
  })
}

/** 注釈を除いたコード（// の行末と /* … *\/。文字列の中の // は URL なので残す） */
const codeOf = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n')

const NOW = Date.UTC(2026, 10, 19, 3, 0, 0)

describe('既読の置き場', () => {
  it('コネクタのコードは private の置き場を作らない・読まない（placePath・/private/ を使わない）', () => {
    const files = sourceFiles(srcDir)
    expect(files.length).toBeGreaterThan(20)
    for (const f of files) {
      const code = codeOf(fs.readFileSync(f, 'utf8'))
      expect(code, f).not.toMatch(/placePath\(/)
      expect(code, f).not.toMatch(/\/private\//)
      expect(code, f).not.toMatch(/['"`]private['"`]/)
    }
  })

  it('写しの問い合わせは records だけを読む（作り物のクラウドに既読があっても届かない）', async () => {
    const fake = new FakeFirebase()
    fake.putRecord(
      OWNER,
      'reads',
      {
        id: '2026-11-19-12',
        v: 1,
        createdAt: 1,
        updatedAt: 1,
        by: 'user',
        ai: null,
        editionId: '2026-11-19-12',
        topicIds: [],
        seen: true,
      } as never,
      { place: 'private' },
    )
    const { core, clock } = await pairedCore(fake, { clock: { now: NOW } })
    await drainAlarms(core, clock)
    expect(core.mirror.warm().done).toBe(true)
    expect(core.mirror.counts().reads).toBeUndefined()
  })
})

describe('答えに出さない物', () => {
  it('前の版の話題・状態・用語の答えに、記録の作った時刻・回・モデルが出ない', async () => {
    const fake = new FakeFirebase()
    const m = makeFakeMonth({ until: '2026-11-19', days: 4, untilSlot: '12' })
    seedRecords(fake, fakeRecordsOf(m))
    const { core, grant, clock } = await pairedCore(fake, { clock: { now: NOW } })
    await drainAlarms(core, clock)
    clock.now = NOW
    const terms = m.editions[0].termPack.entries.slice(0, 5).map((e) => e.term)
    const texts = [
      (await core.callTool('topic_list_recent', {}, { grant })).text,
      (await core.callTool('topic_status', {}, { grant })).text,
      (await core.callTool('topic_lookup_terms', { words: terms }, { grant })).text,
    ]
    const records = [...m.editions.flatMap((e) => [e.edition, e.termPack, ...e.topics]), ...m.corrections, ...m.editionFails]
    for (const t of texts) {
      expect(t).not.toContain(FAKE_MODEL)
      expect(t).not.toContain('fake-checker-model')
      for (const r of records) {
        expect(t).not.toContain(r.runId)
        expect(t).not.toContain(String(r.createdAt))
      }
    }
  })
})

describe('回の種類を残さない・分けない', () => {
  let lines: string[] = []
  beforeEach(() => {
    lines = []
    vi.spyOn(console, 'log').mockImplementation((s: unknown) => {
      lines.push(String(s))
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('回を始める答え・ログ: ログに回の種類・回の id・モデルが出ず、event の名前は種類で分けない', async () => {
    const { core, grant, clock } = await pairedCore(new FakeFirebase(), { clock: { now: NOW } })
    await drainAlarms(core, clock)
    const byKind: Record<string, string[]> = {}
    for (const kind of ['edition', 'trial', 'correction']) {
      lines = []
      clock.now += 11 * 60_000
      const r = await core.callTool('topic_begin_run', { kind, model: FAKE_MODEL }, { grant })
      expect(r.isError, kind).toBeUndefined()
      const runId = /runId: (\S+)/.exec(r.text)![1]
      for (const l of lines) {
        expect(l).not.toContain(runId)
        expect(l).not.toContain(FAKE_MODEL)
        expect(l).not.toMatch(/"kind"|edition|trial|correction/)
      }
      byKind[kind] = lines.map((l) => (JSON.parse(l) as { event: string }).event).filter((e) => e.startsWith('run'))
    }
    expect(byKind.edition).toEqual(byKind.correction)
    expect(byKind.trial).toEqual(byKind.correction)
    expect(byKind.correction).toEqual(['run_started'])
  })

  it('回の覚え書きは期限（12時間）で全部消え、どの回が訂正だけの回だったかが残らない', async () => {
    const { core, grant, clock } = await pairedCore(new FakeFirebase(), { clock: { now: NOW } })
    await drainAlarms(core, clock)
    await core.callTool('topic_begin_run', { kind: 'correction', model: FAKE_MODEL }, { grant })
    expect(core.store.runs()).toHaveLength(1)
    // 1日の回の数は種類を分けない合計と候補を集める回の数だけ（種類ごとの数は持たない）
    expect(Object.keys(core.store.getMeta<Record<string, unknown>>('runDaily') ?? {}).sort()).toEqual(['collect', 'day', 'total'])
    clock.now += 12 * 3_600_000
    await drainAlarms(core, clock)
    expect(core.store.runs()).toEqual([])
    // 日が変わったら、前の日の回の数も残さない（合計と候補を集める回の数の差から、訂正だけの回の数が分かるため）
    expect(core.store.getMeta('runDaily')).toBeNull()
  })

  it('連携を外した後も、回の期限の片付けは続く（覚え書き・資料の控えを残さない。クラウド・出どころへは出ない）', async () => {
    const fake = new FakeFirebase()
    let calls = 0
    const counting = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      return fake.fetch(input as never, init)
    }) as typeof fetch
    const { core, grant, clock, scheduled } = await pairedCore(fake, { clock: { now: NOW }, fetch: counting })
    await drainAlarms(core, clock)
    const r = await core.callTool('topic_begin_run', { kind: 'correction', model: FAKE_MODEL }, { grant })
    const runId = /runId: (\S+)/.exec(r.text)![1]
    core.store.putMaterial({
      runId,
      url: 'https://example.com/fake',
      source: 'fake',
      title: '作り物の題',
      published: null,
      publishedNote: null,
      author: null,
      via: null,
      body: 'あ'.repeat(300),
      bodyChars: 300,
      cut: false,
      fetched: clock.now,
      readAt: null,
    })
    // ［連携をすべて解除］: 1分後に読み直すと連携を外す。alarm は回の期限の片付けの時刻に置き直す（取り消さない）
    fake.setConnector(null)
    clock.now += 61_000
    expect(await core.checkGrant(grant)).toBe(false)
    expect(core.pairingState()).toBe('unpaired')
    const expireAt = core.store.task('expire')!.at
    expect(scheduled[scheduled.length - 1]).toBe(expireAt)
    // 連携していない間の alarm: 時刻の来た片付けだけをする（ほかのやる事は動かさない）
    const before = calls
    core.store.putTask('mirror', clock.now)
    clock.now = expireAt
    expect(await core.alarm()).toBeNull()
    expect(core.store.runs()).toEqual([])
    expect(core.store.materials(runId)).toEqual([])
    expect(calls).toBe(before)
    // 夜の仕事も、連携していない時は片付けだけ（'skipped'）
    expect(await core.nightly()).toBe('skipped')
  })
})
