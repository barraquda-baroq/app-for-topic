// 追いつき（#/catch-up。docs/SPEC.md の 9. の「追いつき」・7.8 の「続報のつなぎ」の 3.。■8 の A。設計: 段階2の 1.8）: しばらく開かな
// かった後に、見ていない版の話題を、続報は threadId ごとに最新の1本にまとめ、重大印 → 各版の順位（order の位置）→ 新しい版の順で並べる。
// どの版を見ていないかで出し方を変えるだけで、選ぶ話題は変えない（D21）。トップの追いつきの帯から来た時も、行き先を直に開いた時も同じ。
// - 追いつく版はストアの catchUpTargets（新しい方から6版の中で、出している版より前で、最後に見た版より後の版）。catchUpTargets は
//   いちばん新しい出せる版に付いていく時の版を「出している版」にするので、開いた時に付いていく版を開き（openEdition(null)。前の版
//   #/e/{id} から来た時も。トップへ戻れば TopPage がその行き先の版を開き直す）、付いていく版が出せるようになった所で1回だけ決める。
//   決めた後は、見たにした・ほかの端末から既読が届いた、でも変えない（設計: 段階2の 1.8 の「開いた時に決めて画面の間は変えない」）。
//   出せる版がまだ無い間（版が届く前）は「追いつく版はありません」を出し、出せる版が届いた所で決める
// - 話題は loadCatchUp で、追いつく版だけを Dexie から読む（多くて5版・100本。30日分を読まない。16.6 の 56）。読み終えて並べたら、
//   追いつく版を全部「見た」にする（帯にも、次からこの画面にも出なくなる）
// - カードはトップと同じ TopCard に、頭の行の版の名前「11/14（土）20:00版」を付ける。既読は淡くするだけで沈めない。「続報あり」は、同じ
//   続報のつながりのもっと新しい話題が端末にある時（並べた後に threadsOf で引く。設計: 段階2の 1.16）
// - L も1列（page-narrow）。列の差し込み口（PanelSlot）が無いので、詳細は L でも真ん中の小さな画面（TopicHost が TopicSheet を出す。
//   side は null。DS の 3.8 と同じ。設計: 段階2の 1.9）
// - 0本なら「追いつく版はありません」だけ。並べた時は、話題の下に「見た版は、ここに出なくなります」
// testid catch-up-page の data-edition-ids（決めた追いつく版の id。新しい順・空白で区切る。決める前は無い）と aria-busy は、E2E と
// 見本が「決め終えた」を待つための物（CSS では選ばない）。props・オブジェクトの鍵に know・markRead・markSeen を使わない（16.6 の 59）
import { useCallback, useEffect, useState, type JSX } from 'react'
import { catchUpTargets, loadCatchUp, markSeen, openEdition, threadsOf, useApp, type CatchUpEntry } from '../../store/appStore'
import { useDocumentTitle } from '../../ui/hooks'
import { AppHeader } from '../../ui/Layout'
import { TopCard } from '../top/TopCard'
import { CATCH_UP_TEXTS, editionNameOfId } from '../top/texts'
import { testIds } from '../top/testIds'
import { useTopicSheet } from '../topic/sheets'
import '../top/top.css'
import './editions.css'

/** 読み込む間の言葉（ほかの画面の読み込みと同じ） */
export const LOADING_TEXT = '読み込み中…'

const NO_IDS: ReadonlySet<string> = new Set()

/**
 * 並べた話題のうち、同じ続報のつながりのもっと新しい話題が端末にある物（「続報あり」。読み終えるまでは空）。
 * 追いつきでは、つながりのいちばん新しい1本が今の版にある物は外してあるので、当たるのは、話題のそろわない版などにもっと新しい1本がある時
 */
function useHasNewer(entries: readonly CatchUpEntry[] | null): ReadonlySet<string> {
  const [found, setFound] = useState<{ of: readonly CatchUpEntry[]; ids: ReadonlySet<string> } | null>(null)
  useEffect(() => {
    if (!entries?.length) return
    let alive = true
    threadsOf(entries.map((e) => e.topic.threadId)).then(
      (threads) => {
        if (!alive) return
        const ids = new Set<string>()
        for (const { topic } of entries)
          if ((threads[topic.threadId] ?? []).some((t) => t.editionId > topic.editionId)) ids.add(topic.id)
        setFound({ of: entries, ids })
      },
      (e: unknown) => console.warn('続報のつながりを読めませんでした', e),
    )
    return () => {
      alive = false
    }
  }, [entries])
  return found && found.of === entries ? found.ids : NO_IDS
}

export function CatchUpPage(): JSX.Element {
  useDocumentTitle(CATCH_UP_TEXTS.title)
  const { openTopic } = useTopicSheet()
  const storeReady = useApp((s) => s.status === 'ready')
  const followReady = useApp((s) => s.opened.follow && s.opened.view?.kind === 'ready')
  const reads = useApp((s) => s.user.reads)
  /** 付いていく版を読み終えた（端末の中を読み終えた後に1回。それでも出せる版が無ければ「追いつく版はありません」） */
  const [followed, setFollowed] = useState(false)
  /** 追いつく版（開いた時に1回だけ決める。決める前は null） */
  const [targets, setTargets] = useState<readonly string[] | null>(null)
  /** 並べた話題（読み終えるまでは null） */
  const [entries, setEntries] = useState<readonly CatchUpEntry[] | null>(null)

  // 付いていく版を開く（端末の中を読み終える前に呼んでも読まないので、読み終えた時にもう一度呼んで、読み終えるのを待つ）
  useEffect(() => {
    let alive = true
    const done = openEdition(null)
    if (storeReady)
      void done.then(() => {
        if (alive) setFollowed(true)
      })
    return () => {
      alive = false
    }
  }, [storeReady])

  // 付いていく版が出せるようになった所で、追いつく版を1回だけ決める
  useEffect(() => {
    if (targets === null && followReady) setTargets(catchUpTargets(useApp.getState(), Date.now()))
  }, [targets, followReady])

  // 追いつく版の話題を読んで並べ、並べたら追いつく版を全部「見た」にする（読めなかった時は付けない）
  useEffect(() => {
    if (targets === null) return
    let alive = true
    loadCatchUp(targets).then(
      (list) => {
        if (!alive) return
        setEntries(list)
        for (const id of targets) markSeen(id)
      },
      (e: unknown) => {
        console.warn('追いつきの話題を読めませんでした', e)
        if (alive) setEntries([])
      },
    )
    return () => {
      alive = false
    }
  }, [targets])

  const hasNewer = useHasNewer(entries)
  // 列の無い画面なので、L でも真ん中の小さな画面（side は null）
  const onOpen = useCallback((topicId: string) => openTopic(topicId, { side: null }), [openTopic])
  const busy = targets === null ? !(followed && !followReady) : entries === null

  return (
    <>
      <AppHeader />
      <main
        className="page page-narrow catch-up"
        data-testid={testIds.catchUpPage}
        data-edition-ids={targets?.join(' ')}
        aria-busy={busy || undefined}
      >
        <h1 className="editions-head">{CATCH_UP_TEXTS.title}</h1>
        {busy ? (
          <p className="muted editions-loading" role="status">
            {LOADING_TEXT}
          </p>
        ) : entries?.length ? (
          <>
            <ol className="catch-up-list">
              {entries.map(({ topic, edition, corrections }) => (
                <li key={topic.id}>
                  <TopCard
                    topic={topic}
                    corrected={corrections.length > 0}
                    read={reads[topic.editionId]?.topicIds.includes(topic.id) ?? false}
                    hasNewer={hasNewer.has(topic.id)}
                    editionName={editionNameOfId(edition.id)}
                    onOpen={onOpen}
                  />
                </li>
              ))}
            </ol>
            <p className="catch-up-note">{CATCH_UP_TEXTS.note}</p>
          </>
        ) : (
          <p className="empty catch-up-empty">{CATCH_UP_TEXTS.empty}</p>
        )}
      </main>
    </>
  )
}
