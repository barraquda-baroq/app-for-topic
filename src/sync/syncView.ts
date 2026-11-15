// 持ち主の確かめの状態と、ログインの画面に出す言葉（docs/SPEC.md の 14.4）と、ヘッダーの同期の表示の状態（docs/SPEC.md の 7.8 の
// 「部品」・「持ち主・データの形の版・同期の表示」の8つ）。DS の src/sync/syncView.ts を写し、言葉を TS の物にした。
// 同期の司令塔（src/sync/controller.ts）が useSyncView に入れ、ヘッダーの src/ui/SyncIndicator.tsx が読む。ログインの画面・ヘッダーが
// 読むので、Firebase を読み込まない小さなファイルにしている（エンジンの型 SyncStatus は型だけを読む）
import { create } from 'zustand'
import { quotaResumeAt } from '../domain/dates'
import type { SyncStatus } from './engine'

/** 持ち主の確かめ（形1） */
export type OwnerState = 'unknown' | 'checking' | 'ok' | 'missing' | 'mismatch'

/** 持ち主の記録がまだ無い時の言葉（ログインの画面） */
export const OWNER_MISSING_MESSAGE = '持ち主の記録がまだありません（docs/DEPLOY.md の 3）'
/** ほかのアカウントの記録の時の言葉（ログインの画面） */
export const OWNER_MISMATCH_MESSAGE = 'このアカウントは Topic Studio の持ち主ではありません'

/**
 * 「同期できません（…）」の短い理由のうち、持ち主の記録が無い時の物（この端末で確かめたアカウントで記録が消えていた時。トップは出したまま
 * 同期だけを止め、ヘッダーに出す。docs/SPEC.md の 7.8・14.8 の 4）
 */
export const OWNER_MISSING_REASON = '持ち主の記録がまだありません'

/** 同期の状態（docs/SPEC.md の 7.8 の8つ） */
export type SyncView =
  | { kind: 'synced' }
  | { kind: 'sending' }
  | { kind: 'pending'; count: number }
  | { kind: 'downloading' }
  | { kind: 'offline' }
  /** 今日の無料枠を使い切った。resumeAt は戻る時刻（端末の時刻で「17:00」） */
  | { kind: 'quota'; resumeAt: string }
  | { kind: 'outdated' }
  | { kind: 'error'; reason: string }

/** 今の同期の状態（null は出さない。ログインしていない・持ち主だと確かめていない・まだ同期を始めていない） */
export const useSyncView = create<{ view: SyncView | null }>(() => ({ view: null }))

/** 止まっている理由の短い言葉（「同期できません（…）」の中。エンジンの errorCode から。DS と同じ物に、索引の無い時を足した） */
function shortReason(s: SyncStatus): string {
  switch (s.errorCode) {
    case 'owner-missing':
      return OWNER_MISSING_REASON
    case 'owner-mismatch':
      return 'このアカウントは持ち主ではありません'
    case 'permission-denied':
      return 'アクセスが拒否されました'
    case 'unauthenticated':
      return 'ログインし直してください'
    // TS は購読に索引（table＋updated）を使うので、公開し忘れた時の理由を短く出す（docs/SPEC.md の 7.7 の「索引」）
    case 'failed-precondition':
      return 'クラウドの索引がまだありません'
    default:
      return s.error ?? '不明なエラー'
  }
}

/**
 * 同期のエンジンの状態と持ち主の確かめから、ヘッダーの表示を決める（docs/SPEC.md の 7.8 の8つ。DS と同じ順で決める）。
 * 持ち主の記録が無い時は、エンジンを動かす前・エンジンが止まった後でも「同期できません（持ち主の記録がまだありません）」
 */
export function syncViewOf(s: { status: SyncStatus | null; owner: OwnerState }, now = Date.now()): SyncView | null {
  if (s.owner === 'missing') return { kind: 'error', reason: OWNER_MISSING_REASON }
  const st = s.status
  if (!st) return null
  if (st.outdated) return { kind: 'outdated' }
  if (st.phase === 'offline') return { kind: 'offline' }
  if (st.phase === 'error') {
    if (st.errorCode === 'quota') return { kind: 'quota', resumeAt: quotaResumeAt(now) }
    return { kind: 'error', reason: shortReason(st) }
  }
  if (st.phase === 'starting' || st.phase === 'downloading') return { kind: 'downloading' }
  if (st.phase === 'uploading') return { kind: 'sending' }
  if (st.pending > 0) return { kind: 'pending', count: st.pending }
  return { kind: 'synced' }
}

/** 表示の色の段: ok = そろっている（--text-faint）、busy = 送っている・未送信・受け取り中（--text-muted）、warn = 止まっている（--danger） */
export type SyncTone = 'ok' | 'busy' | 'warn'

/** 同期の状態の言葉（ヘッダーの M・L と、読み上げ。DS の syncBadge の言葉） */
export function syncLabel(view: SyncView): string {
  switch (view.kind) {
    case 'synced':
      return '同期済み'
    case 'sending':
      return '送信中…'
    case 'pending':
      return `未送信 ${view.count}件`
    case 'downloading':
      return '受け取り中…'
    case 'offline':
      return 'オフライン（端末に保存しています）'
    case 'quota':
      return `今日の無料枠を使い切りました（${view.resumeAt} ごろに戻ります）`
    case 'outdated':
      return '要更新（アプリを更新してください）'
    case 'error':
      return `同期できません（${view.reason}）`
  }
}

/**
 * 幅の狭い画面（S）のヘッダーに出す短い言葉。DS は S でアイコンだけにして小さな窓に詳しい字を出すが、TS の段階1はアイコンも小さな窓も
 * 持たないので、括弧の中を除いた短い字にする（詳しい字は読み上げと title に入れる。src/ui/SyncIndicator.tsx）
 */
export function syncShortLabel(view: SyncView): string {
  switch (view.kind) {
    case 'offline':
      return 'オフライン'
    case 'quota':
      return '無料枠を使い切りました'
    case 'outdated':
      return '要更新'
    case 'error':
      return '同期できません'
    default:
      return syncLabel(view)
  }
}

/** 同期の状態の色の段 */
export function syncTone(view: SyncView): SyncTone {
  switch (view.kind) {
    case 'synced':
      return 'ok'
    case 'sending':
    case 'pending':
    case 'downloading':
      return 'busy'
    default:
      return 'warn'
  }
}
