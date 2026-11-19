// 連携の画面（#/claude/connect?s=…）を、ログインの画面の後に開き直すための覚え（段階3の設計の 3.1）。TS の連携の画面は持ち主の関所の
// 中にあり（src/App.tsx の AuthGate。持ち主と確かめた後だけ開ける）、ログインしていないブラウザで開くと、ログインの画面へ移る。
// ログインの画面からトップへ移る時に連携の印を失わないよう、関所がこの画面のタブ（sessionStorage）に行き先を覚え、ログインの後に
// 戻す。Google のログインがページを切り替える方式（リダイレクト）でも、同じタブなので残る。
// 覚えるのは連携の画面の行き先だけ（ほかの行き先・形の違う物は覚えず、読んでも捨てる）で、30分で古くなる（コネクタの連携の印の
// 期限より長くは残さない）。連携の画面を開いたら消す。描画の中で読むので、読むだけでは消さない（React の StrictMode で2回描いても同じ）
import { CONNECT_ROUTE, CONNECT_STATE_PARAM, validState } from '../../claude/pairing'

const KEY = 'topic-studio:connect-return'
/** 覚えておく長さ */
export const CONNECT_RETURN_TTL_MS = 30 * 60_000

/** 連携の画面の行き先（'/claude/connect?s=…'）か。違えば null、そうなら整えた行き先 */
export function connectReturnPath(path: string): string | null {
  const prefix = `${CONNECT_ROUTE}?`
  if (!path.startsWith(prefix)) return null
  const state = validState(new URLSearchParams(path.slice(prefix.length)).get(CONNECT_STATE_PARAM))
  return state ? `${prefix}${CONNECT_STATE_PARAM}=${encodeURIComponent(state)}` : null
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/** 連携の画面の行き先を覚える（pathname と search。連携の画面でなければ何もしない） */
export function rememberConnectReturn(path: string, now = Date.now()): void {
  const p = connectReturnPath(path)
  if (!p) return
  try {
    storage()?.setItem(KEY, JSON.stringify({ path: p, at: now }))
  } catch {
    /* 覚えられなければ、ログインの後はトップへ（claude.ai から接続し直す） */
  }
}

/** 覚えた行き先（無い・古い・形が違えば null。読むだけで消さない） */
export function peekConnectReturn(now = Date.now()): string | null {
  try {
    const raw = storage()?.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { path?: unknown; at?: unknown }
    if (typeof v.path !== 'string' || typeof v.at !== 'number') return null
    if (!(now - v.at >= 0 && now - v.at < CONNECT_RETURN_TTL_MS)) return null
    return connectReturnPath(v.path)
  } catch {
    return null
  }
}

/** 覚えた行き先を消す（連携の画面を開いた時） */
export function clearConnectReturn(): void {
  try {
    storage()?.removeItem(KEY)
  } catch {
    /* noop */
  }
}
