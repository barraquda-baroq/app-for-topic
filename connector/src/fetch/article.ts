// 取りに行く所と本文（段階3の設計の 1.7 の (2)・(6)・(7)・(11)）。出どころへの要求は全部ここの sourceGet を通る:
// - 名乗りは TopicStudioConnector/1.0（ブラウザの名前を入れない）。転送は同じホストの中だけで3回まで（自分でたどる）。転送の行き先の道も、
//   今日の robots.txt と AI の意思表示で取ってよい道だけ（読んでいない・断る・止める道へはたどらない）。1つの応答は 1MB で止める
// - 取りに行く前に、そのホストの次に取ってよい時刻を予約してから待つ（pace.ts）。応答が終わった時刻からも間をあける。道具の呼び出しの
//   待ちが15秒を超える時は「混んでいます」
// - 403・429・確認画面が返ったら、その日はそのホストを取らない（名前・道・時刻を替えて試し直さない。host_rules を unreadable に）。
//   予約の間を待った後と転送の各段でも、取りに行く前にそのホストの今日の状態を見直す（同時の呼び出しで、待っていた要求が 403 の後に出ない）
// - 1つの回に取りに行くのは 100本・1つのホストに 40本まで、1日（日本時間）に 300本まで（一覧・本文の先読み・電文を含む。控えから
//   返すのは数えない。robots.txt と AI の意思表示の読み・規約と気象庁の見張り・probe の番号は数えない）
// 本文の取り方（data の body の形）: html（scopes・案内の行・記者の質問の段を落とす）・anchor（一覧のページの #番号 の項目）・
// jma-xml（電文を文字に）・feed（Global Voices。RSS の全文。記事のページは取らない）。本文が200字未満の控えは出典にできない
import { jstDateOf, publishedAtOf } from '../../../src/domain/jst'
import { SOURCE_BODY_MIN_CHARS } from '../../../src/domain/limits'
import { log } from '../log'
import type { VaultCore } from '../vault/core'
import type { MaterialRow, RunRow } from '../vault/store'
import { headerAiStop, metaNoAi, tdmMetaReserved } from './aiSignals'
import { USER_AGENT } from './aiAgents'
import { normalizeEvents, readAnchor, readBody, type HtmlEvent, type QaCont } from './htmlTokens'
import { rewriterEvents } from './htmlRewriter'
import { parseTelegram, type Telegram } from './jma'
import { hostGapMs, reserve, settle, waitFor } from './pace'
import type { FeedItem } from './rss'
import { DEFAULT_SOURCES, PENDING_HOSTS, PRESS_QUESTION_MARKS, type PendingHost, type SourceConfig } from './sources'
import { countPermitBody, permitBodiesLeft, qaBlocked, sourceGate } from './terms'
import {
  charsetOf,
  checkBodyUrl,
  decodeBytes,
  hasDoubleSlash,
  isChallenge,
  isFeedResponse,
  isPdfResponse,
  MAX_REDIRECTS,
  mimeOf,
  readCapped,
} from './urlPolicy'
import { acceptedOfHost, checkPath, hopAllowedByRules, markBodyStop, markHostUnreadable, rulesDataOf } from './watch'
import { decidePath } from './robots'

/** 1つの回に取りに行く上限（一覧・本文の先読み・電文を含む） */
export const RUN_FETCH_LIMIT = 100
/** 1つの回に1つのホストへ取りに行く上限 */
export const HOST_FETCH_LIMIT = 40
/** 1日（日本時間）に取りに行く上限（回をまたいで数える。robots.txt・tdmrep.json・規約の見張り・気象庁の見張り・probe は数えない） */
export const DAY_FETCH_LIMIT = 300
/** 1日の数を置く meta の鍵（{ day, n }。日が替われば 0 から） */
export const NET_DAILY_META = 'netDaily'
/** 控えに持つ本文の上限（字） */
export const MATERIAL_MAX_CHARS = 12_000
/** 1回の要求を待つ上限（ms） */
export const SOURCE_TIMEOUT_MS = 15_000

/** 取りに行く中身の data と部品（テストは作り物の出どころと、HTML の小さな読み取りを渡す） */
export interface FetchEnv {
  sources: readonly SourceConfig[]
  pending: readonly PendingHost[]
  /** HTML の文字 → 並び（Workers は HTMLRewriter） */
  html: (text: string) => Promise<HtmlEvent[]>
  /** 1つの回の上限（既定 100・40） */
  runLimit: number
  hostLimit: number
  /** 1日（日本時間）の上限（既定 300） */
  dayLimit?: number
}

export const DEFAULT_FETCH_ENV: FetchEnv = {
  sources: DEFAULT_SOURCES,
  pending: PENDING_HOSTS,
  html: rewriterEvents,
  runLimit: RUN_FETCH_LIMIT,
  hostLimit: HOST_FETCH_LIMIT,
  dayLimit: DAY_FETCH_LIMIT,
}

/** 今日（日本時間）取りに行った数（回をまたいで。数えるのは sourceGet の count の要求だけ） */
export function netToday(core: VaultCore): number {
  const m = core.store.getMeta<{ day: string; n: number }>(NET_DAILY_META)
  return m && m.day === jstDateOf(core.now()) ? m.n : 0
}

/** その Vault の取りに行く中身の data（vault/tools/fetch.ts の createFetchWork が持つ物。無ければ既定） */
export function envOf(core: VaultCore): FetchEnv {
  const w = core.fetchWork as { env?: FetchEnv }
  return w.env ?? DEFAULT_FETCH_ENV
}

// ---------- 要求 ----------

export interface GetRequest {
  url: string
  /** 数える回（無ければ数えない） */
  run: RunRow | null
  /** 予約の待ちの上限（ms。超えたら busy） */
  maxWait: number
  /** 回の上限に数えるか（robots.txt と AI の意思表示の読み・probe の番号は数えない） */
  count?: boolean
  /** 403・確認画面の時に、その日そのホストを取らないにするか（既定 true） */
  markBlocked?: boolean
  accept?: string
  /** 転送の行き先の道を確かめる（false なら転送をたどらない） */
  hop?: (url: URL) => boolean
  /**
   * 転送の行き先の道を、今日の robots.txt と AI の意思表示で確かめるか（既定 true。robots.txt・tdmrep.json そのものを読む時だけ false）。
   * 今日の決まりを読んでいないホストへの転送はたどらない
   */
  rules?: boolean
}

export type GetResult =
  | { ok: true; url: string; status: number; headers: Headers; bytes: Uint8Array; truncated: boolean }
  | {
      ok: false
      /** robots・ai: 待っている間に今日の決まりが変わり、その道を断る・止める（同時の呼び出しの後） */
      why: 'busy' | 'budget' | 'host-budget' | 'blocked' | 'status' | 'network' | 'redirect' | 'robots' | 'ai'
      url: string
      status?: number
      headers?: Headers
      waitMs?: number
    }

/** 頭のバイトを ASCII として読む（確認画面の印を探すため） */
function asciiHead(bytes: Uint8Array, n = 4_000): string {
  let s = ''
  for (let i = 0; i < Math.min(bytes.length, n); i++) s += String.fromCharCode(bytes[i] < 128 ? bytes[i] : 32)
  return s
}

const timeoutSignal = (): AbortSignal | undefined =>
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(SOURCE_TIMEOUT_MS)
    : undefined

/**
 * 取りに行く直前の見直し（読まない。今日の決まりの行だけを見る）: markBlocked なら今日 unreadable のホストを断る（'blocked'）。rules なら、
 * 今日の決まりがある時に、その道が断る・止める道になっていれば断る（'robots'・'ai'。本文の noai の止めを含む）。今日の決まりの無い時は
 * 呼ぶ側が先に読んでいる（checkPath）ので、ここでは断らない
 */
function recheckHost(core: VaultCore, env: FetchEnv, url: URL, req: GetRequest): 'blocked' | 'robots' | 'ai' | null {
  const host = url.hostname.toLowerCase()
  const row = core.store.hostRule(host)
  if (!row || row.day !== jstDateOf(core.now())) return null
  if (req.markBlocked !== false && row.state === 'unreadable') return 'blocked'
  if (req.rules === false) return null
  const data = rulesDataOf(row)
  if (!data) return null
  const v = decidePath(data, `${url.pathname}${url.search}`, acceptedOfHost(env, host)).verdict
  return v === 'ok' ? null : v === 'refused' ? 'robots' : 'ai'
}

/** 出どころへの要求（名乗り・予約の間・回の上限・同じホストの中の転送・1MB・403 と確認画面） */
export async function sourceGet(core: VaultCore, env: FetchEnv, req: GetRequest): Promise<GetResult> {
  const store = core.store
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    return { ok: false, why: 'redirect', url: req.url }
  }
  const count = req.count !== false && req.run !== null
  for (let hop = 0; ; hop++) {
    const host = url.hostname.toLowerCase()
    if (count) {
      if (store.runCount(req.run!.runId, 'net') >= env.runLimit) return { ok: false, why: 'budget', url: url.href }
      if (store.runCount(req.run!.runId, `net:${host}`) >= env.hostLimit) return { ok: false, why: 'host-budget', url: url.href }
      if (netToday(core) >= (env.dayLimit ?? DAY_FETCH_LIMIT)) return { ok: false, why: 'budget', url: url.href }
    }
    const now = core.now()
    const wait = reserve(store, host, now, hostGapMs(store, env.sources, host), req.maxWait)
    if (wait === null) return { ok: false, why: 'busy', url: url.href, waitMs: waitFor(store, host, now) }
    if (wait > 0) await core.sleep(wait)
    // 待っている間に、同じホストへのほかの呼び出しが 403・確認画面・AI への意思表示を受けていれば取りに行かない（予約の後・転送の各段でも）
    const now2 = recheckHost(core, env, url, req)
    if (now2) return { ok: false, why: now2, url: url.href }
    if (count) {
      store.addRunCount(req.run!.runId, 'net')
      store.addRunCount(req.run!.runId, `net:${host}`)
      store.setMeta(NET_DAILY_META, { day: jstDateOf(core.now()), n: netToday(core) + 1 })
    }
    let res: Response
    try {
      res = await core.sourceFetch(url.href, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, Accept: req.accept ?? '*/*' },
        signal: timeoutSignal(),
      })
    } catch {
      log('source_fetch_failed', { host })
      return { ok: false, why: 'network', url: url.href }
    }
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => undefined)
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        return { ok: false, why: 'redirect', url: url.href, status: res.status }
      }
      const sameHost = next.hostname.toLowerCase() === host
      const scheme = next.protocol === 'https:' || (next.protocol === 'http:' && url.protocol === 'http:')
      if (
        hop >= MAX_REDIRECTS ||
        !sameHost ||
        !scheme ||
        next.username ||
        next.password ||
        next.port !== url.port ||
        hasDoubleSlash(next.pathname) ||
        (req.hop && !req.hop(next)) ||
        (req.rules !== false && !hopAllowedByRules(core, env, next))
      )
        return { ok: false, why: 'redirect', url: url.href, status: res.status }
      url = next
      continue
    }
    const { bytes, truncated } = await readCapped(res)
    // 応答が終わった時刻からも間をあける（遅い応答の直後に次を取らない）
    settle(store, host, core.now(), hostGapMs(store, env.sources, host))
    if (res.status === 403 || res.status === 429 || isChallenge(res.headers, res.status, asciiHead(bytes))) {
      if (req.markBlocked !== false) markHostUnreadable(store, host, core.now())
      log('source_blocked', { host, code: res.status })
      return { ok: false, why: 'blocked', url: url.href, status: res.status, headers: res.headers }
    }
    if (res.status < 200 || res.status >= 300)
      return { ok: false, why: 'status', url: url.href, status: res.status, headers: res.headers }
    return { ok: true, url: url.href, status: res.status, headers: res.headers, bytes, truncated }
  }
}

/** 応答を文字にする（符号は Content-Type・XML の宣言・<meta charset>。読めない符号は null） */
export function responseText(r: { headers: Headers; bytes: Uint8Array }): { text: string | null; charset: string } {
  const charset = charsetOf(r.headers.get('content-type'), r.bytes)
  return { text: decodeBytes(r.bytes, charset), charset }
}

// ---------- 本文 ----------

/** 本文を取らない訳（言葉は refusalText） */
export type BodyRefusal =
  | 'url'
  | 'gate'
  | 'qa'
  | 'robots'
  | 'ai'
  | 'unreadable'
  | 'pdf'
  | 'feed'
  | 'charset'
  | 'format'
  | 'busy'
  | 'budget'
  | 'permit'
  | 'status'
  | 'network'
  | 'redirect'
  | 'blocked'

export const BODY_REFUSAL_TEXTS: Readonly<Record<BodyRefusal, string>> = {
  url: 'この URL は取りません（許した出どころの、許した道の https: の URL だけ）',
  gate: 'この出どころは取れません',
  qa: 'この資料は試しの回だけで取ります（会見の記録の道。記者の質問の段を落とせると確かめるまで）',
  robots: 'この出どころは取れません（robots.txt）',
  ai: '取りを止めました（AI への意思表示が出ました。作者に伺います）',
  unreadable: '今日はこのホストを取りません（robots.txt を読めない・403・429・確認画面）',
  pdf: 'PDF は読みません（PDF の資料だけの発表は書けません）',
  feed: 'この出どころの RSS・Atom は資料にしません（RSS の利用条件の断り）',
  charset: '文字の符号が読めません（この資料は読めません）',
  format: '資料の形が読めません',
  busy: '混んでいます。もう一度呼んでください（同じホストへの間をあけています）',
  budget: 'これ以上取りに行けません（1つの回に100本・1つのホストに40本・1日（日本時間）に300本まで）',
  permit: 'この出どころは、この回にこれ以上本文を取れません（許しの範囲の本数）',
  status: '資料を取れませんでした（相手のサイトの答えが正常ではありません）',
  network: '資料を取れませんでした（つながりませんでした）。少し待ってから、もう一度呼んでください',
  redirect: '資料を取れませんでした（ほかのホスト・許していない道への転送はたどりません）',
  blocked: '今日はこのホストを取りません（403・429・確認画面。名乗りを替えて試し直しません）',
}

/** 取った本文の控え（DO の materials の1行にする前） */
export interface BodyRead {
  url: string
  title: string | null
  published: string | null
  lines: string[]
  chars: number
  /** html の本文の時、使った要素（null = ページ全体） */
  scope?: string | null
  /** 記者の質問の印ごとの行の数と落とした数（PRESS_QUESTION_MARKS の番号ごと） */
  marks?: { lines: number; dropped: number }[]
  /** 記者の質問の段の続きとして落とした行・話し手の印で段を終えた行の数 */
  cont?: QaCont
  /** 電文の時 */
  telegram?: Telegram
}

/** 控えの1行にする（本文は 12,000字まで。bodyChars は切る前） */
export function materialOf(
  runId: string,
  src: SourceConfig,
  b: Pick<BodyRead, 'url' | 'title' | 'published' | 'lines'>,
  now: number,
  extra: { author?: string | null; fallbackTitle?: string } = {},
): MaterialRow {
  const text = b.lines.join('\n')
  const chars = Array.from(text)
  const cut = chars.length > MATERIAL_MAX_CHARS
  return {
    runId,
    url: b.url,
    source: src.id,
    title: (b.title ?? extra.fallbackTitle ?? '').slice(0, 300),
    published: b.published,
    publishedNote: null,
    author: extra.author ?? null,
    via: null,
    body: cut ? chars.slice(0, MATERIAL_MAX_CHARS).join('') : text,
    bodyChars: chars.length,
    cut,
    fetched: now,
    readAt: null,
  }
}

/**
 * 本文を取る（html・anchor・jma-xml。feed は取らない）。出どころの状態・会見の道・robots.txt と AI の意思表示（道ごと）・URL の決まり・
 * 許しの本数・回の上限・間・PDF・RSS の断り・X-Robots-Tag と meta の noai を見る
 */
export async function fetchBody(
  core: VaultCore,
  env: FetchEnv,
  src: SourceConfig,
  rawUrl: string,
  run: RunRow | null,
  opts: { maxWait: number; fallback?: { title?: string; published?: string | null } },
): Promise<{ ok: true; read: BodyRead } | { ok: false; why: BodyRefusal; detail?: string }> {
  const check = checkBodyUrl(src, rawUrl)
  if (!check.ok) return { ok: false, why: check.why === 'pdf' ? 'pdf' : 'url' }
  // 全文の RSS の出どころ（Global Voices）は本文を取りに行かない（RSS の全文を控えから返す）。気象庁は電文（.xml）だけで HTML を取らない
  if (src.body.kind === 'feed') return { ok: false, why: 'url' }
  if (src.body.kind === 'jma-xml' && !/\.xml$/i.test(check.url.pathname)) return { ok: false, why: 'url' }
  const store = core.store
  const now = core.now()
  const gate = sourceGate(src, store, now, run)
  if (!gate.ok) return { ok: false, why: 'gate', detail: gate.text }
  if (qaBlocked(src, check.url.pathname, run)) return { ok: false, why: 'qa' }
  const path = await checkPath(core, env, check.url, run, opts.maxWait)
  if (path !== 'ok') return { ok: false, why: path }
  if (run && permitBodiesLeft(store, run.runId, src) === 0) return { ok: false, why: 'permit' }
  const accept = src.body.kind === 'jma-xml' ? 'application/xml, text/xml' : 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1'
  const got = await sourceGet(core, env, {
    url: check.url.href,
    run,
    maxWait: opts.maxWait,
    accept,
    hop: (u) => checkBodyUrl(src, u.href).ok && (src.body.kind !== 'jma-xml' || /\.xml$/i.test(u.pathname)),
  })
  if (!got.ok) return { ok: false, why: got.why === 'host-budget' ? 'budget' : got.why }
  if (run) countPermitBody(store, run.runId, src)
  const ctype = got.headers.get('content-type')
  if (isPdfResponse(ctype)) return { ok: false, why: 'pdf' }
  const host = new URL(got.url).hostname.toLowerCase()
  const headerStop = headerAiStop(got.headers)
  if (headerStop) {
    markBodyStop(store, host, core.now(), headerStop)
    return { ok: false, why: 'ai' }
  }
  const { text } = responseText(got)
  if (text === null) return { ok: false, why: 'charset' }
  if (src.terms.rssRefused && isFeedResponse(ctype, text.slice(0, FEED_HEAD_CHARS))) return { ok: false, why: 'feed' }
  const fallbackTitle = opts.fallback?.title ?? null
  const fallbackDate = opts.fallback?.published ?? null
  if (src.body.kind === 'jma-xml') {
    const t = parseTelegram(text)
    if (!t) return { ok: false, why: 'format' }
    return {
      ok: true,
      read: {
        url: got.url,
        title: t.title || fallbackTitle,
        published: t.reported ?? fallbackDate,
        lines: t.lines,
        chars: charLen(t.lines),
        telegram: t,
      },
    }
  }
  if (mimeOf(ctype) && !/html|xml/.test(mimeOf(ctype))) return { ok: false, why: 'format' }
  const events = normalizeEvents(await env.html(text))
  const metaStop = metaAiStop(events)
  if (metaStop) {
    markBodyStop(store, host, core.now(), metaStop)
    return { ok: false, why: 'ai' }
  }
  if (src.body.kind === 'anchor') {
    const id = decodeURIComponent(new URL(got.url).hash.slice(1) || new URL(rawUrl).hash.slice(1))
    const r = id ? readAnchor(events, id, { dropBlocks: src.body.dropBlocks, countMarks: PRESS_QUESTION_MARKS }) : null
    const lines = r?.lines ?? []
    // 転送で # が消えた時は、元の URL の # を残す（控えの URL は候補と同じ）
    const url = new URL(got.url)
    if (!url.hash && id) url.hash = id
    return {
      ok: true,
      read: {
        url: url.href,
        title: fallbackTitle ?? r?.title ?? null,
        published: fallbackDate,
        lines,
        chars: charLen(lines),
        marks: r?.marks,
        cont: r?.cont,
      },
    }
  }
  const b = readBody(events, {
    scopes: src.body.scopes,
    dropLines: src.body.dropLines,
    dropBlocks: src.body.dropBlocks,
    countMarks: PRESS_QUESTION_MARKS,
  })
  return {
    ok: true,
    read: {
      url: got.url,
      title: b.title ?? fallbackTitle,
      published: b.date ?? fallbackDate,
      lines: b.lines,
      chars: b.chars,
      scope: b.scope,
      marks: b.marks,
      cont: b.cont,
    },
  }
}

const charLen = (lines: readonly string[]) => Array.from(lines.join('\n')).length

/** RSS・Atom の応答かを見る頭の字数（<?xml-stylesheet?>・<!DOCTYPE>・注の後でも見つかるように） */
export const FEED_HEAD_CHARS = 4_000

/**
 * HTML の meta の AI への意思表示（robots・AI の名前の noai と Claude の名前の noindex（metaNoAi）・TDMRep の tdm-reservation: 1）。
 * 止める印か null
 */
export function metaAiStop(events: readonly HtmlEvent[]): string | null {
  for (const e of events) {
    if (e.t !== 'open' || e.name !== 'meta') continue
    const name = e.attrs.name ?? ''
    const content = e.attrs.content ?? ''
    if (metaNoAi(name, content)) return 'meta-noai'
    if (tdmMetaReserved(name, content)) return 'tdm-reservation'
  }
  return null
}

// ---------- Global Voices（RSS の全文） ----------

/** 全文の RSS の項目を文字にした物（別の条件の印・著者なしは外す） */
export type FeedBody =
  | { ok: true; title: string; lines: string[]; chars: number; author: string; published: string | null }
  | { ok: false; why: 'no-author' | 'cond'; mark?: number }

/**
 * 全文の RSS の項目を文字にする（content:encoded の HTML を同じ決まりで文字に。図の説明 figcaption は除く）。著者（dc:creator）の無い
 * 項目と、別の条件の印（excludeIfContains）が頭の2段と終わりの3段にある項目は外す（推測の決まり。外す側に寄せた）
 */
export async function feedBody(env: FetchEnv, src: SourceConfig, item: FeedItem): Promise<FeedBody> {
  const author = (item.author ?? '').replace(/\s+/g, ' ').trim()
  if (!author) return { ok: false, why: 'no-author' }
  const html = item.contentHtml ?? item.summary ?? ''
  const events = normalizeEvents(await env.html(html))
  const b = readBody(events, { scopes: [], skipTags: ['figcaption'] })
  if (src.body.kind === 'feed') {
    const marks = src.body.excludeIfContains.map((m) => m.toLowerCase())
    const edge = [...b.lines.slice(0, 2), ...b.lines.slice(Math.max(2, b.lines.length - 3))].map((l) => l.toLowerCase())
    const hit = marks.findIndex((m) => edge.some((l) => l.includes(m)))
    if (hit >= 0) return { ok: false, why: 'cond', mark: hit }
  }
  return { ok: true, title: item.title, lines: b.lines, chars: b.chars, author: author.slice(0, 100), published: item.date }
}

/** 本文が短い（出典にできない）か */
export const isShort = (chars: number): boolean => chars < SOURCE_BODY_MIN_CHARS

/** 日時の文字を ms に（読めなければ null。日付だけは null） */
export function timeOf(raw: string | null): { ms: number | null; dateOnly: string | null } {
  const p = publishedAtOf(raw)
  if (!p) return { ms: null, dateOnly: null }
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return { ms: null, dateOnly: p }
  const ms = Date.parse(p)
  return { ms: Number.isFinite(ms) ? ms : null, dateOnly: null }
}
