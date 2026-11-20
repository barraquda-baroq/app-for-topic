// 候補集め（段階3の設計の 1.7 の (3)〜(9)。DO の alarm の 'collect:{runId}'）。1回の alarm で「外への要求 6本まで」かつ「読む字数 30万字まで」
// （WORK_BUDGET_CHARS）で区切り、続きは次の alarm で（topic_list_candidates・topic_status(runId) の待ちの間も進む）。気象庁の Atom と
// Global Voices の RSS は、それぞれ1本で1回の alarm（大きいので、ほかと重ねない）。ホストが違えば続けて取り、同じホストは予約の間をあける。
// 段: lists（一覧を読み、窓の広げ方の分まで候補の元を「仮の候補」（s0001…・読めない印）として置く）→ bodies（窓の中の HTML の本文を先に読んで
// 控えに置く・気象庁の電文を優先の順に20本まで読む）→ final（読める候補が20件未満なら窓を24時間広げて bodies をもう一度。決まったら
// c0001 から並べ直し、仮の候補を消す。出どころごとの数（直近14回）・一覧の作りの印・probe の表を書く）。
// - 窓: 始まり = 直前の版の window.until（runs.ts の runWindow）。「始まりより後で、終わりまで」。日付だけの項目は、その日付が窓の始まりより
//   前に終わる物を入れず、項目の時刻を「初めて見た回の始めの時刻」にして窓で絞る（版の回だけ覚える。試しの回は覚えない）
// - 前の版（直近3日・6版）で出典にした URL は、いつも候補から除く
// - 外して数える物: PDF・ほかのホスト・取らない道・日付なし・カテゴリー・robots.txt・AI の意思表示・会見の道（試しの回だけ）・本文が短い・
//   別の条件・著者なし・訓練と取消・気象庁の種類と条件
// - 同じ枠の回が1時間以内に集めた候補があれば使い回す（同じ種類・probe なし・skip が同じ回だけ）
// 題・本文・リンクの文字は probe にも数にも出さない（数と番号と決まった印だけ）
import { jstDateOf } from '../../../src/domain/jst'
import { SOURCE_BODY_MIN_CHARS } from '../../../src/domain/limits'
import { hashJson } from '../../../src/domain/hash'
import { log } from '../log'
import type { VaultCore } from '../vault/core'
import type { TaskStep } from '../vault/runs'
import type { CandidateRow, CollectState, MaterialRow, RunRow } from '../vault/store'
import { recentTopics } from '../vault/tools/read'
import { stripMarks } from '../vault/tools/common'
import { agentCounts, decidePath, hostRulesData, hostStateOf, crawlDelayOf } from './robots'
import {
  envOf,
  FEED_HEAD_CHARS,
  feedBody,
  fetchBody,
  isShort,
  materialOf,
  metaAiStop,
  responseText,
  sourceGet,
  timeOf,
  type FetchEnv,
} from './article'
import { headerAiStop } from './aiSignals'
import { normalizeEvents } from './htmlTokens'
import { readHtmlList } from './htmlList'
import {
  groupKey,
  hasNeedWord,
  isCancel,
  isDrill,
  JMA_KINDS,
  JMA_TELEGRAMS_PER_RUN,
  kindOfTitle,
  sortForRead,
  telegramVerdict,
  type JmaKind,
} from './jma'
import { parseFeed, type FeedItem } from './rss'
import { similarTagText, similarTags } from './similar'
import { jmaSourceOf, sourceById, type ListConfig, type SourceConfig } from './sources'
import { sourceGate, qaBlocked, termsFingerprint, termsPageText } from './terms'
import { checkListUrl, isFeedResponse, isPdfPath, itemRefusal, itemUrl, listHopOk, mimeOf, pathDenied } from './urlPolicy'
import {
  acceptedOfHost,
  checkPath,
  dayWindow,
  jmaUnseen,
  jmaWatchEnabled,
  markBodyStop,
  noteJmaSeen,
  rulesDataOf,
  STEP_REQUESTS,
  STEP_WAIT_MAX_MS,
} from './watch'
import { sourceStateOf } from '../vault/tools/read'

/** 窓を広げる時にさかのぼる間（読める候補が20件未満の時。Q17 のあわせてで B を選んだ時は 72時間にする） */
export const WIDEN_MS = 24 * 3_600_000
/** 窓を広げる目安（読める候補の数） */
export const WIDEN_BELOW = 20
/** 同じ枠の回の候補を使い回す新しさ */
export const REUSE_MS = 3_600_000

/** 仮の候補の id の頭（final で c0001 から並べ直す） */
const STAGE = 's'

type Job =
  | { k: 'list'; src: string; i: number }
  | { k: 'body'; src: string; url: string }
  | { k: 'jma'; url: string }
  | { k: 'hosts'; id: string; step: 1 | 2 }
  | { k: 'terms'; key: string; url: string; step: 1 | 2 }

/** 候補集めの様子（runs.collect の JSON。CollectState に足す欄。題・本文は持たない） */
interface Collect extends CollectState {
  phase?: 'lists' | 'bodies' | 'final'
  jobs?: Job[]
  doneJobs?: number
  startedAt?: number
  finishedAt?: number
  seq?: number
  widenTried?: boolean
  /** 読んだ電文の数 */
  telegrams?: number
  /** 気象庁のまとめた組（EventID・系統）と、取消の組 */
  groups?: string[]
  cancelled?: string[]
  /** probe の文字の値（出どころ → 鍵 → 値。ASCII の印だけ） */
  ptext?: Record<string, Record<string, string>>
  /** 出どころごとの一覧の作りの数 */
  shape?: Record<string, { zero: number; undated: number }>
  /** 使い回した */
  reused?: boolean
}

const tagOf = (tags: readonly string[], head: string) => tags.find((t) => t.startsWith(head))?.slice(head.length) ?? null

/** 窓の中か（「始まりより後で、終わりまで」。日付だけの項目は、その日付が始まりより前に終わる物を入れない） */
export function inWindow(c: Pick<CandidateRow, 'atMs' | 'published' | 'tags'>, since: number, until: number): boolean {
  if (c.atMs === null) return false
  if (c.tags.includes('@d') && c.published) {
    const end = Date.parse(`${c.published}T00:00:00+09:00`) + 86_400_000
    if (Number.isFinite(end) && end <= since) return false
  }
  return c.atMs > since && c.atMs <= until
}

/** URL の指紋（日付だけの項目を初めて見た時刻の鍵） */
const urlFp = (url: string) => hashJson(url)

/** 本文の字数の段（probe） */
function lenBucket(chars: number): string {
  if (chars < SOURCE_BODY_MIN_CHARS) return 'len.lt200'
  if (chars < 1_000) return 'len.200'
  if (chars < 3_000) return 'len.1000'
  if (chars < 6_000) return 'len.3000'
  if (chars < 12_000) return 'len.6000'
  return 'len.12000'
}

/** 1歩の中の予算 */
interface Budget {
  requests: number
  chars: number
  /** 大きな一覧を読んだ（この歩はここまで） */
  heavy: boolean
  /** この歩で待ちが長かったホスト */
  busy: Set<string>
}

class Ctx {
  readonly core: VaultCore
  readonly env: FetchEnv
  readonly run: RunRow
  readonly c: Collect
  readonly store: VaultCore['store']
  /** 前の版（直近3日・6版）の出典の URL（いつも候補から除く） */
  readonly prev: Set<string>
  /** 回を始めた日（日本時間） */
  readonly today: string
  constructor(core: VaultCore, env: FetchEnv, run: RunRow, c: Collect) {
    this.core = core
    this.env = env
    this.run = run
    this.c = c
    this.store = core.store
    this.today = jstDateOf(run.started)
    this.prev = new Set(recentTopics(core, run.started).flatMap((g) => g.topics.flatMap((t) => t.urls)))
  }
  count(src: string, key: string, n = 1) {
    this.store.addRunCount(this.run.runId, `src:${src}:${key}`, n)
  }
  /** probe の数（probe の 'sources' の回だけ） */
  pcount(src: string, key: string, n = 1) {
    if (this.run.probe === 'sources' && n) this.store.addRunCount(this.run.runId, `p:${src}:${key}`, n)
  }
  ptext(src: string, key: string, v: string) {
    if (this.run.probe !== 'sources') return
    const t = (this.c.ptext ??= {})
    ;(t[src] ??= {})[key] = v.replace(/[^A-Za-z0-9_.:/+-]/g, '').slice(0, 40)
  }
  /** 窓を広げた時の始まりまで含めた、いちばん広い始まり */
  get widest(): number {
    return (this.run.sinceMs ?? this.run.started) - WIDEN_MS
  }
  get since(): number {
    return this.c.widenedSinceMs ?? this.run.sinceMs ?? this.run.started
  }
  get until(): number {
    return this.run.untilMs ?? this.run.started
  }
  staged(): CandidateRow[] {
    return this.store.candidates(this.run.runId).filter((r) => r.cid.startsWith(STAGE))
  }
  nextCid(): string {
    this.c.seq = (this.c.seq ?? 0) + 1
    return `${STAGE}${String(this.c.seq).padStart(4, '0')}`
  }
  save() {
    this.store.setRunCollect(this.run.runId, this.c)
  }
}

// ---------- 始め ----------

/** 同じ枠の回が1時間以内に集めた候補を使い回す（使い回したら true） */
function reuse(x: Ctx): boolean {
  const { run, store } = x
  if (run.probe || !run.editionId) return false
  for (const r of store.runs()) {
    const rc = r.collect as Collect
    if (r.runId === run.runId || r.done || r.kind !== run.kind || r.probe || r.editionId !== run.editionId) continue
    if (rc.state !== 'done' || !rc.finishedAt || run.started - rc.finishedAt > REUSE_MS || run.started < rc.finishedAt) continue
    if (JSON.stringify([...r.skip].sort()) !== JSON.stringify([...run.skip].sort())) continue
    const cands = store.candidates(r.runId).filter((c) => !c.cid.startsWith(STAGE))
    const urls = new Set(cands.map((c) => c.url))
    store.putCandidates(cands.map((c) => ({ ...c, runId: run.runId })))
    for (const m of store.materials(r.runId)) if (urls.has(m.url)) store.putMaterial({ ...m, runId: run.runId, readAt: null })
    if (r.sinceMs !== null && r.untilMs !== null) store.setRunWindow(run.runId, r.sinceMs, r.untilMs)
    x.c.widenedSinceMs = rc.widenedSinceMs
    x.c.reused = true
    log('collect_reused', { count: cands.length })
    return true
  }
  return false
}

function plan(x: Ctx): void {
  const { run, env, store, c } = x
  c.startedAt = x.core.now()
  c.jobs = []
  c.doneJobs = 0
  for (const src of env.sources) {
    if (run.kind === 'trial' && run.skip.includes(src.id)) {
      x.count(src.id, 'skip')
      continue
    }
    const gate = sourceGate(src, store, x.core.now(), run)
    if (!gate.ok) {
      x.count(src.id, `gate:${gate.state}`)
      continue
    }
    src.lists.forEach((l, i) => {
      // RSS の利用条件の断りのある出どころと、許しの社で RSS を使ってよくない時は、RSS・Atom を候補の元にしない（data の確かめでも止める）
      if (l.kind !== 'html' && src.terms.rssRefused) return
      if (l.kind === 'rss' && src.permit && !src.permit.rssAllowed) return
      c.jobs!.push({ k: 'list', src: src.id, i })
    })
  }
  c.phase = 'lists'
}

// ---------- 一覧 ----------

/** 一覧の項目（RSS・Atom・HTML をそろえた物） */
interface Entry {
  link: string
  title: string
  /** 日時の文字（RSS の pubDate など。HTML は 'YYYY-MM-DD'） */
  date: string | null
  /** 日付だけ（HTML の一覧） */
  dateOnly: boolean
  categories: string[]
  feed?: FeedItem
}

const isHeavy = (src: SourceConfig, l: ListConfig) => l.kind === 'atom' || src.body.kind === 'feed'

async function listJob(x: Ctx, src: SourceConfig, i: number, b: Budget): Promise<'done' | 'busy'> {
  const { run, store, env, core } = x
  const list = src.lists[i]
  const lk = `l${i}`
  const check = checkListUrl(src, list, list.url)
  if (!check.ok) {
    x.count(src.id, 'list-url')
    return 'done'
  }
  const host = check.url.hostname.toLowerCase()
  if (store.hostRule(host)?.day !== x.today) b.requests += 2
  const path = await checkPath(core, env, check.url, run, STEP_WAIT_MAX_MS)
  if (path === 'busy') return 'busy'
  if (path !== 'ok') {
    x.count(src.id, `gate:${path === 'robots' ? 'robots' : path === 'ai' ? 'ai' : 'unreadable'}`)
    return 'done'
  }
  const accept = list.kind === 'html' ? 'text/html' : 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9'
  const got = await sourceGet(core, env, {
    url: check.url.href,
    run,
    maxWait: STEP_WAIT_MAX_MS,
    accept,
    hop: (u) => listHopOk(src, list, u),
  })
  if (!got.ok) {
    if (got.why === 'busy') return 'busy'
    // 待っている間に、ほかの呼び出しが受けた 403・確認画面・AI への意思表示で今日の決まりが変わった（取りに行っていない）
    if (got.why === 'robots' || got.why === 'ai') {
      x.count(src.id, `gate:${got.why}`)
      return 'done'
    }
    b.requests += 1
    x.count(src.id, got.why === 'budget' || got.why === 'host-budget' ? 'budget' : 'list-fail')
    x.pcount(src.id, `${lk}.status`, got.status ?? 0)
    if (got.why === 'blocked') x.count(src.id, 'gate:unreadable')
    return 'done'
  }
  b.requests += 1
  b.chars += got.bytes.byteLength
  if (isHeavy(src, list)) b.heavy = true
  // 一覧の応答の AI への意思表示（X-Robots-Tag の noai・TDMRep の見出し）。Global Voices は RSS の全文が本文なので、この応答が本文の応答。
  // ほかの一覧でも、断る側に寄せて同じに止める
  const headerStop = headerAiStop(got.headers)
  if (headerStop) {
    markBodyStop(store, host, core.now(), headerStop)
    x.count(src.id, 'gate:ai')
    return 'done'
  }
  const { text, charset } = responseText(got)
  x.pcount(src.id, `${lk}.status`, got.status)
  x.ptext(src.id, `${lk}.type`, mimeOf(got.headers.get('content-type')) || 'none')
  x.ptext(src.id, `${lk}.charset`, charset)
  if (got.truncated) x.pcount(src.id, `${lk}.cut`)
  if (text === null) {
    x.count(src.id, 'charset')
    return 'done'
  }
  // RSS の利用条件の断りのある出どころでは、HTML の一覧の道が RSS・Atom を返しても読まない
  if (src.terms.rssRefused && isFeedResponse(got.headers.get('content-type'), text.slice(0, FEED_HEAD_CHARS))) {
    x.count(src.id, 'feed')
    return 'done'
  }
  const shape = ((x.c.shape ??= {})[src.id] ??= { zero: 0, undated: 0 })
  const entries: Entry[] = []
  if (list.kind === 'html') {
    const events = normalizeEvents(await env.html(text))
    // HTML の一覧のページの meta の AI への意思表示も、断る側に寄せて止める
    const metaStop = metaAiStop(events)
    if (metaStop) {
      markBodyStop(store, host, core.now(), metaStop)
      x.count(src.id, 'gate:ai')
      return 'done'
    }
    const r = readHtmlList(events, src, list, x.today)
    x.pcount(src.id, `${lk}.links`, r.links)
    x.pcount(src.id, `${lk}.matched`, r.matched)
    x.pcount(src.id, `${lk}.dated.row`, r.dated.row)
    x.pcount(src.id, `${lk}.dated.prev`, r.dated.prev)
    x.pcount(src.id, `${lk}.dated.yearless`, r.dated.yearless)
    r.shapes.forEach((s, j) => {
      x.ptext(src.id, `${lk}.shape${j}`, s.shape)
      x.pcount(src.id, `${lk}.shape${j}.n`, s.n)
    })
    if (r.matched === 0) shape.zero += 1
    else if (r.dated.row + r.dated.prev < r.matched / 2) shape.undated += 1
    for (const it of r.items) entries.push({ link: it.url, title: it.title, date: it.date, dateOnly: true, categories: [] })
  } else {
    const feed = parseFeed(text)
    const items = feed.items
    x.pcount(src.id, `${lk}.items`, items.length)
    if (feed.kind === null || items.length === 0) shape.zero += 1
    else if (items.filter((it) => timeOf(it.date).ms !== null || timeOf(it.date).dateOnly).length < items.length / 2)
      shape.undated += 1
    for (const it of items)
      entries.push({ link: it.link, title: it.title, date: it.date, dateOnly: false, categories: it.categories, feed: it })
  }
  if (list.kind === 'atom') await admitJma(x, src, i, entries)
  else for (const e of entries) await admit(x, src, list, i, e)
  return 'done'
}

/** 仮の候補にする（ほかの出どころ・同じ URL は1つ） */
function stage(x: Ctx, row: Omit<CandidateRow, 'runId' | 'cid' | 'readable'>): CandidateRow | null {
  if (x.store.candidates(x.run.runId).some((c) => c.url === row.url)) return null
  const r: CandidateRow = { ...row, runId: x.run.runId, cid: x.nextCid(), readable: false }
  x.store.putCandidates([r])
  return r
}

/** 項目の時刻（ms）。日付だけは、初めて見た回の始めの時刻（版の回だけ覚える。試しの回で覚えの無い物は、その回の始めの時刻） */
function entryTime(x: Ctx, url: string, e: Entry): { at: number | null; published: string | null; dateOnly: boolean } {
  if (e.dateOnly) {
    if (!e.date) return { at: null, published: null, dateOnly: true }
    const first = x.store.firstSeen(urlFp(url), x.run.started, x.run.kind === 'edition') ?? x.run.started
    return { at: first, published: e.date, dateOnly: true }
  }
  const t = timeOf(e.date)
  if (t.ms !== null) return { at: t.ms, published: e.date, dateOnly: false }
  if (t.dateOnly) {
    const first = x.store.firstSeen(urlFp(url), x.run.started, x.run.kind === 'edition') ?? x.run.started
    return { at: first, published: t.dateOnly, dateOnly: true }
  }
  return { at: null, published: null, dateOnly: false }
}

async function admit(x: Ctx, src: SourceConfig, list: ListConfig, i: number, e: Entry): Promise<void> {
  const lk = `l${i}`
  const url = itemUrl(src, e.link, list.url, src.body.kind === 'anchor')
  if (!url) {
    x.count(src.id, 'other-host')
    return
  }
  // Global Voices は本文を RSS から取るので、本文の道（allowPaths）は見ない（ホスト・https・取らない道だけ）
  const refusal = src.body.kind === 'feed' ? feedItemRefusal(src, url) : itemRefusal(src, url)
  if (refusal) {
    x.count(src.id, refusal === 'path' ? 'deny' : refusal)
    return
  }
  if (list.kind === 'rss' && list.excludeCategories?.length) {
    const hit = e.categories.some((cat) => list.excludeCategories!.some((w) => cat.includes(w)))
    if (hit) {
      x.count(src.id, 'category')
      return
    }
  }
  const t = entryTime(x, url, e)
  if (t.at === null) {
    x.count(src.id, 'undated')
    return
  }
  const day = dayWindow(x.run.started)
  if ((t.dateOnly && t.published === x.today) || (!t.dateOnly && t.at > day.since && t.at <= day.until))
    x.pcount(src.id, `${lk}.day`)
  if (x.prev.has(url)) {
    x.count(src.id, 'prev')
    return
  }
  const cand = { atMs: t.at, published: t.published, tags: t.dateOnly ? ['@d'] : [] }
  if (!inWindow(cand, x.widest, x.until)) return
  const u = new URL(url)
  if (src.body.kind !== 'feed') {
    const data = rulesDataOf(x.store.hostRule(u.hostname))
    const v = data ? decidePath(data, `${u.pathname}${u.search}`, acceptedOfHost(x.env, u.hostname)) : null
    if (v && v.verdict !== 'ok') {
      x.count(src.id, v.verdict === 'refused' ? 'robots' : 'ai')
      return
    }
    if (qaBlocked(src, u.pathname, x.run)) {
      x.count(src.id, 'qa')
      return
    }
  }
  const title = stripMarks(e.title).replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!title) {
    x.count(src.id, 'untitled')
    return
  }
  const tags = [...cand.tags, `@l:${list.label}`]
  if (src.body.kind === 'feed') {
    if (!e.feed) return
    const fb = await feedBody(x.env, src, e.feed)
    if (!fb.ok) {
      x.count(src.id, fb.why)
      if (fb.why === 'cond' && fb.mark !== undefined) x.pcount(src.id, `gv.mark${fb.mark}`)
      if (fb.why === 'no-author') x.pcount(src.id, 'gv.noauthor')
      return
    }
    const r = stage(x, { source: src.id, url, title, published: t.published, atMs: t.at, tags: [...tags, '英語'] })
    if (!r) return
    x.store.putMaterial(
      materialOf(x.run.runId, src, { url, title, published: fb.published, lines: fb.lines }, x.core.now(), {
        author: fb.author,
      }),
    )
    x.pcount(src.id, lenBucket(fb.chars))
    return
  }
  stage(x, { source: src.id, url, title, published: t.published, atMs: t.at, tags })
}

/** Global Voices の項目のリンクの決まり（https・本文のホスト・取らない道の外・PDF でない） */
function feedItemRefusal(src: SourceConfig, url: string): 'other-host' | 'deny' | 'pdf' | null {
  const u = new URL(url)
  if (u.protocol !== 'https:' || !src.hosts.body.includes(u.hostname.toLowerCase())) return 'other-host'
  if (pathDenied(u.pathname, src.denyPaths)) return 'deny'
  if (isPdfPath(u.pathname)) return 'pdf'
  return null
}

/** 気象庁の Atom の項目（①種類の表 ②見出しの要る語）を仮の候補にする（電文は bodies の段で読む） */
async function admitJma(x: Ctx, src: SourceConfig, i: number, entries: Entry[]): Promise<void> {
  const seen: string[] = []
  for (const e of entries) {
    const kind = kindOfTitle(e.title)
    if (!kind) {
      x.pcount(src.id, 'jma.other')
      continue
    }
    seen.push(kind.id)
    x.pcount(src.id, `jma.${kind.id}.atom`)
    if (!hasNeedWord(kind, e.feed?.contentHtml ?? e.feed?.summary ?? '')) {
      x.pcount(src.id, `jma.${kind.id}.noword`)
      x.count(src.id, 'jma-kind')
      continue
    }
    x.pcount(src.id, `jma.${kind.id}.word`)
    stageJma(x, src, i, e.link, e.title, timeOf(e.date).ms, kind)
  }
  noteJmaSeen(x.store, [...new Set(seen)], x.core.now())
}

function stageJma(x: Ctx, src: SourceConfig, i: number, link: string, title: string, at: number | null, kind: JmaKind) {
  const url = itemUrl(src, link, src.lists[i]?.url ?? link)
  if (!url || at === null) {
    x.count(src.id, url ? 'undated' : 'other-host')
    return
  }
  const refusal = itemRefusal(src, url)
  if (refusal) {
    x.count(src.id, refusal === 'path' ? 'deny' : refusal)
    return
  }
  if (!inWindow({ atMs: at, published: null, tags: [] }, x.widest, x.until)) return
  if (x.prev.has(url)) {
    x.count(src.id, 'prev')
    return
  }
  const label = src.lists[i]?.label ?? '随時の情報'
  stage(x, {
    source: src.id,
    url,
    title: stripMarks(title).slice(0, 80),
    published: new Date(at).toISOString(),
    atMs: at,
    tags: [`@l:${label}`, `@jma:${kind.id}`],
  })
}

// ---------- 本文と電文 ----------

/** 窓の中の、まだ読んでいない本文と電文を、やる事にする（電文は優先の順・新しい順に、回の20本まで） */
function planBodies(x: Ctx): void {
  const { c, env, store } = x
  const jobs: Job[] = []
  const have = new Set(store.materials(x.run.runId).map((m) => m.url))
  const jma: { url: string; kind: JmaKind; at: number }[] = []
  // 気象庁の見張りの控え（24時間。'ok' の時だけある）
  const jmaSrc = jmaSourceOf(env.sources)
  if (jmaWatchEnabled(env)) {
    const src = jmaSrc
    if (src && sourceGate(src, store, x.core.now(), x.run).ok && !(x.run.kind === 'trial' && x.run.skip.includes(src.id)))
      for (const w of store.jmaWatch()) {
        const kind = JMA_KINDS.find((k) => k.id === w.kind)
        if (kind) stageJma(x, src, 0, w.link, w.title, w.at, kind)
      }
  }
  for (const cand of x.staged()) {
    if (cand.tags.some((t) => t.startsWith('@x:')) || have.has(cand.url)) continue
    if (!inWindow(cand, x.since, x.until)) continue
    const src = sourceById(env.sources, cand.source)
    if (!src) continue
    const kindId = tagOf(cand.tags, '@jma:')
    if (kindId) {
      if (cand.tags.includes('@read')) continue
      const kind = JMA_KINDS.find((k) => k.id === kindId)
      if (kind) jma.push({ url: cand.url, kind, at: cand.atMs ?? 0 })
      continue
    }
    if (src.body.kind === 'html' || src.body.kind === 'anchor') jobs.push({ k: 'body', src: src.id, url: cand.url })
  }
  const room = Math.max(0, JMA_TELEGRAMS_PER_RUN - (c.telegrams ?? 0) - jobs.filter((j) => j.k === 'jma').length)
  const ordered = sortForRead(jma)
  for (const j of ordered.slice(0, room)) jobs.push({ k: 'jma', url: j.url })
  // 超えた分は Atom の題だけで「ほかに n本」と数える
  const over = ordered.slice(room)
  if (over.length && jmaSrc) {
    x.count(jmaSrc.id, 'jma-over', over.length)
    for (const o of over) markStaged(x, o.url, ['@x:jma-over'])
  }
  c.jobs = [...(c.jobs ?? []), ...jobs]
  c.phase = 'bodies'
}

/** 仮の候補の印を足す・題を替える */
function markStaged(x: Ctx, url: string, add: readonly string[], patch: Partial<CandidateRow> = {}) {
  const cand = x.staged().find((s) => s.url === url)
  if (!cand) return
  x.store.putCandidates([{ ...cand, ...patch, tags: [...new Set([...(patch.tags ?? cand.tags), ...add])] }])
}

async function bodyJob(x: Ctx, src: SourceConfig, url: string, b: Budget): Promise<'done' | 'busy'> {
  const cand = x.staged().find((s) => s.url === url)
  if (!cand) return 'done'
  const host = new URL(url).hostname.toLowerCase()
  if (x.store.hostRule(host)?.day !== x.today) b.requests += 2
  const r = await fetchBody(x.core, x.env, src, url, x.run, {
    maxWait: STEP_WAIT_MAX_MS,
    fallback: { title: cand.title, published: cand.published },
  })
  if (!r.ok) {
    if (r.why === 'busy') return 'busy'
    if (!['gate', 'qa', 'robots', 'ai', 'unreadable', 'url'].includes(r.why)) b.requests += 1
    // 本数の上限・許しの本数は、先読みしないだけ（候補には残す）
    if (r.why === 'budget' || r.why === 'permit') {
      x.count(src.id, `nobody:${r.why}`)
      return 'done'
    }
    x.count(src.id, r.why === 'pdf' ? 'pdf' : r.why === 'robots' || r.why === 'ai' ? r.why : `body:${r.why}`)
    markStaged(x, url, [`@x:${r.why}`])
    return 'done'
  }
  b.requests += 1
  b.chars += r.read.chars
  const m = materialOf(x.run.runId, src, r.read, x.core.now(), { fallbackTitle: cand.title })
  x.store.putMaterial(m)
  if (r.read.url !== cand.url) markStaged(x, url, [], { url: r.read.url })
  x.pcount(src.id, lenBucket(m.bodyChars))
  x.pcount(
    src.id,
    r.read.scope === undefined ? 'scope.none' : r.read.scope === null ? 'scope.page' : `scope.${scopeIndex(src, r.read.scope)}`,
  )
  r.read.marks?.forEach((mk, j) => {
    x.pcount(src.id, `qa${j}.lines`, mk.lines)
    x.pcount(src.id, `qa${j}.dropped`, mk.dropped)
  })
  // 記者の質問の段の続きとして落とした行と、話し手の印で段を終えた行（S1 で段の終わりの印を見直す手がかり）
  if (r.read.cont) {
    x.pcount(src.id, 'qa.cont.dropped', r.read.cont.dropped)
    x.pcount(src.id, 'qa.cont.ended', r.read.cont.ended)
  }
  if (isShort(m.bodyChars)) {
    x.count(src.id, 'short')
    markStaged(x, r.read.url, ['@x:short'])
  }
  return 'done'
}

const scopeIndex = (src: SourceConfig, scope: string) => (src.body.kind === 'html' ? src.body.scopes.indexOf(scope) : -1)

async function jmaJob(x: Ctx, url: string, b: Budget): Promise<'done' | 'busy'> {
  const cand = x.staged().find((s) => s.url === url)
  const src = cand ? sourceById(x.env.sources, cand.source) : null
  if (!src || !cand) return 'done'
  const kind = JMA_KINDS.find((k) => k.id === tagOf(cand.tags, '@jma:'))
  if (!kind) return 'done'
  const host = new URL(url).hostname.toLowerCase()
  if (x.store.hostRule(host)?.day !== x.today) b.requests += 2
  const r = await fetchBody(x.core, x.env, src, url, x.run, { maxWait: STEP_WAIT_MAX_MS, fallback: { title: cand.title } })
  if (!r.ok) {
    if (r.why === 'busy') return 'busy'
    b.requests += 1
    x.count(src.id, `body:${r.why}`)
    markStaged(x, url, [`@x:${r.why}`, '@read'])
    return 'done'
  }
  b.requests += 1
  b.chars += r.read.chars
  x.c.telegrams = (x.c.telegrams ?? 0) + 1
  x.pcount(src.id, 'jma.read')
  const t = r.read.telegram!
  if (isDrill(t)) {
    x.count(src.id, 'drill')
    x.pcount(src.id, 'jma.drill')
    markStaged(x, url, ['@x:drill', '@read'])
    return 'done'
  }
  const key = groupKey(kind, t)
  if (isCancel(t)) {
    x.count(src.id, 'drill')
    x.pcount(src.id, 'jma.cancel')
    markStaged(x, url, ['@x:drill', '@read'])
    if (key) {
      ;(x.c.cancelled ??= []).push(key)
      for (const s of x.staged()) if (s.tags.includes(`@g:${key}`)) markStaged(x, s.url, ['@x:drill'])
    }
    return 'done'
  }
  if (key && x.c.cancelled?.includes(key)) {
    x.count(src.id, 'drill')
    markStaged(x, url, ['@x:drill', '@read'])
    return 'done'
  }
  if (key && x.c.groups?.includes(key)) {
    // 同じ組のもっと新しい電文を読んだ（組ごとにいちばん新しい電文だけ）
    x.count(src.id, 'jma-dup')
    markStaged(x, url, ['@x:jma-dup', '@read'])
    return 'done'
  }
  if (key) (x.c.groups ??= []).push(key)
  const v = telegramVerdict(kind, t)
  if (!v.include) {
    x.count(src.id, 'jma-cond')
    markStaged(x, url, ['@x:jma-cond', '@read', ...(key ? [`@g:${key}`] : [])])
    return 'done'
  }
  x.pcount(src.id, 'jma.after')
  const head = t.headline ? `　${t.headline}` : ''
  const title = stripMarks(`${t.title || cand.title}${head}`)
    .replace(/\s+/g, ' ')
    .slice(0, 120)
  const m = materialOf(x.run.runId, src, r.read, x.core.now(), { fallbackTitle: title })
  x.store.putMaterial(m)
  if (isShort(m.bodyChars)) x.count(src.id, 'short')
  markStaged(
    x,
    url,
    ['@read', ...(isShort(m.bodyChars) ? ['@x:short'] : []), ...(v.tag ? [v.tag] : []), ...(key ? [`@g:${key}`] : [])],
    {
      title,
      url: r.read.url,
    },
  )
  return 'done'
}

// ---------- 決める ----------

/** 読める候補か（控えがあれば本文が200字以上。先読みしなかった HTML は読める物として残す。電文は読んで入れた物だけ） */
function readableOf(c: CandidateRow, mats: ReadonlyMap<string, MaterialRow>): boolean {
  if (c.tags.some((t) => t.startsWith('@x:'))) return false
  const m = mats.get(c.url)
  if (c.tags.some((t) => t.startsWith('@jma:')))
    return c.tags.includes('@read') && m !== undefined && m.bodyChars >= SOURCE_BODY_MIN_CHARS
  return m ? m.bodyChars >= SOURCE_BODY_MIN_CHARS : true
}

/** 決める（読める候補が少なければ窓を広げて本文の段をもう一度。決まったら c0001 から並べ直す）。広げたら false */
function finalize(x: Ctx): boolean {
  const { run, store, env, c } = x
  const mats = new Map(store.materials(run.runId).map((m) => [m.url, m]))
  const staged = x.staged()
  const ready = staged.filter((s) => readableOf(s, mats) && inWindow(s, x.since, x.until))
  if (ready.length < WIDEN_BELOW && !c.widenTried && run.sinceMs !== null && run.untilMs !== null) {
    c.widenTried = true
    c.widenedSinceMs = run.sinceMs - WIDEN_MS
    planBodies(x)
    if (c.jobs!.length) return false
    // 読む物が無ければ、広げた窓のまま決める
  }
  const order = new Map(env.sources.map((s, i) => [s.id, i]))
  const chosen = staged
    .filter((s) => readableOf(s, mats) && inWindow(s, x.since, x.until))
    .sort(
      (a, b) =>
        (order.get(a.source) ?? 99) - (order.get(b.source) ?? 99) || (b.atMs ?? 0) - (a.atMs ?? 0) || (a.cid < b.cid ? -1 : 1),
    )
  const rows: CandidateRow[] = chosen.map((s, i) => ({
    ...s,
    cid: `c${String(i + 1).padStart(4, '0')}`,
    tags: s.tags.filter((t) => !t.startsWith('@read') && !t.startsWith('@g:') && !t.startsWith('@jma:')),
    readable: true,
  }))
  const sim = similarTags(rows.map((r) => ({ cid: r.cid, title: r.title })))
  for (const r of rows) {
    const others = sim.get(r.cid)
    if (others) r.tags.push(similarTagText(others))
  }
  // 窓の外の物・外した物の控えは残さない（読める候補の控えだけ）
  const keep = new Set(rows.map((r) => r.url))
  store.transaction(() => {
    const n = staged.length
    store.sql.run(`DELETE FROM candidates WHERE run_id = ? AND substr(cid, 1, 1) = ?`, run.runId, STAGE)
    store.countRows(n)
    if (rows.length) store.putCandidates(rows)
    for (const m of mats.values()) if (!keep.has(m.url)) store.deleteMaterial(run.runId, m.url)
  })
  if (c.widenedSinceMs !== undefined && run.untilMs !== null) store.setRunWindow(run.runId, c.widenedSinceMs, run.untilMs)
  writeCounts(x, rows)
  if (run.probe === 'sources') writeProbe(x, rows.length)
  log('collect_done', { count: rows.length })
  return true
}

/** 出どころごとの数（直近14回）と一覧の作りの印 */
function writeCounts(x: Ctx, rows: readonly CandidateRow[]): void {
  const { run, store, env } = x
  const now = x.core.now()
  const unseen = jmaUnseen(store, now)
  for (const src of env.sources) {
    const counts: Record<string, number> = { ok: rows.filter((r) => r.source === src.id).length }
    for (const [k, n] of Object.entries(store.runCounts(run.runId, `src:${src.id}:`)))
      counts[k.slice(`src:${src.id}:`.length)] = n
    store.putSourceCounts(src.id, run.started, counts)
    const sh = x.c.shape?.[src.id]
    const flags = store.sourceFlags(src.id)
    const next = {
      ...flags,
      structure: sh ? sh.zero > 0 : (flags.structure ?? false),
      undated: sh ? sh.undated > 0 : (flags.undated ?? false),
      ...(src.id === 'jma' ? { jmaUnseen: unseen } : {}),
    }
    if (JSON.stringify(next) !== JSON.stringify(flags)) store.setSourceFlags(src.id, next, now)
  }
}

/** probe の表（'sources'。数と番号と決まった印だけ。題・本文・リンクの文字は持たない） */
function writeProbe(x: Ctx, readable: number): void {
  const { run, store, env, c } = x
  const now = x.core.now()
  for (const src of env.sources) {
    const data: Record<string, number | string | boolean | null> = {
      state: sourceStateOf(src, store, now, { trial: true }).state,
    }
    for (const host of [...new Set([...src.hosts.list, ...src.hosts.body])]) {
      const rule = store.hostRule(host)
      const d = rulesDataOf(rule)
      const h = src.hosts.list.length + src.hosts.body.length > 2 ? `${host}.` : ''
      data[`${h}robots`] = d?.status ?? null
      data[`${h}rules`] = rule?.state ?? null
      data[`${h}delay`] = rule?.crawlDelay ?? null
      if (d) {
        const a = agentCounts(d)
        data[`${h}agents.anthropic`] = a.anthropic
        data[`${h}agents.ai`] = a.ai
        data[`${h}agents.unknown`] = a.unknown
        data[`${h}signals`] = d.signals.length + (d.aiComment ? 1 : 0)
        data[`${h}tdm`] = d.tdmStatus
      }
    }
    for (const [k, n] of Object.entries(store.runCounts(run.runId, `src:${src.id}:`)))
      data[`ex.${k.slice(`src:${src.id}:`.length)}`] = n
    for (const [k, n] of Object.entries(store.runCounts(run.runId, `p:${src.id}:`))) data[k.slice(`p:${src.id}:`.length)] = n
    for (const [k, v] of Object.entries(c.ptext?.[src.id] ?? {})) data[k] = v
    data.readable = store.candidates(run.runId).filter((r) => r.source === src.id).length
    store.putProbe({ runId: run.runId, source: src.id, data, text: null })
  }
  store.putProbe({
    runId: run.runId,
    source: '_collect',
    data: {
      ms: now - (c.startedAt ?? run.started),
      readable,
      requests: store.runCount(run.runId, 'net'),
      widened: c.widenedSinceMs !== undefined,
      telegrams: c.telegrams ?? 0,
    },
    text: null,
  })
}

// ---------- probe 'hosts'・'terms' ----------

/** server の頭（ASCII の印だけ） */
const serverHead = (h: Headers | undefined) =>
  (h?.get('server') ?? '')
    .split(/[\s/]/)[0]
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .slice(0, 20)

/** probe 'hosts' の前の結果（meta。ホストごと。消えない。403・確認画面なら二度と試さない） */
export const HOSTS_PROBE_META = 'hostsProbe'

interface HostsProbeSeen {
  day: string
  robots: number
  challenge: boolean
  page: number | null
}

const hostsProbeSeen = (x: Ctx): Record<string, HostsProbeSeen> =>
  x.store.getMeta<Record<string, HostsProbeSeen>>(HOSTS_PROBE_META) ?? {}

function noteHostsProbe(x: Ctx, id: string, patch: Partial<HostsProbeSeen>): void {
  const all = hostsProbeSeen(x)
  const prev = all[id] ?? { day: x.today, robots: 0, challenge: false, page: null }
  all[id] = { ...prev, ...patch }
  x.store.setMeta(HOSTS_PROBE_META, all)
}

/** 前の結果で、もう取りに行かないか（403・429・確認画面だった・同じ日に確かめた・今日そのホストを取らない） */
function hostsProbeDone(x: Ctx, id: string, host: string): HostsProbeSeen | 'unreadable' | null {
  const seen = hostsProbeSeen(x)[id]
  if (seen && (seen.robots === 403 || seen.robots === 429 || seen.challenge || seen.day === x.today)) return seen
  const rule = x.store.hostRule(host)
  if (rule && rule.day === jstDateOf(x.core.now()) && rule.state === 'unreadable') return 'unreadable'
  return null
}

async function hostsJob(x: Ctx, id: string, step: 1 | 2): Promise<'done' | 'busy'> {
  const p = x.env.pending.find((h) => h.id === id)
  if (!p) return 'done'
  const { store, core, env, run } = x
  const cur = store.probes(run.runId).find((r) => r.source === id)?.data ?? {}
  if (step === 1) {
    // S1b は1回だけ（403・確認画面なら、ほかの回・日・時刻では二度と試さない。設計 1.7 の (2) の 5）
    const done = hostsProbeDone(x, id, p.host)
    if (done) {
      const data: Record<string, number | string | boolean | null> =
        done === 'unreadable'
          ? { verdict: 'tried-before', unreadable: true }
          : { verdict: 'tried-before', robots: done.robots, challenge: done.challenge, page: done.page, day: done.day }
      store.putProbe({ runId: run.runId, source: id, data, text: null })
      return 'done'
    }
    const got = await sourceGet(core, env, {
      url: `https://${p.host}/robots.txt`,
      run: null,
      maxWait: STEP_WAIT_MAX_MS,
      count: false,
      markBlocked: false,
      rules: false,
      accept: 'text/plain, */*;q=0.1',
    })
    if (!got.ok && got.why === 'busy') return 'busy'
    const status = got.status ?? 0
    const data: Record<string, number | string | boolean | null> = {
      robots: status,
      server: serverHead(got.headers) || null,
      challenge:
        (got.headers?.get('cf-mitigated') ?? '').toLowerCase().includes('challenge') || (!got.ok && got.why === 'blocked'),
    }
    const now = core.now()
    if (got.ok) {
      const rd = hostRulesData({ status, text: responseText(got).text ?? '' }, { status: 0, entries: null }, null)
      const v = decidePath(rd, '/')
      data.verdict = v.verdict
      data.a = !v.reasons.some((r) => r === 'connector' || r === 'claude-user')
      data.b = !v.reasons.some((r) => r.startsWith('anthropic:'))
      data.c = v.verdict !== 'stopped'
      const st = hostStateOf(rd, ['/'])
      store.putHostRule({
        host: p.host,
        day: jstDateOf(now),
        state: st.state,
        crawlDelay: crawlDelayOf(rd),
        data: rd as never,
        checked: now,
        changed: null,
      })
    } else if (status === 404 || status === 410) {
      data.verdict = 'no-rules'
      const rd = hostRulesData({ status, text: null }, { status: 0, entries: null }, null)
      store.putHostRule({
        host: p.host,
        day: jstDateOf(now),
        state: 'ok',
        crawlDelay: null,
        data: rd as never,
        checked: now,
        changed: null,
      })
    } else {
      data.verdict = 'unreadable'
      store.putHostRule({
        host: p.host,
        day: jstDateOf(now),
        state: 'unreadable',
        crawlDelay: null,
        data: {},
        checked: now,
        changed: null,
      })
    }
    store.putProbe({ runId: run.runId, source: id, data, text: null })
    noteHostsProbe(x, id, { day: x.today, robots: status, challenge: data.challenge === true, page: null })
    // robots.txt が 403 の時だけ、規約のページ1つの番号を見る（本文は読まない）
    if (status === 403) x.c.jobs!.unshift({ k: 'hosts', id, step: 2 })
    return 'done'
  }
  const got = await sourceGet(core, env, {
    url: p.statusUrl,
    run: null,
    maxWait: STEP_WAIT_MAX_MS,
    count: false,
    markBlocked: false,
  })
  if (!got.ok && got.why === 'busy') return 'busy'
  store.putProbe({
    runId: run.runId,
    source: id,
    data: { ...cur, page: got.status ?? 0, pageServer: serverHead(got.headers) || null },
    text: null,
  })
  noteHostsProbe(x, id, { page: got.status ?? 0 })
  return 'done'
}

/** probe 'terms' のページ（出どころの termsPages と、S1b で robots.txt が取ってよいと分かった今は取らない所の termsPages） */
function termsTargets(x: Ctx): { key: string; url: string; scopes: readonly string[]; pending: boolean }[] {
  const out: { key: string; url: string; scopes: readonly string[]; pending: boolean }[] = []
  for (const s of x.env.sources) {
    if (x.run.skip.includes(s.id)) continue
    s.termsPages.forEach((p, i) => out.push({ key: `${s.id}.t${i}`, url: p.url, scopes: p.scopes, pending: false }))
  }
  for (const h of x.env.pending)
    h.termsPages.forEach((p, i) => out.push({ key: `${h.id}.t${i}`, url: p.url, scopes: p.scopes, pending: true }))
  return out
}

async function termsJob(x: Ctx, key: string, url: string, step: 1 | 2): Promise<'done' | 'busy'> {
  const { store, core, env, run } = x
  const target = termsTargets(x).find((t) => t.key === key)
  if (!target) return 'done'
  const u = new URL(url)
  const host = u.hostname.toLowerCase()
  if (step === 1) {
    if (target.pending) {
      // 今は取らない所は、S1b の robots.txt の読み（今日でなくてよい）で取ってよいと分かったホストだけ。robots.txt を読み直さない
      const rule = store.hostRule(host)
      const d = rulesDataOf(rule)
      if (!rule || rule.state !== 'ok' || !d || decidePath(d, u.pathname).verdict !== 'ok') {
        store.putProbe({ runId: run.runId, source: key, data: { verdict: 'skipped' }, text: null })
        return 'done'
      }
    } else {
      const path = await checkPath(core, env, u, null, STEP_WAIT_MAX_MS)
      if (path === 'busy') return 'busy'
      if (path !== 'ok') {
        store.putProbe({ runId: run.runId, source: key, data: { verdict: path }, text: null })
        return 'done'
      }
    }
  }
  // 規約のページも、403・429・確認画面なら、その日はそのホストを取らない（同じホストのほかの規約のページも取らない。2回目も取らない）
  const got = await sourceGet(core, env, {
    url,
    run: null,
    maxWait: STEP_WAIT_MAX_MS,
    count: false,
    accept: 'text/html',
  })
  if (!got.ok && got.why === 'busy') return 'busy'
  if (!got.ok && (got.why === 'blocked' || got.why === 'robots' || got.why === 'ai')) {
    if (step === 1)
      store.putProbe({
        runId: run.runId,
        source: key,
        data: { verdict: got.why === 'blocked' ? 'blocked' : got.why, status: got.status ?? 0 },
        text: null,
      })
    else {
      const cur = store.probes(run.runId).find((r) => r.source === key)
      if (cur) store.putProbe({ ...cur, data: { ...cur.data, fp2: null, same: false, status2: got.status ?? 0 } })
    }
    return 'done'
  }
  let text: string | null = null
  if (got.ok) {
    const t = responseText(got).text
    if (t !== null) text = termsPageText(normalizeEvents(await env.html(t)), { scopes: target.scopes })
  }
  const fp = text !== null ? termsFingerprint(text) : null
  if (step === 1) {
    store.putProbe({
      runId: run.runId,
      source: key,
      data: { verdict: 'ok', status: got.status ?? 0, chars: text === null ? 0 : Array.from(text).length, fp },
      text: text === null ? null : Array.from(text).slice(0, 20_000).join(''),
    })
    // 同じページを2回取って、同じ指紋になるかを見る（読めた時だけ）
    if (got.ok) x.c.jobs!.unshift({ k: 'terms', key, url, step: 2 })
    return 'done'
  }
  const cur = store.probes(run.runId).find((r) => r.source === key)
  if (cur) store.putProbe({ ...cur, data: { ...cur.data, fp2: fp, same: fp !== null && fp === cur.data.fp } })
  return 'done'
}

// ---------- 1歩 ----------

const jobHost = (x: Ctx, j: Job): string => {
  try {
    if (j.k === 'list') return new URL(sourceById(x.env.sources, j.src)!.lists[j.i].url).hostname.toLowerCase()
    if (j.k === 'hosts') return x.env.pending.find((p) => p.id === j.id)?.host ?? ''
    return new URL(j.url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 候補集めを1歩進める（FetchWork.collectStep）。外への要求 6本・読む字数 workBudgetChars まで。どの残りの仕事もホストの待ちが長い時は、
 * いちばん早く取れる時刻を次の時刻にする
 */
export async function collectStep(core: VaultCore, runId: string): Promise<TaskStep> {
  const env = envOf(core)
  const run = core.store.getRun(runId)
  if (!run || run.done || run.collect.state !== 'collecting') return { done: true }
  const c = { ...(run.collect as Collect) }
  const x = new Ctx(core, env, run, c)
  if (!c.phase) {
    if (run.probe === 'hosts') {
      c.jobs = env.pending.map((p) => ({ k: 'hosts' as const, id: p.id, step: 1 as const }))
      c.phase = 'bodies'
      c.startedAt = core.now()
    } else if (run.probe === 'terms') {
      c.jobs = termsTargets(x).map((t) => ({ k: 'terms' as const, key: t.key, url: t.url, step: 1 as const }))
      c.phase = 'bodies'
      c.startedAt = core.now()
    } else if (reuse(x)) {
      x.c.state = 'done'
      x.c.finishedAt = core.now()
      delete x.c.jobs
      x.save()
      return { done: true }
    } else plan(x)
  }
  const b: Budget = { requests: 0, chars: 0, heavy: false, busy: new Set() }
  const budgetChars = core.config.workBudgetChars
  for (let guard = 0; guard < 200; guard++) {
    const jobs = c.jobs ?? []
    if (!jobs.length) {
      if (run.probe === 'hosts' || run.probe === 'terms') {
        c.state = 'done'
        c.finishedAt = core.now()
        c.progress = { done: c.doneJobs ?? 0, total: c.doneJobs ?? 0 }
        delete c.jobs
        x.save()
        log('probe_done', { count: c.doneJobs ?? 0 })
        return { done: true }
      }
      if (c.phase === 'lists') {
        planBodies(x)
        continue
      }
      if (c.phase === 'bodies') c.phase = 'final'
      if (c.phase === 'final') {
        if (!finalize(x)) continue
        c.state = 'done'
        c.finishedAt = core.now()
        c.progress = { done: c.doneJobs ?? 0, total: c.doneJobs ?? 0 }
        for (const k of ['jobs', 'groups', 'cancelled', 'ptext', 'shape', 'phase'] as const) delete c[k]
        x.save()
        return { done: true }
      }
    }
    if (b.heavy || b.requests >= STEP_REQUESTS || b.chars >= budgetChars) break
    // 待ちの短いホストの仕事から（大きな一覧は歩の最初だけ）
    const idx = jobs.findIndex((j) => {
      const host = jobHost(x, j)
      if (b.busy.has(host)) return false
      if (j.k === 'list') {
        const src = sourceById(env.sources, j.src)
        if (src && isHeavy(src, src.lists[j.i]) && b.requests > 0) return false
      }
      const next = core.store.hostNext(host)
      return next === null || next - core.now() <= STEP_WAIT_MAX_MS
    })
    if (idx < 0) break
    const job = jobs[idx]
    let r: 'done' | 'busy' = 'done'
    if (job.k === 'list') {
      const src = sourceById(env.sources, job.src)
      if (src) r = await listJob(x, src, job.i, b)
    } else if (job.k === 'body') {
      const src = sourceById(env.sources, job.src)
      if (src) r = await bodyJob(x, src, job.url, b)
    } else if (job.k === 'jma') r = await jmaJob(x, job.url, b)
    else if (job.k === 'hosts') {
      r = await hostsJob(x, job.id, job.step)
      if (r === 'done') b.requests += 1
    } else {
      r = await termsJob(x, job.key, job.url, job.step)
      if (r === 'done') b.requests += job.step === 1 ? 3 : 1
    }
    if (r === 'busy') {
      b.busy.add(jobHost(x, job))
      continue
    }
    const at = (c.jobs ?? []).indexOf(job)
    if (at >= 0) c.jobs!.splice(at, 1)
    c.doneJobs = (c.doneJobs ?? 0) + 1
  }
  const left = c.jobs ?? []
  c.progress = { done: c.doneJobs ?? 0, total: (c.doneJobs ?? 0) + left.length }
  x.save()
  // 次の時刻: 予算で止めた時はすぐ。待ちで止めた時は、いちばん早く取れる時刻
  if (b.requests >= STEP_REQUESTS || b.chars >= budgetChars || b.heavy || !left.length) return { done: false, next: core.now() }
  const nexts = left.map((j) => core.store.hostNext(jobHost(x, j)) ?? core.now())
  return { done: false, next: Math.max(core.now(), Math.min(...nexts)) }
}
