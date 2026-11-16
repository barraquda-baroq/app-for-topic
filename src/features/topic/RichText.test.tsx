// 本文の1つの欄の文（src/features/topic/RichText.tsx。docs/SPEC.md の 4.6・7.1・5.12。設計: 段階2の 1.11・1.12）: <strong class="emph"> の
// 数と中身・用語のボタン（testid term-mark・data-term-id・aria-expanded・aria-controls・押した時）・強調と用語が重なる時・記録の文を
// HTML として読まない
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RichText } from './RichText'

afterEach(cleanup)

function renderIn(el: ReactElement) {
  const { container } = render(<p data-testid="field">{el}</p>)
  return container.querySelector('p')!
}

describe('RichText', () => {
  it('強調の語句を <strong class="emph"> で包む（最初に出る所だけ。見つからない語句は付けない）', () => {
    const p = renderIn(
      <RichText text="橋が開通し、橋の通行料はまだ決まっていない" phrases={['橋', '通行料はまだ決まっていない', '無い語句']} />,
    )
    const strong = [...p.querySelectorAll('strong')]
    expect(strong.map((s) => [s.className, s.textContent])).toEqual([
      ['emph', '橋'],
      ['emph', '通行料はまだ決まっていない'],
    ])
    expect(p.textContent).toBe('橋が開通し、橋の通行料はまだ決まっていない')
    expect(p.querySelectorAll('button')).toHaveLength(0)
  })

  it('強調も印も無ければ文だけ（囲む要素を足さない）', () => {
    const p = renderIn(<RichText text="ふつうの文" />)
    expect(p.innerHTML).toBe('ふつうの文')
  })

  it('用語の印はボタン（term-mark・data-term-id・aria-expanded）。押すと語の id とボタンを知らせる', () => {
    const onPressTerm = vi.fn()
    renderIn(
      <RichText
        text="市議会の議決で決まる"
        hits={[
          { start: 0, end: 3, termId: 't1' },
          { start: 4, end: 6, termId: 't2' },
        ]}
        openTermId="t2"
        noteId="note-1"
        onPressTerm={onPressTerm}
      />,
    )
    const marks = screen.getAllByTestId('term-mark')
    expect(marks.map((b) => [b.tagName, b.className, b.getAttribute('type'), b.dataset.termId, b.textContent])).toEqual([
      ['BUTTON', 'term-mark', 'button', 't1', '市議会'],
      ['BUTTON', 'term-mark', 'button', 't2', '議決'],
    ])
    expect(marks.map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'true'])
    // aria-controls は開いている語のボタンだけ
    expect(marks.map((b) => b.getAttribute('aria-controls'))).toEqual([null, 'note-1'])
    fireEvent.click(marks[0])
    expect(onPressTerm).toHaveBeenCalledWith('t1', marks[0])
  })

  it('強調の中の語・語をまたぐ強調: ボタンは語ごとに1つで、中を <strong> で分ける', () => {
    const p = renderIn(
      <RichText
        text="市は来週の土曜に1日通行止めにする。利上げを決めた"
        phrases={['来週の土曜に1日通行止め', 'げを決め']}
        hits={[
          { start: 10, end: 14, termId: 'stop' },
          { start: 18, end: 21, termId: 'hike' },
        ]}
      />,
    )
    const marks = [...p.querySelectorAll('button')]
    expect(marks.map((b) => b.innerHTML)).toEqual([
      '<strong class="emph">通行止め</strong>',
      '利上<strong class="emph">げ</strong>',
    ])
    expect([...p.querySelectorAll('strong')].map((s) => s.textContent)).toEqual(['来週の土曜に1日', '通行止め', 'げ', 'を決め'])
    expect(p.textContent).toBe('市は来週の土曜に1日通行止めにする。利上げを決めた')
  })

  it('記録の文を HTML として読まない（<b>・<script>・<img> は字のまま）', () => {
    const text = '<b>太字</b>と<img src=x onerror=alert(1)>と<script>x</script>'
    const p = renderIn(<RichText text={text} phrases={['<b>太字</b>']} hits={[{ start: 11, end: 16, termId: 't' }]} />)
    expect(p.textContent).toBe(text)
    expect(p.querySelector('b')).toBeNull()
    expect(p.querySelector('img')).toBeNull()
    expect(p.querySelector('script')).toBeNull()
    expect(p.querySelector('strong')?.textContent).toBe('<b>太字</b>')
  })
})
