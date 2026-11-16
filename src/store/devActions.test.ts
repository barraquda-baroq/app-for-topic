// 開発用のフック（window.__ts）の既読・「知ってる」（src/store/devActions.ts。docs/SPEC.md の 16.3 の「開発サーバー」）: 話題の id から
// 版を引いて既読にする・開いている版の話題の用語から「知ってる」にする・付ける決まりはストアの関数のまま。保存先（Dexie。fake-indexeddb）は本物。
// 段階2で足した見た版（markSeen）と、今の行き先に詳細の印を積む openTopic（src/features/topic/sheets.ts の sheetState。設計: 段階2の 4.2）
import { createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence, type AnyRecord, type Persistence } from '../db/persistence'
import { openedOnThisPage, PAGE_ID, sheetOf } from '../features/topic/sheets'
import { fakeRecordsOf, makeFakeEdition } from '../test/fixtures/fakeEditions'
import { applyRemoteChanges, flushNow, getRawUserRecords, initStore, openEdition, resetStoreForTests, useApp } from './appStore'
import { knowTerm, markReadTopic, markSeenEdition, openTopicSheet } from './devActions'

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

describe('window.__ts.markSeen(editionId)', () => {
  it('版の一覧を見たにする（読んだ話題は足さない・戻さない・重ねて呼んでも1つ）', async () => {
    const r = markSeenEdition('2026-11-15-12')
    expect(r).toMatchObject({ ok: true, changed: true, record: { editionId: '2026-11-15-12', topicIds: [], seen: true } })
    expect(markSeenEdition('2026-11-15-12')).toMatchObject({ ok: true, changed: false })
    // 端末に版の記録が無い版も、30日の内なら付く（どこまで見たかを先に作れる）
    expect(markSeenEdition('2026-11-14-20').ok).toBe(true)
    await flushNow()
    expect(useApp.getState().user.reads['2026-11-15-12'].seen).toBe(true)
    expect(await p.outboxKeys()).toEqual(new Set(['reads/2026-11-15-12', 'reads/2026-11-14-20']))
  })

  it('形の違う id は invalid・30日の外は expired（ストアの決まりのまま）', () => {
    expect(markSeenEdition('2026-11-15')).toEqual({ ok: false, reason: 'invalid' })
    expect(markSeenEdition(TODAY.topics[0].id)).toEqual({ ok: false, reason: 'invalid' })
    expect(markSeenEdition('2026-10-01-12')).toMatchObject({ ok: false, reason: 'expired' })
  })
})

describe('window.__ts.openTopic(topicId, side?)', () => {
  const routerAt = (path: string) =>
    createMemoryRouter(
      ['/', '/e/:editionId', '/catch-up'].map((p) => ({ path: p, element: null })),
      { initialEntries: [path] },
    )

  it('今の行き先のまま、履歴の state に詳細の印（sheetState）を積む。もう開いていれば置き換える', async () => {
    const router = routerAt('/e/2026-11-14-20')
    const id = TODAY.topics[0].id
    expect(openTopicSheet(router, id, 'world')).toBe(true)
    await vi.waitFor(() => expect(sheetOf(router.state.location.state)).not.toBeNull())
    expect(router.state.location.pathname).toBe('/e/2026-11-14-20')
    expect(router.state.historyAction).toBe('PUSH')
    expect(router.state.location.state).toEqual({ sheet: { kind: 'topic', id, side: 'world' }, sheetPage: PAGE_ID })
    expect(openedOnThisPage(router.state.location.state)).toBe(true)
    const next = TODAY.topics[1].id
    expect(openTopicSheet(router, next)).toBe(true)
    await vi.waitFor(() => expect(sheetOf(router.state.location.state)?.id).toBe(next))
    expect(router.state.historyAction).toBe('REPLACE')
    // side を渡さない・知らない値は null（L では真ん中の小さな画面）
    expect(sheetOf(router.state.location.state)?.side).toBeNull()
    expect(openTopicSheet(router, id, 'left' as never)).toBe(true)
    await vi.waitFor(() => expect(sheetOf(router.state.location.state)?.id).toBe(id))
    expect(sheetOf(router.state.location.state)?.side).toBeNull()
  })

  it('ルーターがまだ無い・id が空の時は開かない', () => {
    const router = routerAt('/')
    expect(openTopicSheet(null, TODAY.topics[0].id)).toBe(false)
    expect(openTopicSheet(router, '')).toBe(false)
    expect(sheetOf(router.state.location.state)).toBeNull()
  })
})
