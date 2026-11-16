// 話題の詳細を出す所（docs/SPEC.md の 9. の「詳細」・14.5）。src/App.tsx の RootLayout（ログインの関所の中・画面の後）に1つだけ置く
// （画面ごとに置かない。どの画面から開いても、履歴の state.sheet を見てここが出す。設計: 段階2の 1.9）。
// - 出し方: S・M は下からのシート（TopicSheet = 今の Modal）。L は state.sheet.side の列の差し込み口（PanelSlot）が出ていれば、その列に
//   重ねるパネル（TopicPanel）、出ていなければ（追いつきの画面・段階1の仮のトップ）真ん中の小さな画面（TopicSheet）。幅が変わる（向きを
//   変える）と、同じ state のままシートとパネルが入れ替わる（読んだ話題・押した［知ってる］は替わらない）
// - 話題と訂正: 開いている版（useApp の opened.view が ready）にその話題があればそれ（描画と同じ時にそろう。シートが空で開かない）、
//   無い時（追いつきの画面・前の話題へのリンク・読み込み直した後にほかの版の話題を開いていた）は loadTopicView で端末から読む（読む間は
//   「読み込み中…」）。読めない（30日で消えた・端末に無い）時は閉じる。端末の保存先が誤りを返した時（iPhone で裏から戻った直後の
//   IndexedDB の接続切れなど）も、読み込み中のまま止めずに同じく閉じる。開いている間は、版が替わっても読んだ写しのまま出す
// - 開いた時に、その話題を既読にし、その版を見たにもする（1回で書く。設計: 段階2の 1.6）
// - 読み込み直した後（state.sheet が前のページの物）: 端末の中を読み終えて、その話題を読めれば開き直し（このページの印に替える）、
//   読めなければ閉じる（DS の SheetHost と同じ。印を外すまでの間に一瞬出さない）
// - ［知ってる］は閉じた時に書く（src/features/topic/useKnownPresses.ts）。閉じる・ほかの話題へ替わる・画面が替わると、話題ごとの部品
//   （OpenTopic）が消えて書く
// - 閉じた時のフォーカスは、シートとパネルが開いた所（カードの見出しのボタン）へ戻す。幅の切り替えでカードが描き直されて戻る先が無い
//   時・クリップの窓を開いたまま戻った時（窓が #root を inert にしていてシートが戻せない）は、同じ話題のカードへ戻す（段階2の通しの
//   確かめで足した。開発）。S・M は同じ話題が総合とジャンルの区切りに2回出るので、開いた時の区切りのカードを先に選び、無ければ画面に
//   見えている物を選ぶ（ジャンルの区切りから開いた時に、画面の外の総合のカードへ飛ばない。設計: 段階2の 2.）
// props・オブジェクトの鍵に know・markRead・markSeen を使わない（docs/SPEC.md の 16.6 の 59）
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { genreLabel, regionLabel, FIXED_TEXTS } from '../../domain/fixedTexts'
import { editionIdOfRecordId } from '../../domain/ids'
import type { ShownCorrection, ShownTopic } from '../../domain/repair'
import {
  loadTopicView,
  markRead,
  threadOf,
  useApp,
  type EditionView,
  type ThreadTopic,
  type TopicView,
} from '../../store/appStore'
import { notify } from '../../store/uiStore'
import { useWidthClass } from '../../ui/hooks'
import { testIds } from '../top/testIds'
import { editionNameOfId } from '../top/texts'
import { ClipButton } from './ClipButton'
import { DETAIL_TEXTS } from './detailTexts'
import { openedOnThisPage, sheetState, usePanelSlots, useCurrentLocation, useTopicSheet, type TopicSheetState } from './sheets'
import { TopicDetail } from './TopicDetail'
import { TopicPanel } from './TopicPanel'
import { TopicSheet } from './TopicSheet'
import { isKnownOrPressed, useKnownPresses } from './useKnownPresses'
import './topic.css'

const NO_CORRECTIONS: readonly ShownCorrection[] = []

/** 開いている版（ready）の中の、その話題（無ければ null） */
function topicInView(view: EditionView | null, id: string): ShownTopic | null {
  return view?.kind === 'ready' ? (view.topics.find((t) => t.id === id) ?? null) : null
}

/** 開いている版（ready）の中の、その話題の訂正（無ければ undefined） */
function correctionsInView(view: EditionView | null, id: string): ShownCorrection[] | undefined {
  return view?.kind === 'ready' ? view.corrections[id] : undefined
}

/** その要素のある一覧の区切り（S・M の 'all'・ジャンル、L の列の 'jp'・'world'・'other'。区切りの外なら null） */
function sectionOf(el: Element | null): string | null {
  return el?.closest(`[data-testid="${testIds.topSection}"]`)?.getAttribute('data-section') ?? null
}

/**
 * その話題のカードの見出しのボタンへフォーカスする（無ければ何もしない）。S・M は同じ話題が総合とジャンルに2回出て、「既読 n件」に
 * 畳んだ中の物は見えないので、見えている物（checkVisibility の無いブラウザは offsetParent で見る）のうち、開いた時の区切り（section）の
 * 物、無ければ画面の中にある物、それも無ければ DOM で最初の物を選ぶ（総合のカードは、ジャンルの区切りから開いた時には画面の外にある）
 */
function focusCardOf(topicId: string, section: string | null): void {
  const buttons: HTMLElement[] = []
  for (const card of document.querySelectorAll<HTMLElement>(`[data-testid="${testIds.topCard}"]`)) {
    if (card.getAttribute('data-topic-id') !== topicId) continue
    const button = card.querySelector<HTMLElement>('.top-card-open')
    if (!button || !(button.checkVisibility?.({ visibilityProperty: true }) ?? button.offsetParent !== null)) continue
    buttons.push(button)
  }
  const inView = (b: HTMLElement) => {
    const r = b.getBoundingClientRect()
    return r.height > 0 && r.bottom > 0 && r.top < window.innerHeight
  }
  const target =
    (section !== null ? buttons.find((b) => sectionOf(b) === section) : undefined) ?? buttons.find(inView) ?? buttons[0]
  target?.focus({ preventScroll: true })
}

/**
 * 詳細の題（版の行「11/15（日）12:00版・国内・経済」。分からない所は書かない。読む間は話題の id の頭の版だけ）。
 * docs/SPEC.md の 9.・設計: 段階2の 1.9
 */
export function topicTitle(topicId: string, topic: Pick<ShownTopic, 'editionId' | 'region' | 'genre'> | null): string {
  const editionId = topic?.editionId ?? editionIdOfRecordId(topicId)
  const parts = [editionId ? editionNameOfId(editionId) : null]
  if (topic) parts.push(regionLabel(topic.region), genreLabel(topic.genre))
  return parts.filter((s): s is string => Boolean(s)).join('・')
}

export function TopicHost(): JSX.Element | null {
  const { current } = useTopicSheet()
  const location = useLocation()
  if (!current) return null
  // 話題ごとに作り直す（前の話題・続報へのリンクで中身が替わると、押した［知ってる］を書き、読み直す）
  return <OpenTopic key={current.id} sheet={current} fresh={openedOnThisPage(location.state)} />
}

/** 開いている1つの話題（読んだ写し・続報のつながり・押した［知ってる］を持ち、シートかパネルに出す） */
function OpenTopic({ sheet, fresh }: { sheet: TopicSheetState; fresh: boolean }): JSX.Element | null {
  const { openTopic, closeTopic } = useTopicSheet()
  const navigate = useNavigate()
  const currentLocation = useCurrentLocation()
  const id = sheet.id
  // 開いた所の区切り（描く時のフォーカスは、まだ押したカードの見出しのボタンにある。閉じた時に戻す先を、同じ区切りのカードにする）
  const [openerSection] = useState(() => sectionOf(document.activeElement))
  const storeReady = useApp((s) => s.status === 'ready')
  const viewTopic = useApp((s) => topicInView(s.opened.view, id))
  const viewCorrections = useApp((s) => correctionsInView(s.opened.view, id))

  // 読んだ写し（開いている間は替えない。開いている版にあればそれ、無ければ端末から読んだ物）
  const [shown, setShown] = useState<TopicView | null>(null)
  if (shown === null && viewTopic) setShown({ kind: 'ready', topic: viewTopic, corrections: viewCorrections ?? [] })
  useEffect(() => {
    if (shown !== null || viewTopic || !storeReady) return
    let alive = true
    void loadTopicView(id).then(
      (v) => {
        if (alive) setShown((prev) => prev ?? v)
      },
      (e: unknown) => {
        // 端末から読めなかった（Dexie の誤り）: 「読み込み中…」のまま止めず、読めない時と同じく閉じる（下の effect が閉じる。
        // 設計: 段階2の 1.9 の「読めない時は閉じる」）。拒否を受けずに放っておくと、閉じもせず ×・Esc・戻るでしか抜けられない
        console.warn('話題を端末から読めませんでした', e)
        if (alive) setShown((prev) => prev ?? { kind: 'none' })
      },
    )
    return () => {
      alive = false
    }
  }, [id, shown, viewTopic, storeReady])

  // 読み込み直した後: 読めれば開き直し（このページの印に替える）、読めなければ閉じる。このページで開いた物は、読めなければ閉じる
  useEffect(() => {
    if (shown === null) return
    if (shown.kind !== 'ready') {
      if (fresh && shown.kind === 'newer') notify(FIXED_TEXTS.newerRecord)
      closeTopic()
      return
    }
    if (fresh) return
    const loc = currentLocation()
    const state = loc.state && typeof loc.state === 'object' ? (loc.state as Record<string, unknown>) : {}
    void navigate(
      { pathname: loc.pathname, search: loc.search },
      { replace: true, state: { ...state, ...sheetState(id, sheet.side) } },
    )
  }, [shown, fresh])

  // 開いた時に、その話題を既読に・その版を見たに（1回だけ）
  const topic = shown?.kind === 'ready' ? shown.topic : null
  const readDone = useRef(false)
  useEffect(() => {
    if (!fresh || !topic || readDone.current) return
    readDone.current = true
    markRead(topic.editionId, topic.id, { seen: true })
  }, [fresh, topic])

  // 続報のつながり（前の話題・もっと新しい話題へのリンク）
  const [thread, setThread] = useState<ThreadTopic[] | null>(null)
  useEffect(() => {
    if (!topic) return
    let alive = true
    void threadOf(topic.threadId).then(
      (t) => {
        if (alive) setThread(t)
      },
      (e: unknown) => {
        // 端末から読めなかった: つながりのリンク（前の話題・続報あり）を出さないだけにする（本文はもう読めている。設計: 段階2の 1.16）
        console.warn('続報のつながりを端末から読めませんでした', e)
        if (alive) setThread([])
      },
    )
    return () => {
      alive = false
    }
  }, [topic])

  // 開いた時に「知ってる」だった語（開いている間は替えない。押した語・裏になって書いた語も、閉じるまで出したまま）。
  // 閉じずにほかの話題から替わった時は、前の話題で押した語はまだ書いていない（前の部品の後片付けで書くのは、この部品を描いた後）ので、
  // まだ書いていない押した語も数える（設計: 段階2の 1.13 の「次に開いた時から出さない（本文の印も付けない）」・docs/SPEC.md の 5.8）
  const hiddenTermIds = useMemo<ReadonlySet<string>>(() => {
    if (!topic) return new Set()
    const user = useApp.getState().user
    return new Set(topic.terms.filter((t) => isKnownOrPressed(user, t.termId, t.asOf)).map((t) => t.termId))
  }, [topic])
  const presses = useKnownPresses()

  // 閉じた後にフォーカスがどこにも無い時は、同じ話題のカードの見出しのボタンへ戻す。開いた所へ戻すのはシート（Modal）とパネルだが、
  // 開いた所のカードが幅の切り替え（パネルとシートの入れ替え）で描き直された時・読み込み直した後に開き直した時は、戻る先が無くなって
  // いる（開発。設計: 段階2の 2. の「閉じた時は開いたカードの見出しのボタンへ」・8. の 8）。この後片付けはシートとパネルが
  // フォーカスを戻した後（useEffect の後片付けは描いた後に動く）なので、戻せた時は何もしない
  useEffect(
    () => () => {
      const active = document.activeElement
      if (!active || active === document.body) focusCardOf(id, openerSection)
    },
    [id, openerSection],
  )

  // 説明の箱が開いている時の Esc は、フォーカスが中身の外（［クリップ］・body）にあっても箱だけを閉じる（中身の TopicDetail が入れる。
  // 設計: 段階2の 1.12・2. の「説明の箱が開いている時は先に箱だけを閉じて止める」）
  const noteCloser = useRef<(() => boolean) | null>(null)
  const onEscape = useCallback(() => noteCloser.current?.() ?? false, [])

  const width = useWidthClass()
  const slot = usePanelSlots((s) => (sheet.side ? s[sheet.side] : null))
  const asPanel = width === 'L' && slot !== null

  if (!fresh || (shown !== null && shown.kind !== 'ready')) return null
  const corrections = shown?.kind === 'ready' ? shown.corrections : NO_CORRECTIONS
  const title = topicTitle(id, topic)
  const clip = topic ? <ClipButton topic={topic} corrections={corrections} /> : null
  const body = topic ? (
    <TopicDetail
      topic={topic}
      corrections={corrections}
      mode={asPanel ? 'panel' : 'sheet'}
      hiddenTermIds={hiddenTermIds}
      pressed={presses.pressed}
      onPressKnown={presses.press}
      onUndoKnown={presses.undo}
      thread={thread}
      onOpenTopic={(topicId) => openTopic(topicId)}
      noteCloser={noteCloser}
    />
  ) : (
    <p className="muted topic-loading" role="status">
      {DETAIL_TEXTS.loading}
    </p>
  )
  if (asPanel)
    return (
      <TopicPanel slot={slot} title={title} actions={clip} onClose={closeTopic} onEscape={onEscape}>
        {body}
      </TopicPanel>
    )
  return (
    <TopicSheet title={title} footer={clip} onClose={closeTopic} onEscape={onEscape}>
      {body}
    </TopicSheet>
  )
}
