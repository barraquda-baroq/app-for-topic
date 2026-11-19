// アプリの外（コネクタ）へページごと移る（テストで差し替えられるように分けておく。NS の src/features/claude/leave.ts と同じ）
export function leaveTo(url: string): void {
  window.location.assign(url)
}
