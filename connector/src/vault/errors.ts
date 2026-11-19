// コネクタの失敗（Claude に返す日本語の説明つき。NS の connector/src/vault/errors.ts を写し、名前と文を TS の物にした）。
// unpaired・identity_lost は認証の問題: MCP の呼び出しは HTTP 401 にして、claude.ai に接続し直してもらう。
// それ以外はツールの結果（isError）として、何をすればよいかを返す。
// TS の種類（B3。設計の 1.1 の「誤り」）: 回（run_*・slot_taken）・辞書の作り直し・下書き（draft_*。中身は B5）・取りに行く所（fetch_*。中身は B4）。
// 種類の名前はログに出る（code）。回の種類（kind）で分けない（D21・設計の 1.10）

export type ConnectorErrorCode =
  | 'unpaired'
  | 'identity_lost'
  | 'anonymous_disabled'
  | 'key_missing'
  | 'read_budget'
  | 'write_budget'
  | 'firestore_quota'
  | 'writes_off'
  | 'model_mismatch'
  | 'unavailable'
  | 'warming'
  /** 書き込みの前の取り込みが終わらない（端末からの変更が多い。少し待って試し直す） */
  | 'catching_up'
  | 'permission'
  | 'invalid'
  /** 回が見つからない（始めていない・期限で消えた） */
  | 'run_unknown'
  /** 古い回（始めて12時間を過ぎた） */
  | 'run_expired'
  /** 終わった回（版か作れなかった印を足した後） */
  | 'run_done'
  /** その回の種類では使えない道具 */
  | 'run_kind'
  /** 同じ枠の版の回が動いている（最後の呼び出しが10分以内） */
  | 'run_busy'
  /** 1日に始められる回の数を超えた（種類を分けない合計。候補を集める回の数も） */
  | 'run_limit'
  /** その枠の版がもうある */
  | 'slot_taken'
  /** 辞書を作り直している（今の表が無い間だけ） */
  | 'dictionary_rebuilding'
  /** 下書きが無い・数を超えた・照合の後で置き換えられない・読む前の照合・締め切りの後（B5） */
  | 'draft_unknown'
  | 'draft_limit'
  | 'draft_state'
  | 'draft_unread'
  | 'draft_deadline'
  /** 取りに行けない（robots.txt・AI の意思表示・規約・確認画面）・混んでいる・PDF・本文が短い・数を超えた・失敗した（B4） */
  | 'fetch_refused'
  | 'fetch_busy'
  | 'fetch_pdf'
  | 'fetch_short'
  | 'fetch_limit'
  | 'fetch_failed'

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode
  constructor(code: ConnectorErrorCode, message: string) {
    super(message)
    this.name = 'ConnectorError'
    this.code = code
  }
}

/** 接続し直してもらう失敗（HTTP 401） */
export function isAuthProblem(code: ConnectorErrorCode): boolean {
  return code === 'unpaired' || code === 'identity_lost'
}

export const MESSAGES = {
  unpaired:
    'Topic Studio 側で連携が解除されています（アプリの 設定 →「Claude との連携」）。claude.ai の「カスタマイズ → コネクタ」で Topic Studio に接続し直してください。',
  identityLost:
    'コネクタの身元（匿名のアカウント）が使えなくなりました。claude.ai の「カスタマイズ → コネクタ」で Topic Studio に接続し直し、アプリでもう一度許可してください。',
  anonymousDisabled:
    'Firebase の匿名ログインが無効です。Firebase コンソール → Authentication →「ログイン方法」で「匿名」を有効にしてください（docs/CONNECTOR.md の 1-A）。',
  keyMissing:
    'コネクタの鍵（TOKEN_ENC_KEY）が設定されていません。Mac か Windows で npm run connector:setup をもう一度実行してください。',
  writesOff:
    '書き込みは停止中です。アプリの 設定 →「Claude との連携」で「書き込みを許可」をオンにすると、版などを足せます（読むのは続けられます）。',
  unavailable: '一時的に Topic Studio のクラウドに接続できません。少し待ってから、もう一度試してください。',
  permission:
    'Topic Studio のクラウドに拒まれました（アクセスルールが古い可能性）。Mac か Windows で npm run deploy を実行して、アクセスルールを公開し直してください。',
  runUnknown: 'この回は見つかりません（runId が違うか、期限で消えました）。回を始め直してください（topic_begin_run）。',
  runExpired: '古い回です（始めて12時間を過ぎました）。回を始め直してください（topic_begin_run）。',
  runDone:
    'この回は終わりました（版か作れなかった印を足しました）。続けて作業する時は、回を始め直してください（topic_begin_run）。',
  dictionaryRebuilding: '辞書を作り直しています（初めての取り込みの途中）。少し待ってから、もう一度試してください。',
} as const

export function modelMismatchMessage(cloud: number | null, mine: number): string {
  if (cloud === null)
    return 'アプリのデータの形の版がクラウドにありません。アプリを開いて同期してから、もう一度試してください（読むのは続けられます）。'
  if (cloud > mine)
    return `アプリが新しい版のデータを書いています（データの形 ${cloud}、コネクタは ${mine}）。npm run deploy でコネクタを更新してください（読むのは続けられます）。`
  return `アプリの版が古いままです（データの形 ${cloud}、コネクタは ${mine}）。すべての端末のアプリを更新して同期してから、もう一度試してください（読むのは続けられます）。`
}
