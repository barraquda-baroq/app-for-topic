// トップの L（国内｜世界の2列。src/features/top/TopWide.tsx）の空の列（段階3の設計の 3.4。作者に伺っている Q18 の今の決め方 A）:
// 世界の話題が0本の版は、世界の列の見出しの下に「この版には世界の話題がありません」の1行を出す（国内が0本なら国内の列に）。
// 全部を既読にした列（話題はあるが「既読 n件」に畳んだ）には出さない。S・M（総合とジャンルの区切り）には出さない。
// 話題は作り物の版（src/test/fixtures/fakeEditions.ts）を表示用の写しにした物
import { act, cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { repairEdition, repairTopic, type ShownEdition, type ShownReadMark, type ShownTopic } from '../../domain/repair'
import { resetStoreForTests, useApp } from '../../store/appStore'
import { resetTopUiForTests } from '../../store/uiStore'
import { makeFakeEdition, type FakeEdition } from '../../test/fixtures/fakeEditions'
import { FAKE_OUTLETS } from '../../test/fixtures/fakeOutlets'
import { setTestWidth, TEST_WIDTHS } from '../../test/width'
import { AppFrame } from '../../ui/Layout'
import { resetSheetsForTests } from '../topic/sheets'
import { TopPage } from './TopPage'
import { SECTION_EMPTY_TEST_ID, type ReadyView } from './TopSection'
import { SECTION_TEXTS } from './texts'

// ストアの markSeen（見たにする）と threadsOf（続報のつながり）だけを差し替える（src/features/top/TopPage.test.tsx と同じ）
vi.mock('../../store/appStore', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../store/appStore')>()
  return {
    ...m,
    markSeen: vi.fn(() => ({ ok: true, changed: false })),
    threadsOf: vi.fn(async (ids: Iterable<string>) => Object.fromEntries([...new Set(ids)].map((id) => [id, []]))),
  }
})

/** 2026-11-15（日）14:10 日本時間（いちばん新しい枠は 12:00） */
const T_1410 = Date.parse('2026-11-15T14:10:00+09:00')
const FE = makeFakeEdition({ date: '2026-11-15', slot: '12', seed: 'top-wide' })

function ok<T>(r: { kind: string; value?: T }): T {
  if (r.kind !== 'ok') throw new Error('作り物の記録を写しにできません')
  return r.value as T
}

/** その地域の話題だけを残した版（region が null なら全部） */
function viewOf(fe: FakeEdition, keep: 'jp' | 'world' | null): ReadyView {
  const edition = ok<ShownEdition>(repairEdition(fe.edition))
  const topics = fe.topics
    .map((t) => ok<ShownTopic>(repairTopic(t, { outlets: FAKE_OUTLETS })))
    .filter((t) => keep === null || t.region === keep)
  const ids = new Set(topics.map((t) => t.id))
  return {
    kind: 'ready',
    editionId: edition.id,
    edition: { ...edition, order: edition.order.filter((id) => ids.has(id)) },
    topics,
    newerTopics: [],
    missing: [],
    corrections: {},
  }
}

function readMark(editionId: string, topicIds: string[]): ShownReadMark {
  return {
    id: editionId,
    v: 1,
    createdAt: 1,
    updatedAt: 1,
    by: 'user',
    ai: null,
    editionId,
    topicIds,
    seen: true,
  } as ShownReadMark
}

function showTop(view: ReadyView, reads: Record<string, ShownReadMark> = {}) {
  act(() =>
    useApp.setState({
      status: 'ready',
      user: { knownTerms: {}, reads },
      editions: [view.edition],
      newerEditions: [],
      editionFails: [],
      opened: { follow: true, view, waiting: null },
    }),
  )
  const page = (
    <AppFrame>
      <TopPage />
    </AppFrame>
  )
  const router = createMemoryRouter([{ path: '/', element: page }], { initialEntries: ['/'] })
  render(<RouterProvider router={router} />)
}

const columnOf = (key: 'jp' | 'world') =>
  screen.getByTestId('top-edition').querySelector<HTMLElement>(`[data-testid="top-section"][data-section="${key}"]`)!
const emptyOf = (key: 'jp' | 'world') => columnOf(key).querySelector(`[data-testid="${SECTION_EMPTY_TEST_ID}"]`)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T_1410)
  setTestWidth(TEST_WIDTHS.L)
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView']
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  resetTopUiForTests()
  resetSheetsForTests()
  vi.useRealTimers()
})

describe('L の空の列の1行（Q18 の A）', () => {
  it('世界の話題が0本の版: 世界の列の見出しの下に1行（「既読 n件」は出さない）。国内の列には出さない', () => {
    const view = viewOf(FE, 'jp')
    expect(view.topics.length).toBeGreaterThan(0)
    showTop(view)
    expect(screen.getByTestId('top-edition').getAttribute('data-layout')).toBe('wide')
    expect(emptyOf('world')?.textContent).toBe('この版には世界の話題がありません')
    expect(emptyOf('world')?.textContent).toBe(SECTION_TEXTS.columnEmpty.world)
    expect(columnOf('world').querySelector('[data-testid="top-card"]')).toBeNull()
    expect(columnOf('world').querySelector('[data-testid="top-read-fold"]')).toBeNull()
    // 見出しの後ろに1行
    const head = columnOf('world').querySelector('h2')!
    expect(head.nextElementSibling?.getAttribute('data-testid')).toBe(SECTION_EMPTY_TEST_ID)
    expect(emptyOf('jp')).toBeNull()
    expect(columnOf('jp').querySelectorAll('[data-testid="top-card"]').length).toBe(view.topics.length)
  })

  it('国内の話題が0本の版: 国内の列に1行', () => {
    showTop(viewOf(FE, 'world'))
    expect(emptyOf('jp')?.textContent).toBe('この版には国内の話題がありません')
    expect(emptyOf('world')).toBeNull()
  })

  it('両方に話題がある版・全部を既読にした列（「既読 n件」に畳んだ）には出さない', () => {
    const all = viewOf(FE, null)
    showTop(all)
    expect(emptyOf('jp')).toBeNull()
    expect(emptyOf('world')).toBeNull()
    cleanup()
    const worldIds = all.topics.filter((t) => t.region === 'world').map((t) => t.id)
    showTop(all, { [all.editionId]: readMark(all.editionId, worldIds) })
    expect(columnOf('world').querySelector(':scope > .top-cards')).toBeNull()
    expect(columnOf('world').querySelector('[data-testid="top-read-fold"]')).toBeTruthy()
    expect(emptyOf('world')).toBeNull()
  })

  it('S・M（総合とジャンルの区切り）には出さない（話題の無い区切りは出ない）', () => {
    setTestWidth(TEST_WIDTHS.S)
    showTop(viewOf(FE, 'jp'))
    expect(screen.getByTestId('top-edition').getAttribute('data-layout')).not.toBe('wide')
    expect(screen.queryByTestId(SECTION_EMPTY_TEST_ID)).toBeNull()
  })
})
