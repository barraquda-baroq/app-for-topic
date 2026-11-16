// 詳細の中で［知ってる］を押した語（docs/SPEC.md の 5.8・7.4。設計: 段階2の 1.13）。押した時には書かず、詳細の中にためておき、
// 詳細を閉じた時（［×］・Esc・背景・戻る・ほかの話題へ替わった・画面が替わった = この hook を使う部品が消えた時）にストアの know で書く。
// ［取り消す］は、まだ書いていない分から外すだけ（unknow を呼ばない）。理由: 時期で変わる語（7.4）は asOf を新しい方に合わせるので、
// 前が on: true（古い asOf）の語で know → unknow と書くと on: false・新しい asOf になり、押す前は出なかった古い話題でも語が出るように
// なる。書いた後に前の asOf へは戻せない。書かずに捨てれば、記録は押す前のまま。
// ページが裏になった時（visibilitychange の hidden・pagehide。iPhone で裏のまま閉じられても失わない）も、ためた分を書く。書いた後の語は
// 「知ってるにしました」だけにし、［取り消す］を出さない（書いた後に戻すと上と同じ事が起きる）。
// 裏になった時は、ストアの保存（src/store/lifecycle.ts の saveBeforeLeave）より先に書くよう、同じ知らせを先に受ける（capture）。
// 古いブラウザで後になっても失わないよう、書いた後に端末への保存も急がせる（flushNow）。
// 書く時の決まり（30日・確かめ・変わらない時は書かない）はストアのまま。書けなかった時はお知らせ。
// オブジェクトの鍵・props に know を使わない（ビルドで縮むと CI の grep に当たる。docs/SPEC.md の 16.6 の 59）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushNow, know } from '../../store/appStore'
import { notifyError } from '../../store/uiStore'
import { KNOWN_TEXTS } from './detailTexts'

/** 押した語（written = もう書いた。書いた後は取り消せない） */
export interface PressedTerm {
  termId: string
  term: string
  asOf: string | null
  written: boolean
}

/** 押す語（話題の用語の termId・表記・説明の時点） */
export interface KnownPress {
  termId: string
  term: string
  asOf: string | null
}

export interface KnownPresses {
  /** 押した語（termId → 押した語） */
  pressed: Readonly<Record<string, PressedTerm>>
  /** ［知ってる］（もう押した語は何もしない） */
  press: (term: KnownPress) => void
  /** ［取り消す］（まだ書いていない語だけ。書いた語は何もしない） */
  undo: (termId: string) => void
}

export function useKnownPresses(): KnownPresses {
  const [pressed, setPressed] = useState<Readonly<Record<string, PressedTerm>>>({})
  // 閉じた時・裏になった時に読む写し（setState の後すぐにも読めるよう、変える時に一緒に替える）
  const ref = useRef(pressed)
  const update = useCallback((next: Readonly<Record<string, PressedTerm>>) => {
    ref.current = next
    setPressed(next)
  }, [])

  /** まだ書いていない語を書く（書いた物があれば true）。部品が消える時にも呼ぶので、画面の状態は呼ぶ側が替える */
  const write = useCallback((): boolean => {
    const waiting = Object.values(ref.current).filter((p) => !p.written)
    if (!waiting.length) return false
    let failed = false
    const next = { ...ref.current }
    for (const p of waiting) {
      const r = know({ termId: p.termId, term: p.term, asOf: p.asOf })
      if (!r.ok) failed = true
      next[p.termId] = { ...p, written: true }
    }
    ref.current = next
    if (failed) notifyError(KNOWN_TEXTS.failed)
    return true
  }, [])

  // 閉じた時（この部品が消えた時）に書く
  useEffect(() => () => void write(), [write])

  // ページが裏になった時に書き、書いた語の［取り消す］を消す
  useEffect(() => {
    const onHide = () => {
      if (!write()) return
      setPressed(ref.current)
      void flushNow()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide()
    }
    document.addEventListener('visibilitychange', onVisibility, true)
    window.addEventListener('pagehide', onHide, true)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility, true)
      window.removeEventListener('pagehide', onHide, true)
    }
  }, [write])

  const press = useCallback(
    (term: KnownPress) => {
      if (ref.current[term.termId]) return
      update({ ...ref.current, [term.termId]: { termId: term.termId, term: term.term, asOf: term.asOf, written: false } })
    },
    [update],
  )
  const undo = useCallback(
    (termId: string) => {
      const p = ref.current[termId]
      if (!p || p.written) return
      const next = { ...ref.current }
      delete next[termId]
      update(next)
    },
    [update],
  )
  return useMemo(() => ({ pressed, press, undo }), [pressed, press, undo])
}
