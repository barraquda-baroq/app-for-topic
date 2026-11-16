// ヘッダーの版の表示（src/ui/EditionLabel.tsx。docs/SPEC.md の 9.。設計: 段階2の 1.2）: 出している版（opened.view が ready）の名前を
// 「11/15（日）12:00版」で出し、読み上げは「11月15日（日）12:00版（版の一覧へ）」、押すと版の一覧（#/editions）へ。前の版を開いている時は
// その版の名前。出せる版が無い時（まだ版が無い・待っている・新しい形の記録・30日の外・壊れた版）は出さない。ヘッダーでは名前の右、
// 空きの左に置き、S（600px 未満）では名前を隠して（src/ui/layout.css）これを出す
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import type { ShownEdition } from '../domain/repair'
import { useApp, type EditionView } from '../store/appStore'
import { setTestWidth, TEST_WIDTHS } from '../test/width'
import { EditionLabel, spokenEditionName } from './EditionLabel'
import { AppHeader } from './Layout'

// CSS は import するとテストでは中身が空になるので、ファイルを読む（src/styles.test.ts と同じ読み方）
const NODE_FS = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ NODE_FS)) as {
  readFileSync: (path: string, encoding: 'utf8') => string
}
/** このファイルからの場所（new URL を直接書くと Vite が開発サーバーの URL に書き換えるので、関数に包む） */
const fileAt = (relative: string) => decodeURIComponent(new URL(relative, import.meta.url).pathname)
const layoutCss = readFileSync(fileAt('./layout.css'), 'utf8')

/** 表示用の写しの版（名前に使うのは date・slot だけ） */
function edition(id: string): ShownEdition {
  return {
    id,
    v: 1,
    createdAt: 0,
    by: 'connector',
    ai: 'claude',
    model: '',
    runId: '',
    date: id.slice(0, 10),
    slot: id.slice(11),
    order: [],
    candidateCount: null,
    notChosen: [],
    window: null,
    usage: null,
  }
}

const ready = (id: string): EditionView => ({
  kind: 'ready',
  editionId: id,
  edition: edition(id),
  topics: [],
  newerTopics: [],
  missing: [],
  corrections: {},
})

function open(view: EditionView | null, follow = true) {
  useApp.setState({ opened: { follow, view, waiting: null } })
}

function renderAt(width: number, element = <EditionLabel />) {
  setTestWidth(width)
  const router = createMemoryRouter(
    [
      { path: '/', element },
      { path: '/editions', element: <p data-testid="editions-here">版の一覧</p> },
    ],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
  return router
}

afterEach(() => {
  cleanup()
  open(null)
})

describe('ヘッダーの版の表示', () => {
  it('出している版の名前「11/15（日）12:00版」。読み上げは「11月15日（日）12:00版（版の一覧へ）」で、押すと版の一覧へ', async () => {
    open(ready('2026-11-15-12'))
    const router = renderAt(TEST_WIDTHS.L)
    const label = screen.getByTestId('edition-label')
    expect(label.textContent).toBe('11/15（日）12:00版')
    expect(label.getAttribute('aria-label')).toBe('11月15日（日）12:00版（版の一覧へ）')
    expect(label.getAttribute('href')).toBe('/editions')
    expect(label.getAttribute('data-edition-id')).toBe('2026-11-15-12')
    expect(label.className).toBe('edition-label')
    // 下向きの山形は飾り（読み上げの名前が同じ事を言う）
    expect(label.querySelector('svg.icon.icon-sm')?.getAttribute('aria-hidden')).toBe('true')
    await userEvent.setup().click(label)
    expect(router.state.location.pathname).toBe('/editions')
    expect(screen.getByTestId('editions-here')).toBeTruthy()
  })

  it('前の版（openEdition で選んだ版）を開いている時はその版の名前。開いている版が替わると、その場で替わる', () => {
    open(ready('2026-11-13-20'), false)
    renderAt(TEST_WIDTHS.S)
    expect(screen.getByTestId('edition-label').textContent).toBe('11/13（金）20:00版')
    expect(screen.getByTestId('edition-label').getAttribute('aria-label')).toBe('11月13日（金）20:00版（版の一覧へ）')
    act(() => open(ready('2026-11-15-12')))
    expect(screen.getByTestId('edition-label').textContent).toBe('11/15（日）12:00版')
    act(() => open(null))
    expect(screen.queryByTestId('edition-label')).toBeNull()
  })

  it.each<[string, EditionView | null]>([
    ['まだ版が無い・付いていく版を探している', null],
    ['端末に無い', { kind: 'none', editionId: '2026-11-15-12' }],
    ['新しい形の記録', { kind: 'newer', editionId: '2026-11-15-12' }],
    ['壊れた版', { kind: 'broken', editionId: '2026-11-15-12' }],
    ['30日の外', { kind: 'expired', editionId: '2026-10-01-12', edition: edition('2026-10-01-12') }],
    [
      '話題がそろうのを待っている',
      { kind: 'waiting', editionId: '2026-11-15-12', edition: edition('2026-11-15-12'), missing: ['x'] },
    ],
  ])('出せる版が無い時（%s）は出さない', (_label, view) => {
    open(view)
    renderAt(TEST_WIDTHS.L)
    expect(screen.queryByTestId('edition-label')).toBeNull()
  })

  it('版の日付か枠が読めない時は出さない', () => {
    open({ ...ready('2026-11-15-12'), edition: { ...edition('2026-11-15-12'), slot: '09' } } as EditionView)
    renderAt(TEST_WIDTHS.L)
    expect(screen.queryByTestId('edition-label')).toBeNull()
  })

  it('読み上げの名前: 月・年の境の曜日も正しく、0で埋めない。日付か枠が読めなければ null', () => {
    expect(spokenEditionName('2027-01-01', '12')).toBe('1月1日（金）12:00版')
    expect(spokenEditionName('2026-12-31', '20')).toBe('12月31日（木）20:00版')
    expect(spokenEditionName('2026-11-15', '09')).toBeNull()
    expect(spokenEditionName('2026-02-30', '12')).toBeNull()
    expect(spokenEditionName(null, '12')).toBeNull()
  })
})

describe('ヘッダーの中の置き場所', () => {
  it('アイコンと名前の右、空きの左に置く（押せる物はアイコン・版の表示・歯車の3つ）', () => {
    open(ready('2026-11-15-12'))
    renderAt(TEST_WIDTHS.L, <AppHeader />)
    const header = screen.getByTestId('app-header')
    const label = within(header).getByTestId('edition-label')
    expect(label.previousElementSibling).toBe(within(header).getByTestId('brand'))
    expect(label.nextElementSibling?.className).toBe('spacer')
    expect(
      within(header)
        .getAllByRole('link')
        .map((a) => a.getAttribute('data-testid')),
    ).toEqual(['brand', 'edition-label', 'open-settings'])
  })

  it('S（600px 未満）では名前を隠す（幅の区分の 599px。docs/SPEC.md の 9.・14.5 の 380px 未満を変えた）。版の表示は隠さない', () => {
    const css = layoutCss.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/@media \(max-width: 599px\) \{\s*\.app-header \.brand-name \{\s*display: none;\s*\}\s*\}/)
    expect(css).not.toMatch(/379px/)
    expect(css).not.toMatch(/\.edition-label[^{]*\{[^}]*display: none/)
  })
})
