// トップの画面（docs/SPEC.md の 9.・14.5）と前の版（#/e/{版の id}。同じ画面で開く。設計: 段階2の 1.3〜1.8・2.）。
// - #/ はいちばん新しい出せる版に付いていく（ストアの openEdition(null)）。#/e/{id} はその版を開く（openEdition(id)。id が読めない時は
//   「見つかりません」）。ほかの画面（版の一覧・設定）へ移っても開いた版は変えない（版の一覧・ヘッダーの版の表示がその版のまま）
// - 並べ方は幅で替える: S・M は1列（TopStack。切り替えの列・総合とジャンル）、L は国内｜世界の2列（TopWide）
// - 既読を沈める並びは画面を出した時（この画面を開いた時・版が替わった時）に決め、その画面の間は変えない（詳細を閉じるたびにカードが動くと、
//   指の下で一覧がずれる。その場では淡くするだけ。設計: 段階2の 1.6）。別の端末の既読が届いても沈め直さない
// - 版を見たにするのは、同期が落ち着いた後に 3秒出ていた時か、一覧を操作した時だけ（src/features/top/useSeenMark.ts）
// - 前の版では「続報あり」（同じ続報のつながりのもっと新しい話題が端末にある）をカードに出す（その版の話題の threadId をまとめて引く。
//   20回の索引の読み。設計: 段階2の 1.16）
// - 版がまだ無い時は「まだ版はありません」と届く時期（top-empty。届く時刻の案内で足りる。docs/SPEC.md の 17.6 の 7・8）、出せる版が
//   無く話題がそろうのを待っている時は「版を受け取っています…」（top-waiting）。どちらの時も状態の1行・追いつきの帯は出さない（1.7・1.21）。
//   版の記録が新しい形の物だけで出せる版が無い時は、top-empty を出さず、状態の1行（新しい形の記録です…）を出す（届いているのに
//   「まだ版はありません」とは言わない。設計: 段階2の 1.7 の 0. と 3.）
// 言葉は src/features/top/texts.ts、testid は src/features/top/testIds.ts
import { useEffect, useMemo, useState, type JSX } from 'react'
import { useParams } from 'react-router-dom'
import { parseEditionId } from '../../domain/ids'
import { openEdition, threadsOf, useApp, type OpenedEdition } from '../../store/appStore'
import { useDocumentTitle, useWidthClass } from '../../ui/hooks'
import { AppHeader } from '../../ui/Layout'
import { NotFound } from '../../ui/NotFound'
import { NewerOnlyStatus, PastEditionStatus } from './EditionStatus'
import { TopStack } from './TopStack'
import { TopWide } from './TopWide'
import type { ReadyView, TopListState } from './TopSection'
import { EMPTY_NOTE, EMPTY_TITLE, PAST_TEXTS, WAITING_TEXT } from './texts'
import { testIds } from './testIds'
import { useSeenMark } from './useSeenMark'
import './top.css'

const NONE: readonly string[] = []

/**
 * 画面を出した時の既読（沈める並び）。出している版が替わった時だけ取り直す（その画面の間は、既読が増えても変えない）。
 * editionId が null（まだ出していない）の間は空
 */
function useSunkIds(editionId: string | null, readIds: readonly string[]): ReadonlySet<string> {
  const [snap, setSnap] = useState<{ editionId: string | null; ids: ReadonlySet<string> }>(() => ({
    editionId,
    ids: new Set(editionId === null ? NONE : readIds),
  }))
  if (snap.editionId !== editionId) {
    const next = { editionId, ids: new Set(editionId === null ? NONE : readIds) }
    setSnap(next)
    return next.ids
  }
  return snap.ids
}

/** 前の版の話題のうち、同じ続報のつながりのもっと新しい話題が端末にある物（前の版だけ。読み終えるまでは空） */
function useHasNewer(view: ReadyView | null, past: boolean): ReadonlySet<string> {
  const [found, setFound] = useState<{ editionId: string; ids: ReadonlySet<string> } | null>(null)
  const editionId = past && view ? view.editionId : null
  const topics = past && view ? view.topics : null
  useEffect(() => {
    if (editionId === null || !topics) return
    let alive = true
    void threadsOf(topics.map((t) => t.threadId)).then((threads) => {
      if (!alive) return
      const ids = new Set<string>()
      for (const t of topics) if ((threads[t.threadId] ?? []).some((x) => x.editionId > editionId)) ids.add(t.id)
      setFound({ editionId, ids })
    })
    return () => {
      alive = false
    }
  }, [editionId, topics])
  return found && found.editionId === editionId ? found.ids : EMPTY_SET
}

const EMPTY_SET: ReadonlySet<string> = new Set()

/**
 * 今の行き先で出す物。前の版（target が id）は、その版を開き終えるまで出さない（付いていく版が一瞬出ないように）。トップ（target が null）も、
 * 前の版から戻って付いていく版を読み終えるまで出さない
 */
function viewFor(opened: OpenedEdition, target: string | null): OpenedEdition | null {
  if (target === null) return opened.follow ? opened : null
  return !opened.follow && opened.view?.editionId === target ? opened : null
}

export function TopPage(): JSX.Element {
  const { editionId: param } = useParams()
  const target = param === undefined ? null : param
  const valid = target === null || parseEditionId(target) !== null
  useDocumentTitle(undefined)

  const opened = useApp((s) => s.opened)
  const reads = useApp((s) => s.user.reads)
  const shown = valid ? viewFor(opened, target) : null

  // 開く版（読めない id の時は開かない。その画面を離れても開いた版は変えない）。開いた後に、ほかの所（版の一覧・追いつきの画面・
  // 作り物の版を入れ終えた時）がトップに付いていく版へ戻した時も、この行き先の版を開き直す（開き終えて合えば、もう呼ばない）
  const matched = shown !== null
  useEffect(() => {
    if (valid) void openEdition(target)
  }, [target, valid])
  useEffect(() => {
    if (valid && !matched) void openEdition(target)
  }, [target, valid, matched, opened])
  const past = target !== null
  const view = shown?.view?.kind === 'ready' ? shown.view : null
  const editionId = view?.editionId ?? null
  const readIds = editionId === null ? NONE : (reads[editionId]?.topicIds ?? NONE)
  const sunk = useSunkIds(editionId, readIds)
  const hasNewer = useHasNewer(view, past)
  const corrections = view?.corrections
  const list = useMemo<TopListState | null>(
    () =>
      editionId === null
        ? null
        : {
            editionId,
            sunk,
            read: new Set(readIds),
            corrected: new Set(Object.entries(corrections ?? {}).flatMap(([id, cs]) => (cs.length ? [id] : []))),
            hasNewer,
          },
    [editionId, sunk, readIds, corrections, hasNewer],
  )
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  useSeenMark(editionId, root)
  const width = useWidthClass()

  if (!valid) return <NotFound />
  return (
    <>
      <AppHeader />
      {view && list ? (
        width === 'L' ? (
          <TopWide view={view} list={list} past={past} rootRef={setRoot} />
        ) : (
          <TopStack view={view} list={list} past={past} rootRef={setRoot} />
        )
      ) : (
        <main className="page page-narrow top" data-testid={testIds.topPage}>
          <h1 className="visually-hidden">トップ</h1>
          {shown ? <TopBlank opened={shown} past={past} /> : null}
        </main>
      )}
    </>
  )
}

/** 出せる版が無い時（前の版を開けない時・待つ間・版がまだ無い時） */
function TopBlank({ opened, past }: { opened: OpenedEdition; past: boolean }): JSX.Element {
  const kind = opened.view?.kind ?? null
  const hasNewer = useApp((s) => s.newerEditions.length > 0)
  if (past) {
    // 前の版: 話題がそろうのを待っている版は「版を受け取っています…」、新しい形の記録はそう言い、ほか（端末に無い・30日の外・出せない）は
    // 「この版は端末にありません」。どれも［いちばん新しい版へ］を添える
    if (kind === 'waiting')
      return (
        <>
          <p className="top-waiting" data-testid={testIds.topWaiting} role="status">
            {WAITING_TEXT}
          </p>
          <PastEditionStatus />
        </>
      )
    return <PastEditionStatus text={kind === 'newer' ? PAST_TEXTS.newer : PAST_TEXTS.notOnDevice} />
  }
  if (opened.waiting)
    return (
      <p className="top-waiting" data-testid={testIds.topWaiting} role="status">
        {WAITING_TEXT}
      </p>
    )
  // 新しい形の版の記録が届いている（出せる版は無い）: 「まだ版はありません」ではなく、アプリの更新が要る事を言う（設計: 段階2の 1.7 の 0.）
  if (hasNewer)
    return (
      <div className="top-notes">
        <NewerOnlyStatus />
      </div>
    )
  return (
    <div className="top-empty" data-testid={testIds.topEmpty}>
      <p className="top-empty-title">{EMPTY_TITLE}</p>
      <p className="top-empty-note">{EMPTY_NOTE}</p>
    </div>
  )
}
