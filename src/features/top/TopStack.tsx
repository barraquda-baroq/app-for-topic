// トップの S・M の並び（docs/SPEC.md の 9. の S。M も同じ1列にする。■6 の A。設計: 段階2の 1.3）: 上に固定の切り替えの列、その下に
// 状態の1行・追いつきの帯、いちばん上に「総合」（版の order の順＝今日知るべき順に20本）、その下にジャンルの区切り（政治・経済・
// テクノロジー・AI・事故・事件・スポーツ・エンタメ。区切りの中も order の順）、いちばん下に「この版の選び方」。
// 同じ話題が総合とジャンルに2回出る（総合を上から読めば全部読め、ジャンルの区切りは読んだ物が「既読 n件」にまとまるので、2回目は短い）。
// ジャンルが分からない話題（後の版の値）と新しい形の記録の話題は総合にだけ出す（docs/SPEC.md の 7.1）。
// 切り替えの列は DS の src/features/top/TopPage.tsx の StackedTop の作りを写した: 今の区切りはスクロールの位置で決め（区切りの上の端が
// 列の下＋16px より上の物のうち最後）、押した直後は押した物に固定（自分でスクロール・押す・キーで外す）。押すと
// scrollIntoView({ block: 'start', behavior: scrollBehavior() }) と区切りの見出しへフォーカス。下が短くて先頭まで上がれない時は、
// いちばん下に足りない分の空き（fitSpacer）。
// 詳細は下からのシート（side は null。どこに出すかは src/features/topic/TopicHost.tsx）。ほかの画面から戻った時は、前のスクロールの
// 位置と今の区切りへ戻す（src/store/uiStore.ts の useTopUi に版ごとに覚える。読み込み直した・開き直した時は先頭から。設計: 段階2の 2.）
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type Ref } from 'react'
import { genreLabel, GENRE_TAB_LABELS } from '../../domain/fixedTexts'
import { GENRE_VALUES } from '../../domain/types'
import { useTopUi } from '../../store/uiStore'
import { scrollBehavior } from '../../ui/motion'
import { useTopicSheet } from '../topic/sheets'
import { CatchUpBand } from './CatchUpBand'
import { ChoiceNote } from './ChoiceNote'
import { EditionStatus, PastEditionStatus } from './EditionStatus'
import { GenreSwitcher } from './GenreSwitcher'
import { orderedItems, TopSection, type ReadyView, type TopItem, type TopListState } from './TopSection'
import { SECTION_TEXTS } from './texts'
import { testIds } from './testIds'

/** S・M の区切り1つ（items が空のジャンルは区切りを出さず、切り替えの列では押せない見た目にする） */
export interface StackSection {
  /** 'all' かジャンル */
  section: string
  title: string
  /** 切り替えの列の言葉 */
  tab: string
  note: string | null
  items: TopItem[]
}

/**
 * S・M の区切り（総合と7つのジャンル。この順で、切り替えの列も同じ順）。総合は order の全部（新しい形の記録の話題も、その位置に）、
 * ジャンルはそのジャンルの話題だけ（知らないジャンル・新しい形の記録の話題は入れない）
 */
export function stackSections(view: Pick<ReadyView, 'edition' | 'topics' | 'newerTopics'>): StackSection[] {
  const all = orderedItems(view)
  return [
    { section: 'all', title: SECTION_TEXTS.all, tab: SECTION_TEXTS.all, note: SECTION_TEXTS.allNote, items: all },
    ...GENRE_VALUES.map((g) => ({
      section: g,
      title: genreLabel(g) ?? g,
      tab: GENRE_TAB_LABELS[g],
      note: null,
      items: all.filter((it) => it.kind === 'topic' && it.topic.genre === g),
    })),
  ]
}

export interface TopLayoutProps {
  view: ReadyView
  list: TopListState
  /** 前の版（#/e/{id}）を見ている（状態の1行の所に「前の版を見ています」。追いつきの帯は出さない） */
  past: boolean
  /** 一覧の外枠（top-edition）を受け取る（その中の操作で版を見たにする。src/features/top/useSeenMark.ts） */
  rootRef?: Ref<HTMLDivElement>
}

/** 状態の1行と追いつきの帯（S・M は切り替えの列の下、L は2列の上） */
export function TopNotes({ past }: { past: boolean }): JSX.Element {
  return (
    <div className="top-notes">
      {past ? (
        <PastEditionStatus />
      ) : (
        <>
          <EditionStatus />
          <CatchUpBand />
        </>
      )}
    </div>
  )
}

export function TopStack({ view, list, past, rootRef }: TopLayoutProps): JSX.Element {
  const baseId = useId()
  const sectionId = (k: string) => `${baseId}-sec-${k}`
  const headingId = (k: string) => `${baseId}-head-${k}`
  const sections = useMemo(() => stackSections(view), [view])
  const shown = sections.filter((s) => s.items.length > 0)
  const shownKeys = shown.map((s) => s.section).join(' ')
  const { openTopic } = useTopicSheet()
  const onOpen = useCallback((topicId: string) => openTopic(topicId, { side: null }), [openTopic])

  const switcher = useRef<HTMLElement>(null)
  const spacer = useRef<HTMLDivElement>(null)
  const [current, setCurrent] = useState('all')
  const currentRef = useRef(current)
  currentRef.current = current
  // 切り替えの列で移った区切り。自分でスクロールし始めるまでは、位置ではなくこれを今の区切りとする（DS と同じ）
  const pinned = useRef<string | null>(null)
  const lastScroll = useRef(0)

  // ほかの画面から戻った時は、前の位置と区切りへ戻す（ヘッダーの外枠が先頭へ戻した後に動く）。離れる時・版が替わる時に覚える
  const editionId = view.editionId
  useLayoutEffect(() => {
    const place = useTopUi.getState().places[editionId]
    if (place) {
      window.scrollTo(0, place.scroll.page ?? 0)
      if (place.section) setCurrent(place.section)
    }
    lastScroll.current = window.scrollY
    return () => {
      useTopUi.getState().setPlace(editionId, { scroll: { page: lastScroll.current }, section: currentRef.current })
    }
  }, [editionId])

  // どれが今の区切りかはスクロールの位置で決める（その区切りの見出しが切り替えの列のすぐ下にある物）
  useEffect(() => {
    const keys = shownKeys.split(' ').filter(Boolean)
    let raf = 0
    const update = () => {
      lastScroll.current = window.scrollY
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (pinned.current) {
          setCurrent(pinned.current)
          return
        }
        // 区切りの上の端が、切り替えの列の下の端（＋移った時の間の 12px と少しのゆとり）より上に来た物のうち、いちばん下の物
        const line = (switcher.current?.getBoundingClientRect().bottom ?? 0) + 16
        let next = keys[0] ?? 'all'
        for (const k of keys) {
          const top = document.getElementById(sectionId(k))?.getBoundingClientRect().top
          if (top !== undefined && top <= line) next = k
        }
        setCurrent(next)
      })
    }
    const release = () => {
      pinned.current = null
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    window.addEventListener('wheel', release, { passive: true })
    window.addEventListener('touchstart', release, { passive: true })
    window.addEventListener('pointerdown', release, { passive: true })
    window.addEventListener('keydown', release)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('wheel', release)
      window.removeEventListener('touchstart', release)
      window.removeEventListener('pointerdown', release)
      window.removeEventListener('keydown', release)
    }
    // 区切りの id（sectionId）は useId から作るので変わらない。出す区切りが替わった時だけ付け直す
  }, [shownKeys])

  /**
   * 下の区切りが短くて、押した区切りの見出しが切り替えの列の下まで上がれない時は、いちばん下に足りない分だけ空きを足す
   * （押した区切りの先頭へ必ずスクロールできるように。総合へ移った時などは 0 に戻る。DS と同じ）
   */
  const fitSpacer = (k: string) => {
    const pane = document.getElementById(sectionId(k))
    const space = spacer.current
    if (!pane || !space) return
    const margin = Number.parseFloat(getComputedStyle(pane).scrollMarginTop) || 0
    const target = pane.getBoundingClientRect().top + window.scrollY - margin
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight - space.offsetHeight
    space.style.height = `${Math.max(0, Math.ceil(target - maxScroll))}px`
  }

  const jumpTo = (k: string) => {
    pinned.current = k
    setCurrent(k)
    requestAnimationFrame(() => {
      fitSpacer(k)
      document.getElementById(sectionId(k))?.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
      // 読み上げ・キーボードでも移った先から続けられるように、区切りの見出しへフォーカスを移す
      document.getElementById(headingId(k))?.focus({ preventScroll: true })
    })
  }

  return (
    <main className="top top-stack" data-testid={testIds.topPage}>
      <h1 className="visually-hidden">トップ</h1>
      <div
        ref={rootRef}
        className="top-edition"
        data-testid={testIds.topEdition}
        data-edition-id={view.editionId}
        data-layout="stack"
      >
        <GenreSwitcher
          navRef={switcher}
          tabs={sections.map((s) => ({
            section: s.section,
            label: s.tab,
            empty: s.items.length === 0,
            controls: sectionId(s.section),
          }))}
          current={current}
          onJump={jumpTo}
        />
        <div className="top-stack-body">
          <TopNotes past={past} />
          {shown.map((s) => (
            <TopSection
              key={s.section}
              list={list}
              section={s.section}
              title={s.title}
              note={s.note}
              items={s.items}
              onOpen={onOpen}
              id={sectionId(s.section)}
              headingId={headingId(s.section)}
            />
          ))}
          <ChoiceNote edition={view.edition} />
        </div>
        <div ref={spacer} className="top-stack-spacer" aria-hidden="true" />
      </div>
    </main>
  )
}
