// ツールの結果の共通の道具（NS の connector/src/vault/tools/common.ts の fail・capText を写し、答えの頭の1行の枠を足した）。
// 結果はいつも日本語のテキスト。資料の本文・下書きは structuredContent に入れない。
// - 結果の上限は 10万字（capText。NS と同じ）。1回に返す字数の既定は 12,000字（定期実行はいつも Claude Code のセッションから。
//   長い物は cursor で続き。設計の 1.1。使うのは B3 以降のツール）
// - 答えの頭の1行に今の時刻（「いま 11:42（日本時間）」）。runId を渡した呼び出しは、書く係の締め切りと照合の打ち切りまでの分も添える
//   （定期実行の回はシェルを使わないので、Claude が今の時刻を知る道がほかに無い。設計の 1.2「答えの頭の1行に今の時刻」）
import { jstParts } from '../../../../src/domain/jst'

export interface ToolResult {
  text: string
  isError?: boolean
  /** 足すツールだけ（作った記録の id・飛ばした理由。資料の本文・下書きは入れない。形は B3 が決める） */
  structured?: Record<string, unknown>
  /** 認証の問題（連携の解除・身元を失った）: MCP の呼び出しを HTTP 401 にする */
  auth?: boolean
}

/** 結果の上限（claude.ai は約15万字。余裕を見て10万字。NS と同じ） */
export const RESULT_LIMIT = 100_000

/** 1回に返す字数の既定（長い資料・下書きは cursor で続き。設計の 1.1 の「結果の文」） */
export const DEFAULT_ITEM_BUDGET = 12_000

/** 長すぎる結果を、行の切れ目で切る */
export function capText(text: string, limit = RESULT_LIMIT): string {
  if (text.length <= limit) return text
  const room = limit - 120
  let cut = text.lastIndexOf('\n', room)
  if (cut < room / 2) cut = room
  // サロゲートペアの途中で切らない
  const c = text.charCodeAt(cut - 1)
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1
  return `${text.slice(0, cut)}\n[...]（結果が長いため、ここで切りました。範囲を狭めるか、cursor で続きを読んでください）`
}

export function ok(text: string): ToolResult {
  return { text: capText(text) }
}

export function fail(message: string, candidates?: readonly string[]): ToolResult {
  const list = candidates && candidates.length ? `\n候補:\n${candidates.map((c) => `- ${c}`).join('\n')}` : ''
  return { text: capText(`${message}${list}`), isError: true }
}

/** 入力の文字列（無い・空なら undefined） */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

export function strList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
}

/** 回の締め切り（ms。書く係の締め切りと照合の打ち切り。回を始めた時に決める。B3 の vault/runs.ts） */
export interface RunDeadlines {
  writeBy: number
  verifyBy: number
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 「いま 11:42（日本時間）」 */
export function nowLine(now: number): string {
  const p = jstParts(now)
  return `いま ${pad2(p.hour)}:${pad2(p.minute)}（日本時間）`
}

/** 締め切りまでの分（切り捨て。過ぎていれば「を過ぎています」） */
function untilText(label: string, at: number, now: number): string {
  const left = Math.floor((at - now) / 60_000)
  return left > 0 ? `${label}まで ${left}分` : `${label}を過ぎています`
}

/**
 * 答えの頭の1行: 「いま 11:42（日本時間）」。回の締め切りを渡すと「・書く係の締め切りまで n分・照合の打ち切りまで m分」も添える
 * （回の期限の12時間とは別の言葉）
 */
export function headLine(now: number, deadlines?: RunDeadlines | null): string {
  const line = nowLine(now)
  if (!deadlines) return line
  return `${line}・${untilText('書く係の締め切り', deadlines.writeBy, now)}・${untilText('照合の打ち切り', deadlines.verifyBy, now)}`
}

/** 結果の頭に1行を足す（失敗の答えにも足す。上限は足した後で数える） */
export function withHead(result: ToolResult, head: string): ToolResult {
  return { ...result, text: capText(`${head}\n${result.text}`) }
}

/** 先頭 n 字（改行は空白に。切ったら [...]） */
export function head(text: string, n = 60): string {
  const one = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(one)
  return chars.length > n ? `${chars.slice(0, n).join('')}[...]` : one
}
