// AI への意思表示の読み（段階3の設計の 1.7 の (2) の 2 の (c)。純粋な部品）: robots.txt の Content-Signal・Content-Usage の行、
// /.well-known/tdmrep.json と応答の見出し・HTML の meta の tdm-reservation（TDM の留保）、本文と一覧の応答の X-Robots-Tag、
// HTML の <meta name="robots">。どれも AI の利用を断る値が出たら
// 「取りを止める」（作者に伺う）。断る値の読み方は、外す側（止める側）に寄せる。
import { ANTHROPIC_AGENTS, AI_AGENTS, agentKey } from './aiAgents'
import { patternMatches } from './robots'

/** 断る値（no・n・false・disallow・0・deny） */
const NEGATIVE = /^(?:no|n|false|disallow|disallowed|deny|denied|0|off|none)$/i

/**
 * Content-Signal・Content-Usage の行の値（`ai-train=no, search=yes` の形）から、AI の利用を断る値を返す（印の並び。無ければ空）。
 * search（検索）の値だけは AI の利用として数えない。ほかの鍵（ai-input・ai-train・train-ai・train-genai・ai-use・bots（自動の処理）など。
 * 知らない鍵も）の断る値は数える。鍵の無い断る値（`Content-Usage: n`）も数える（止める側に寄せる）
 */
export function signalRefusals(field: string, value: string): string[] {
  const out: string[] = []
  const f = field.trim().toLowerCase()
  // aipref の形（`/path train-ai=n`）の道の頭は読み飛ばす
  for (const part of value.split(/[,;]/)) {
    const t = part.trim()
    const m = /([A-Za-z0-9_-]+)\s*=\s*"?([A-Za-z0-9_-]+)"?\s*$/.exec(t)
    if (!m) {
      const bare = /(?:^|\s)"?([A-Za-z0-9_-]+)"?$/.exec(t)
      if (bare && NEGATIVE.test(bare[1])) out.push(`${f}:all`)
      continue
    }
    const key = m[1].toLowerCase()
    if (key === 'search') continue
    if (NEGATIVE.test(m[2])) out.push(`${f}:${key}`)
  }
  return out
}

/** tdmrep.json の1つ（location は道の形。tdm-reservation が 1 なら留保） */
export interface TdmEntry {
  location: string
  reserved: boolean
}

/**
 * tdmrep.json を読む（JSON の配列。読めなければ null = 留保の印なし。形の違う要素は飛ばす）。location が URL の時は道だけにする
 */
export function parseTdmRep(text: string): TdmEntry[] | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(v)) return null
  const out: TdmEntry[] = []
  for (const e of v) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    let loc = typeof o.location === 'string' ? o.location.trim() : ''
    if (!loc) continue
    if (/^https?:\/\//i.test(loc)) {
      try {
        const u = new URL(loc)
        loc = `${u.pathname}${u.search}`
      } catch {
        continue
      }
    }
    if (!loc.startsWith('/')) loc = `/${loc}`
    const r = o['tdm-reservation']
    out.push({ location: loc.slice(0, 300), reserved: r === 1 || r === '1' || r === true })
  }
  return out
}

/** その道が TDM の留保に当たるか */
export function tdmReserved(entries: readonly TdmEntry[] | null, path: string): boolean {
  if (!entries) return false
  return entries.some((e) => e.reserved && patternMatches(e.location, path))
}

const NOAI = /(?:^|[\s,;:])(?:noai|noimageai)(?=$|[\s,;])/i

/** X-Robots-Tag の指示のうち、名前（`ClaudeBot:`）でなく値に : を使う物 */
const XRT_COLON_DIRECTIVES: ReadonlySet<string> = new Set([
  'unavailable_after',
  'max-snippet',
  'max-image-preview',
  'max-video-preview',
])

/**
 * X-Robots-Tag の値が AI への意思表示か: noai・noimageai（名前つきの値 `ClaudeBot: noai` も同じに見る）と、Claude・Anthropic の名前の
 * noindex・none（`ClaudeBot: noindex`。meta の metaNoAi と同じ決まり）。値は `,` で区切り、`名前:` で始まる所から次の `名前:` までを
 * その名前の指示に読む
 */
export function xRobotsNoAi(value: string | null): boolean {
  if (!value) return false
  if (NOAI.test(value)) return true
  let name: string | null = null
  for (const raw of value.split(',')) {
    let part = raw.trim()
    const m = /^([^:]+?)\s*:\s*(.*)$/.exec(part)
    if (m && !XRT_COLON_DIRECTIVES.has(m[1].trim().toLowerCase())) {
      name = agentKey(m[1])
      part = m[2]
    }
    if (name !== null && ANTHROPIC_META_NAMES.has(name) && /(?:^|\s)(?:noindex|none)(?=$|\s)/i.test(part)) return true
  }
  return false
}

/** TDMRep の応答の見出し（`tdm-reservation: 1`）で留保しているか */
export const tdmHeaderReserved = (value: string | null): boolean => (value ?? '').trim() === '1'

/** TDMRep の HTML の meta（`<meta name="tdm-reservation" content="1">`）で留保しているか */
export const tdmMetaReserved = (name: string, content: string): boolean =>
  name.trim().toLowerCase() === 'tdm-reservation' && content.trim() === '1'

/** 応答の見出しの AI への意思表示（X-Robots-Tag の noai など・TDMRep の tdm-reservation: 1）。止める印か null */
export function headerAiStop(headers: Headers): string | null {
  if (xRobotsNoAi(headers.get('x-robots-tag'))) return 'x-robots-noai'
  if (tdmHeaderReserved(headers.get('tdm-reservation'))) return 'tdm-reservation'
  return null
}

const AI_META_NAMES: ReadonlySet<string> = new Set(['robots', ...ANTHROPIC_AGENTS.map(agentKey), ...AI_AGENTS.map(agentKey)])
const ANTHROPIC_META_NAMES: ReadonlySet<string> = new Set(ANTHROPIC_AGENTS.map(agentKey))

/**
 * <meta name="…" content="…"> が AI への意思表示か: name が robots か AI・Claude の名前で、content に noai・noimageai がある。
 * Claude・Anthropic の名前の meta の noindex・none も断りとして止める
 */
export function metaNoAi(name: string, content: string): boolean {
  const n = agentKey(name)
  if (!AI_META_NAMES.has(n)) return false
  if (NOAI.test(` ${content} `)) return true
  return ANTHROPIC_META_NAMES.has(n) && /(?:^|[\s,])(?:noindex|none)(?=$|[\s,])/i.test(content)
}
