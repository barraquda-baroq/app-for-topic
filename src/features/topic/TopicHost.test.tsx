// 話題の詳細を出す所（docs/SPEC.md の 9. の「詳細」・14.5。設計: 段階2の 1.9・1.13・2.・4.1）: 履歴の state.sheet を見て、S・M は
// 下からのシート、L は列の差し込み口があればその列に重ねるパネル・無ければ真ん中の小さな画面。開いた版の話題はすぐ、ほかの版の話題は
// 端末から読んで出す（読めなければ閉じる）。開いた時に既読と見たを1回で書く。前の話題へのリンクは置き換え（履歴を増やさない）。
// 読み込み直した後は、読めれば開き直し、読めなければ閉じる。［知ってる］は閉じた時に書き、［取り消す］は書かない（前が on: true の
// 古い asOf の語でも、記録は押す前のまま）。ページが裏になると書き、その後は［取り消す］を出さない。クリップは何も記録しない。
// 端末の中の保存先（Dexie。fake-indexeddb）とストアは本物。作り物の版だけを使う（中身はすべて作り物）
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { JSX } from 'react'
import { createMemoryRouter, RouterProvider, type InitialEntry } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence, type AnyRecord, type Persistence } from '../../db/persistence'
import { FAKE_TOPIC_SCENES, fakeRecordsOf, makeFakeMonth } from '../../test/fixtures/fakeEditions'
import { FAKE_OUTLETS } from '../../test/fixtures/fakeOutlets'
import { setTestWidth, TEST_WIDTHS } from '../../test/width'
import {
  flushNow,
  getRawUserRecords,
  initStore,
  know,
  openEdition,
  resetStoreForTests,
  setTopicOutlets,
  useApp,
} from '../../store/appStore'
import { openTopicSheet, type SheetRouter } from '../../store/devActions'
import { useToasts } from '../../store/uiStore'
import { KNOWN_TEXTS } from './detailTexts'
import { PAGE_ID, PanelSlot, resetSheetsForTests, sheetOf, usePanelSlots } from './sheets'
import { TopicHost } from './TopicHost'

/** 2026-11-15（日）14:10 日本時間（いちばん新しい版は 11/15 12:00版。その訂正の後） */
const NOW = Date.parse('2026-11-15T14:10:00+09:00')
const MONTH = makeFakeMonth({ until: '2026-11-15', untilSlot: '12', days: 3, seed: 'topic-host' })
const NEWEST = MONTH.editions[MONTH.editions.length - 1]

let stores: Persistence[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  setTestWidth(TEST_WIDTHS.S)
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  resetSheetsForTests()
  usePanelSlots.setState({ jp: null, world: null })
  useToasts.setState({ toasts: [] })
  for (const p of stores) p.close()
  stores = []
  vi.useRealTimers()
})

/** 作り物の版を受け取った物として端末に入れ、ストアを始めてトップ（いちばん新しい出せる版）を開く */
async function startStore(): Promise<Persistence> {
  const p = createPersistence(`topic-host-${Math.random().toString(36).slice(2)}`)
  stores.push(p)
  await p.applyRemote(
    fakeRecordsOf(MONTH)
      .filter((r) => r.table !== 'termPacks')
      .map((r) => ({ table: r.table, id: r.record.id, record: r.record as unknown as AnyRecord })),
  )
  setTopicOutlets(FAKE_OUTLETS)
  await initStore(p)
  await openEdition(null)
  return p
}

/** 列（L のパネルを重ねる所）: 一覧と差し込み口 */
function Column(): JSX.Element {
  return (
    <div data-testid="column" style={{ position: 'relative' }}>
      <div data-testid="column-list">
        <button type="button">カード</button>
      </div>
      <PanelSlot side="world" />
    </div>
  )
}

function renderHost(entries: InitialEntry[] = ['/'], { column = false }: { column?: boolean } = {}): SheetRouter {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            {column ? <Column /> : null}
            <TopicHost />
          </>
        ),
      },
    ],
    { initialEntries: entries },
  )
  render(<RouterProvider router={router} />)
  return router as unknown as SheetRouter
}

async function open(router: SheetRouter, topicId: string, side: 'jp' | 'world' | null = null): Promise<HTMLElement> {
  await act(async () => {
    openTopicSheet(router, topicId, side)
  })
  return screen.findByTestId('topic-detail')
}

const topicIdAt = (rank: number) => NEWEST.topics[rank - 1].id

describe('出し方と開け閉め（設計: 段階2の 1.9・2.）', () => {
  it('S: 開いた版の話題は下からのシート（題は版の行・見出しへフォーカス・下の帯に［クリップ］）。［×］で閉じると1つ戻る', async () => {
    await startStore()
    const router = renderHost()
    const id = topicIdAt(FAKE_TOPIC_SCENES.major)
    const detail = await open(router, id)
    expect(detail.getAttribute('data-mode')).toBe('sheet')
    const sheet = detail.closest('.modal') as HTMLElement
    expect(sheet.classList.contains('topic-sheet')).toBe(true)
    expect(within(sheet).getByRole('heading', { level: 2 }).textContent).toBe('11/15（日）12:00版・国内・テクノロジー')
    expect(document.activeElement).toBe(within(detail).getByRole('heading', { level: 3 }))
    expect(within(sheet.querySelector('.modal-foot') as HTMLElement).getByTestId('topic-clip')).toBeTruthy()
    fireEvent.click(within(sheet).getByTestId('modal-close'))
    await waitFor(() => expect(screen.queryByTestId('topic-detail')).toBeNull())
    expect(sheetOf(router.state.location.state)).toBeNull()
    expect(router.state.historyAction).toBe('POP')
  })

  it('開いた時に、その話題を既読にし、その版を見たにする（1回で書く）', async () => {
    await startStore()
    const router = renderHost()
    const id = topicIdAt(4)
    await open(router, id)
    await waitFor(() => expect(useApp.getState().user.reads[NEWEST.edition.id]).toMatchObject({ topicIds: [id], seen: true }))
  })

  it('L で差し込み口のある列の side なら、その列に重ねるパネル（重ねた列の一覧は inert）。Esc で閉じる', async () => {
    setTestWidth(TEST_WIDTHS.L)
    await startStore()
    const router = renderHost(['/'], { column: true })
    const detail = await open(router, topicIdAt(FAKE_TOPIC_SCENES.major), 'world')
    expect(detail.getAttribute('data-mode')).toBe('panel')
    expect(detail.closest('[data-testid="panel-slot"]')?.getAttribute('data-side')).toBe('world')
    expect(document.querySelector('.modal')).toBeNull()
    expect((screen.getByTestId('column-list') as HTMLElement).inert).toBe(true)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('topic-detail')).toBeNull())
    expect((screen.getByTestId('column-list') as HTMLElement).inert).toBe(false)
  })

  it('L で差し込み口の無い side（null・出ていない列）は真ん中の小さな画面。S・M は差し込み口があってもシート', async () => {
    setTestWidth(TEST_WIDTHS.L)
    await startStore()
    const router = renderHost(['/'], { column: true })
    const detail = await open(router, topicIdAt(2), 'jp')
    expect(detail.getAttribute('data-mode')).toBe('sheet')
    expect(detail.closest('.modal')).toBeTruthy()
    cleanup()
    setTestWidth(TEST_WIDTHS.M)
    const r2 = renderHost(['/'], { column: true })
    const d2 = await open(r2, topicIdAt(2), 'world')
    expect(d2.getAttribute('data-mode')).toBe('sheet')
  })

  it('ほかの版の話題は端末から読む（読む間は「読み込み中…」）。読めない話題は開かずに閉じる', async () => {
    await startStore()
    const router = renderHost()
    const first = MONTH.scenes.chain[0]
    const detail = await open(router, first)
    expect(detail.getAttribute('data-topic-id')).toBe(first)
    // 訂正もその話題の分を読む
    expect(
      within(detail)
        .getAllByTestId('topic-correction')
        .map((e) => e.textContent),
    ).toEqual(['訂正: 新しい橋の歩道の幅は 2メートルではなく 3メートルでした'])
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('11/13（金）12:00版・国内・経済')
    await act(async () => {
      router.navigate(-1)
    })
    const missing = `${NEWEST.edition.id}-zzzzzzzz`
    await act(async () => {
      openTopicSheet(router, missing, null)
    })
    await waitFor(() => expect(sheetOf(router.state.location.state)).toBeNull())
    expect(screen.queryByTestId('topic-detail')).toBeNull()
  })

  it('閉じた時に開いた所へ戻せない（フォーカスがどこにも無い）時は、同じ話題の見えているカードの見出しのボタンへ戻す', async () => {
    // jsdom は checkVisibility を持たないので、見えるかどうかを data-shown で決める（src/ui/Modal.test.tsx と同じ）
    const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'checkVisibility')
    Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
      value(this: HTMLElement) {
        return this.closest('[data-shown="false"]') === null
      },
      configurable: true,
    })
    try {
      await startStore()
      const id = topicIdAt(4)
      // S・M のように同じ話題のカードが2つあり、1つ目は「既読 n件」に畳んでいて見えない
      const card = (shown: boolean, label: string) => (
        <article data-testid="top-card" data-topic-id={id} data-shown={String(shown)}>
          <h3>
            <button type="button" className="top-card-open">
              {label}
            </button>
          </h3>
        </article>
      )
      const router = createMemoryRouter(
        [
          {
            path: '*',
            element: (
              <>
                {card(false, '畳んだカード')}
                {card(true, '見えるカード')}
                <TopicHost />
              </>
            ),
          },
        ],
        { initialEntries: ['/'] },
      )
      render(<RouterProvider router={router} />)
      // 開発用のフックで開く（カードを押していないので、開いた所はどこにも無い）
      ;(document.activeElement as HTMLElement | null)?.blur()
      await open(router as unknown as SheetRouter, id)
      fireEvent.click(screen.getByTestId('modal-close'))
      await waitFor(() => expect(screen.queryByTestId('topic-detail')).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '見えるカード' })))
    } finally {
      if (before) Object.defineProperty(HTMLElement.prototype, 'checkVisibility', before)
      else Reflect.deleteProperty(HTMLElement.prototype, 'checkVisibility')
    }
  })

  it('前の話題へのリンクは、同じシートの中身を替える（置き換え。履歴を増やさない）', async () => {
    await startStore()
    const router = renderHost()
    const [, second, third] = MONTH.scenes.chain
    const detail = await open(router, third)
    const prev = await within(detail).findByRole('button', { name: /^前の話題:/ })
    fireEvent.click(prev)
    await waitFor(() => expect(screen.getByTestId('topic-detail').getAttribute('data-topic-id')).toBe(second))
    expect(router.state.historyAction).toBe('REPLACE')
    expect(sheetOf(router.state.location.state)?.id).toBe(second)
  })
})

describe('読み込み直した後（設計: 段階2の 2.）', () => {
  it('前のページの state.sheet は、端末の中を読み終えて話題を読めれば開き直す（このページの印に替える）', async () => {
    const id = topicIdAt(3)
    const router = renderHost([{ pathname: '/', state: { sheet: { kind: 'topic', id, side: null }, sheetPage: 'old-page' } }])
    expect(screen.queryByTestId('topic-detail')).toBeNull()
    await act(async () => {
      await startStore()
    })
    expect((await screen.findByTestId('topic-detail')).getAttribute('data-topic-id')).toBe(id)
    expect((router.state.location.state as { sheetPage?: string }).sheetPage).toBe(PAGE_ID)
  })

  it('読めない話題（端末に無い）なら開かずに印を外す', async () => {
    const id = `${NEWEST.edition.id}-zzzzzzzz`
    const router = renderHost([{ pathname: '/', state: { sheet: { kind: 'topic', id, side: null }, sheetPage: 'old-page' } }])
    await act(async () => {
      await startStore()
    })
    await waitFor(() => expect(sheetOf(router.state.location.state)).toBeNull())
    expect(screen.queryByTestId('topic-detail')).toBeNull()
  })
})

describe('［知ってる］は閉じた時に書く（設計: 段階2の 1.13）', () => {
  const topicId = topicIdAt(FAKE_TOPIC_SCENES.jpRulingParty)

  /** 一覧の、その語の行 */
  const rowOf = (termId: string) => document.querySelector(`.topic-term[data-term-id="${termId}"]`) as HTMLElement

  it('押しても書かず、閉じた時に書く。開き直すと一覧にも本文の印にも出ない', async () => {
    await startStore()
    const router = renderHost()
    const detail = await open(router, topicId)
    const termId = within(detail).getAllByTestId('term-mark')[0].getAttribute('data-term-id')!
    fireEvent.click(within(rowOf(termId)).getByTestId('term-known'))
    expect(rowOf(termId).textContent).toContain(KNOWN_TEXTS.pressed)
    expect(useApp.getState().user.knownTerms[termId]).toBeUndefined()
    fireEvent.click(screen.getByTestId('modal-close'))
    await waitFor(() => expect(screen.queryByTestId('topic-detail')).toBeNull())
    expect(useApp.getState().user.knownTerms[termId]).toMatchObject({ on: true })
    const again = await open(router, topicId)
    expect(again.querySelector(`[data-testid="term-mark"][data-term-id="${termId}"]`)).toBeNull()
    expect(rowOf(termId)).toBeNull()
  })

  it('［取り消す］は書かない（閉じても記録は押す前のまま）', async () => {
    await startStore()
    const router = renderHost()
    const detail = await open(router, topicId)
    const termId = within(detail).getAllByTestId('term-mark')[0].getAttribute('data-term-id')!
    fireEvent.click(within(rowOf(termId)).getByTestId('term-known'))
    fireEvent.click(within(rowOf(termId)).getByRole('button', { name: KNOWN_TEXTS.undo }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('topic-detail')).toBeNull())
    expect(useApp.getState().user.knownTerms[termId]).toBeUndefined()
  })

  it('前が on: true（古い asOf）の時期で変わる語を新しい話題で押して取り消すと、記録は押す前のまま', async () => {
    await startStore()
    const { termId, key, asOfBefore, asOfAfter } = MONTH.scenes.changingTerm
    expect(know({ termId, term: key, asOf: asOfBefore }).ok).toBe(true)
    await flushNow()
    const before = getRawUserRecords().knownTerms[termId]
    expect(before).toMatchObject({ on: true, asOf: asOfBefore })
    const router = renderHost()
    // いちばん新しい版の話題の説明は新しい（asOfAfter）ので、知ってるにしていても、もう一度出る
    expect(NEWEST.topics[FAKE_TOPIC_SCENES.jpRulingParty - 1].terms.find((t) => t.termId === termId)?.asOf).toBe(asOfAfter)
    await open(router, topicId)
    fireEvent.click(within(rowOf(termId)).getByTestId('term-known'))
    fireEvent.click(within(rowOf(termId)).getByRole('button', { name: KNOWN_TEXTS.undo }))
    fireEvent.click(screen.getByTestId('modal-close'))
    await waitFor(() => expect(screen.queryByTestId('topic-detail')).toBeNull())
    await flushNow()
    expect(getRawUserRecords().knownTerms[termId]).toEqual(before)
  })

  it('ページが裏になると書き、その後は「知ってるにしました」だけ（［取り消す］を出さない）', async () => {
    await startStore()
    const router = renderHost()
    const detail = await open(router, topicId)
    const termId = within(detail).getAllByTestId('term-mark')[0].getAttribute('data-term-id')!
    fireEvent.click(within(rowOf(termId)).getByTestId('term-known'))
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    visibility.mockRestore()
    expect(useApp.getState().user.knownTerms[termId]).toMatchObject({ on: true })
    expect(rowOf(termId).textContent).toContain(KNOWN_TEXTS.pressed)
    expect(within(rowOf(termId)).queryByRole('button', { name: KNOWN_TEXTS.undo })).toBeNull()
    // 閉じるまで一覧に残る
    expect(rowOf(termId)).toBeTruthy()
  })

  it('ほかの話題へ替わった時も書く', async () => {
    await startStore()
    const router = renderHost()
    const third = MONTH.scenes.chain[2]
    const detail = await open(router, third)
    const termId = within(detail).getAllByTestId('term-known')[0].getAttribute('data-term-id')!
    fireEvent.click(within(detail).getAllByTestId('term-known')[0])
    fireEvent.click(await within(detail).findByRole('button', { name: /^前の話題:/ }))
    await waitFor(() => expect(screen.getByTestId('topic-detail').getAttribute('data-topic-id')).toBe(MONTH.scenes.chain[1]))
    expect(useApp.getState().user.knownTerms[termId]).toMatchObject({ on: true })
  })
})

describe('クリップは何も記録しない（docs/SPEC.md の 7.6）', () => {
  it('［クリップ］を押しても、ストアのアプリの記録も localStorage も変わらない', async () => {
    await startStore()
    const router = renderHost()
    await open(router, topicIdAt(5))
    await flushNow()
    const before = JSON.stringify(getRawUserRecords())
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      await act(async () => {
        fireEvent.click(screen.getByTestId('topic-clip'))
      })
      expect(writeText).toHaveBeenCalledTimes(1)
      await flushNow()
      expect(JSON.stringify(getRawUserRecords())).toBe(before)
      expect(setItem).not.toHaveBeenCalled()
    } finally {
      setItem.mockRestore()
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })
})
