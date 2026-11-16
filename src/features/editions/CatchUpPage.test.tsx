// 追いつき（#/catch-up。docs/SPEC.md の 9. の「追いつき」。■8 の A。設計: 段階2の 1.8・1.9・1.16）: 付いていく版を開き、出せるように
// なった所で追いつく版を1回だけ決める（画面の間は変えない）。追いつく版の話題を並べ、並べた後に追いつく版を全部見たにする。
// カードはトップと同じ TopCard に版の名前・既読は淡く・訂正あり・続報あり。0本なら「追いつく版はありません」。カードを押すと、列が無いので
// L でも side は null（真ん中の小さな画面）。
// 追いつく版の決め方（catchUpTargetIds）と並べ方（catchUpItems）は src/domain/catchUp.test.ts、版を読む口（loadCatchUp）は
// src/store/appStore.test.ts で確かめる
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catchUpItems } from '../../domain/catchUp'
import {
  repairCorrection,
  repairEdition,
  repairTopic,
  type ShownCorrection,
  type ShownEdition,
  type ShownReadMark,
  type ShownTopic,
} from '../../domain/repair'
import {
  loadCatchUp,
  markSeen,
  openEdition,
  resetStoreForTests,
  threadsOf,
  useApp,
  type AppState,
  type CatchUpEntry,
  type EditionView,
} from '../../store/appStore'
import { makeFakeMonth, type FakeEdition } from '../../test/fixtures/fakeEditions'
import { FAKE_OUTLETS } from '../../test/fixtures/fakeOutlets'
import { setTestWidth, TEST_WIDTHS } from '../../test/width'
import { resetSheetsForTests, sheetOf } from '../topic/sheets'
import { CatchUpPage, LOADING_TEXT } from './CatchUpPage'

// ストアの読む口・書く口だけを差し替える（追いつく版を決める catchUpTargets は本物。版の一覧と既読だけで決める純粋な物）
vi.mock('../../store/appStore', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../store/appStore')>()
  return {
    ...m,
    openEdition: vi.fn(async () => {}),
    loadCatchUp: vi.fn(async () => [] as CatchUpEntry[]),
    markSeen: vi.fn(() => ({ ok: true, changed: true })),
    threadsOf: vi.fn(async (ids: Iterable<string>) => Object.fromEntries([...new Set(ids)].map((id) => [id, []]))),
  }
})

/** 2026-11-15（日）14:10 日本時間（いちばん新しい枠は 12:00） */
const T_1410 = Date.parse('2026-11-15T14:10:00+09:00')

// 11/13 12:00・11/13 20:00・11/14 20:00・11/15 12:00 の4つの版（11/14 12:00 は作れなかった）
const MONTH = makeFakeMonth({ until: '2026-11-15', untilSlot: '12', days: 3, seed: 'catch-up-page' })
const NEWEST = MONTH.editions[MONTH.editions.length - 1]
const PREV = MONTH.editions[MONTH.editions.length - 2]

function ok<T>(r: { kind: string; value?: T }): T {
  if (r.kind !== 'ok') throw new Error('作り物の記録を写しにできません')
  return r.value as T
}

const editionOf = (fe: FakeEdition): ShownEdition => ok<ShownEdition>(repairEdition(fe.edition))
const topicsOf = (fe: FakeEdition): ShownTopic[] =>
  fe.topics.map((t) => ok<ShownTopic>(repairTopic(t, { outlets: FAKE_OUTLETS })))
const EDITIONS = MONTH.editions.map(editionOf)
const CORRECTIONS = MONTH.corrections.map((c) => ok<ShownCorrection>(repairCorrection(c)))
const byId = new Map(MONTH.editions.map((fe) => [fe.edition.id, fe]))

function readyView(fe: FakeEdition): EditionView {
  const edition = editionOf(fe)
  return {
    kind: 'ready',
    editionId: edition.id,
    edition,
    topics: topicsOf(fe),
    newerTopics: [],
    missing: [],
    corrections: {},
  }
}

/** ストアの loadCatchUp と同じ並べ方の写し（作り物の版から。今の版は NEWEST） */
function entriesFor(ids: readonly string[]): CatchUpEntry[] {
  const eds = ids.map((id) => byId.get(id)!)
  const items = catchUpItems(
    eds.map((fe) => ({ editionId: fe.edition.id, order: fe.edition.order, topics: topicsOf(fe) })),
    { editionId: NEWEST.edition.id, topics: topicsOf(NEWEST) },
  )
  return items.map((it) => ({
    topic: it.topic,
    edition: editionOf(byId.get(it.editionId)!),
    corrections: CORRECTIONS.filter((c) => c.topicId === it.topic.id),
  }))
}

function seenMark(editionId: string, topicIds: string[] = [], seen = true): ShownReadMark {
  return { id: editionId, v: 1, createdAt: 1, updatedAt: 1, by: 'user', ai: null, editionId, topicIds, seen } as ShownReadMark
}

function setStore(patch: Partial<AppState> = {}) {
  act(() =>
    useApp.setState({
      status: 'ready',
      user: { knownTerms: {}, reads: { '2026-11-13-12': seenMark('2026-11-13-12') } },
      editions: EDITIONS,
      newerEditions: [],
      editionFails: [],
      opened: { follow: true, view: readyView(NEWEST), waiting: null },
      ...patch,
    }),
  )
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/catch-up', element: <CatchUpPage /> },
      { path: '/', element: <p>トップの画面</p> },
    ],
    { initialEntries: ['/catch-up'] },
  )
  render(<RouterProvider router={router} />)
  return router
}

const page = () => screen.getByTestId('catch-up-page')
const cardIds = () => screen.queryAllByTestId('top-card').map((c) => c.getAttribute('data-topic-id'))
const cardOf = (topicId: string) => screen.getAllByTestId('top-card').find((c) => c.getAttribute('data-topic-id') === topicId)!

/** 最後に見たのが 11/13 12:00版の時の追いつく版（新しい順） */
const TARGETS = ['2026-11-14-20', '2026-11-13-20']

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T_1410)
  setTestWidth(TEST_WIDTHS.S)
  vi.mocked(openEdition).mockReset()
  vi.mocked(openEdition).mockImplementation(async () => {})
  vi.mocked(markSeen).mockClear()
  vi.mocked(threadsOf).mockReset()
  vi.mocked(threadsOf).mockImplementation(async (ids) => Object.fromEntries([...new Set(ids)].map((id) => [id, []])))
  vi.mocked(loadCatchUp).mockReset()
  vi.mocked(loadCatchUp).mockImplementation(async (ids) => entriesFor(ids))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  resetSheetsForTests()
  vi.useRealTimers()
})

describe('追いつく版を決める', () => {
  it('最後に見た版より後の版を決め、その話題を並べる。並べた後に、追いつく版を全部見たにする', async () => {
    setStore()
    let resolve: () => void = () => {}
    vi.mocked(loadCatchUp).mockImplementation((ids) => new Promise<CatchUpEntry[]>((r) => (resolve = () => r(entriesFor(ids)))))
    renderPage()
    await waitFor(() => expect(loadCatchUp).toHaveBeenCalledTimes(1))
    expect(vi.mocked(loadCatchUp).mock.calls[0][0]).toEqual(TARGETS)
    expect(page().getAttribute('data-edition-ids')).toBe(TARGETS.join(' '))
    // 読み終えるまでは見たにしない
    expect(page().getAttribute('aria-busy')).toBe('true')
    expect(screen.getByText(LOADING_TEXT)).toBeTruthy()
    expect(markSeen).not.toHaveBeenCalled()
    await act(async () => resolve())
    const expected = entriesFor(TARGETS)
    expect(expected.length).toBeGreaterThan(20)
    expect(cardIds()).toEqual(expected.map((e) => e.topic.id))
    expect(vi.mocked(markSeen).mock.calls.map((c) => c[0])).toEqual(TARGETS)
    expect(page().getAttribute('aria-busy')).toBeNull()
    expect(screen.getByText('見た版は、ここに出なくなります')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('追いつき')
    expect(document.title).toBe('追いつき — Topic Studio')
    // 付いていく版を開く（もう付いていく版を出していても呼ぶ。読み直すだけ）
    expect(vi.mocked(openEdition).mock.calls.every((c) => c[0] === null)).toBe(true)
  })

  it('開いた時に1回だけ決める（見たにした後・ほかの端末の既読が届いた後も、並べた物を変えない）', async () => {
    setStore()
    renderPage()
    await waitFor(() => expect(cardIds().length).toBeGreaterThan(0))
    const before = cardIds()
    act(() =>
      useApp.setState({
        user: { knownTerms: {}, reads: Object.fromEntries(TARGETS.map((id) => [id, seenMark(id)])) },
      }),
    )
    act(() => useApp.setState({ opened: { follow: true, view: readyView(NEWEST), waiting: null } }))
    expect(loadCatchUp).toHaveBeenCalledTimes(1)
    expect(cardIds()).toEqual(before)
    expect(page().getAttribute('data-edition-ids')).toBe(TARGETS.join(' '))
  })

  it('前の版を開いていた時は付いていく版を開き、付いていく版が出せるようになってから決める', async () => {
    // openEdition(null) は、付いていく版を読み終えてから終わる（読み終えた時には opened.follow が true）
    let resolve: () => void = () => {}
    vi.mocked(openEdition).mockImplementation(() => new Promise<void>((r) => (resolve = r)))
    setStore({ opened: { follow: false, view: readyView(PREV), waiting: null } })
    renderPage()
    await waitFor(() => expect(openEdition).toHaveBeenCalledWith(null))
    expect(loadCatchUp).not.toHaveBeenCalled()
    expect(page().getAttribute('aria-busy')).toBe('true')
    expect(page().hasAttribute('data-edition-ids')).toBe(false)
    expect(screen.queryByText('追いつく版はありません')).toBeNull()
    setStore()
    await act(async () => resolve())
    await waitFor(() => expect(loadCatchUp).toHaveBeenCalledTimes(1))
    expect(vi.mocked(loadCatchUp).mock.calls[0][0]).toEqual(TARGETS)
  })

  it('端末の中を読み終えるまでは「読み込み中…」。読み終えたら、もう一度付いていく版を開いて待つ', async () => {
    setStore({ status: 'loading', opened: { follow: true, view: null, waiting: null } })
    renderPage()
    expect(screen.getByText(LOADING_TEXT)).toBeTruthy()
    expect(openEdition).toHaveBeenCalledTimes(1)
    let resolve: () => void = () => {}
    vi.mocked(openEdition).mockImplementation(() => new Promise<void>((r) => (resolve = r)))
    act(() => useApp.setState({ status: 'ready' }))
    await waitFor(() => expect(openEdition).toHaveBeenCalledTimes(2))
    // 付いていく版を読み終えるまでは、出せる版が無くても「追いつく版はありません」を出さない
    expect(screen.queryByText('追いつく版はありません')).toBeNull()
    await act(async () => resolve())
    expect(screen.getByText('追いつく版はありません')).toBeTruthy()
    expect(page().getAttribute('aria-busy')).toBeNull()
  })

  it('出せる版が無い時は「追いつく版はありません」（まだ決めない）。後から版が出せるようになった所で決める', async () => {
    setStore({ opened: { follow: true, view: null, waiting: '2026-11-15-12' } })
    renderPage()
    expect(await screen.findByText('追いつく版はありません')).toBeTruthy()
    expect(page().hasAttribute('data-edition-ids')).toBe(false)
    expect(loadCatchUp).not.toHaveBeenCalled()
    expect(markSeen).not.toHaveBeenCalled()
    setStore()
    await waitFor(() => expect(cardIds().length).toBeGreaterThan(0))
    expect(page().getAttribute('data-edition-ids')).toBe(TARGETS.join(' '))
    expect(screen.queryByText('追いつく版はありません')).toBeNull()
  })

  it('追いつく版が無ければ「追いつく版はありません」で、見たにしない（最後に見た版の後は今の版だけ）', async () => {
    setStore({ user: { knownTerms: {}, reads: { '2026-11-14-20': seenMark('2026-11-14-20') } } })
    renderPage()
    expect(await screen.findByText('追いつく版はありません')).toBeTruthy()
    expect(page().getAttribute('data-edition-ids')).toBe('')
    expect(markSeen).not.toHaveBeenCalled()
    expect(screen.queryByText('見た版は、ここに出なくなります')).toBeNull()
  })

  it('30日の内に見た版が無い（初めて使う）時も「追いつく版はありません」', async () => {
    setStore({ user: { knownTerms: {}, reads: {} } })
    renderPage()
    expect(await screen.findByText('追いつく版はありません')).toBeTruthy()
    expect(page().getAttribute('data-edition-ids')).toBe('')
  })

  it('話題を読めなかった時は「追いつく版はありません」で、見たにしない', async () => {
    setStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(loadCatchUp).mockImplementation(async () => {
      throw new Error('読めない')
    })
    renderPage()
    expect(await screen.findByText('追いつく版はありません')).toBeTruthy()
    expect(markSeen).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('カード', () => {
  it('頭の行に版の名前。既読は淡く（沈めない）・訂正あり・続報あり（もっと新しい話題が端末にある時）', async () => {
    const entries = entriesFor(TARGETS)
    const [first, second, third] = entries
    vi.mocked(loadCatchUp).mockImplementation(async () =>
      entries.map((e, i) =>
        i === 1 ? { ...e, corrections: [{ ...CORRECTIONS[0], topicId: e.topic.id, text: '作り物の訂正' }] } : e,
      ),
    )
    vi.mocked(threadsOf).mockImplementation(async (ids) => {
      const out: Record<string, { id: string; editionId: string; headline: string }[]> = {}
      for (const id of new Set(ids)) out[id] = []
      out[third.topic.threadId] = [
        { id: third.topic.id, editionId: third.topic.editionId, headline: third.topic.headline },
        { id: '2026-11-15-20-999', editionId: '2026-11-15-20', headline: '作り物のもっと新しい話題' },
      ]
      return out
    })
    setStore({
      user: {
        knownTerms: {},
        reads: {
          '2026-11-13-12': seenMark('2026-11-13-12'),
          [first.topic.editionId]: seenMark(first.topic.editionId, [first.topic.id], false),
        },
      },
    })
    renderPage()
    await waitFor(() => expect(cardIds()).toHaveLength(entries.length))
    // 既読（読んだ話題）は淡くするだけで、並びは変えない
    expect(cardIds()[0]).toBe(first.topic.id)
    expect(cardOf(first.topic.id).getAttribute('data-read')).toBe('true')
    expect(cardOf(second.topic.id).getAttribute('data-read')).toBeNull()
    expect(cardOf(second.topic.id).getAttribute('data-correction')).toBe('true')
    expect(cardOf(first.topic.id).getAttribute('data-correction')).toBeNull()
    await waitFor(() => expect(within(cardOf(third.topic.id)).queryByText('続報あり')).toBeTruthy())
    expect(within(cardOf(first.topic.id)).queryByText('続報あり')).toBeNull()
    expect(within(cardOf(first.topic.id)).getByText(editionLabel(first.topic.editionId))).toBeTruthy()
    // 詳細を開いて読むと、その場で淡くなる
    act(() =>
      useApp.setState({
        user: {
          knownTerms: {},
          reads: {
            ...useApp.getState().user.reads,
            [second.topic.editionId]: seenMark(second.topic.editionId, [second.topic.id]),
          },
        },
      }),
    )
    expect(cardOf(second.topic.id).getAttribute('data-read')).toBe('true')
    expect(cardIds()[1]).toBe(second.topic.id)
  })

  it.each(Object.entries(TEST_WIDTHS))(
    '%s: カードを押すと、今の行き先のまま詳細の印を積む（列が無いので side は null）',
    async (_w, width) => {
      setTestWidth(width)
      setStore()
      const router = renderPage()
      await waitFor(() => expect(cardIds().length).toBeGreaterThan(0))
      const id = cardIds()[2]!
      fireEvent.click(within(cardOf(id)).getByRole('button'))
      expect(router.state.location.pathname).toBe('/catch-up')
      expect(sheetOf(router.state.location.state)).toEqual({ kind: 'topic', id, side: null })
    },
  )
})

/** 「11/14（土）20:00版」 */
function editionLabel(editionId: string): string {
  const [y, m, d, slot] = editionId.split('-')
  const wd = '日月火水木金土'[new Date(`${y}-${m}-${d}T12:00:00+09:00`).getUTCDay()]
  return `${Number(m)}/${Number(d)}（${wd}）${slot}:00版`
}
