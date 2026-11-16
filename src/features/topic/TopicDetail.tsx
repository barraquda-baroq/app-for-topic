// 話題の詳細の中身（docs/SPEC.md の 9. の「詳細」。S・M の下からのシートと L のパネルで同じ物。設計: 段階2の 1.10〜1.17）。
// 並び（9. の「だから何？→ 当事者の主張 → AI の見解 → 対立見解 → 共通の注記 → 用語 → 元記事」を骨にして、書いていない欄の場所を決めた。
// 上は「何が起きたか」、下は「確かめる材料」。開発。設計: 段階2の 1.10）:
//   頭の行（重大・続報）→ 訂正（足した順。見出しの上）→ 見出し → 結論 → 要約 → 続報（何が新しいか・経緯・前の話題）→ 続報あり →
//   だから何？ → 当事者の主張 → AI の見解と対立見解・共通の注記 → 経緯（続報でない時）→ 確かめられなかった点 → 用語 → 元記事 →
//   下の細い字（照合の件数・順位の理由・書いた AI）
// 版の行（「11/15（日）12:00版・国内・経済」）は、シートの題・パネルの頭に出す（上に固定されるので。ここでは繰り返さない）。
// 本文の強調は <strong class="emph">（作者の答え A）、本文の中の用語の印は点線のボタン（■2 の A。src/features/topic/RichText.tsx）。
// 用語の印は1つの話題で語ごとに最初の1か所だけ・開いた時に「知ってる」だった語には付けない（src/domain/termMarks.ts）。
// 説明の箱の Esc はここ（根の React の onKeyDown）で受け、箱だけを閉じて止める（document に付けると、先に登録したシートの Esc が
// 先に動いてシートごと閉じる。React はシートの portal の先で受けるので、document の Modal・パネルの Esc まで届かない。設計: 段階2の 2.）。
// フォーカスが中身の外（シートの下の帯・パネルの頭の行の［クリップ］、本文の字を押した後の body）にある時は、ここでは受けられないので、
// 箱を閉じる関数を noteCloser で渡し、シート（Modal）とパネルが Esc で閉じる前に呼ぶ（箱が開いていれば箱だけを閉じて止める）。
// 記録の文は文のまま出す（HTML として読まない。4.6）。props の名前に know・markRead・markSeen を使わない（16.6 の 59）
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import {
  asOfText,
  BREAKING_LABEL,
  conclusionLabelText,
  FIXED_TEXTS,
  sourceDateText,
  stanceLabel,
  timelineWhenText,
} from '../../domain/fixedTexts'
import type { ShownCorrection, ShownTopic } from '../../domain/repair'
import { detailTextFields, findTermHits, type TermHit } from '../../domain/termMarks'
import type { TopicTerm } from '../../domain/types'
import type { ThreadTopic } from '../../store/appStore'
import { ExternalLinkIcon } from '../../ui/icons'
import { testIds } from '../top/testIds'
import { CARD_TEXTS, editionNameOfId } from '../top/texts'
import {
  checkText,
  DETAIL_HEADS,
  FOLLOW_UP_PREFIX,
  NEWER_TOPIC_PREFIX,
  PREV_TOPIC_PREFIX,
  rankReasonText,
  SO_WHAT_LABELS,
  threadLinkText,
  unverifiedText,
  VIEW_TEXTS,
  viaText,
  writerText,
} from './detailTexts'
import { RichText } from './RichText'
import { KnownControl, TermNote } from './TermNote'
import type { KnownPress, PressedTerm } from './useKnownPresses'

export interface TopicDetailProps {
  topic: ShownTopic
  /** その話題の訂正（足した順） */
  corrections: readonly ShownCorrection[]
  /** シート（S・M と、列の無い画面の真ん中の小さな画面）かパネル（L の列に重ねる）か（data-mode） */
  mode: 'sheet' | 'panel'
  /** 開いた時に「知ってる」だった語（用語の一覧にも本文の印にも出さない。開いている間は変えない） */
  hiddenTermIds: ReadonlySet<string>
  /** この詳細で［知ってる］を押した語（閉じた時に書く） */
  pressed: Readonly<Record<string, PressedTerm>>
  onPressKnown: (term: KnownPress) => void
  onUndoKnown: (termId: string) => void
  /** 同じ続報のつながり（src/store/appStore.ts の threadOf。版の id の順。読む前は null） */
  thread: readonly ThreadTopic[] | null
  /** 前の話題・続報へのリンク（同じシート・パネルの中身を替える） */
  onOpenTopic: (topicId: string) => void
  /**
   * 説明の箱を閉じる関数を入れる所（箱が開いていれば閉じて語のボタンへフォーカスを戻し true、開いていなければ false）。シートとパネルが
   * Esc で閉じる前に呼ぶ（フォーカスが中身の外にあって、根の onKeyDown が受けられない時のため）
   */
  noteCloser?: MutableRefObject<(() => boolean) | null>
}

const NONE: readonly never[] = []

/** 開いている説明の箱（語・その語のある欄・押したボタン） */
interface OpenTerm {
  termId: string
  key: string
  button: HTMLButtonElement
}

/**
 * 軸の後ろの論点の行。論点の文は「論点は『家計をすぐ助ける』か『財政と将来の負担を重く見る』か」のように「論点」から書く事が多い
 * （docs/SPEC.md の 5.6 の例）ので、そう書いてある時は「論点:」を重ねない（「論点: 論点は…」にしない。開発。見本の見直しで分かった）
 */
function issueLine(issue: string): string {
  return issue.startsWith(VIEW_TEXTS.issue) ? issue : `${VIEW_TEXTS.issue}: ${issue}`
}

/** 続報のつながりの中の、前の話題と、もっと新しい話題（いちばん新しい1本） */
function threadLinks(topic: ShownTopic, thread: readonly ThreadTopic[] | null) {
  if (!thread) return { prev: null, newer: null }
  const prev = topic.followUp ? (thread.find((t) => t.id === topic.followUp?.prevTopicId && t.id !== topic.id) ?? null) : null
  const later = thread.filter((t) => t.editionId > topic.editionId && t.id !== topic.id)
  return { prev, newer: later.length ? later[later.length - 1] : null }
}

export function TopicDetail({
  topic,
  corrections,
  mode,
  hiddenTermIds,
  pressed,
  onPressKnown,
  onUndoKnown,
  thread,
  onOpenTopic,
  noteCloser,
}: TopicDetailProps): JSX.Element {
  const rootRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const noteId = `${useId()}-term-note`
  const [openTerm, setOpenTerm] = useState<OpenTerm | null>(null)

  // 用語の印（話題ごとに1回。描き直すたびに区切りを作り直さない）
  const hitsByKey = useMemo(() => {
    const hits = findTermHits(detailTextFields(topic), topic.terms, (t) => hiddenTermIds.has(t.termId))
    const map = new Map<string, TermHit[]>()
    for (const h of hits) map.set(h.key, [...(map.get(h.key) ?? []), h])
    return map
  }, [topic, hiddenTermIds])
  const termsById = useMemo(() => new Map(topic.terms.map((t) => [t.termId, t])), [topic])
  const listedTerms = useMemo(() => {
    const seen = new Set<string>()
    return topic.terms.filter((t) => {
      if (hiddenTermIds.has(t.termId) || seen.has(t.termId)) return false
      seen.add(t.termId)
      return true
    })
  }, [topic, hiddenTermIds])

  // 中身が出た時に、フォーカスが中身に無ければ見出しへ（シート・パネルが読む間を先に出して［×］などにフォーカスがあった時。
  // シート・パネルがもう見出しへ移していれば何もしない。設計: 段階2の 2. の「フォーカス」）
  useEffect(() => {
    if (!rootRef.current?.contains(document.activeElement)) titleRef.current?.focus({ preventScroll: true })
  }, [])

  const closeNote = (focus = true) => {
    const button = openTerm?.button
    setOpenTerm(null)
    if (focus && button?.isConnected) button.focus()
  }
  const toggleTerm = (termId: string, key: string, button: HTMLButtonElement) => {
    if (openTerm?.termId === termId) closeNote()
    else setOpenTerm({ termId, key, button })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || !openTerm) return
    // 日本語の変換を取り消す Esc では閉じない（src/ui/Modal.tsx と同じ）
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    e.stopPropagation()
    closeNote()
  }
  // シート・パネルが Esc で閉じる前に呼ぶ関数（描くたびに今の箱を見る物に替える。描いた直後に替え、押した Esc を取りこぼさない）
  useLayoutEffect(() => {
    if (!noteCloser) return
    noteCloser.current = () => {
      if (!openTerm) return false
      closeNote()
      return true
    }
    return () => {
      noteCloser.current = null
    }
  })

  /** 欄の文（強調と用語の印つき） */
  const rich = (key: string, text: string): ReactNode => (
    <RichText
      text={text}
      phrases={topic.emphasis[key] ?? NONE}
      hits={hitsByKey.get(key) ?? NONE}
      openTermId={openTerm?.termId ?? null}
      noteId={noteId}
      onPressTerm={(termId, button) => toggleTerm(termId, key, button)}
    />
  )
  /** その欄の段落のすぐ下に開く説明の箱 */
  const note = (key: string): ReactNode => {
    if (!openTerm || openTerm.key !== key) return null
    const term = termsById.get(openTerm.termId)
    if (!term) return null
    return (
      <TermNote
        term={term}
        id={noteId}
        pressed={pressed[term.termId]}
        onPressKnown={onPressKnown}
        onUndoKnown={onUndoKnown}
        onClose={() => closeNote()}
      />
    )
  }
  /** 欄の段落と、その下の説明の箱 */
  const field = (key: string, text: string, className = 'topic-text'): ReactNode => (
    <>
      <p className={className}>{rich(key, text)}</p>
      {note(key)}
    </>
  )
  const timelineList = () =>
    topic.timeline.length ? (
      <ol className="topic-timeline">
        {topic.timeline.map((e, i) => {
          const when = timelineWhenText(e.when)
          const key = `timeline.${i}.text`
          return (
            <li key={i}>
              <p className="topic-text">
                {when ? <span className="topic-when">{when}</span> : null}
                {rich(key, e.text)}
              </p>
              {note(key)}
            </li>
          )
        })}
      </ol>
    ) : null

  const conclusionLabel = conclusionLabelText(topic.conclusion.label)
  const { prev, newer } = threadLinks(topic, thread)
  const view = topic.view

  return (
    <article
      ref={rootRef}
      className="topic-detail"
      data-testid={testIds.topicDetail}
      data-topic-id={topic.id}
      data-mode={mode}
      onKeyDown={onKeyDown}
    >
      {topic.major || topic.followUp ? (
        <p className="topic-head">
          {topic.major ? <span className="topic-major">{CARD_TEXTS.major}</span> : null}
          {topic.followUp ? <span className="topic-tag">{CARD_TEXTS.followUp}</span> : null}
        </p>
      ) : null}

      {corrections.length ? (
        <div className="topic-corrections">
          {corrections.map((c) => (
            <p key={c.id} className="topic-correction" data-testid={testIds.topicCorrection}>
              {FIXED_TEXTS.correctionPrefix} {c.text}
            </p>
          ))}
        </div>
      ) : null}

      <h3 ref={titleRef} className="topic-title" tabIndex={-1}>
        {topic.headline}
      </h3>

      {conclusionLabel || topic.conclusion.breaking || topic.conclusion.note ? (
        <div className="topic-conclusion">
          {conclusionLabel || topic.conclusion.breaking ? (
            <p className="topic-conclusion-labels">
              {conclusionLabel ? <span className="topic-label">{conclusionLabel}</span> : null}
              {topic.conclusion.breaking ? <span className="topic-breaking">{BREAKING_LABEL}</span> : null}
            </p>
          ) : null}
          {topic.conclusion.note ? field('conclusion.note', topic.conclusion.note, 'topic-text topic-conclusion-note') : null}
        </div>
      ) : null}

      {topic.summary ? field('summary', topic.summary, 'topic-text topic-summary') : null}

      {topic.followUp ? (
        <section className="topic-section topic-follow-up">
          <p className="topic-text">
            <span className="topic-follow-up-head">{FOLLOW_UP_PREFIX} </span>
            {rich('followUp.whatsNew', topic.followUp.whatsNew)}
          </p>
          {note('followUp.whatsNew')}
          {timelineList()}
          {prev ? (
            <button type="button" className="topic-thread-link" onClick={() => onOpenTopic(prev.id)}>
              {PREV_TOPIC_PREFIX} {threadLinkText(prev.headline, editionNameOfId(prev.editionId))}
            </button>
          ) : null}
        </section>
      ) : null}

      {newer ? (
        <button type="button" className="topic-thread-link" onClick={() => onOpenTopic(newer.id)}>
          {NEWER_TOPIC_PREFIX} {threadLinkText(newer.headline, editionNameOfId(newer.editionId))}
        </button>
      ) : null}

      <section className="topic-section">
        <h4 className="topic-section-head">{DETAIL_HEADS.soWhat}</h4>
        {(Object.keys(SO_WHAT_LABELS) as (keyof typeof SO_WHAT_LABELS)[]).map((k) => {
          const text = topic.soWhat[k]
          return (
            <div key={k} className="topic-so-what">
              <p className="topic-sub">{SO_WHAT_LABELS[k]}</p>
              {text ? field(`soWhat.${k}`, text) : <p className="topic-text topic-none">{FIXED_TEXTS.soWhatNone}</p>}
            </div>
          )
        })}
      </section>

      {topic.stakeholders.length ? (
        <section className="topic-section">
          <h4 className="topic-section-head">{DETAIL_HEADS.stakeholders}</h4>
          <p className="topic-note">{FIXED_TEXTS.stakeholdersNote}</p>
          <ul className="topic-list">
            {topic.stakeholders.map((s, i) => (
              <li key={i} className="topic-stakeholder">
                <p className="topic-stakeholder-head">
                  <span className="topic-stakeholder-name">{s.name}</span>
                  <span className="topic-label">{stanceLabel(s.stance)}</span>
                  {s.stanceNote ? <span className="topic-stance-note">{s.stanceNote}</span> : null}
                </p>
                {s.claim ? (
                  field(`stakeholders.${i}.claim`, s.claim)
                ) : (
                  <p className="topic-text topic-none">{FIXED_TEXTS.claimUnverified}</p>
                )}
                {s.reason ? field(`stakeholders.${i}.reason`, s.reason, 'topic-text topic-reason') : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view ? (
        <section className="topic-section">
          <h4 className="topic-section-head">{DETAIL_HEADS.view}</h4>
          {view.kind === 'opposed' ? (
            <>
              <p className="topic-axis">
                {VIEW_TEXTS.axis}: {view.axis}
              </p>
              {view.issue ? <p className="topic-axis">{issueLine(view.issue)}</p> : null}
              {topic.genre === 'ai' ? <p className="topic-note topic-ai-note">{FIXED_TEXTS.aiGenreNote}</p> : null}
              <p className="topic-sub">{VIEW_TEXTS.aiView}</p>
              {field('view.aiView', view.aiView)}
              <p className="topic-sub">{VIEW_TEXTS.counterView}</p>
              {field('view.counterView', view.counterView)}
              {/* 共通の注記は、見解と対立見解がある時だけ（none には注記の文が指す物が無い。docs/SPEC.md の 5.7 を変えた。設計: 段階2の 1.10） */}
              <p className="topic-note topic-common-note">{FIXED_TEXTS.commonNote}</p>
            </>
          ) : (
            <p className="topic-text">{view.noneReason ?? FIXED_TEXTS.viewNone}</p>
          )}
        </section>
      ) : null}

      {!topic.followUp && topic.timeline.length ? (
        <section className="topic-section">
          <h4 className="topic-section-head">{DETAIL_HEADS.timeline}</h4>
          {timelineList()}
        </section>
      ) : null}

      {topic.unverified.length ? (
        <details className="topic-unverified">
          <summary>{unverifiedText(topic.unverified.length)}</summary>
          <ul className="topic-list">
            {topic.unverified.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {listedTerms.length ? (
        <section className="topic-section">
          <h4 className="topic-section-head">{DETAIL_HEADS.terms}</h4>
          <ul className="topic-list topic-terms">
            {listedTerms.map((t: TopicTerm) => {
              const asOf = asOfText(t.asOf)
              return (
                <li key={t.termId} className="topic-term" data-term-id={t.termId}>
                  <p className="topic-term-head">
                    <span className="topic-term-name">{t.term}</span>
                    {asOf ? <span className="term-asof">{asOf}</span> : null}
                  </p>
                  <p className="topic-term-text">{t.explanation}</p>
                  <KnownControl term={t} pressed={pressed[t.termId]} onPressKnown={onPressKnown} onUndoKnown={onUndoKnown} />
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {topic.sources.length ? (
        <section className="topic-section topic-sources">
          <h4 className="topic-section-head">{DETAIL_HEADS.sources}</h4>
          <ul className="topic-list">
            {topic.sources.map((s, i) => {
              const name = `${s.outlet}「${s.title}」`
              return (
                <li key={i} className="topic-source">
                  {s.link ? (
                    <a className="topic-source-link" href={s.link} target="_blank" rel="noopener noreferrer">
                      {/* 名前とアイコンを1つにまとめる（指の端末でリンクを 34px の高さの flex にしても、アイコンが名前の後に並ぶ。topic.css） */}
                      <span className="topic-source-label">
                        {name}
                        <ExternalLinkIcon small />
                      </span>
                    </a>
                  ) : (
                    <span className="topic-source-name">{name}</span>
                  )}
                  <span className="topic-source-meta">
                    {sourceDateText(s)}
                    {s.via ? viaText(s.via) : ''}
                  </span>
                  {!s.link && s.url ? <span className="topic-url">{s.url}</span> : null}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      <footer className="topic-foot">
        {topic.check ? <p>{checkText(topic.check.claims, topic.check.fixed)}</p> : null}
        {topic.rankReason ? <p>{rankReasonText(topic.rank, topic.rankReason)}</p> : null}
        <p>{writerText(topic.ai)}</p>
      </footer>
    </article>
  )
}
