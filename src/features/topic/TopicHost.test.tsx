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
import { editionIdOfRecordId } from '../../domain/ids'
import { markDraftClean, markDraftDirty } from '../../store/draftRegistry'
import { installLeaveHandlers } from '../../store/lifecycle'
import { useToasts } from '../../store/uiStore'
import { DETAIL_TEXTS, KNOWN_TEXTS } from './detailTexts'
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

  // 端末の保存先が誤りを返す時（iPhone で裏から戻った直後の IndexedDB の接続切れなど）も、読めない時と同じく閉じる（設計: 段階2の 1.9）。
  // 拒否を受けないと「読み込み中…」のまま止まる
  it('端末から話題を読めない（保存先が誤りを返す）時は、「読み込み中…」のまま止めずに閉じる', async () => {
    const p = await startStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.spyOn(p, 'getTopics').mockRejectedValue(new Error('端末の保存先を読めません（作り物の誤り）'))
      const router = renderHost()
      // ほかの版の話題（開いた版に無いので、端末から読む）
      await act(async () => {
        openTopicSheet(router, MONTH.scenes.chain[0], null)
      })
      await waitFor(() => expect(sheetOf(router.state.location.state)).toBeNull())
      expect(document.querySelector('.modal.topic-sheet')).toBeNull()
      expect(screen.queryByText(DETAIL_TEXTS.loading)).toBeNull()
      expect(warn).toHaveBeenCalledWith('話題を端末から読めませんでした', expect.any(Error))
    } finally {
      warn.mockRestore()
    }
  })

  it('続報のつながりを端末から読めない時は、本文を出したまま、つながりのリンクを出さない', async () => {
    const p = await startStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.spyOn(p, 'topicsOfThread').mockRejectedValue(new Error('端末の保存先を読めません（作り物の誤り）'))
      const router = renderHost()
      const detail = await open(router, MONTH.scenes.chain[2])
      await waitFor(() => expect(warn).toHaveBeenCalledWith('続報のつながりを端末から読めませんでした', expect.any(Error)))
      expect(screen.getByTestId('topic-detail')).toBe(detail)
      expect(within(detail).queryByRole('button', { name: /^前の話題:/ })).toBeNull()
    } finally {
      warn.mockRestore()
    }
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

  // 説明の箱が開いている時の Esc は、フォーカスが中身の外（シートの下の帯・パネルの頭の行の［クリップ］、本文の字を押した後の body）に
  // あっても、箱だけを閉じて語のボタンへ戻す。次の Esc で詳細を閉じる（設計: 段階2の 1.12 の「Esc で閉じる」・2. の「先に箱だけを閉じて止める」）
  it.each([
    ['S のシート', 'S', null, 'clip'],
    ['S のシート', 'S', null, 'body'],
    ['L のパネル', 'L', 'world', 'clip'],
    ['L のパネル', 'L', 'world', 'body'],
  ] as const)(
    '%s（幅 %s・差し込み口 %s）: 説明の箱が開いている時は、フォーカスが中身の外（%s）でも Esc で箱だけを閉じ、次の Esc で詳細を閉じる',
    async (_name, width, side, where) => {
      setTestWidth(TEST_WIDTHS[width])
      await startStore()
      const router = renderHost(['/'], { column: side !== null })
      const detail = await open(router, topicIdAt(FAKE_TOPIC_SCENES.jpRulingParty), side)
      expect(detail.getAttribute('data-mode')).toBe(side ? 'panel' : 'sheet')
      const mark = within(detail).getAllByTestId('term-mark')[0]
      fireEvent.click(mark)
      expect(within(detail).getByTestId('term-note')).toBeTruthy()
      if (where === 'clip') screen.getByTestId('topic-clip').focus()
      else (document.activeElement as HTMLElement | null)?.blur()
      expect(detail.contains(document.activeElement)).toBe(false)
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      expect(within(detail).queryByTestId('term-note')).toBeNull()
      expect(screen.getByTestId('topic-detail')).toBe(detail)
      expect(document.activeElement).toBe(mark)
      expect(sheetOf(router.state.location.state)).not.toBeNull()
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByTestId('topic-detail')).toBeNull())
    },
  )

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

  // iPhone の Safari はページを離れる時に visibilitychange を送らず pagehide だけの事がある（設計: 段階2の 1.13・8. の 17）。
  // 押した分を失わないよう、pagehide でも書き、端末にも保存する。アプリの保存（src/store/lifecycle.ts の saveBeforeLeave。起動の時に
  // 付ける）より先に書く（capture）ので、saveBeforeLeave が下書きを反映して保存・送信を始める時には、もうストアに入っている
  it('pagehide でも書いて端末に保存し、その後は「知ってるにしました」だけ。アプリの保存（saveBeforeLeave）より先に書く', async () => {
    installLeaveHandlers()
    await startStore()
    const router = renderHost()
    const detail = await open(router, topicId)
    const termId = within(detail).getAllByTestId('term-mark')[0].getAttribute('data-term-id')!
    fireEvent.click(within(rowOf(termId)).getByTestId('term-known'))
    // saveBeforeLeave がいちばん初めに呼ぶ下書きの反映の時に、ストアの記録を見る
    const atLeave: (boolean | null)[] = []
    const key = Symbol('pagehide-test')
    markDraftDirty(key, () => atLeave.push(useApp.getState().user.knownTerms[termId]?.on ?? null))
    try {
      act(() => {
        window.dispatchEvent(new Event('pagehide'))
      })
    } finally {
      markDraftClean(key)
    }
    expect(atLeave).toEqual([true])
    expect(useApp.getState().user.knownTerms[termId]).toMatchObject({ on: true })
    await flushNow()
    expect(getRawUserRecords().knownTerms[termId]).toMatchObject({ on: true })
    expect(rowOf(termId).textContent).toContain(KNOWN_TEXTS.pressed)
    expect(within(rowOf(termId)).queryByRole('button', { name: KNOWN_TEXTS.undo })).toBeNull()
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

  // 閉じずにほかの話題へ替えると、React は先に次の話題を描き、その後で前の話題の部品の後片付け（ここで書く）を動かす。次の話題が
  // 描く時に決める「開いた時に知ってるだった語」に、前の話題で押してまだ書いていない語も数える（設計: 段階2の 1.13 の「次に開いた時から
  // 出さない（本文の印も付けない）」・docs/SPEC.md の 5.8）
  type FakeTopicOf = (typeof NEWEST.topics)[number]
  /** a で押すと b でも「知ってる」になる語（b の説明の時点が a の時点以前）を持つ組（無ければ投げる） */
  function sharedTermOf(pairs: [FakeTopicOf, FakeTopicOf][]): { a: string; b: string; termId: string } {
    for (const [a, b] of pairs)
      for (const t of a.terms) {
        const bt = b.terms.find((x) => x.termId === t.termId)
        if (bt && (bt.asOf == null || (t.asOf != null && bt.asOf <= t.asOf))) return { a: a.id, b: b.id, termId: t.termId }
      }
    throw new Error('同じ語を持つ話題の組がありません')
  }
  const termMarkOf = (termId: string) =>
    screen.getByTestId('topic-detail').querySelector(`[data-testid="term-mark"][data-term-id="${termId}"]`)

  it('L でパネルを閉じずに同じ版の別の話題を開くと、前の話題で押した語は一覧にも本文の印にも出ない（［取り消す］した語は出る）', async () => {
    setTestWidth(TEST_WIDTHS.L)
    await startStore()
    const jp = NEWEST.topics.filter((t) => t.region === 'jp')
    const { a, b, termId } = sharedTermOf(
      jp.flatMap((x) => jp.filter((y) => y !== x).map((y): [FakeTopicOf, FakeTopicOf] => [x, y])),
    )
    const router = renderHost(['/'], { column: true })
    // 押す前の B には、その語が一覧に出る
    expect((await open(router, b, 'world')).getAttribute('data-mode')).toBe('panel')
    expect(rowOf(termId)).toBeTruthy()
    // A で押して［取り消す］してから B へ替えると、書かないので B にはまだ出る
    await open(router, a, 'world')
    await waitFor(() => expect(screen.getByTestId('topic-detail').getAttribute('data-topic-id')).toBe(a))
    fireEvent.click(within(rowOf(termId)).getByTestId('term-known'))
    fireEvent.click(within(rowOf(termId)).getByRole('button', { name: KNOWN_TEXTS.undo }))
    await open(router, b, 'world')
    await waitFor(() => expect(screen.getByTestId('topic-detail').getAttribute('data-topic-id')).toBe(b))
    expect(useApp.getState().user.knownTerms[termId]).toBeUndefined()
    expect(rowOf(termId)).toBeTruthy()
    // A で押したまま B へ替えると、A の分を書き、B の一覧にも本文の印にも出さない
    await open(router, a, 'world')
    await waitFor(() => expect(screen.getByTestId('topic-detail').getAttribute('data-topic-id')).toBe(a))
    fireEvent.click(within(rowOf(termId)).getByTestId('term-known'))
    await open(router, b, 'world')
    await waitFor(() => expect(screen.getByTestId('topic-detail').getAttribute('data-topic-id')).toBe(b))
    expect(router.state.historyAction).toBe('REPLACE')
    expect(useApp.getState().user.knownTerms[termId]).toMatchObject({ on: true })
    expect(rowOf(termId)).toBeNull()
    expect(termMarkOf(termId)).toBeNull()
  })

  it('前の版を開いたまま、続報で押してから「前の話題」へ替えると、前の話題にその語を出さない', async () => {
    await startStore()
    const all = MONTH.editions.flatMap((e) => e.topics)
    const chain = MONTH.scenes.chain.map((id) => all.find((t) => t.id === id)!)
    const { a, b, termId } = sharedTermOf(chain.slice(1).map((t, i): [FakeTopicOf, FakeTopicOf] => [t, chain[i]]))
    // 前の話題 B の版（前の版 #/e/{B の版}）を開いている。B は開いた版にあるので、替えた時にすぐ描く
    await act(async () => {
      await openEdition(editionIdOfRecordId(b))
    })
    expect(useApp.getState().opened.view?.kind).toBe('ready')
    const router = renderHost()
    await open(router, a)
    await waitFor(() => expect(screen.getByTestId('topic-detail').getAttribute('data-topic-id')).toBe(a))
    await waitFor(() => expect(rowOf(termId)).toBeTruthy())
    fireEvent.click(within(rowOf(termId)).getByTestId('term-known'))
    fireEvent.click(await within(screen.getByTestId('topic-detail')).findByRole('button', { name: /^前の話題:/ }))
    await waitFor(() => expect(screen.getByTestId('topic-detail').getAttribute('data-topic-id')).toBe(b))
    expect(useApp.getState().user.knownTerms[termId]).toMatchObject({ on: true })
    expect(rowOf(termId)).toBeNull()
    expect(termMarkOf(termId)).toBeNull()
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
