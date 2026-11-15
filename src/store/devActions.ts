// 開発用のフック（window.__ts。開発サーバーだけ。src/main.tsx）の既読・「知ってる」（docs/SPEC.md の 16.3 の「開発サーバー」）。
// 段階1には既読・「知ってる」を付ける画面の操作が無い（段階2）ので、エミュレーターにつないだ開発サーバーと同期の E2E
// （e2e/data.sync.spec.ts）で、ストアの関数（src/store/appStore.ts の markRead・know）を話題の id・語の id だけで呼べるようにする。
// 付ける決まり（30件まで・重なり無し・30日の内の版だけ・端末に書く前の確かめ）はストアの関数のまま。公開するビルドでは src/main.tsx の
// 開発用の分岐ごと使われないので、ビルドに入らない
import { editionIdOfRecordId, TOPIC_ID_RE } from '../domain/ids'
import type { KnownTerm, ReadMark } from '../domain/types'
import { know, markRead, useApp, type EditResult } from './appStore'

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
