// 今日（DS の src/ui/hooks.test.tsx から）: PWA を開いたまま 0時を過ぎたら、次の 0時のタイマーで今日を計算し直す。
// 裏にあってタイマーが遅れた時も、画面が見えるようになった時・フォーカスが戻った時に計算し直す。
// 段階2で足した今の時刻（useNow）: 決めた間の変わり目で描き直し、見えるようになった時にも計算し直す
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coverDateLabel } from '../domain/dates'
import { useNow, useToday } from './hooks'

let renders = 0

function Today() {
  renders++
  return <p data-testid="today">{coverDateLabel(useToday())}</p>
}

beforeEach(() => {
  renders = 0
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 10, 23, 59, 30))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useToday', () => {
  it('次の 0時を過ぎたら、次の日になる', () => {
    render(<Today />)
    expect(screen.getByTestId('today').textContent).toBe('TUE · 2026.11.10')
    act(() => vi.advanceTimersByTime(20_000))
    expect(screen.getByTestId('today').textContent).toBe('TUE · 2026.11.10')
    act(() => vi.advanceTimersByTime(12_000))
    expect(screen.getByTestId('today').textContent).toBe('WED · 2026.11.11')
    // その次の 0時でも変わる（タイマーを掛け直している）
    act(() => vi.advanceTimersByTime(24 * 60 * 60 * 1000))
    expect(screen.getByTestId('today').textContent).toBe('THU · 2026.11.12')
  })

  it('タイマーが遅れても、画面が見えるようになった時・フォーカスが戻った時に計算し直す', () => {
    render(<Today />)
    // 時計だけが進んだ（端末が眠っていてタイマーが動かなかった）
    vi.setSystemTime(new Date(2026, 10, 12, 8, 0))
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(screen.getByTestId('today').textContent).toBe('THU · 2026.11.12')
    vi.setSystemTime(new Date(2026, 10, 13, 8, 0))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(screen.getByTestId('today').textContent).toBe('FRI · 2026.11.13')
  })

  it('日付が変わらない時は描き直さない', () => {
    render(<Today />)
    const before = renders
    act(() => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(renders).toBe(before)
  })
})

describe('useNow（トップの状態の1行の、枠の時刻と30分の境。設計: 段階2の 1.1）', () => {
  function Now({ step }: { step?: number }) {
    const now = new Date(useNow(step))
    return <p data-testid="now">{`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`}</p>
  }

  it('分の変わり目で描き直す（既定は1分ごと）', () => {
    render(<Now />)
    expect(screen.getByTestId('now').textContent).toBe('23:59')
    act(() => vi.advanceTimersByTime(29_000))
    expect(screen.getByTestId('now').textContent).toBe('23:59')
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByTestId('now').textContent).toBe('0:00')
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByTestId('now').textContent).toBe('0:01')
  })

  it('30分ごとにすると、30分の変わり目（日本時間の 12:30 など）でだけ描き直す', () => {
    vi.setSystemTime(new Date('2026-11-15T12:20:00+09:00'))
    const seen: number[] = []
    function Stamps() {
      seen.push(useNow(30 * 60_000))
      return null
    }
    render(<Stamps />)
    act(() => vi.advanceTimersByTime(9 * 60_000 + 59_000))
    expect(seen.map((t) => new Date(t).toISOString())).toEqual(['2026-11-15T03:20:00.000Z'])
    act(() => vi.advanceTimersByTime(1_000))
    // 12:30（日本時間）の変わり目で1回だけ描き直す
    expect(seen.map((t) => new Date(t).toISOString())).toEqual(['2026-11-15T03:20:00.000Z', '2026-11-15T03:30:00.000Z'])
    act(() => vi.advanceTimersByTime(30 * 60_000))
    expect(seen.at(-1)).toBe(Date.parse('2026-11-15T13:00:00+09:00'))
    expect(seen).toHaveLength(3)
  })

  it('タイマーが遅れても、画面が見えるようになった時に計算し直す', () => {
    render(<Now />)
    vi.setSystemTime(new Date(2026, 10, 11, 8, 30, 10))
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(screen.getByTestId('now').textContent).toBe('8:30')
  })
})
