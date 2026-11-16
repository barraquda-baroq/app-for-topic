// 開発用のフック（window.__ts。開発サーバーだけ。src/main.tsx）の既読・「知ってる」・見た版・詳細を開く（docs/SPEC.md の 16.3 の「開発サーバー」）。
// 段階1には既読・「知ってる」を付ける画面の操作が無かったので、エミュレーターにつないだ開発サーバーと同期の E2E
// （e2e/data.sync.spec.ts）で、ストアの関数（src/store/appStore.ts の markRead・know）を話題の id・語の id だけで呼べるようにした
// （段階2で画面の操作を作った後も、E2E と見本が場面を作るのに使う）。
// 段階2で、版を見たにする（追いつきの見本・E2E。ストアの markSeen）と、今の行き先に詳細の印を積んで開く（詳細の E2E がトップのカードを
// 待たずに詳細を開く。src/features/topic/sheets.ts の sheetState。設計: 段階2の 4.2）を足した。
// 付ける決まり（30件まで・重なり無し・30日の内の版だけ・端末に書く前の確かめ）はストアの関数のまま。公開するビルドでは src/main.tsx の
// 開発用の分岐ごと使われないので、ビルドに入らない
import type { createHashRouter } from 'react-router-dom'
import { editionIdOfRecordId, TOPIC_ID_RE } from '../domain/ids'
import type { KnownTerm, ReadMark } from '../domain/types'
import { sheetOf, sheetState, type PanelSide } from '../features/topic/sheets'
import { know, markRead, markSeen, useApp, type EditResult } from './appStore'

/** 話題を読んだ（版の id は話題の id の頭から引く。window.__ts.markRead(topicId)） */
export function markReadTopic(topicId: string): EditResult<ReadMark> {
  const editionId = typeof topicId === 'string' && TOPIC_ID_RE.test(topicId) ? editionIdOfRecordId(topicId) : null
  if (!editionId) return { ok: false, reason: 'invalid' }
  return markRead(editionId, topicId)
}

/**
 * 語を「知ってる」にする（window.__ts.know(termId)）。押した時の表記と説明の時点（asOf）は、開いている版（トップはいちばん新しい
 * 出せる版）の話題の用語から取る（画面の［知ってる］も、開いた話題の用語から押すため。docs/SPEC.md の 7.4）。開いている版の話題に
 * その語が無ければ missing
 */
export function knowTerm(termId: string): EditResult<KnownTerm> {
  const s = useApp.getState()
  if (s.status !== 'ready') return { ok: false, reason: 'not-ready' }
  const view = s.opened.view
  if (view?.kind === 'ready') {
    for (const topic of view.topics) {
      const term = topic.terms.find((t) => t.termId === termId)
      if (term) return know({ termId, term: term.term, asOf: term.asOf })
    }
  }
  return { ok: false, reason: 'missing' }
}

/**
 * 版の一覧を見たにする（window.__ts.markSeen(editionId)。追いつきの見本・E2E で「どこまで見たか」を作る）。決まり（30日の内の版だけ・
 * 戻さない・形の違う id は invalid）はストアの markSeen のまま
 */
export function markSeenEdition(editionId: string): EditResult<ReadMark> {
  return markSeen(editionId)
}

/** 詳細を開くのに動かすルーター（src/App.tsx の appRouter() の値。テストは createMemoryRouter の値） */
export type SheetRouter = ReturnType<typeof createHashRouter>

/**
 * 話題の詳細を開く（window.__ts.openTopic(topicId, side?)）。今の行き先のまま、履歴の state に詳細の印（sheetState）を積む
 * （画面の［カード］と同じ形。もう開いている時は置き換えて、履歴を増やさない）。side は L で重ねる列（'jp'・'world'。渡さない・ほかの値は
 * null = 真ん中の小さな画面かシート）。どの話題か・出せるかは確かめない（出せない話題は詳細の部品が閉じる）。ルーターがまだ無い・
 * id が空の時は false
 */
export function openTopicSheet(router: SheetRouter | null, topicId: string, side: PanelSide | null = null): boolean {
  if (!router || typeof topicId !== 'string' || topicId === '') return false
  const loc = router.state.location
  const rest = loc.state && typeof loc.state === 'object' ? { ...(loc.state as Record<string, unknown>) } : {}
  const lane = side === 'jp' || side === 'world' ? side : null
  void router.navigate(
    { pathname: loc.pathname, search: loc.search },
    { state: { ...rest, ...sheetState(topicId, lane) }, replace: sheetOf(loc.state) !== null },
  )
  return true
}
