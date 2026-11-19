// Workers の中（workerd）で、HTMLRewriter を使った本文の抜き出しと候補集めの alarm の続き（段階3の設計の 7.「Workers の中」）:
// 作り物の出どころ（test/support/fakeNews.ts）を fetch の差し替えで。ホストごとの間（予約）を守る・1回の alarm は6本まで・
// 気象庁の Atom と全文の RSS は1本で1回の alarm
import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { FAKE_OUTLETS } from '../../../src/test/fixtures/fakeOutlets'
import { fetchBody } from '../../src/fetch/article'
import { collectStep } from '../../src/fetch/collector'
import { rewriterEvents } from '../../src/fetch/htmlRewriter'
import { VaultCore } from '../../src/vault/core'
import type { RunRow, SqlRunner, SqlValue } from '../../src/vault/store'
import { createFetchWork } from '../../src/vault/tools/fetch'
import { FakeFirebase } from '../support/fakeFirebase'
import { fakeEnv, FakeNews, FAKE_SOURCES, seedFakeNews } from '../support/fakeNews'

const NOW = Date.UTC(2026, 10, 19, 1, 16)

function doSql(storage: DurableObjectStorage): SqlRunner {
  return {
    all<T>(sql: string, ...params: SqlValue[]): T[] {
      return storage.sql.exec(sql, ...params).toArray() as T[]
    },
    run(sql: string, ...params: SqlValue[]): void {
      storage.sql.exec(sql, ...params)
    },
    transaction<T>(fn: () => T): T {
      return storage.transactionSync(fn)
    },
  }
}

/** DO の SQLite の上に、作り物の出どころ・HTMLRewriter の VaultCore を作る（連携はしない。取りに行く部品だけを見る） */
async function withCore(fn: (core: VaultCore, news: FakeNews, clock: { now: number }) => Promise<void>) {
  const stub = env.VAULT.get(env.VAULT.idFromName(`b4-${crypto.randomUUID()}`))
  await runInDurableObject(stub, async (_vault, state) => {
    const clock = { now: NOW }
    const news = seedFakeNews(new FakeNews(clock))
    const fake = new FakeFirebase()
    const core = new VaultCore({
      sql: doSql(state.storage),
      fetch: fake.fetch as typeof fetch,
      config: {
        projectId: fake.project,
        apiKey: 'test-api-key',
        identityUrl: fake.identityUrl,
        tokenUrl: fake.tokenUrl,
        firestoreUrl: fake.firestoreUrl,
        workBudgetChars: 300_000,
        dailyReadBudget: 15_000,
        dailyWriteBudget: 5_000,
      },
      secret: 'workerd-test-secret-0123456789abcdef',
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms
      },
      outlets: FAKE_OUTLETS,
      sourceFetch: news.fetch as typeof fetch,
      fetchWork: createFetchWork(fakeEnv({ html: rewriterEvents })),
    })
    await fn(core, news, clock)
  })
}

const trialRun = (runId: string): RunRow => ({
  runId,
  kind: 'trial',
  model: 'fake-writer-model',
  started: NOW,
  expires: NOW + 12 * 3_600_000,
  lastCall: NOW,
  editionId: '2026-11-19-12',
  writerMs: NOW + 90 * 60_000,
  checkerMs: NOW + 150 * 60_000,
  sinceMs: Date.UTC(2026, 10, 18, 9, 0),
  untilMs: NOW,
  done: false,
  probe: null,
  skip: [],
  collect: { state: 'collecting' },
  notes: {},
})

describe('Workers の中の本文の抜き出し（HTMLRewriter）', () => {
  it('HTML の本文（記者の質問の段を落とす）と #番号 の項目', async () => {
    await withCore(async (core) => {
      const e = fakeEnv({ html: rewriterEvents })
      const html = FAKE_SOURCES.find((s) => s.id === 'fake-html')!
      const r = await fetchBody(core, e, html, 'https://example.com/fake-ministry/press/1001.html', null, { maxWait: 15_000 })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.read.title).toBe('作り物の制度の見直しについて')
      expect(r.read.chars).toBeGreaterThan(200)
      expect(r.read.lines.join('\n')).not.toContain('作り物の質問の文')
      const anchor = FAKE_SOURCES.find((s) => s.id === 'fake-anchor')!
      const a = await fetchBody(core, e, anchor, 'https://example.com/fake-office/index.html#n101', null, { maxWait: 15_000 })
      expect(a.ok && a.read.url).toBe('https://example.com/fake-office/index.html#n101')
      expect(a.ok && a.read.chars).toBeGreaterThan(200)
    })
  })
})

describe('Workers の中の候補集めの alarm の続き', () => {
  it('ホストごとの間を守り、1回は6本まで・大きな一覧は1本で1回。最後に c0001 から並べる', async () => {
    await withCore(async (core, news, clock) => {
      const runId = 'r202611191016-w001'
      core.store.putRun(trialRun(runId))
      const steps: string[][] = []
      for (let i = 0; i < 80; i++) {
        const before = news.calls.length
        const st = await collectStep(core, runId)
        steps.push(news.urls().slice(before))
        if (st.done) break
        if (st.next > clock.now) clock.now = st.next
      }
      expect(core.store.getRun(runId)!.collect.state).toBe('done')
      for (const s of steps) {
        expect(s.length).toBeLessThanOrEqual(8)
        const heavy = s.filter((u) => u.endsWith('/fake-met/xml/feed/extra.xml') || u.endsWith('/fake-voices/feed/'))
        if (heavy.length) expect(s.filter((u) => !u.endsWith('robots.txt') && !u.endsWith('tdmrep.json'))).toEqual(heavy)
      }
      const at = news.calls.map((c) => c.at)
      for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(1_000)
      const cands = core.store.candidates(runId)
      expect(cands.map((c) => c.cid)).toEqual(['c0001', 'c0002', 'c0003', 'c0004', 'c0005', 'c0006', 'c0007', 'c0008'])
    })
  })
})
