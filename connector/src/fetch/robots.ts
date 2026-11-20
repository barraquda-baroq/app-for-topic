// robots.txt の読みと、取ってよいかの決まり（段階3の設計の 1.7 の (2) の 2。問1 の作者の答えの芯。純粋な部品）。
// (a) 取ってよいのは、コネクタの名前の組と Claude-User の組の両方で、取りに行く道が許されている時（名前の組が無ければ * の組）
// (b) Claude・Anthropic の名前の組（ClaudeBot・Claude-User・Claude-Web・Claude-SearchBot・Claude-Code・anthropic-ai）のどれか1つでも
//     その道を断っていれば取らない。ただし、コネクタの名前を名指しした組がその道を許している時だけは、(b)・(c) の名前の組を見ない
// (c) ほかの AI の名前の組の断り・Content-Signal・Content-Usage の断る値・tdmrep.json の留保・本文の noai・# の注の AI の語は、取りを止めて
//     作者に伺う
// (d) 表に無い名前の組（初めて読んだ時の名前に無い物）が増え、その道を断っている時も (c) と同じに止める
// 読めない時（5xx・時間切れ・403・確認画面）は、その日はそのホストから取らない（watch.ts）。404 は「決まりなし」。
// 道の比べ方は RFC 9309（いちばん長く当たる規則。同じ長さなら Allow。* と $。ASCII でない字は %xx にそろえ、予約でない字の %xx は字に
// 戻してから比べる）。組の名前は大文字・小文字を区別せず、版の書き（/1.0）を落として比べる。UA の全文（`…/5.0 (compatible; ClaudeBot/1.0)`）
// を書いた組は、中の Claude・ほかの AI の名前の組にも読む。組を区切るのは規則（Allow・Disallow）の後の User-agent だけ（Crawl-delay・
// Sitemap・Host・Content-Signal などの行は組を区切らない。RFC 9309 の 2.2.4）。コロンの無い行（`Disallow /`）と、鍵のよくある書き違い
// （`User agent`・`Useragent`・`Disalow` など）は、断る側に寄せて読む（Allow の書き違いは読まない）。覚えきれない組（規則が上限を超えた組）は、
// どの道も断る側に読み、行が上限を超えた・1MB で切った robots.txt は、取りを止めて伺う（読み落とした断りで取らないように）
import { fingerprint } from '../../../src/domain/hash'
import { agentKey, agentKind, CLAUDE_USER_AGENT, CONNECTOR_AGENT, ANTHROPIC_AGENTS, hasAiWord } from './aiAgents'
import { signalRefusals, tdmReserved, type TdmEntry } from './aiSignals'

export interface RobotsRule {
  allow: boolean
  pattern: string
}

export interface RobotsGroup {
  /** 組の名前（そろえた形。'*' を含みうる） */
  agents: string[]
  rules: RobotsRule[]
  crawlDelay?: number
  /** 規則が上限を超えて覚えきれなかった（どの道も断る側に読む） */
  overflow?: true
}

export interface ParsedRobots {
  groups: RobotsGroup[]
  /** # の注に AI の語があった */
  aiComment: boolean
  /** Content-Signal・Content-Usage の断る値（印） */
  signals: string[]
  /** 行が上限を超えた（後ろの行を読んでいない） */
  truncated: boolean
}

/** 1つの組に覚える規則の上限（大きな robots.txt で DO の行がふくらまないように） */
const MAX_RULES = 400
/** 読む robots.txt の行の上限 */
const MAX_LINES = 5_000

/** Disallow の鍵のよくある書き違い（断る側だけ広げる。Allow の書き違いは読まない） */
const DISALLOW_TYPOS: ReadonlySet<string> = new Set(['disallow', 'dissallow', 'dissalow', 'disalow', 'diasllow', 'disallaw'])

/** 鍵をそろえる（空白・'-' を落として小文字に。User-agent と Disallow の書き違いを読む） */
function fieldKey(raw: string): string {
  const k = raw.replace(/[\s-]/g, '').toLowerCase()
  if (k === 'useragent') return 'user-agent'
  if (DISALLOW_TYPOS.has(k)) return 'disallow'
  if (k === 'crawldelay') return 'crawl-delay'
  if (k === 'contentsignal') return 'content-signal'
  if (k === 'contentusage') return 'content-usage'
  return k
}

/** 行を鍵と値に分ける（コロンで。コロンの無い行は、空白で2つに分かれる時だけ空白で） */
function splitLine(line: string): { field: string; value: string } | null {
  const colon = line.indexOf(':')
  if (colon > 0) return { field: fieldKey(line.slice(0, colon)), value: line.slice(colon + 1).trim() }
  if (colon === 0) return null
  const parts = line.split(/\s+/)
  if (parts.length !== 2) return null
  return { field: fieldKey(parts[0]), value: parts[1] }
}

/**
 * User-agent の値から組の名前を出す（そろえた名前。UA の全文の形（空白・括弧・';' がある）は、中の Claude・ほかの AI の名前も足す。
 * `…/5.0 (compatible; ClaudeBot/1.0)` の意図は ClaudeBot の断りなので）
 */
function agentNamesOf(value: string): string[] {
  const out = [agentKey(value) || '*']
  if (/[\s();]/.test(value))
    for (const m of value.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? []) {
      const kind = agentKind(m)
      if (kind === 'anthropic' || kind === 'ai') out.push(agentKey(m))
    }
  return [...new Set(out)]
}

/**
 * robots.txt を読む（RFC 9309。続けて書かれた User-agent の行は1つの組。規則（Allow・Disallow）の後の User-agent は次の組。
 * Crawl-delay・Sitemap・Host・Content-Signal・知らない行は組を区切らない）
 */
export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = []
  let cur: RobotsGroup | null = null
  let lastWasAgent = false
  let aiComment = false
  const signals: string[] = []
  const all = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
  const truncated = all.length > MAX_LINES
  const lines = all.slice(0, MAX_LINES)
  for (const raw of lines) {
    const hash = raw.indexOf('#')
    if (hash >= 0 && hasAiWord(raw.slice(hash + 1))) aiComment = true
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim()
    if (!line) continue
    const kv = splitLine(line)
    if (!kv) continue
    const { field, value } = kv
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] }
        groups.push(cur)
      }
      for (const a of agentNamesOf(value)) if (!cur.agents.includes(a)) cur.agents.push(a)
      lastWasAgent = true
      continue
    }
    if (field === 'content-signal' || field === 'content-usage') {
      signals.push(...signalRefusals(field, value))
      continue
    }
    if (!cur) continue
    if (field === 'allow' || field === 'disallow') {
      // 規則の行の後の User-agent は次の組
      lastWasAgent = false
      // 空の Disallow は「何も断らない」（全部を許す規則として、いちばん短い Allow にする。空の Allow は読み飛ばす）
      if (!value && field === 'allow') continue
      if (cur.rules.length >= MAX_RULES) {
        cur.overflow = true
        continue
      }
      cur.rules.push(value ? { allow: field === 'allow', pattern: value } : { allow: true, pattern: '' })
    } else if (field === 'crawl-delay') {
      // 同じ組に2つあれば長い方
      const n = Number(value)
      if (Number.isFinite(n) && n >= 0) cur.crawlDelay = Math.min(Math.max(cur.crawlDelay ?? 0, n), 3_600)
    }
  }
  return { groups, aiComment, signals: [...new Set(signals)], truncated }
}

/** 比べる形にそろえる（ASCII でない字を %xx に・予約でない字（英数字と - . _ ~）の %xx は字に戻し、ほかの %xx は大文字に。RFC 9309 の 2.2.2） */
function normPct(s: string): string {
  let t = s
  try {
    t = s.replace(/[^\x00-\x7f]+/g, (m) => encodeURIComponent(m))
  } catch {
    // 壊れた字（対になっていないサロゲート）はそのまま
  }
  return t.replace(/%[0-9a-f]{2}/gi, (m) => {
    const c = String.fromCharCode(parseInt(m.slice(1), 16))
    return /[A-Za-z0-9._~-]/.test(c) ? c : m.toUpperCase()
  })
}

/** 規則の道の形がその道に当たるか（頭から。* は何でも、終わりの $ は道の終わり） */
export function patternMatches(pattern: string, path: string): boolean {
  return matchLength(pattern, path) >= 0
}

/** 当たった時の規則の長さ（当たらなければ -1） */
function matchLength(pattern: string, path: string): number {
  const p = normPct(pattern)
  const anchored = p.endsWith('$')
  const body = anchored ? p.slice(0, -1) : p
  const re = new RegExp(`^${body.split('*').map(escapeRe).join('.*')}${anchored ? '$' : ''}`)
  return re.test(normPct(path)) ? p.length : -1
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/** 規則の並びでその道が許されるか（いちばん長く当たる規則。同じ長さなら Allow。当たる規則が無ければ許す） */
export function rulesAllow(rules: readonly RobotsRule[], path: string): boolean {
  let best = -1
  let allow = true
  for (const r of rules) {
    const n = matchLength(r.pattern, path)
    if (n < 0) continue
    if (n > best || (n === best && r.allow)) {
      best = n
      allow = r.allow
    }
  }
  return allow
}

/** 規則の並びがその道を、はっきり許すか（当たる規則があり、いちばん長く当たる物が Allow。空の Disallow は全部を許す） */
export function rulesExplicitlyAllow(rules: readonly RobotsRule[], path: string): boolean {
  let best = -1
  let allow = false
  for (const r of rules) {
    const n = matchLength(r.pattern, path)
    if (n < 0) continue
    if (n > best || (n === best && r.allow)) {
      best = n
      allow = r.allow
    }
  }
  return best >= 0 && allow
}

/** 名前の組（名前に当たる組の規則を全部合わせた物。当たる組が無ければ null） */
export function namedGroup(groups: readonly RobotsGroup[], agent: string): RobotsGroup | null {
  const k = agentKey(agent)
  const hit = groups.filter((g) => g.agents.includes(k))
  if (!hit.length) return null
  const delays = hit.map((g) => g.crawlDelay).filter((d): d is number => d !== undefined)
  return {
    agents: [k],
    rules: hit.flatMap((g) => g.rules),
    ...(delays.length ? { crawlDelay: Math.max(...delays) } : {}),
    ...(hit.some((g) => g.overflow) ? { overflow: true as const } : {}),
  }
}

/** 組がその道を許すか（覚えきれなかった組は、どの道も断る） */
export const groupAllows = (g: RobotsGroup, path: string): boolean => !g.overflow && rulesAllow(g.rules, path)

/** その名前に当たる組（名前の組が無ければ * の組。どちらも無ければ空の組） */
export function effectiveGroup(groups: readonly RobotsGroup[], agent: string): RobotsGroup {
  return namedGroup(groups, agent) ?? namedGroup(groups, '*') ?? { agents: ['*'], rules: [] }
}

/** ホストの決まりの読み（host_rules の data。題・本文は持たない） */
export interface HostRulesData {
  /** robots.txt の番号（0 = 届かない） */
  status: number
  /** robots.txt の文字の指紋（無い・404 は ''） */
  fp: string
  /** 覚えておく組（コネクタ・*・Claude・ほかの AI・表に無い名前） */
  groups: RobotsGroup[]
  /** 名前の組の名前の全部（'*' を除く） */
  names: string[]
  /** 初めて読んだ時の名前（(d) の「増えた」を比べる元。消えない） */
  base: string[]
  /** Content-Signal・Content-Usage の断る値 */
  signals: string[]
  aiComment: boolean
  /** tdmrep.json（無い・404 は null） */
  tdm: TdmEntry[] | null
  tdmStatus: number
  /** robots.txt の行が上限を超えた・1MB で切った（取りを止めて伺う） */
  truncated?: true
  /** 本文の応答で見た AI への意思表示（X-Robots-Tag・meta の noai。止めたまま。data の terms.accepted が新しくなると外れる） */
  stop?: { day: string; reasons: string[] }
}

/** robots.txt の読みから、覚える data を作る（prev = 前の data。base と本文の止めを引き継ぐ） */
export function hostRulesData(
  robots: { status: number; text: string | null; truncated?: boolean },
  tdm: { status: number; entries: TdmEntry[] | null },
  prev: HostRulesData | null,
): HostRulesData {
  const parsed: ParsedRobots =
    robots.text !== null ? parseRobots(robots.text) : { groups: [], aiComment: false, signals: [], truncated: false }
  const names = [...new Set(parsed.groups.flatMap((g) => g.agents).filter((a) => a !== '*'))]
  // 覚える組: コネクタ・*・Claude・ほかの AI と、表に無い名前（(d) で見る）。表にある AI でない名前（検索など）は名前だけ
  const keep = parsed.groups
    .map((g) => ({ ...g, agents: g.agents.filter((a) => agentKind(a) !== 'other') }))
    .filter((g) => g.agents.length > 0)
  return {
    status: robots.status,
    fp: robots.text !== null && robots.text.trim() ? fingerprint(robots.text, 16) : '',
    groups: keep,
    names,
    base: prev ? prev.base : names,
    signals: parsed.signals,
    aiComment: parsed.aiComment,
    tdm: tdm.entries,
    tdmStatus: tdm.status,
    ...(parsed.truncated || robots.truncated ? { truncated: true as const } : {}),
    ...(prev?.stop ? { stop: prev.stop } : {}),
  }
}

/** 道の決まり（ok = 取ってよい・refused = robots.txt が断る・stopped = AI への意思表示。reasons は印） */
export interface PathVerdict {
  verdict: 'ok' | 'refused' | 'stopped'
  reasons: string[]
}

/**
 * その道を取ってよいか（1.7 の (2) の 2 の (a)〜(d) と AI への意思表示）。acceptedAfter = 本文の止めを外す日（その日より前の止めは
 * 見ない。data の terms.accepted がその日より新しい時）。順: 名指しで許す → 断る（(a)・(b)）→ 止める（(c)・(d)・意思表示）
 */
export function decidePath(data: HostRulesData, path: string, acceptedAfter: string | null = null): PathVerdict {
  const stops: string[] = []
  if (data.signals.length) stops.push(...data.signals)
  if (data.aiComment) stops.push('robots-comment')
  if (data.truncated) stops.push('robots-long')
  if (tdmReserved(data.tdm, path)) stops.push('tdm-reservation')
  if (data.stop && !(acceptedAfter !== null && acceptedAfter > data.stop.day)) stops.push(...data.stop.reasons)
  // コネクタの名前を名指しした組がその道をはっきり許す（Allow が当たる・空の Disallow）: Claude・ほかの AI・表に無い名前の組を見ない
  const named = namedGroup(data.groups, CONNECTOR_AGENT)
  if (named && !named.overflow && rulesExplicitlyAllow(named.rules, path))
    return stops.length ? { verdict: 'stopped', reasons: stops } : { verdict: 'ok', reasons: ['connector-named'] }
  const refused: string[] = []
  // (a) コネクタの名前（無ければ *）と Claude-User（無ければ *）の両方
  if (!groupAllows(effectiveGroup(data.groups, CONNECTOR_AGENT), path)) refused.push('connector')
  if (!groupAllows(effectiveGroup(data.groups, CLAUDE_USER_AGENT), path)) refused.push('claude-user')
  // (b) Claude・Anthropic のどの名前の組でも（表の名前と、Claude・Anthropic の語を含む名前）
  const anthropic = new Set([...ANTHROPIC_AGENTS.map(agentKey), ...data.names.filter((n) => agentKind(n) === 'anthropic')])
  for (const a of anthropic) {
    const g = namedGroup(data.groups, a)
    if (g && !groupAllows(g, path)) refused.push(`anthropic:${a}`)
  }
  if (refused.length) return { verdict: 'refused', reasons: [...new Set(refused)] }
  // (c)・(d) ほかの AI の名前・表に無い名前の新しい組
  const base = new Set(data.base)
  for (const name of data.names) {
    const kind = agentKind(name)
    if (kind !== 'ai' && !(kind === 'unknown' && !base.has(name))) continue
    const g = namedGroup(data.groups, name)
    if (g && !groupAllows(g, path)) stops.push(kind === 'ai' ? `ai:${name}` : `new-agent:${name}`)
  }
  return stops.length ? { verdict: 'stopped', reasons: [...new Set(stops)] } : { verdict: 'ok', reasons: [] }
}

/** Crawl-delay（秒。コネクタの名前の組（無ければ *）と Claude-User の組（無ければ *）の長い方。無ければ null） */
export function crawlDelayOf(data: HostRulesData): number | null {
  const a = effectiveGroup(data.groups, CONNECTOR_AGENT).crawlDelay
  const b = effectiveGroup(data.groups, CLAUDE_USER_AGENT).crawlDelay
  const ds = [a, b].filter((d): d is number => d !== undefined)
  return ds.length ? Math.max(...ds) : null
}

/**
 * ホストの状態（host_rules の state）: 出どころの道（一覧の道・取ってよい道）のどれかで止める → stopped、全部で断る → refused、
 * ほかは ok（断る道だけは、取る時に道ごとに断る）
 */
export function hostStateOf(
  data: HostRulesData,
  paths: readonly string[],
  acceptedAfter: string | null = null,
): { state: 'ok' | 'refused' | 'stopped'; reasons: string[] } {
  const verdicts = (paths.length ? paths : ['/']).map((p) => decidePath(data, p, acceptedAfter))
  const stopped = verdicts.filter((v) => v.verdict === 'stopped')
  if (stopped.length) return { state: 'stopped', reasons: [...new Set(stopped.flatMap((v) => v.reasons))] }
  if (verdicts.every((v) => v.verdict === 'refused'))
    return { state: 'refused', reasons: [...new Set(verdicts.flatMap((v) => v.reasons))] }
  return { state: 'ok', reasons: [] }
}

/** 名前の組の名前（probe に出す印。表の種類ごとの数） */
export function agentCounts(data: HostRulesData): Record<string, number> {
  const out: Record<string, number> = { anthropic: 0, ai: 0, other: 0, unknown: 0, connector: 0 }
  for (const n of data.names) {
    const k = agentKind(n)
    if (k !== 'any') out[k] = (out[k] ?? 0) + 1
  }
  return out
}
