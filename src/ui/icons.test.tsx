// 線のアイコン（DS の src/ui/icons.test.tsx から）: どれも同じ作り（24 四方・線 1.8・丸い端・文字の色）か、段階0・2で使う物がそろっているか
import { cleanup, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import * as icons from './icons'
import { GearIcon, ICON_STROKE, ICON_STROKE_SMALL, type IconProps } from './icons'

afterEach(cleanup)

/** 線のアイコン（名前が …Icon の物） */
const LINE_ICONS = Object.entries(icons).filter(([name, value]) => name.endsWith('Icon') && typeof value === 'function') as [
  string,
  ComponentType<IconProps>,
][]

const svgOf = (el: HTMLElement) => el.querySelector('svg') as SVGSVGElement

describe('線のアイコン', () => {
  it('段階0・2の画面で使うアイコンがそろっている（段階0の歯車・×・✓・下向きの矢印、段階2の山形・クリップ・同期の雲・外へのリンク）', () => {
    expect(LINE_ICONS.map(([name]) => name).sort()).toEqual([
      'CheckIcon',
      'ChevronLeftIcon',
      'ChevronRightIcon',
      'CloudIcon',
      'CloudOffIcon',
      'CopyIcon',
      'DownIcon',
      'DownloadIcon',
      'ExternalLinkIcon',
      'GearIcon',
      'XIcon',
    ])
  })

  it.each(LINE_ICONS)('%s: 24 四方・線 1.8・丸い端・文字と同じ色の飾り', (_name, Icon) => {
    const { container } = render(<Icon />)
    const svg = svgOf(container)
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('class')).toBe('icon')
    expect(svg.getAttribute('fill')).toBe('none')
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    expect(svg.getAttribute('stroke-width')).toBe(String(ICON_STROKE))
    expect(svg.getAttribute('stroke-linecap')).toBe('round')
    expect(svg.getAttribute('stroke-linejoin')).toBe('round')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.children.length).toBeGreaterThan(0)
  })

  it.each(LINE_ICONS)('%s: 丸は 24 四方の中に収まっている', (_name, Icon) => {
    const { container } = render(<Icon />)
    for (const circle of container.querySelectorAll('circle')) {
      const [cx, cy, r] = ['cx', 'cy', 'r'].map((a) => Number(circle.getAttribute(a)))
      expect(cx - r).toBeGreaterThanOrEqual(1)
      expect(cy - r).toBeGreaterThanOrEqual(1)
      expect(cx + r).toBeLessThanOrEqual(23)
      expect(cy + r).toBeLessThanOrEqual(23)
    }
  })

  it('title を渡すと、読み上げる絵になる', () => {
    const { container } = render(<GearIcon title="設定" />)
    const svg = svgOf(container)
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.hasAttribute('aria-hidden')).toBe(false)
    expect(svg.querySelector('title')?.textContent).toBe('設定')
  })

  it('small は 14px より小さく出す時の形（12px・線 2.4）', () => {
    const { container } = render(<GearIcon small />)
    const svg = svgOf(container)
    expect(svg.getAttribute('class')).toBe('icon icon-sm')
    expect(svg.getAttribute('stroke-width')).toBe(String(ICON_STROKE_SMALL))
    expect(ICON_STROKE_SMALL).toBe(2.4)
  })
})
