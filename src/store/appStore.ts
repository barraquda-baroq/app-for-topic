// 端末の中の保存の入れ物（docs/SPEC.md の 14.4）。DS の src/store/appStore.ts の initStore・getPersistence の名前だけを写した物
// （段階0にはデータが無いので、保存先を開いて持つだけ。段階1で DS と同じくデータの読み込み・保存を足す）
import { createPersistence, type Persistence } from '../db/persistence'

let persistence: Persistence | null = null

/** 端末の中の保存先（initStore の前は null） */
export function getPersistence(): Persistence | null {
  return persistence
}

/** 起動時に呼ぶ（src/main.tsx。ログインの状態を確かめる前に） */
export async function initStore(p: Persistence = createPersistence()): Promise<void> {
  persistence = p
}

/** テスト用 */
export function resetStoreForTests(): void {
  persistence = null
}
