// トップの区切り（S・M は総合と各ジャンル、L は国内・世界の列と、国内の列の下の「そのほか」。docs/SPEC.md の 9.。設計: 段階2の 1.3・1.4）。
// 区切りの中は版の order の順（今日知るべき順）。画面を出した時に既読だった話題（sunk）は、下の「既読 n件」に畳む（1.6）。
// 画面を出した後に読んだ話題は、その場で淡くするだけで動かさない（read。指の下で一覧がずれないように）。
// 話題が新しい形の記録の時は、その位置に押せない淡いカードを置く（呼ぶ側が総合・そのほかにだけ渡す。1.21）。
// 見出しは <h2 tabIndex={-1}>（S・M の切り替えの列で移った時に、ここへフォーカスを移す。DS と同じ。設計: 段階2の 2.）。
// testid は top-section（data-section）。総合とジャンルで同じ話題が2回出るので、読み上げでも区切りの見出しで分かるようにする（8. の 4）。
// 段階3で、話題が1本も無い区切りの見出しの下の1行（emptyNote。L の国内・世界の列だけが渡す。作者に伺っている Q18 の今の決め方 A。
// 段階3の設計の 3.4）を足した。全部を既読にした区切り（話題はあるが「既読 n件」に畳んだ）には出さない
import { useId, type JSX } from 'react'
import type { ShownTopic } from '../../domain/repair'
import type { EditionView } from '../../store/appStore'
import { ReadFold } from './ReadFold'
import { NewerTopicCard, TopCard } from './TopCard'
import { testIds } from './testIds'

/** 話題が1本も無い区切りの1行の testid（E2E・単体のテストが探す） */
export const SECTION_EMPTY_TEST_ID = 'top-section-empty'

/** 出している版（ストアの opened.view が ready の物） */
export type ReadyView = Extract<EditionView, { kind: 'ready' }>

/** 区切りに並べる物（話題か、新しい形の記録の話題の id） */
export type TopItem = { kind: 'topic'; topic: ShownTopic } | { kind: 'newer'; id: string }

/**
 * 版の order の順（今日知るべき順。正は order。docs/SPEC.md の 7.2）に並べた物。新しい形の記録の話題はその位置に置き、端末にもクラウドにも
 * 無いと分かった話題（missing）は飛ばす
 */
export function orderedItems(view: Pick<ReadyView, 'edition' | 'topics' | 'newerTopics'>): TopItem[] {
  const topics = new Map(view.topics.map((t) => [t.id, t]))
  const newer = new Set(view.newerTopics)
  const out: TopItem[] = []
  for (const id of view.edition.order) {
    const topic = topics.get(id)
    if (topic) out.push({ kind: 'topic', topic })
    else if (newer.has(id)) out.push({ kind: 'newer', id })
  }
  return out
}

/** 区切りの並べ方に要る物（S・M・L で同じ。TopPage が決めて渡す） */
export interface TopListState {
  editionId: string
  /** 画面を出した時に既読だった話題（「既読 n件」に畳む。画面の間は変えない） */
  sunk: ReadonlySet<string>
  /** 今の既読（淡い見出し） */
  read: ReadonlySet<string>
  /** 訂正のある話題 */
  corrected: ReadonlySet<string>
  /** もっと新しい続報が端末にある話題（前の版だけ） */
  hasNewer: ReadonlySet<string>
}

export interface TopSectionProps {
  list: TopListState
  /** 区切り（data-section。'all'・ジャンル・'jp'・'world'・'other'） */
  section: string
  title: string
  /** 見出しの添え書き（「今日知るべき順」など） */
  note?: string | null
  items: readonly TopItem[]
  onOpen: (topicId: string) => void
  /** 区切りの要素の id（切り替えの列が移る先） */
  id?: string
  /** 見出しの id（切り替えの列で移った時にフォーカスを移す） */
  headingId?: string
  /** 話題が1本も無い時に、見出しの下に出す1行（L の国内・世界の列だけ。段階3の設計の 3.4） */
  emptyNote?: string | null
}

export function TopSection({
  list,
  section,
  title,
  note,
  items,
  onOpen,
  id,
  headingId,
  emptyNote,
}: TopSectionProps): JSX.Element {
  const ownHeadingId = useId()
  const headId = headingId ?? ownHeadingId
  const shown = items.filter((it) => it.kind === 'newer' || !list.sunk.has(it.topic.id))
  const folded = items.filter(
    (it): it is Extract<TopItem, { kind: 'topic' }> => it.kind === 'topic' && list.sunk.has(it.topic.id),
  )
  const card = (it: TopItem) =>
    it.kind === 'newer' ? (
      <li key={it.id}>
        <NewerTopicCard topicId={it.id} />
      </li>
    ) : (
      <li key={it.topic.id}>
        <TopCard
          topic={it.topic}
          corrected={list.corrected.has(it.topic.id)}
          read={list.read.has(it.topic.id)}
          hasNewer={list.hasNewer.has(it.topic.id)}
          onOpen={onOpen}
        />
      </li>
    )
  return (
    <section id={id} className="top-section" aria-labelledby={headId} data-testid={testIds.topSection} data-section={section}>
      <h2 id={headId} className="top-section-head" tabIndex={-1}>
        <span className="top-section-title">{title}</span>
        {note ? <span className="top-section-note">（{note}）</span> : null}
      </h2>
      {items.length === 0 && emptyNote ? (
        <p className="top-section-empty muted small" data-testid={SECTION_EMPTY_TEST_ID}>
          {emptyNote}
        </p>
      ) : null}
      {shown.length ? <ol className="top-cards">{shown.map(card)}</ol> : null}
      <ReadFold editionId={list.editionId} section={section} count={folded.length}>
        <ol className="top-cards">{folded.map(card)}</ol>
      </ReadFold>
    </section>
  )
}
