// 画面を閉じる・裏に回る・再読み込みする・アプリを更新する時の保存処理。DS の src/store/lifecycle.ts から（DS は NS の物から）。
// 段階1で、端末への保存（ストアの flushNow）と、送信待ちをすぐ送る（同期のエンジン）を足した（docs/SPEC.md の 7.8 の「部品」の
// saveBeforeLeave）。DS の復旧用の控え（writeRecoveryJournal）は写さない（TS のアプリの記録は既読・知ってるだけで、保存を待つのは
// 長くて 2秒。src/store/appStore.ts）
import { uploadNow } from '../sync/controller'
import { flushNow } from './appStore'
import { flushAllDrafts } from './draftRegistry'

/**
 * 入力欄の下書きをすべてストアへ反映し、まだ保存できていない変更を端末に書き、送信待ちをすぐ送り始める。端末に書けたら true、
 * 書けなかったら false（送るのは待たない）。pagehide / visibilitychange(hidden) / アプリ更新の前に呼ぶ。
 */
export async function saveBeforeLeave(): Promise<boolean> {
  flushAllDrafts()
  const saved = await flushNow()
  uploadNow()
  return saved
}

let installed = false

export function installLeaveHandlers(): void {
  if (installed) return
  installed = true
  window.addEventListener('pagehide', () => void saveBeforeLeave())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void saveBeforeLeave()
  })
}
