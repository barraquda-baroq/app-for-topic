// トップの画面（docs/SPEC.md の 14.5）: 段階0は、ヘッダー（アイコンと名前・設定の歯車）の下に「まだ版はありません」と届く時期の1行
import { cleanup, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { setTestWidth, TEST_WIDTHS } from '../../test/width'
import { AppFrame } from '../../ui/Layout'
import { EMPTY_NOTE, EMPTY_TITLE, TopPage } from './TopPage'

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

afterEach(cleanup)

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
