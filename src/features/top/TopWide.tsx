// トップの L の並び（docs/SPEC.md の 9. の L。設計: 段階2の 1.4）: 国内｜世界の2列（同じ幅）。DS の .top-wide と同じく、ページ全体は
// スクロールせず列の中だけ（高さは 100dvh − ヘッダー − ノッチ）。列の中は版の order の順で、重大印の話題は順位1なのでその地域の列の
// いちばん上に来る。地域が分からない話題（後の版の値）と新しい形の記録の話題は、国内の列のいちばん下の「そのほか」に出す（開発。L に総合の
// 列は無いので、無くさずに出す所。docs/SPEC.md の 7.1 の「総合にだけ出す」を L で変える。お知らせ・直す節）。ジャンルの区切り・切り替えの
// 列は L には無い（カードにジャンルの字がある）。状態の1行・追いつきの帯は2列の上（全幅）、「この版の選び方」は世界の列のいちばん下。
// 詳細のパネル（■7 の A）: 開いたカードと反対の列の上に重ねる（国内のカードは世界の列、世界のカードは国内の列。読んでいる列は見えたまま
// で、同じ列の次のカードを続けて開ける）。重ねる列は panelSideFor の1か所で決める（■7 の答えで替える。B なら、いつも 'world'）。
// 列ごとに差し込み口（PanelSlot）を列の一覧の兄弟に置き、詳細の部品（src/features/topic/TopicHost.tsx）がそこへ出す。重ねた列の一覧は
// inert にする（Tab で隠れたカードに入らない。パネルは inert の外）。
// ほかの画面から戻った時は、列ごとのスクロールの位置へ戻す（src/store/uiStore.ts の useTopUi。設計: 段階2の 2.）。
// 段階3で、話題が1本も無い列（今の出どころでは、世界の話題がほとんど入らない）の見出しの下に1行を出すようにした（SECTION_TEXTS の
// columnEmpty。作者に伺っている Q18 の今の決め方 A。列の形は版ごとに変えず、空の世界の列は詳細のパネルの置き場になる。段階3の設計の 3.4）
import { useCallback, useLayoutEffect, useMemo, useRef, type JSX } from 'react'
import { regionLabel } from '../../domain/fixedTexts'
import { useTopUi } from '../../store/uiStore'
import { PanelSlot, useTopicSheet, type PanelSide } from '../topic/sheets'
import { ChoiceNote } from './ChoiceNote'
import { orderedItems, TopSection, type ReadyView, type TopItem } from './TopSection'
import { TopNotes, type TopLayoutProps } from './TopStack'
import { SECTION_TEXTS } from './texts'
import { testIds } from './testIds'

/** L の列（国内・世界） */
export type WideColumn = PanelSide

const COLUMNS: readonly WideColumn[] = ['jp', 'world']

/**
 * その列のカードを開いた時に、詳細を重ねる列（■7 の A: 反対の列。docs/SPEC.md の 9. の「PC は右のパネル」を変える案で、仕様どおりの
 * B（いつも右の世界の列）に替える時はここだけを替える）
 */
export function panelSideFor(column: WideColumn): PanelSide {
  return column === 'jp' ? 'world' : 'jp'
}

/** L の列の中身（国内・世界と、国内の列の下の「そのほか」） */
export interface WideColumns {
  jp: TopItem[]
  world: TopItem[]
  /** 地域が分からない話題と、新しい形の記録の話題 */
  other: TopItem[]
}

/** L の列に分ける（どれも order の順） */
export function wideColumns(view: Pick<ReadyView, 'edition' | 'topics' | 'newerTopics'>): WideColumns {
  const out: WideColumns = { jp: [], world: [], other: [] }
  for (const it of orderedItems(view)) {
    if (it.kind === 'topic' && regionLabel(it.topic.region) !== null) out[it.topic.region as WideColumn].push(it)
    else out.other.push(it)
  }
  return out
}

export function TopWide({ view, list, past, rootRef }: TopLayoutProps): JSX.Element {
  const columns = useMemo(() => wideColumns(view), [view])
  const { current, openTopic } = useTopicSheet()
  // 詳細を重ねている列（その列の一覧は inert）
  const covered = current?.side ?? null
  const onOpenJp = useCallback((id: string) => openTopic(id, { side: panelSideFor('jp') }), [openTopic])
  const onOpenWorld = useCallback((id: string) => openTopic(id, { side: panelSideFor('world') }), [openTopic])

  // 列ごとのスクロールの位置（ほかの画面から戻った時に戻す。離れる時・版が替わる時に覚える）
  const scrollers = useRef<Record<WideColumn, HTMLDivElement | null>>({ jp: null, world: null })
  const lastScroll = useRef<Record<WideColumn, number>>({ jp: 0, world: 0 })
  const editionId = view.editionId
  useLayoutEffect(() => {
    const place = useTopUi.getState().places[editionId]
    for (const c of COLUMNS) {
      const el = scrollers.current[c]
      if (!el) continue
      if (place) el.scrollTop = place.scroll[c] ?? 0
      lastScroll.current[c] = el.scrollTop
    }
    return () => {
      useTopUi.getState().setPlace(editionId, { scroll: { ...lastScroll.current }, section: null })
    }
  }, [editionId])

  return (
    <main className="top top-wide" data-testid={testIds.topPage}>
      <h1 className="visually-hidden">トップ</h1>
      <div
        ref={rootRef}
        className="top-edition"
        data-testid={testIds.topEdition}
        data-edition-id={view.editionId}
        data-layout="wide"
      >
        <TopNotes past={past} />
        <div className="top-columns">
          {COLUMNS.map((c) => (
            <div key={c} className="top-column">
              <div
                ref={(el) => {
                  scrollers.current[c] = el
                }}
                className="top-column-list"
                inert={covered === c}
                onScroll={(e) => {
                  lastScroll.current[c] = e.currentTarget.scrollTop
                }}
              >
                <TopSection
                  list={list}
                  section={c}
                  title={regionLabel(c) ?? c}
                  note={SECTION_TEXTS.columnNote}
                  items={columns[c]}
                  onOpen={c === 'jp' ? onOpenJp : onOpenWorld}
                  emptyNote={SECTION_TEXTS.columnEmpty[c]}
                />
                {c === 'jp' && columns.other.length ? (
                  <TopSection list={list} section="other" title={SECTION_TEXTS.other} items={columns.other} onOpen={onOpenJp} />
                ) : null}
                {c === 'world' ? <ChoiceNote edition={view.edition} /> : null}
              </div>
              <PanelSlot side={c} />
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}
