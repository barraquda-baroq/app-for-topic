// ログ（Workers Logs）。NS の connector/src/log.ts を元に、もっと固くした（設計の 1.10・docs/SPEC.md の 3.）。
// - 出すのは event の名前と、数・真偽と、決まった鍵（LABEL_KEYS: ツールの名前・誤りの種類・表の名前・ホスト・出どころの id など）の
//   決まった形の印（ASCII の英数字と _ . : - だけの 64 字まで）だけ。ほかの文字列は、どの鍵でも長さだけ（[12字]）にする。
//   name のような何でも入る鍵は印にしない（接続の名前・資料の URL の slug が印の形で出ないように。例外の名前は logError の error で出す）。
//   NS の決まり（ASCII 以外を伏せ、200字を超える文字列を出さない）では、英語の資料（Global Voices）の短い文が出てしまうため
// - 回の種類（kind）・回の id（runId）・モデル（model）は、長さも出さない（Workers Logs は何日か残り、チャットの訂正の回の時刻が分かるため。
//   D21・設計の 1.10）。回の種類で event の名前を分けることもしない（呼ぶ側の決まり）
// - URL はホストだけ（パス・問い合わせ部分の ?state=…&k=… を出さない）。例外は種類（名前と誤りの印）と文の長さだけ
// - ツールの入力・答え・資料の文・題・語は、どの鍵に入っても印の形に合わないか、決まった鍵でないので出ない
export type LogValue = string | number | boolean | null | undefined

/** 印として文字列のまま出してよい鍵 */
export const LABEL_KEYS: ReadonlySet<string> = new Set([
  'event',
  'tool',
  'code',
  'reason',
  'scope',
  'window',
  'category',
  'table',
  'host',
  'source',
  'op',
  'result',
])

/** 長さも出さない鍵（回の種類・回の id・モデル） */
export const DROPPED_KEYS: ReadonlySet<string> = new Set(['kind', 'runId', 'model'])

/** 印の形（ASCII の英数字と _ . : - だけ。64 字まで） */
const LABEL = /^[A-Za-z0-9_.:-]{1,64}$/

/** 文字列の長さだけ */
const lengthOf = (s: string) => `[${Array.from(s).length}字]`

/** ログに出してよい値にする（key が決まった鍵で、印の形の時だけ文字列のまま。オブジェクトは出さない） */
export function safeValue(v: unknown, key = ''): LogValue {
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v as LogValue
  if (typeof v === 'string') return LABEL_KEYS.has(key) && LABEL.test(v) ? v : lengthOf(v)
  return `[${typeof v}]`
}

/** URL のホストだけ */
export function safeUrl(url: string): string {
  try {
    return new URL(url).host || '[URL]'
  } catch {
    return '[URL]'
  }
}

/**
 * 例外を短い印にする: 例外の名前と、誤りの印（code。FirestoreError の PERMISSION_DENIED など印の形の物だけ）と、文の長さ。
 * 文そのものは出さない（取りに行った URL のパス・読めなかった JSON の切れ端が入りうるため）
 */
export function safeError(e: unknown): string {
  const name = e instanceof Error ? e.name : typeof e
  const msg = e instanceof Error ? e.message : String(e)
  const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined
  const parts = [LABEL.test(name) ? name : 'Error']
  if (typeof code === 'string' && LABEL.test(code)) parts.push(code)
  if (msg) parts.push(lengthOf(msg))
  return parts.join(' ')
}

/** ログの1行にする（JSON。出してよい値だけ） */
export function logLine(event: string, fields: Record<string, unknown> = {}): Record<string, LogValue> {
  const out: Record<string, LogValue> = { event: safeValue(event, 'event') }
  for (const [k, v] of Object.entries(fields)) {
    if (DROPPED_KEYS.has(k) || k === 'event') continue
    out[k] = safeValue(v, k)
  }
  return out
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify(logLine(event, fields)))
}

/** 例外のログ（例外の印 error は safeError で作る。ほかの鍵で渡した文字列の例外の文は、長さだけになる） */
export function logError(event: string, e: unknown, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ...logLine(event, fields), error: safeError(e) }))
}
