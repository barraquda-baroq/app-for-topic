// 動きの共通の決まり（docs/SPEC.md の 9.。DS の docs/SPEC.md の 4.9）: 端末の「視差効果を減らす」では、なめらかなスクロールをやめて
// すぐに移る（切り替えの列で区切りへ移る時など）
import { afterEach, describe, expect, it } from 'vitest'
import { prefersReducedMotion, scrollBehavior } from './motion'

const original = window.matchMedia

afterEach(() => {
  window.matchMedia = original
})

function media(reduced: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: q === '(prefers-reduced-motion: reduce)' ? reduced : false,
  })) as unknown as typeof window.matchMedia
}

describe('視差効果を減らす設定', () => {
  it('ふだんはなめらかにスクロールする', () => {
    media(false)
    expect(prefersReducedMotion()).toBe(false)
    expect(scrollBehavior()).toBe('smooth')
  })

  it('視差効果を減らす設定では、すぐに移る', () => {
    media(true)
    expect(prefersReducedMotion()).toBe(true)
    expect(scrollBehavior()).toBe('auto')
  })

  it('matchMedia の無い環境では、減らさない', () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia
    expect(prefersReducedMotion()).toBe(false)
    expect(scrollBehavior()).toBe('smooth')
  })
})
