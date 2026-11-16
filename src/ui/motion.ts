// 動きの共通の決まり（docs/SPEC.md の 9.。DS の docs/SPEC.md の 4.9）。DS の src/ui/motion.ts から、scrollBehavior・prefersReducedMotion
// だけを写した物（目立たせる枠・ロックの揺れ・ページめくり・振動は TS に無い）。端末の「視差効果を減らす」（prefers-reduced-motion:
// reduce）では、scrollTo・scrollIntoView のなめらかなスクロールをやめて、すぐに移る（切り替えの列で区切りへ移る時など）。
// CSS の動きは src/styles.css の @media (prefers-reduced-motion: reduce) が全部止める

/** 端末で「視差効果を減らす」を選んでいる */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

/** scrollTo・scrollIntoView の behavior（視差効果を減らす設定では 'auto'、ふだんは 'smooth'） */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}
