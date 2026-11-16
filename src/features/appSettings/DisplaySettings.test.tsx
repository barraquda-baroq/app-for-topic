// 設定の「表示」（docs/SPEC.md の 14.3・14.5。DS の物から）: 外観4つの切り替えと起動アニメーションのオン・オフを、この端末に保存する。
// 選んだ外観が <html data-theme> とブラウザの枠の色に入ること（PrefsEffect）も合わせて確かめる。
// 段階2で、記事の字の大きさ［小｜中｜大］（既定は中・保存の版 v は上げない・<html data-text-size> に入る）を足した
// （docs/SPEC.md の 9.・7.5。設計: 段階2の 1.18・4.1）
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, PREFS_KEY, THEME_COLORS, usePrefs } from '../../store/uiStore'
import { PrefsEffect } from '../../ui/Layout'
import { APPEARANCE_OPTIONS, DisplaySettings, TEXT_SIZE_OPTIONS } from './DisplaySettings'

const saved = () => JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Record<string, unknown> | null

beforeEach(() => {
  localStorage.clear()
  usePrefs.setState(DEFAULT_PREFS)
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-text-size')
  document.querySelector('meta[name="theme-color"]')?.remove()
})

afterEach(cleanup)

describe('DisplaySettings', () => {
  it('「表示」の区切りに、外観の4つを仕様書の順に出す（初めは「端末の設定に合わせる」）', () => {
    render(<DisplaySettings />)
    expect(screen.getByRole('region', { name: '表示' })).toBeTruthy()
    const group = screen.getByRole('group', { name: '外観' })
    const buttons = Array.from(group.querySelectorAll('button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['端末の設定に合わせる', 'ホワイト', 'ダーク', 'ディープダーク'])
    expect(APPEARANCE_OPTIONS.map((o) => o.value)).toEqual(['system', 'white', 'dark', 'deep-dark'])
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false'])
  })

  it('外観を押すと選んだ状態になり、この端末（topic-studio:prefs の appearance）に保存する', async () => {
    const user = userEvent.setup()
    render(<DisplaySettings />)
    for (const { value } of APPEARANCE_OPTIONS.slice().reverse()) {
      await user.click(screen.getByTestId(`appearance-${value}`))
      expect(usePrefs.getState().appearance).toBe(value)
      expect(saved()).toMatchObject({ v: 1, appearance: value })
      expect(screen.getByTestId(`appearance-${value}`).getAttribute('aria-pressed')).toBe('true')
      const pressed = within(screen.getByRole('group', { name: '外観' })).getAllByRole('button', { pressed: true })
      expect(pressed).toHaveLength(1)
    }
  })

  it('起動アニメーションは初めオン。切り替えるとオフになり、保存する', async () => {
    const user = userEvent.setup()
    render(<DisplaySettings />)
    const sw = screen.getByRole('switch', { name: '起動アニメーション' }) as HTMLInputElement
    expect(sw.checked).toBe(true)
    expect(screen.getByTestId('launch-switch').textContent).toContain('オン')
    await user.click(sw)
    expect(sw.checked).toBe(false)
    expect(usePrefs.getState().launchAnimation).toBe(false)
    expect(saved()).toMatchObject({ launchAnimation: false })
    expect(screen.getByTestId('launch-switch').textContent).toContain('オフ')
    await user.click(sw)
    expect(usePrefs.getState().launchAnimation).toBe(true)
    expect(saved()).toMatchObject({ launchAnimation: true })
  })

  it('ほかの所で設定が変わったら、その場で表示も替わる', () => {
    render(<DisplaySettings />)
    act(() => usePrefs.getState().setPrefs({ appearance: 'deep-dark', launchAnimation: false, textSize: 's' }))
    expect(screen.getByTestId('appearance-deep-dark').getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByRole('switch', { name: '起動アニメーション' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.getByTestId('text-size-s').getAttribute('aria-pressed')).toBe('true')
  })

  it('文字の大きさは［小｜中｜大］の3つを、外観・起動アニメーションの後に出す（初めは中）', () => {
    render(<DisplaySettings />)
    const group = screen.getByRole('group', { name: '文字の大きさ' })
    expect(group).toBe(screen.getByTestId('text-size'))
    expect(group.className).toBe('segmented aset-seg')
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['小', '中', '大'])
    expect(TEXT_SIZE_OPTIONS.map((o) => o.value)).toEqual(['s', 'm', 'l'])
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
    // 並び: 外観 → 起動アニメーション → 文字の大きさ（段階0の2つの後に足した。設計: 段階2の 1.23）
    const rows = [...screen.getByTestId('display-settings').querySelectorAll('.aset-row .aset-row-label > span:first-child')]
    expect(rows.map((r) => r.textContent)).toEqual(['外観', '起動アニメーション', '文字の大きさ'])
  })

  it('文字の大きさを押すと選んだ状態になり、この端末（topic-studio:prefs の textSize）に保存する。保存の版 v は 1 のまま', async () => {
    const user = userEvent.setup()
    render(<DisplaySettings />)
    for (const { value } of [...TEXT_SIZE_OPTIONS].reverse()) {
      await user.click(screen.getByTestId(`text-size-${value}`))
      expect(usePrefs.getState().textSize).toBe(value)
      expect(saved()).toMatchObject({ v: 1, textSize: value })
      const pressed = within(screen.getByTestId('text-size')).getAllByRole('button', { pressed: true })
      expect(pressed).toEqual([screen.getByTestId(`text-size-${value}`)])
    }
    // 外観は変えない
    expect(usePrefs.getState().appearance).toBe(DEFAULT_PREFS.appearance)
  })

  it('選んだ文字の大きさが <html data-text-size> に入る（PrefsEffect）', async () => {
    const user = userEvent.setup()
    render(
      <>
        <PrefsEffect />
        <DisplaySettings />
      </>,
    )
    const root = document.documentElement
    expect(root.getAttribute('data-text-size')).toBe('m')
    for (const value of ['l', 's', 'm'] as const) {
      await user.click(screen.getByTestId(`text-size-${value}`))
      expect(root.getAttribute('data-text-size')).toBe(value)
    }
  })

  it('選んだ外観が <html data-theme> とブラウザの枠の色に入る（端末の設定に合わせるは、ダークでない端末ならホワイト）', async () => {
    const user = userEvent.setup()
    render(
      <>
        <PrefsEffect />
        <DisplaySettings />
      </>,
    )
    const root = document.documentElement
    const meta = () => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content
    expect(root.getAttribute('data-theme')).toBe('white')
    expect(meta()).toBe(THEME_COLORS.white)
    for (const value of ['dark', 'deep-dark', 'white'] as const) {
      await user.click(screen.getByTestId(`appearance-${value}`))
      expect(root.getAttribute('data-theme')).toBe(value)
      expect(meta()).toBe(THEME_COLORS[value])
    }
    await user.click(screen.getByTestId('appearance-system'))
    expect(root.getAttribute('data-theme')).toBe('white')
  })
})
