// 一覧のカード（docs/SPEC.md の 9. の「一覧のカード」・5.10）。トップ（S・M・L）・前の版・追いつきの画面が同じ物を使う。
// 形（設計: 段階2の 1.5）: 箱で囲まず、行の下に 1px の線（DS の行の作り。D22）。上から
//   1. 頭の行（小さな字）: 重大印の札・「国内・経済」（分からない方は出さない）・「続報」・「続報あり」（前の版・追いつきだけ）・「訂正あり」・
//      追いつきの画面では版の名前
//   2. 見出し（太字・記事の字の大きさ --read-head）
//   3. 要約（強調あり・用語の印なし。カードは押すと詳細を開く所で、中に小さな押す所があると押し間違えるため。設計: 段階2の 1.12）
//   4. 下の行（小さな字）: 結論ラベル（知らない値は出さない）・「速報・未確認」・報じた社（頭から2社と n社）・「照合済み」
// 重大印は色に頼らず、「重大」の字の札とカードの左の縦線（--major-line = 字の色）で出す（オレンジは使わない。D8・■3 の A）。
// 押す所は見出しの <h3><button> で、カードのどこを押しても同じ物を開く（カードの onClick は見出しのボタンへ渡すだけ。入れ子のボタンを
// 作らない）。押すと onOpen(topic.id) を呼び、呼ぶ側が openTopic(id, { side }) を呼ぶ。
// 既読は data-read と淡い見出し（--read-text）。見た目は is-read などのクラスで分け、data-* を CSS で選ばない（src/screensCss.test.ts）。
// props の名前に know・markRead・markSeen を使わない（ビルドで縮んだ時に CI の grep に当たる。docs/SPEC.md の 16.6 の 59）
import { useRef, type JSX, type MouseEvent } from 'react'
import { BREAKING_LABEL, conclusionLabelText, genreLabel, regionLabel } from '../../domain/fixedTexts'
import type { ShownTopic } from '../../domain/repair'
import { RichText } from '../topic/RichText'
import { CARD_TEXTS, outletsText, SECTION_TEXTS } from './texts'
import { testIds } from './testIds'

export interface TopCardProps {
  topic: ShownTopic
  /** 訂正がある（「訂正あり」・data-correction） */
  corrected: boolean
  /** 既読（淡い見出し・data-read） */
  read: boolean
  /** もっと新しい続報が端末にある（前の版・追いつきだけ。「続報あり」） */
  hasNewer?: boolean
  /** 頭の行に出す版の名前（追いつきの画面。「11/14（土）20:00版」） */
  editionName?: string | null
  /** 押した時（呼ぶ側が openTopic(id, { side }) を呼ぶ。TopWide は panelSideFor(列) で side を決める） */
  onOpen: (topicId: string) => void
}

/** 地域とジャンルの言葉（「国内・経済」。分からない方は書かない。両方分からなければ null。docs/SPEC.md の 7.1） */
export function placeText(topic: Pick<ShownTopic, 'region' | 'genre'>): string | null {
  const parts = [regionLabel(topic.region), genreLabel(topic.genre)].filter((s): s is string => s !== null)
  return parts.length ? parts.join('・') : null
}

export function TopCard({ topic, corrected, read, hasNewer = false, editionName = null, onOpen }: TopCardProps): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  const place = placeText(topic)
  const label = conclusionLabelText(topic.conclusion.label)
  const outlets = outletsText(topic.outletNames)
  // カードのどこを押しても見出しのボタンと同じにする（ボタンそのものを押した時はボタンが開く。字を選んでいる時は開かない）。
  // 先にボタンへフォーカスを移しておく（閉じた時に、詳細の部品がフォーカスをこのボタンへ戻すため。設計: 段階2の 2.）
  const onCardClick = (e: MouseEvent<HTMLElement>) => {
    const btn = button.current
    if (!btn || btn.contains(e.target as Node)) return
    if (window.getSelection?.()?.toString()) return
    btn.focus({ preventScroll: true })
    btn.click()
  }
  const className = ['top-card', topic.major ? 'is-major' : '', read ? 'is-read' : ''].filter(Boolean).join(' ')
  return (
    <article
      className={className}
      data-testid={testIds.topCard}
      data-topic-id={topic.id}
      data-read={read ? 'true' : undefined}
      data-major={topic.major ? 'true' : undefined}
      data-correction={corrected ? 'true' : undefined}
      onClick={onCardClick}
    >
      <p className="top-card-meta">
        {topic.major ? <span className="top-card-major">{CARD_TEXTS.major}</span> : null}
        {editionName ? <span className="top-card-edition">{editionName}</span> : null}
        {place ? <span>{place}</span> : null}
        {topic.followUp ? <span>{CARD_TEXTS.followUp}</span> : null}
        {hasNewer ? <span>{CARD_TEXTS.hasNewer}</span> : null}
        {corrected ? <span className="top-card-corrected">{CARD_TEXTS.corrected}</span> : null}
      </p>
      <h3 className="top-card-head">
        <button ref={button} type="button" className="top-card-open" onClick={() => onOpen(topic.id)}>
          {topic.headline}
        </button>
      </h3>
      {topic.summary ? (
        <p className="top-card-summary">
          <RichText text={topic.summary} phrases={topic.emphasis.summary} />
        </p>
      ) : null}
      <p className="top-card-foot">
        {label ? <span className="top-card-label">{label}</span> : null}
        {topic.conclusion.breaking ? <span className="top-card-breaking">{BREAKING_LABEL}</span> : null}
        {outlets ? <span className="top-card-outlets">{outlets}</span> : null}
        {topic.check ? <span>{CARD_TEXTS.checked}</span> : null}
      </p>
    </article>
  )
}

/**
 * 話題が新しい形の記録の時の、押せない淡いカード（その話題の order の位置に置く。docs/SPEC.md の 7.1。設計: 段階2の 1.21）。
 * 地域・ジャンルが読めないので、総合（L は国内の列の下の「そのほか」）にだけ出す
 */
export function NewerTopicCard({ topicId }: { topicId: string }): JSX.Element {
  return (
    <article className="top-card is-newer" data-testid={testIds.topCard} data-topic-id={topicId}>
      <p className="top-card-newer">{SECTION_TEXTS.newerTopic}</p>
    </article>
  )
}
