// 版の一覧を「見た」にする時（docs/SPEC.md の 7.4 の reads.seen・9. の「追いつき」。開発。設計: 段階2の 1.6・8. の 16）。
// 版が表に出ただけでは見たにしない: しばらく開かなかった後・新しい端末の最初の受け取りでは、同期が版を何回かに分けて届け、付いていく版が
// そのたびに途中の版を一瞬出すので、出ただけで付けると途中の版が全部「見た」になり、追いつきの帯に出なくなる。だから次のどちらかの時だけ
// ストアの markSeen(editionId) を呼ぶ:
//   1. 同期が落ち着いている（syncSettled。synced・pending・sending。null・受け取り中・オフラインは落ち着いていない）間に、その版の一覧が
//      続けて 3秒（SEEN_AFTER_MS）出ていて、その間ページが表（document.visibilityState === 'visible'）だった。版が替わる・落ち着かなく
//      なる・裏になると数え直す
//   2. その版の一覧で利用者が操作した（一覧の外枠の中の pointerdown・wheel・キー。切り替えの列・「既読 n件」・カードを押した時も
//      pointerdown で入る）。アプリが動かすスクロール（戻った時の位置・scrollIntoView）は数えない（scroll の知らせは使わない）
// オフラインで開いて読むだけ（操作しない）の時は見たにならない（つながって落ち着いた後に、出ている版が 3秒で見たになる）。
// もう見た版には何もしない（markSeen は変わらない時は書かないが、毎回の操作で呼ばないように）。見たは戻さない（■13 の A）
import { useEffect } from 'react'
import { syncSettled } from '../../domain/editionStatus'
import { markSeen, useApp } from '../../store/appStore'
import { useSyncView } from '../../sync/syncView'

/** 同期が落ち着いている間に、その版の一覧が続けて出ていたら見たにするまでの時間 */
export const SEEN_AFTER_MS = 3000

/** 利用者の操作とみなす知らせ（一覧の外枠の中。scroll はアプリが動かすスクロールと見分けられないので入れない） */
const OPERATION_EVENTS = ['pointerdown', 'wheel', 'keydown'] as const

/** その版をまだ見ていなければ見たにする（30日の外・形の違う id などで付けられない時は、ストアの決まりのとおり付けない） */
function seeEdition(editionId: string): void {
  if (useApp.getState().user.reads[editionId]?.seen === true) return
  markSeen(editionId)
}

/**
 * 出している版の一覧を見たにする（editionId が null の間は何もしない）。root は一覧の外枠（その中の操作を数える。null の間は
 * 操作を数えない）
 */
export function useSeenMark(editionId: string | null, root: HTMLElement | null): void {
  const settled = useSyncView((s) => syncSettled(s.view))

  // 1. 同期が落ち着いている間に、表で 3秒続けて出ていた
  useEffect(() => {
    if (editionId === null || !settled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
    const start = () => {
      stop()
      if (document.visibilityState !== 'visible') return
      timer = setTimeout(() => {
        timer = null
        seeEdition(editionId)
      }, SEEN_AFTER_MS)
    }
    // 裏になったら止め、表に戻ったら初めから数え直す
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop())
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [editionId, settled])

  // 2. その版の一覧で利用者が操作した（中の部品が知らせを止めても数えるよう、捕まえる側で受ける）
  useEffect(() => {
    if (editionId === null || !root) return
    const onOperation = () => seeEdition(editionId)
    for (const type of OPERATION_EVENTS) root.addEventListener(type, onOperation, { capture: true, passive: true })
    return () => {
      for (const type of OPERATION_EVENTS) root.removeEventListener(type, onOperation, { capture: true })
    }
  }, [editionId, root])
}
