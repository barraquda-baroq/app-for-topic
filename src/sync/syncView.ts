// 持ち主の確かめの状態と、ログインの画面に出す言葉（docs/SPEC.md の 14.4）。DS の src/sync/syncView.ts の持ち主の部分だけを写した物
// （同期の表示は段階1で足す）。ログインの画面が読むので、Firebase を読み込まない小さなファイルにしている

/** 持ち主の確かめ（形1） */
export type OwnerState = 'unknown' | 'checking' | 'ok' | 'missing' | 'mismatch'

/** 持ち主の記録がまだ無い時の言葉（ログインの画面） */
export const OWNER_MISSING_MESSAGE = '持ち主の記録がまだありません（docs/DEPLOY.md の 3）'
/** ほかのアカウントの記録の時の言葉（ログインの画面） */
export const OWNER_MISMATCH_MESSAGE = 'このアカウントは Topic Studio の持ち主ではありません'
