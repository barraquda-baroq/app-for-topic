// S・M の切り替えの列（docs/SPEC.md の 9.。設計: 段階2の 1.3）: 「総合｜政治｜経済｜テック｜AI｜事件｜スポーツ｜エンタメ」の8つ（数は
// 付けない）・今の区切りは aria-current・話題が0本のジャンルは押せない見た目（aria-disabled）で、位置は残す
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GENRE_TAB_LABELS } from '../../domain/fixedTexts'
import { GENRE_VALUES } from '../../domain/types'
import { GenreSwitcher, type SwitcherTab } from './GenreSwitcher'

afterEach(cleanup)

const TABS: SwitcherTab[] = [
  { section: 'all', label: '総合', empty: false, controls: 'sec-all' },
  ...GENRE_VALUES.map((g) => ({ section: g, label: GENRE_TAB_LABELS[g], empty: g === 'ai', controls: `sec-${g}` })),
]

describe('切り替えの列', () => {
  it('8つの字を、総合からジャンルの順に（数は付けない）', () => {
    render(<GenreSwitcher tabs={TABS} current="all" onJump={() => {}} />)
    const tabs = screen.getAllByTestId('top-switcher-tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['総合', '政治', '経済', 'テック', 'AI', '事件', 'スポーツ', 'エンタメ'])
    expect(tabs.map((t) => t.getAttribute('data-section'))).toEqual(['all', ...GENRE_VALUES])
    expect(screen.getByTestId('top-switcher').tagName).toBe('NAV')
  })

  it('今の区切りだけ aria-current="true"（ほかは付けない）', () => {
    const { rerender } = render(<GenreSwitcher tabs={TABS} current="all" onJump={() => {}} />)
    const current = () => screen.getAllByTestId('top-switcher-tab').filter((t) => t.getAttribute('aria-current') === 'true')
    expect(current().map((t) => t.textContent)).toEqual(['総合'])
    rerender(<GenreSwitcher tabs={TABS} current="economy" onJump={() => {}} />)
    expect(current().map((t) => t.textContent)).toEqual(['経済'])
  })

  it('押すとその区切りを知らせる。aria-controls は移る先の区切り', () => {
    const onJump = vi.fn()
    render(<GenreSwitcher tabs={TABS} current="all" onJump={onJump} />)
    const economy = screen.getAllByTestId('top-switcher-tab')[2]
    expect(economy.getAttribute('aria-controls')).toBe('sec-economy')
    fireEvent.click(economy)
    expect(onJump).toHaveBeenCalledWith('economy')
  })

  it('話題が0本のジャンルは押せない見た目（aria-disabled）で、押しても移らず、位置は残す', () => {
    const onJump = vi.fn()
    render(<GenreSwitcher tabs={TABS} current="all" onJump={onJump} />)
    const tabs = screen.getAllByTestId('top-switcher-tab')
    const ai = tabs[4]
    expect(ai.textContent).toBe('AI')
    expect(ai.getAttribute('aria-disabled')).toBe('true')
    expect(ai.classList.contains('is-empty')).toBe(true)
    expect(ai.getAttribute('aria-controls')).toBeNull()
    fireEvent.click(ai)
    expect(onJump).not.toHaveBeenCalled()
    expect(tabs.filter((t) => t.getAttribute('aria-disabled') === 'true')).toHaveLength(1)
    expect(tabs).toHaveLength(8)
  })
})
