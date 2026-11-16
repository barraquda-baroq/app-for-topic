// トップの画面（docs/SPEC.md の 9.・14.5。設計: 段階2の 1.3〜1.8・1.21・1.22・2.）: S・M は総合とジャンルの区切り（知らないジャンルは総合
// だけ）、L は国内｜世界の2列（地域の分からない話題・新しい形の記録は国内の列の下の「そのほか」）。既読を沈めるのは画面を出した時だけ
// （出した後に読んだ物はその場で淡く・別の端末の既読が届いても沈め直さない）。「既読 n件」の開け閉め・状態の1行・追いつきの帯・空と待つ間
// （今の文のまま。1行と帯を出さない）・前の版・この版の選び方。カードを押すと履歴の state に詳細の印を積む（L は反対の列）
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GENRE_VALUES } from '../../domain/types'
import {
  repairCorrection,
  repairEdition,
  repairEditionFail,
  repairTopic,
  type ShownCorrection,
  type ShownEdition,
  type ShownReadMark,
  type ShownTopic,
} from '../../domain/repair'
import { markSeen, resetStoreForTests, threadsOf, useApp, type AppState, type OpenedEdition } from '../../store/appStore'
import { resetTopUiForTests, useTopUi } from '../../store/uiStore'
import { useSyncView } from '../../sync/syncView'
import { makeFakeMonth, type FakeEdition } from '../../test/fixtures/fakeEditions'
import { FAKE_OUTLETS } from '../../test/fixtures/fakeOutlets'
import { setTestWidth, TEST_WIDTHS } from '../../test/width'
import { AppFrame } from '../../ui/Layout'
import { resetSheetsForTests, sheetOf, sheetState } from '../topic/sheets'
import { TopPage } from './TopPage'
import type { ReadyView } from './TopSection'
import { panelSideFor } from './TopWide'
import { EMPTY_NOTE, EMPTY_TITLE, PAST_TEXTS, WAITING_TEXT } from './texts'

// ストアの markSeen（見たにする）と threadsOf（続報のつながり）だけを差し替える（端末に書く・読む決まりはストアのテストで確かめる）。
// markSeen はメモリの既読に seen を付けるだけにする（追いつきの帯が消える所まで見る）
const threads: Record<string, { id: string; editionId: string; headline: string }[]> = {}
vi.mock('../../store/appStore', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../store/appStore')>()
  return {
    ...m,
    markSeen: vi.fn((editionId: string) => {
      const s = m.useApp.getState()
      const prev = s.user.reads[editionId]
      const mark = { ...(prev ?? { id: editionId, editionId, topicIds: [] }), seen: true } as ShownReadMark
      m.useApp.setState({ user: { ...s.user, reads: { ...s.user.reads, [editionId]: mark } } })
      return { ok: true, changed: true }
    }),
    threadsOf: vi.fn(async (ids: Iterable<string>) => Object.fromEntries([...new Set(ids)].map((id) => [id, threads[id] ?? []]))),
  }
})

/** 2026-11-15（日）14:10 日本時間（いちばん新しい枠は 12:00） */
const T_1410 = Date.parse('2026-11-15T14:10:00+09:00')
/** 2026-11-15（日）20:40 日本時間（いちばん新しい枠は 20:00） */
const T_2040 = Date.parse('2026-11-15T20:40:00+09:00')

// 11/13 12:00・11/13 20:00・11/14 20:00・11/15 12:00 の4つの版（11/14 12:00 は作れなかった）。failsNext で 11/15 20:00 も作れなかった印
const MONTH = makeFakeMonth({ until: '2026-11-15', untilSlot: '12', days: 3, seed: 'top-page', extras: ['failsNext'] })
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

function readyView(fe: FakeEdition, patch: Partial<ReadyView> = {}): ReadyView {
  const edition = editionOf(fe)
  return {
    kind: 'ready',
    editionId: edition.id,
    edition,
    topics: topicsOf(fe),
    newerTopics: [],
    missing: [],
    corrections: {},
    ...patch,
  }
}

function readMark(editionId: string, topicIds: string[] = [], seen = false): ShownReadMark {
  return { id: editionId, v: 1, createdAt: 1, updatedAt: 1, by: 'user', ai: null, editionId, topicIds, seen } as ShownReadMark
}

/** ストアを、版を読み終えた状態にする（opened を渡さなければ、いちばん新しい版に付いていく） */
function setStore(patch: Partial<AppState> = {}) {
  act(() =>
    useApp.setState({
      status: 'ready',
      user: { knownTerms: {}, reads: {} },
      editions: EDITIONS,
      newerEditions: [],
      editionFails: MONTH.editionFails.map((f) => ok(repairEditionFail(f))),
      opened: { follow: true, view: readyView(NEWEST), waiting: null },
      ...patch,
    }),
  )
}

function setReads(reads: Record<string, ShownReadMark>) {
  act(() => useApp.setState({ user: { knownTerms: {}, reads } }))
}

function renderTop(path = '/') {
  const page = (
    <AppFrame>
      <TopPage />
    </AppFrame>
  )
  const router = createMemoryRouter(
    [
      { path: '/', element: page },
      { path: '/e/:editionId', element: page },
      { path: '/catch-up', element: <p>追いつきの画面</p> },
      { path: '/settings', element: <p>設定の画面</p> },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

const sectionOf = (key: string) =>
  screen.getByTestId('top-edition').querySelector<HTMLElement>(`[data-testid="top-section"][data-section="${key}"]`)
const cardIds = (el: Element | null) =>
  [...(el?.querySelectorAll('[data-testid="top-card"]') ?? [])].map((c) => c.getAttribute('data-topic-id'))
/** 区切りの中の、畳んでいないカード */
const openIds = (key: string) => cardIds(sectionOf(key)!.querySelector(':scope > .top-cards'))
/** 区切りの中の「既読 n件」に畳んだカード */
const foldedIds = (key: string) => cardIds(sectionOf(key)!.querySelector('[data-testid="top-read-fold"]'))

let scrollIntoView: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T_1410)
  setTestWidth(TEST_WIDTHS.S)
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView']
  for (const k of Object.keys(threads)) delete threads[k]
  vi.mocked(markSeen).mockClear()
  vi.mocked(threadsOf).mockClear()
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  resetTopUiForTests()
  resetSheetsForTests()
  useSyncView.setState({ view: null })
  vi.useRealTimers()
})

describe('版が無い時・待つ間（段階0・1の文のまま）', () => {
  it.each(Object.entries(TEST_WIDTHS))(
    '%s: 版が無い時は「まだ版はありません」と届く時期だけ（状態の1行・帯は出さない）',
    (_w, width) => {
      setTestWidth(width)
      vi.setSystemTime(T_2040)
      act(() => useSyncView.setState({ view: { kind: 'synced' } }))
      renderTop()
      const top = screen.getByTestId('top-page')
      expect(within(top).getByTestId('top-empty').textContent).toBe(EMPTY_TITLE + EMPTY_NOTE)
      expect(EMPTY_TITLE).toBe('まだ版はありません')
      expect(EMPTY_NOTE).toBe('12:00版と20:00版は、段階3から届くようになります。')
      expect(screen.queryByTestId('top-edition')).toBeNull()
      expect(screen.queryByTestId('edition-status')).toBeNull()
      expect(screen.queryByTestId('catch-up-band')).toBeNull()
      expect(document.title).toBe('Topic Studio')
    },
  )

  it('出せる版が無く話題がそろうのを待っている時は「版を受け取っています…」だけ（20:40 で作れなかった印があっても1行・帯は出さない）', () => {
    vi.setSystemTime(T_2040)
    act(() => useSyncView.setState({ view: { kind: 'synced' } }))
    renderTop()
    setStore({
      user: { knownTerms: {}, reads: { [EDITIONS[0].id]: readMark(EDITIONS[0].id, [], true) } },
      opened: { follow: true, view: null, waiting: NEWEST.edition.id },
    })
    expect(screen.getByTestId('top-waiting').textContent).toBe(WAITING_TEXT)
    expect(WAITING_TEXT).toBe('版を受け取っています…')
    expect(screen.queryByTestId('top-empty')).toBeNull()
    expect(screen.queryByTestId('top-edition')).toBeNull()
    expect(screen.queryByTestId('edition-status')).toBeNull()
    expect(screen.queryByTestId('catch-up-band')).toBeNull()
  })
})

describe('S・M: 総合とジャンルの区切り', () => {
  it.each([
    ['S', TEST_WIDTHS.S],
    ['M', TEST_WIDTHS.M],
  ])('%s: いちばん上に総合（order の順に20本）、その下にジャンルの区切り（区切りの中も order の順）', (_w, width) => {
    setTestWidth(width)
    renderTop()
    setStore()
    const edition = screen.getByTestId('top-edition')
    expect(edition.getAttribute('data-edition-id')).toBe(NEWEST.edition.id)
    expect(edition.getAttribute('data-layout')).toBe('stack')
    const sections = [...edition.querySelectorAll('[data-testid="top-section"]')].map((s) => s.getAttribute('data-section'))
    expect(sections).toEqual(['all', ...GENRE_VALUES])
    expect(openIds('all')).toEqual(NEWEST.edition.order)
    expect(within(sectionOf('all')!).getByRole('heading', { level: 2 }).textContent).toBe('総合（今日知るべき順）')
    const topics = topicsOf(NEWEST)
    for (const g of GENRE_VALUES) {
      expect(openIds(g), g).toEqual(topics.filter((t) => t.genre === g).map((t) => t.id))
      expect(openIds(g).length, g).toBeGreaterThan(0)
    }
    expect(within(sectionOf('economy')!).getByRole('heading', { level: 2 }).textContent).toBe('経済')
    expect(within(sectionOf('incident')!).getByRole('heading', { level: 2 }).textContent).toBe('事故・事件')
    // 切り替えの列は8つで、押せない物は無い。L の列・差し込み口は無い
    const tabs = screen.getAllByTestId('top-switcher-tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['総合', '政治', '経済', 'テック', 'AI', '事件', 'スポーツ', 'エンタメ'])
    expect(tabs.filter((t) => t.getAttribute('aria-disabled'))).toHaveLength(0)
    expect(tabs.filter((t) => t.getAttribute('aria-current') === 'true').map((t) => t.textContent)).toEqual(['総合'])
    expect(screen.queryAllByTestId('panel-slot')).toHaveLength(0)
  })

  it('知らないジャンルの話題（後の版の値）は総合にだけ出す', () => {
    renderTop()
    setStore()
    const novel = topicsOf(NEWEST).find((t) => t.genre === 'novel')!
    expect(novel).toBeTruthy()
    expect(openIds('all')).toContain(novel.id)
    for (const g of GENRE_VALUES) expect(openIds(g)).not.toContain(novel.id)
  })

  it('話題が0本のジャンルは区切りを出さず、切り替えの列では押せない見た目（位置は残す）', () => {
    renderTop()
    const view = readyView(NEWEST)
    setStore({ opened: { follow: true, view: { ...view, topics: view.topics.filter((t) => t.genre !== 'ai') }, waiting: null } })
    expect(sectionOf('ai')).toBeNull()
    const tabs = screen.getAllByTestId('top-switcher-tab')
    expect(tabs).toHaveLength(8)
    expect(tabs[4].textContent).toBe('AI')
    expect(tabs[4].getAttribute('aria-disabled')).toBe('true')
  })

  it('切り替えの列を押すと、その区切りへ移り（scrollIntoView）、区切りの見出しへフォーカスを移し、押した物が今の区切り', async () => {
    renderTop()
    setStore()
    const economy = screen.getAllByTestId('top-switcher-tab')[2]
    fireEvent.click(economy)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    expect(scrollIntoView.mock.contexts[0]).toBe(sectionOf('economy'))
    expect(scrollIntoView.mock.calls[0][0]).toMatchObject({ block: 'start' })
    expect(document.activeElement).toBe(within(sectionOf('economy')!).getByRole('heading', { level: 2 }))
    expect(economy.getAttribute('aria-current')).toBe('true')
  })

  it('カードを押すと、今の行き先のまま履歴の state に詳細の印を積む（S・M は side なし）', () => {
    const router = renderTop()
    setStore()
    const id = NEWEST.edition.order[3]
    fireEvent.click(within(sectionOf('all')!.querySelector(`[data-topic-id="${id}"]`)!).getByRole('button'))
    expect(router.state.location.pathname).toBe('/')
    expect(sheetOf(router.state.location.state)).toEqual({ kind: 'topic', id, side: null })
  })

  it('ほかの画面から戻ると、前のスクロールの位置と区切りへ戻す（版ごとに覚える）', async () => {
    // jsdom は動かないので、位置だけを替える
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(((x: number, y: number) => {
      Object.defineProperty(window, 'scrollY', { configurable: true, value: y })
      void x
    }) as typeof window.scrollTo)
    act(() => useTopUi.getState().setPlace(NEWEST.edition.id, { scroll: { page: 640 }, section: 'economy' }))
    const router = renderTop()
    setStore()
    expect(scrollTo).toHaveBeenCalledWith(0, 640)
    // 離れる時に、今の位置を覚える
    await act(() => router.navigate('/settings'))
    expect(useTopUi.getState().places[NEWEST.edition.id]).toEqual({ scroll: { page: 640 }, section: 'economy' })
    scrollTo.mockRestore()
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
  })
})

describe('L: 国内｜世界の2列', () => {
  beforeEach(() => setTestWidth(TEST_WIDTHS.L))

  it('国内と世界の列に、それぞれの地域の話題を order の順に（重大印の話題は列のいちばん上）。切り替えの列は無い', () => {
    renderTop()
    setStore()
    const edition = screen.getByTestId('top-edition')
    expect(edition.getAttribute('data-layout')).toBe('wide')
    const topics = topicsOf(NEWEST)
    expect(openIds('jp')).toEqual(topics.filter((t) => t.region === 'jp').map((t) => t.id))
    expect(openIds('world')).toEqual(topics.filter((t) => t.region === 'world').map((t) => t.id))
    expect(openIds('jp')[0]).toBe(topics.find((t) => t.major)!.id)
    expect(sectionOf('other')).toBeNull()
    expect(screen.queryByTestId('top-switcher')).toBeNull()
    expect(within(sectionOf('jp')!).getByRole('heading', { level: 2 }).textContent).toBe('国内（知るべき順）')
    // 差し込み口は列ごとに1つ、列の一覧の兄弟に置く
    const slots = screen.getAllByTestId('panel-slot')
    expect(slots.map((s) => s.getAttribute('data-side'))).toEqual(['jp', 'world'])
    expect(slots[0].previousElementSibling?.contains(sectionOf('jp'))).toBe(true)
    // この版の選び方は世界の列のいちばん下
    expect(slots[1].previousElementSibling?.lastElementChild?.getAttribute('data-testid')).toBe('choice-note')
  })

  it('地域が分からない話題と、新しい形の記録の話題は、国内の列の下の「そのほか」に order の順で', () => {
    renderTop()
    const view = readyView(NEWEST)
    const unknown = { ...view.topics[4], region: 'mars' }
    const newerId = view.topics[19].id
    const topics = view.topics.map((t, i) => (i === 4 ? unknown : t)).filter((t) => t.id !== newerId)
    setStore({ opened: { follow: true, view: { ...view, topics, newerTopics: [newerId] }, waiting: null } })
    const other = sectionOf('other')!
    expect(other.closest('.top-column')).toBe(sectionOf('jp')!.closest('.top-column'))
    expect(within(other).getByRole('heading', { level: 2 }).textContent).toBe('そのほか')
    expect(openIds('other')).toEqual([unknown.id, newerId])
    expect(openIds('jp')).not.toContain(unknown.id)
    expect(openIds('world')).not.toContain(unknown.id)
    expect(other.querySelector(`[data-topic-id="${newerId}"]`)?.textContent).toBe('新しい形の記録（アプリを更新してください）')
  })

  it('カードを押すと反対の列に重ねる印を積む（国内 → 世界、世界 → 国内、そのほか → 世界）', () => {
    expect(panelSideFor('jp')).toBe('world')
    expect(panelSideFor('world')).toBe('jp')
    const router = renderTop()
    const view = readyView(NEWEST)
    const unknown = { ...view.topics[4], region: 'mars' }
    setStore({
      opened: { follow: true, view: { ...view, topics: view.topics.map((t, i) => (i === 4 ? unknown : t)) }, waiting: null },
    })
    const jpCard = sectionOf('jp')!.querySelector('[data-testid="top-card"]')!
    fireEvent.click(within(jpCard as HTMLElement).getByRole('button'))
    expect(sheetOf(router.state.location.state)).toMatchObject({ id: openIds('jp')[0], side: 'world' })
    const worldCard = sectionOf('world')!.querySelector('[data-testid="top-card"]')!
    fireEvent.click(within(worldCard as HTMLElement).getByRole('button'))
    expect(sheetOf(router.state.location.state)).toMatchObject({ id: openIds('world')[0], side: 'jp' })
    const otherCard = sectionOf('other')!.querySelector('[data-testid="top-card"]')!
    fireEvent.click(within(otherCard as HTMLElement).getByRole('button'))
    expect(sheetOf(router.state.location.state)).toMatchObject({ id: unknown.id, side: 'world' })
  })

  it('詳細を重ねている列の一覧だけ inert（パネルの差し込み口は inert の外）', async () => {
    const router = renderTop()
    setStore()
    const lists = () => screen.getAllByTestId('panel-slot').map((s) => s.previousElementSibling as HTMLElement)
    const inert = () => lists().map((l) => l.hasAttribute('inert'))
    expect(inert()).toEqual([false, false])
    await act(() => router.navigate('/', { state: sheetState(NEWEST.edition.order[0], 'world') }))
    expect(inert()).toEqual([false, true])
    await act(() => router.navigate('/', { state: sheetState(NEWEST.edition.order[1], 'jp') }))
    expect(inert()).toEqual([true, false])
    expect(screen.getAllByTestId('panel-slot').map((s) => s.closest('[inert]'))).toEqual([null, null])
  })
})

describe('既読を「既読 n件」に沈める（画面を出した時だけ）', () => {
  const read = NEWEST.edition.order[2]
  const later = NEWEST.edition.order[5]

  it('画面を出した時に既読だった話題は、区切りの下の「既読 n件」に畳む（総合とそのジャンルの両方）', () => {
    renderTop()
    setStore({ user: { knownTerms: {}, reads: { [NEWEST.edition.id]: readMark(NEWEST.edition.id, [read]) } } })
    expect(openIds('all')).toEqual(NEWEST.edition.order.filter((id) => id !== read))
    expect(foldedIds('all')).toEqual([read])
    const genre = topicsOf(NEWEST).find((t) => t.id === read)!.genre
    expect(foldedIds(genre)).toEqual([read])
    const folded = sectionOf('all')!.querySelector(`[data-topic-id="${read}"]`)!
    expect(folded.getAttribute('data-read')).toBe('true')
    // 畳んで始まり、押すと開く・もう一度押すと畳む（ボタンは aria-expanded）
    const fold = within(sectionOf('all')!).getByTestId('top-read-fold')
    const button = fold.querySelector<HTMLButtonElement>('.top-read-fold-btn')!
    expect(button.textContent).toBe('既読 1件')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    const body = fold.querySelector('.fold')!
    expect(body.classList.contains('is-closed')).toBe(true)
    expect(button.getAttribute('aria-controls')).toBe(body.id)
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(body.classList.contains('is-closed')).toBe(false)
    // ほかの区切りの開け閉めは変えない
    expect(within(sectionOf(genre)!).getByTestId('top-read-fold').querySelector('.fold')!.classList.contains('is-closed')).toBe(
      true,
    )
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('既読が無い区切りには「既読 n件」を出さない', () => {
    renderTop()
    setStore()
    expect(screen.queryAllByTestId('top-read-fold')).toHaveLength(0)
  })

  it('画面を出した後に読んだ話題は、その場で淡くするだけで動かさない（別の端末の既読が届いた時も）', () => {
    renderTop()
    setStore({ user: { knownTerms: {}, reads: { [NEWEST.edition.id]: readMark(NEWEST.edition.id, [read]) } } })
    setReads({ [NEWEST.edition.id]: readMark(NEWEST.edition.id, [read, later]) })
    expect(foldedIds('all')).toEqual([read])
    expect(openIds('all')).toContain(later)
    const card = sectionOf('all')!.querySelector(`[data-topic-id="${later}"]`)!
    expect(card.getAttribute('data-read')).toBe('true')
    expect(card.classList.contains('is-read')).toBe(true)
  })

  it('次にトップを出した時に沈める（ほかの画面から戻った時）', async () => {
    const router = renderTop()
    setStore()
    setReads({ [NEWEST.edition.id]: readMark(NEWEST.edition.id, [later]) })
    expect(foldedIds('all')).toEqual([])
    await act(() => router.navigate('/settings'))
    await act(() => router.navigate('/'))
    expect(foldedIds('all')).toEqual([later])
  })

  it('版が替わった時に、その版の既読で沈め直す', () => {
    renderTop()
    setStore({ opened: { follow: true, view: readyView(PREV), waiting: null } })
    expect(screen.queryAllByTestId('top-read-fold')).toHaveLength(0)
    setReads({ [NEWEST.edition.id]: readMark(NEWEST.edition.id, [later]) })
    act(() => useApp.setState({ opened: { follow: true, view: readyView(NEWEST), waiting: null } }))
    expect(screen.getByTestId('top-edition').getAttribute('data-edition-id')).toBe(NEWEST.edition.id)
    expect(foldedIds('all')).toEqual([later])
  })
})

describe('カードの印', () => {
  it('訂正のある話題は data-correction（開いた版の訂正）', () => {
    renderTop()
    const id = NEWEST.edition.order[4]
    const corrections = MONTH.corrections.map((c) => ok<ShownCorrection>(repairCorrection(c))).filter((c) => c.topicId === id)
    expect(corrections.length).toBeGreaterThan(0)
    setStore({ opened: { follow: true, view: readyView(NEWEST, { corrections: { [id]: corrections } }), waiting: null } })
    const cards = sectionOf('all')!.querySelectorAll('[data-correction="true"]')
    expect([...cards].map((c) => c.getAttribute('data-topic-id'))).toEqual([id])
  })

  it('話題が新しい形の記録の時は、その order の位置に押せない淡いカード（総合だけ）', () => {
    renderTop()
    const view = readyView(NEWEST)
    const newerId = NEWEST.edition.order[19]
    setStore({
      opened: {
        follow: true,
        view: { ...view, topics: view.topics.filter((t) => t.id !== newerId), newerTopics: [newerId] },
        waiting: null,
      },
    })
    expect(openIds('all')).toEqual(NEWEST.edition.order)
    const card = sectionOf('all')!.querySelector(`[data-topic-id="${newerId}"]`)!
    expect(card.textContent).toBe('新しい形の記録（アプリを更新してください）')
    expect(within(card as HTMLElement).queryAllByRole('button')).toHaveLength(0)
    for (const g of GENRE_VALUES) expect(openIds(g)).not.toContain(newerId)
  })
})

describe('状態の1行（docs/SPEC.md の 4.7。設計: 段階2の 1.7）', () => {
  it('出している版がいちばん新しい枠の版なら出さない', () => {
    act(() => useSyncView.setState({ view: { kind: 'synced' } }))
    renderTop()
    setStore()
    expect(screen.queryByTestId('edition-status')).toBeNull()
  })

  it('いちばん新しい枠が作れなかった時は「20:00版は作れませんでした（使用量の上限）」（切り替えの列の下・静かに）', () => {
    vi.setSystemTime(T_2040)
    renderTop()
    setStore()
    const status = screen.getByTestId('edition-status')
    expect(status.getAttribute('data-kind')).toBe('failed')
    expect(status.textContent).toBe('20:00版は作れませんでした（使用量の上限）')
    expect(status.getAttribute('role')).toBeNull()
    expect(status.classList.contains('is-failed')).toBe(true)
    // S・M は切り替えの列の後
    expect(screen.getByTestId('top-switcher').compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('印も版も無いまま30分たつと、同期が落ち着いている時だけ「20:00版はまだ届いていません」', () => {
    vi.setSystemTime(T_2040)
    renderTop()
    setStore({ editionFails: [] })
    expect(screen.queryByTestId('edition-status')).toBeNull()
    act(() => useSyncView.setState({ view: { kind: 'downloading' } }))
    expect(screen.queryByTestId('edition-status')).toBeNull()
    act(() => useSyncView.setState({ view: { kind: 'synced' } }))
    const status = screen.getByTestId('edition-status')
    expect(status.getAttribute('data-kind')).toBe('not-arrived')
    expect(status.textContent).toBe('20:00版はまだ届いていません')
    act(() => useSyncView.setState({ view: { kind: 'offline' } }))
    expect(screen.queryByTestId('edition-status')).toBeNull()
  })

  it('もっと新しい版を待っている時は「11/15（日）20:00版を受け取っています…」', () => {
    vi.setSystemTime(T_2040)
    renderTop()
    setStore({ opened: { follow: true, view: readyView(NEWEST), waiting: '2026-11-15-20' } })
    const status = screen.getByTestId('edition-status')
    expect(status.getAttribute('data-kind')).toBe('waiting')
    expect(status.textContent).toBe('11/15（日）20:00版を受け取っています…')
  })

  it('L は2列の上（全幅）', () => {
    setTestWidth(TEST_WIDTHS.L)
    vi.setSystemTime(T_2040)
    renderTop()
    setStore()
    const status = screen.getByTestId('edition-status')
    expect(status.closest('.top-columns')).toBeNull()
    expect(status.compareDocumentPosition(screen.getAllByTestId('panel-slot')[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('追いつきの帯（■8 の A。設計: 段階2の 1.8）', () => {
  const [ed1312, ed1320, ed1420] = EDITIONS.map((e) => e.id)

  it('最後に見た版の後に見ていない版が2つ以上あると「見ていない版が 2つあります（…から）」と［追いつく］［×］', () => {
    renderTop()
    setStore({ user: { knownTerms: {}, reads: { [ed1312]: readMark(ed1312, [], true) } } })
    const band = screen.getByTestId('catch-up-band')
    expect(band.textContent).toContain('見ていない版が 2つあります（11/13（金）20:00版から）')
    const go = within(band).getByRole('link', { name: '追いつく' })
    expect(go.getAttribute('href')).toBe('/catch-up')
    // 状態の1行の下（S・M は切り替えの列の下）
    expect(screen.getByTestId('top-switcher').compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('［×］で帯に出した版を全部見たにして、帯が消える（読まずに閉じる）', () => {
    renderTop()
    setStore({ user: { knownTerms: {}, reads: { [ed1312]: readMark(ed1312, [], true) } } })
    fireEvent.click(within(screen.getByTestId('catch-up-band')).getByRole('button', { name: '追いつきの知らせを閉じる' }))
    expect(
      vi
        .mocked(markSeen)
        .mock.calls.map((c) => c[0])
        .sort(),
    ).toEqual([ed1320, ed1420])
    expect(screen.queryByTestId('catch-up-band')).toBeNull()
  })

  it('最後に見た版の後が1つだけ（1日1回、夜だけ開く並び）・初めて使う（見た版が無い）時は出さない', () => {
    renderTop()
    setStore({ user: { knownTerms: {}, reads: { [ed1320]: readMark(ed1320, [], true) } } })
    expect(screen.queryByTestId('catch-up-band')).toBeNull()
    setReads({})
    expect(screen.queryByTestId('catch-up-band')).toBeNull()
  })
})

describe('前の版（#/e/{版の id}。設計: 段階2の 1.8・2.）', () => {
  const prevId = PREV.edition.id

  it('その版の一覧を出し、状態の1行の所に「前の版を見ています ［いちばん新しい版へ］」。追いつきの帯は出さない', () => {
    renderTop(`/e/${prevId}`)
    setStore({
      user: { knownTerms: {}, reads: { [EDITIONS[0].id]: readMark(EDITIONS[0].id, [], true) } },
      opened: { follow: false, view: readyView(PREV), waiting: null },
    })
    expect(screen.getByTestId('top-edition').getAttribute('data-edition-id')).toBe(prevId)
    const status = screen.getByTestId('edition-status')
    expect(status.getAttribute('data-kind')).toBe('past')
    expect(status.textContent).toBe(`${PAST_TEXTS.viewing}${PAST_TEXTS.toNewest}`)
    expect(within(status).getByRole('link').getAttribute('href')).toBe('/')
    expect(screen.queryByTestId('catch-up-band')).toBeNull()
  })

  it('同じ続報のつながりのもっと新しい話題が端末にある話題には「続報あり」', async () => {
    const [, second, third] = MONTH.scenes.chain
    const topic = topicsOf(PREV).find((t) => t.id === second)!
    threads[topic.threadId] = [
      { id: second, editionId: prevId, headline: '2本目' },
      { id: third, editionId: NEWEST.edition.id, headline: '3本目' },
    ]
    renderTop(`/e/${prevId}`)
    setStore({ opened: { follow: false, view: readyView(PREV), waiting: null } })
    const card = () => sectionOf('all')!.querySelector(`[data-topic-id="${second}"]`)!
    await waitFor(() => expect(card().querySelector('.top-card-meta')?.textContent).toContain('続報あり'))
    expect(sectionOf('all')!.textContent?.match(/続報あり/g)).toHaveLength(1)
  })

  it('開き終えるまでは、付いていく版を出さない', () => {
    renderTop(`/e/${prevId}`)
    setStore()
    expect(screen.queryByTestId('top-edition')).toBeNull()
    expect(screen.queryByTestId('top-empty')).toBeNull()
    expect(screen.getByTestId('top-page')).toBeTruthy()
  })

  it.each([
    ['none', PAST_TEXTS.notOnDevice],
    ['expired', PAST_TEXTS.notOnDevice],
    ['newer', PAST_TEXTS.newer],
  ] as const)('%s の版は「%s」と［いちばん新しい版へ］', (kind, text) => {
    renderTop(`/e/${prevId}`)
    const view = (
      kind === 'expired' ? { kind, editionId: prevId, edition: editionOf(PREV) } : { kind, editionId: prevId }
    ) as OpenedEdition['view']
    setStore({ opened: { follow: false, view, waiting: null } })
    const status = screen.getByTestId('edition-status')
    expect(status.textContent).toBe(`${text}${PAST_TEXTS.toNewest}`)
    expect(screen.queryByTestId('top-empty')).toBeNull()
  })

  it('話題がそろうのを待っている版は「版を受け取っています…」', () => {
    renderTop(`/e/${prevId}`)
    setStore({
      opened: {
        follow: false,
        view: { kind: 'waiting', editionId: prevId, edition: editionOf(PREV), missing: [] },
        waiting: null,
      },
    })
    expect(screen.getByTestId('top-waiting').textContent).toBe(WAITING_TEXT)
    expect(screen.getByTestId('edition-status').getAttribute('data-kind')).toBe('past')
  })

  it('版の id が読めない時は「見つかりません」', () => {
    renderTop('/e/2026-13-40-99')
    setStore()
    expect(screen.queryByTestId('top-page')).toBeNull()
    expect(screen.getByText('ページが見つかりません。削除された可能性があります。')).toBeTruthy()
  })
})

describe('この版の選び方（■14 の A。設計: 段階2の 1.22）', () => {
  it('いちばん下に畳んだ「この版の選び方」。候補の数と、選ばなかった見出しと理由', () => {
    renderTop()
    setStore()
    const edition = editionOf(NEWEST)
    const note = screen.getByTestId('choice-note')
    expect(note.tagName).toBe('DETAILS')
    expect((note as HTMLDetailsElement).open).toBe(false)
    expect(note.querySelector('summary')?.textContent).toBe('この版の選び方')
    expect(note.textContent).toContain(`候補 ${edition.candidateCount} 件から20本を選びました`)
    expect([...note.querySelectorAll('li .choice-note-headline')].map((h) => h.textContent)).toEqual(
      edition.notChosen.map((n) => n.headline),
    )
    // S・M はエンタメの区切りの後
    expect(sectionOf('entertainment')!.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('候補の数が分からない時は候補の行を書かず、どちらも無ければ出さない', () => {
    renderTop()
    const view = readyView(NEWEST)
    setStore({ opened: { follow: true, view: { ...view, edition: { ...view.edition, candidateCount: null } }, waiting: null } })
    expect(screen.getByTestId('choice-note').textContent).not.toContain('候補')
    act(() =>
      useApp.setState({
        opened: {
          follow: true,
          view: { ...view, edition: { ...view.edition, candidateCount: null, notChosen: [] } },
          waiting: null,
        },
      }),
    )
    expect(screen.queryByTestId('choice-note')).toBeNull()
  })
})
