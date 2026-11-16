// 画面の小さな共通のフック。DS の src/ui/hooks.ts をそのまま写した物（DS は NS の物から、幅の区分を S・M・L にした。
// docs/SPEC.md の 9.）。段階2で、DS の useNow（今の時刻）を足した
import { useEffect, useState } from 'react'
import { msUntilNextDay, sameDay, todayYmd, type Ymd } from '../domain/dates'

/** 幅の区分（docs/SPEC.md の 9.）。S は 600px 未満（スマホ）、M は 600〜899px、L は 900px 以上（PC） */
export type WidthClass = 'S' | 'M' | 'L'
/** M の始まりの幅。src/styles.css の @media（max-width: 599px）と同じ値にする */
export const WIDTH_M = 600
/** L の始まりの幅。src/styles.css の @media（max-width: 899px）と同じ値にする */
export const WIDTH_L = 900

/** 画面の幅から幅の区分を決める */
export function widthClassOf(width: number): WidthClass {
  if (width >= WIDTH_L) return 'L'
  if (width >= WIDTH_M) return 'M'
  return 'S'
}

export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false)
  const [matches, setMatches] = useState(get)
  useEffect(() => {
    if (!window.matchMedia) return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** 今の幅の区分（向きを変えた・ウインドウの幅を変えた時はすぐに変わる） */
export function useWidthClass(): WidthClass {
  const l = useMediaQuery(`(min-width: ${WIDTH_L}px)`)
  const m = useMediaQuery(`(min-width: ${WIDTH_M}px)`)
  return l ? 'L' : m ? 'M' : 'S'
}

/** スマホの幅（S） */
export function useIsMobile(): boolean {
  return !useMediaQuery(`(min-width: ${WIDTH_M}px)`)
}

/** ドキュメントタイトルを設定する */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} — Topic Studio` : 'Topic Studio'
  }, [title])
}

/**
 * 今日（端末の暦の日付）。PWA を開いたまま 0時を過ぎてもログインの画面の日付が前の日のままに
 * ならないよう、次の 0時にタイマーで計算し直し、画面が見えるようになった時（visibilitychange）・フォーカスが戻った時にも計算し直す
 * （裏にある間はタイマーが遅れることがあるため）。日付が変わった時だけ描き直す。
 */
export function useToday(): Ymd {
  const [today, setToday] = useState(() => todayYmd())
  useEffect(() => {
    let timer = 0
    const refresh = () => {
      const now = todayYmd()
      setToday((prev) => (sameDay(prev, now) ? prev : now))
      window.clearTimeout(timer)
      // 0時の少し後に（タイマーが少し早く来ても、前の日のまま次の日を待たないように）
      timer = window.setTimeout(refresh, msUntilNextDay() + 1000)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', refresh)
    }
  }, [])
  return today
}

/**
 * 今の時刻（ミリ秒）。stepMs ごと（既定は 1分）の変わり目にそろえて描き直す（時計の 0時（UTC）から数えた変わり目。日本時間は
 * UTC から 9時間ずれるだけなので、30分の変わり目は日本時間の 12:00・12:30・20:00・20:30 にも当たる）。画面が見えるようになった
 * 時にも計算し直す（裏にある間はタイマーが遅れるため）。DS の useNow から（DS はデイリーの今の時刻の線）。TS はトップの状態の1行を、
 * 枠の時刻と「まだ届いていません」の30分の境で変えるのに使う（docs/SPEC.md の 4.7。設計: 段階2の 1.1・1.7）
 */
export function useNow(stepMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let timer = 0
    const tick = () => {
      const t = Date.now()
      setNow(t)
      window.clearTimeout(timer)
      timer = window.setTimeout(tick, stepMs - (t % stepMs))
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick()
    }
    timer = window.setTimeout(tick, stepMs - (Date.now() % stepMs))
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [stepMs])
  return now
}
