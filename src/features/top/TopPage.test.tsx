// トップの画面（docs/SPEC.md の 14.5・16.2 の 8）: 段階0は、ヘッダー（アイコンと名前・設定の歯車）の下に「まだ版はありません」と届く時期の
// 1行。段階1の仮の一覧は、出せる版の見出しだけを順位の順に並べ、既読は見出しの行の data-read にだけ置く
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { repairEdition, repairTopic, type ShownEdition, type ShownReadMark, type ShownTopic } from '../../domain/repair'
import { resetStoreForTests, useApp } from '../../store/appStore'
import { makeFakeEdition } from '../../test/fixtures/fakeEditions'
import { FAKE_OUTLETS } from '../../test/fixtures/fakeOutlets'
import { setTestWidth, TEST_WIDTHS } from '../../test/width'
import { AppFrame } from '../../ui/Layout'
import { EMPTY_NOTE, EMPTY_TITLE, TopPage, WAITING_TEXT } from './TopPage'

function renderTop() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <AppFrame>
            <TopPage />
          </AppFrame>
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
  resetStoreForTests()
})

const FAKE = makeFakeEdition({ date: '2026-11-15', slot: '12', seed: 'top-page' })

function shown<T>(r: { kind: string; value?: T }): T {
  if (r.kind !== 'ok') throw new Error('作り物の記録を写しにできません')
  return r.value as T
}

/** 開いている版（トップはいちばん新しい出せる版）を、作り物の版にする */
function openFake(reads: Record<string, ShownReadMark> = {}) {
  const edition = shown<ShownEdition>(repairEdition(FAKE.edition))
  const topics = FAKE.topics.flatMap((t) => {
    const r = repairTopic(t, { outlets: FAKE_OUTLETS })
    return r.kind === 'ok' ? [r.value as ShownTopic] : []
  })
  act(() =>
    useApp.setState({
      status: 'ready',
      user: { knownTerms: {}, reads },
      editions: [edition],
      opened: {
        follow: true,
        view: { kind: 'ready', editionId: edition.id, edition, topics, newerTopics: [], missing: [], corrections: {} },
        waiting: null,
      },
    }),
  )
  return topics
}

describe('トップの画面（段階0）', () => {
  it.each(Object.entries(TEST_WIDTHS))('%s: 「まだ版はありません」と、12:00版と20:00版が届く時期', (_w, width) => {
    setTestWidth(width)
    renderTop()
    const top = screen.getByTestId('top-page')
    expect(within(top).getByTestId('top-empty').textContent).toBe(EMPTY_TITLE + EMPTY_NOTE)
    expect(EMPTY_TITLE).toBe('まだ版はありません')
    expect(EMPTY_NOTE).toBe('12:00版と20:00版は、段階3から届くようになります。')
    expect(document.title).toBe('Topic Studio')
  })

  it('ヘッダーは左にアイコンと「Topic Studio」（トップへ）、右に設定の歯車だけ（同期の表示・版の表示は後の段階）', () => {
    renderTop()
    const header = screen.getByTestId('app-header')
    const brand = within(header).getByTestId('brand')
    expect(brand.getAttribute('aria-label')).toBe('Topic Studio（トップへ）')
    expect(brand.getAttribute('href')).toBe('/')
    expect(brand.querySelector('img')?.getAttribute('src')).toBe('./icon.svg')
    expect(brand.textContent).toBe('Topic Studio')
    const settings = within(header).getByTestId('open-settings')
    expect(settings.getAttribute('aria-label')).toBe('設定')
    expect(settings.getAttribute('href')).toBe('/settings')
    expect(within(header).getAllByRole('link')).toHaveLength(2)
    expect(within(header).queryAllByRole('button')).toHaveLength(0)
  })
})

describe('トップの仮の一覧（段階1。docs/SPEC.md の 16.2 の 8）', () => {
  it.each(Object.entries(TEST_WIDTHS))(
    '%s: 出せる版の見出しだけを、順位の順に並べる（版がまだ無い時の言葉は出さない）',
    (_w, width) => {
      setTestWidth(width)
      renderTop()
      const topics = openFake()
      expect(topics).toHaveLength(20)
      const list = screen.getByTestId('top-headlines')
      expect(list.tagName).toBe('OL')
      expect(list.getAttribute('data-edition-id')).toBe('2026-11-15-12')
      const rows = within(list).getAllByTestId('top-headline')
      expect(rows.map((r) => r.textContent)).toEqual(FAKE.topics.map((t) => t.headline))
      expect(rows.map((r) => r.getAttribute('data-topic-id'))).toEqual(FAKE.edition.order)
      // 見出しだけ（リンク・ボタン・ほかの欄の文は出さない。見た目は段階2）
      expect(within(list).queryAllByRole('link')).toHaveLength(0)
      expect(within(list).queryAllByRole('button')).toHaveLength(0)
      expect(list.textContent).not.toContain(FAKE.topics[0].summary)
      expect(screen.queryByTestId('top-empty')).toBeNull()
      expect(screen.queryByTestId('top-waiting')).toBeNull()
    },
  )

  it('既読の話題は、見出しの行の data-read に置く（見た目は変えない）。別の端末の既読が届くと付く', () => {
    renderTop()
    openFake()
    const row = (id: string) => screen.getByTestId('top-headlines').querySelector(`[data-topic-id="${id}"]`)!
    expect(row(FAKE.topics[2].id).getAttribute('data-read')).toBeNull()
    const read: ShownReadMark = {
      id: '2026-11-15-12',
      v: 1,
      createdAt: 1,
      updatedAt: 1,
      by: 'user',
      ai: null,
      editionId: '2026-11-15-12',
      topicIds: [FAKE.topics[2].id],
      seen: false,
    } as ShownReadMark
    act(() => useApp.setState({ user: { knownTerms: {}, reads: { '2026-11-15-12': read } } }))
    expect(row(FAKE.topics[2].id).getAttribute('data-read')).toBe('true')
    expect(row(FAKE.topics[3].id).getAttribute('data-read')).toBeNull()
    expect(row(FAKE.topics[2].id).className).toBe(row(FAKE.topics[3].id).className)
  })

  it('出せる版がまだ無く、届いた版の話題がそろうのを待っている時は「版を受け取っています…」だけ', () => {
    renderTop()
    act(() => useApp.setState({ status: 'ready', opened: { follow: true, view: null, waiting: '2026-11-15-12' } }))
    expect(screen.getByTestId('top-waiting').textContent).toBe(WAITING_TEXT)
    expect(WAITING_TEXT).toBe('版を受け取っています…')
    expect(screen.queryByTestId('top-empty')).toBeNull()
    expect(screen.queryByTestId('top-headlines')).toBeNull()
  })
})
