// 開発用のフック（window.__ts）の既読・「知ってる」（src/store/devActions.ts。docs/SPEC.md の 16.3 の「開発サーバー」）: 話題の id から
// 版を引いて既読にする・開いている版の話題の用語から「知ってる」にする・付ける決まりはストアの関数のまま。保存先（Dexie。fake-indexeddb）は本物
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence, type AnyRecord, type Persistence } from '../db/persistence'
import { fakeRecordsOf, makeFakeEdition } from '../test/fixtures/fakeEditions'
import { applyRemoteChanges, flushNow, getRawUserRecords, initStore, openEdition, resetStoreForTests, useApp } from './appStore'
import { knowTerm, markReadTopic } from './devActions'

/** 2026-11-15 13:00（日本時間） */
const NOW = Date.UTC(2026, 10, 15, 4, 0)
const TODAY = makeFakeEdition({ date: '2026-11-15', slot: '12', seed: 'dev-actions' })
let p: Persistence

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  p = createPersistence(`dev-actions-${Math.random().toString(36).slice(2)}`)
  await initStore(p)
  await applyRemoteChanges(
    fakeRecordsOf(TODAY).map((r) => ({ table: r.table, id: r.record.id, record: r.record as unknown as AnyRecord })),
  )
  await openEdition(null)
})

afterEach(() => {
  resetStoreForTests()
  p.close()
  vi.useRealTimers()
})

describe('window.__ts.markRead(topicId)', () => {
  it('話題の id の頭の版を既読にし、端末に保存して送信待ちに積む（重ねて呼んでも1つ）', async () => {
    const id = TODAY.topics[0].id
    const r = markReadTopic(id)
    expect(r.ok && r.changed).toBe(true)
    expect(markReadTopic(id)).toMatchObject({ ok: true, changed: false })
    expect(markReadTopic(TODAY.topics[1].id)).toMatchObject({ ok: true, changed: true })
    await flushNow()
    expect(getRawUserRecords().reads['2026-11-15-12']).toMatchObject({
      editionId: '2026-11-15-12',
      topicIds: [id, TODAY.topics[1].id],
      seen: false,
    })
    expect(useApp.getState().user.reads['2026-11-15-12'].topicIds).toEqual([id, TODAY.topics[1].id])
    expect(await p.outboxKeys()).toEqual(new Set(['reads/2026-11-15-12']))
  })

  it.each([['2026-11-15-12'], ['p:abcdefgh'], ['2026-11-15-12-ABCDEFGH'], ['']])('話題の id でない %j は invalid', (id) => {
    expect(markReadTopic(id)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('30日の外の版の話題は expired（ストアの決まりのまま）', () => {
    expect(markReadTopic('2026-10-01-12-abcdefgh')).toMatchObject({ ok: false, reason: 'expired' })
  })
})

describe('window.__ts.know(termId)', () => {
  it('開いている版の話題の用語から、表記と説明の時点を取って「知ってる」にする', async () => {
    const term = TODAY.topics.flatMap((t) => t.terms)[0]
    const r = knowTerm(term.termId)
    expect(r).toMatchObject({ ok: true, changed: true, record: { id: term.termId, term: term.term, asOf: term.asOf, on: true } })
    await flushNow()
    expect(await p.outboxKeys()).toEqual(new Set([`knownTerms/${term.termId}`]))
  })

  it('開いている版の話題に無い語は missing。端末の中を読み終える前は not-ready', () => {
    expect(knowTerm('t000000000000')).toEqual({ ok: false, reason: 'missing' })
    resetStoreForTests()
    expect(knowTerm(TODAY.topics[0].terms[0]?.termId ?? 't000000000000')).toEqual({ ok: false, reason: 'not-ready' })
  })
})
