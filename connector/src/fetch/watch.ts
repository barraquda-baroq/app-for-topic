// 見張り（段階3の設計の 1.7 の (2)・(4)・(5)・(10)）:
// - 毎日の決まりの読み（cron 4:23 の rules。cron が動かなかった日は、その日の最初の回が読む）: ホストごとに robots.txt と
//   /.well-known/tdmrep.json を読み、robots.ts の (a)〜(d) で決めて DO（host_rules）に覚える。前と変わったら、その日の候補の一覧と
//   topic_status に「robots.txt が変わりました」。読めない時（5xx・時間切れ・403・確認画面・文字の符号が読めない）は、その日はそのホストから
//   取らない。404 は決まりなし
// - 規約のページ（日曜だけ）: data の termsPages のうち watch: 'weekly' で指紋のある物を取り、data の指紋と比べる。違えばその出どころを
//   「取らない（規約のページが変わりました）」にする（気象庁の 'probe-only' は取らない）。止めは data の指紋が新しくなるまで続け（次の週に
//   読めない・同じでも外さない）、2週続けて読めないページも同じに止める
// - 気象庁の見張り（3時間ごと。気象庁の data が 'ok' で指紋がそろった時だけ）: 短い Atom を1本読み、版に入れてよい種類の項目だけ（題・
//   リンク・時刻・種類）を24時間持つ（電文は読まない）
// - 一覧の作りの印（source_state）: 一覧が 200 なのに道の形に合う項目が0件・日付の読めた項目が半分未満（取りは止めない）
import { jstDateOf, jstParts } from '../../../src/domain/jst'
import { log } from '../log'
import type { VaultCore } from '../vault/core'
import type { TaskStep } from '../vault/runs'
import type { HostRuleRow, MirrorStore, RunRow } from '../vault/store'
import { envOf, responseText, sourceGet, type FetchEnv } from './article'
import { headerAiStop, parseTdmRep } from './aiSignals'
import { hostGapMs, settle } from './pace'
import { normalizeEvents } from './htmlTokens'
import { hasNeedWord, kindOfTitle, JMA_KINDS } from './jma'
import { crawlDelayOf, decidePath, hostRulesData, hostStateOf, type HostRulesData } from './robots'
import { parseFeed } from './rss'
import { hostsOfSources, jmaSourceOf, sourcesOfHost, termsFingerprinted, type SourceConfig } from './sources'
import { sourceGate, termsFingerprint, termsPageText } from './terms'
import { timeOf } from './article'
import { listHopOk } from './urlPolicy'

/** 決まりの読みの1歩で待つ上限（ms。超えたら次の alarm で） */
export const STEP_WAIT_MAX_MS = 1_500
/** 1歩の外への要求の数 */
export const STEP_REQUESTS = 6
/** robots.txt の後の tdmrep.json を待つ上限（ms。そのホストの間がこれより長い時は、その日の決まりを読まない＝取らない） */
export const TDM_WAIT_MAX_MS = 15_000

/** host_rules の data を読む（形が違えば null） */
export function rulesDataOf(row: HostRuleRow | null): HostRulesData | null {
  const d = row?.data as Partial<HostRulesData> | undefined
  if (!d || !Array.isArray(d.groups) || !Array.isArray(d.names) || !Array.isArray(d.base) || !Array.isArray(d.signals))
    return null
  return d as HostRulesData
}

/** そのホストの出どころの terms.accepted のいちばん新しい日（本文の止めを外す日） */
export function acceptedOfHost(env: FetchEnv, host: string): string | null {
  const days = sourcesOfHost(env.sources, host).map((s) => s.terms.accepted)
  return days.length ? days.sort().at(-1)! : null
}

/** ホストの状態を決める道（一覧の道と、取ってよい道） */
export function hostPaths(env: FetchEnv, host: string): string[] {
  const out = new Set<string>()
  for (const s of sourcesOfHost(env.sources, host)) {
    if (s.hosts.list.includes(host))
      for (const l of s.lists)
        try {
          const u = new URL(l.url)
          if (u.hostname.toLowerCase() === host) out.add(u.pathname)
        } catch {
          // data の確かめ（sources.test.ts）で止める
        }
    if (s.hosts.body.includes(host)) for (const p of s.allowPaths) out.add(p)
  }
  return [...out]
}

/** http の一覧だけを取るホストか（data で http: true を付けた許しの社の一覧のホストで、本文のホストでない） */
export function httpOnlyHost(env: FetchEnv, host: string): boolean {
  const on = sourcesOfHost(env.sources, host)
  if (on.some((s) => s.hosts.body.includes(host))) return false
  return on.some((s) =>
    s.lists.some((l) => {
      if (l.kind !== 'rss' || !l.http) return false
      try {
        const u = new URL(l.url)
        return u.protocol === 'http:' && u.hostname.toLowerCase() === host
      } catch {
        return false
      }
    }),
  )
}

/** その日、そのホストを取らない（403・429・確認画面。読んだ決まりは残す） */
export function markHostUnreadable(store: MirrorStore, host: string, now: number): void {
  const prev = store.hostRule(host)
  store.putHostRule({
    host,
    day: jstDateOf(now),
    state: 'unreadable',
    crawlDelay: prev?.crawlDelay ?? null,
    data: prev?.data ?? {},
    checked: now,
    changed: prev?.changed ?? null,
  })
}

/** 本文の応答で AI への意思表示を見た: そのホストの取りを止める（data の terms.accepted が新しくなるまで） */
export function markBodyStop(store: MirrorStore, host: string, now: number, reason: string): void {
  const prev = store.hostRule(host)
  const data = rulesDataOf(prev)
  const day = jstDateOf(now)
  const reasons = [...new Set([...(data?.stop?.reasons ?? []), reason])]
  store.putHostRule({
    host,
    day: prev?.day ?? day,
    state: 'stopped',
    crawlDelay: prev?.crawlDelay ?? null,
    data: { ...(prev?.data ?? {}), stop: { day, reasons } },
    checked: prev?.checked ?? now,
    changed: prev?.changed ?? null,
  })
  log('source_ai_signal', { host, reason })
}

/**
 * そのホストの robots.txt と tdmrep.json を読んで覚える（2本。数えない）。予約の待ちが maxWait を超える時は null（読まない）
 */
export async function readHostRules(core: VaultCore, env: FetchEnv, host: string, maxWait: number): Promise<HostRuleRow | null> {
  const store = core.store
  const startedAt = core.now()
  const prev = store.hostRule(host)
  const prevData = rulesDataOf(prev)
  // http の一覧だけのホスト（許しの社で https の一覧が無い時）は、robots.txt も同じ http で読む（robots.txt は scheme ごと）
  const scheme = httpOnlyHost(env, host) ? 'http' : 'https'
  const robots = await sourceGet(core, env, {
    url: `${scheme}://${host}/robots.txt`,
    run: null,
    maxWait,
    count: false,
    markBlocked: false,
    rules: false,
    accept: 'text/plain, */*;q=0.1',
  })
  if (!robots.ok && robots.why === 'busy') return null
  let unreadable = false
  let robotsText: string | null = null
  const robotsStatus = robots.ok ? robots.status : (robots.status ?? 0)
  if (robots.ok) {
    // 文字の符号が読めない robots.txt は「決まりなし」にせず、読めない日にする（読み落とした断りで取らないように）
    robotsText = responseText(robots).text
    if (robotsText === null) unreadable = true
  } else if (robots.status !== 404 && robots.status !== 410) unreadable = true
  // 読んだ robots.txt の Crawl-delay を、続く tdmrep.json と最初のページから効かせる（前の日の値で予約した間を、新しい間まで進める）
  let gap = hostGapMs(store, env.sources, host)
  if (robotsText !== null) {
    const delay = crawlDelayOf(hostRulesData({ status: robotsStatus, text: robotsText }, { status: 0, entries: null }, prevData))
    if (delay !== null) gap = Math.max(gap, Math.ceil(delay * 1_000))
    settle(store, host, core.now(), gap)
  }
  let tdmEntries = null
  let tdmStatus = 0
  if (!unreadable) {
    const tdm = await sourceGet(core, env, {
      url: `${scheme}://${host}/.well-known/tdmrep.json`,
      run: null,
      // robots.txt の後の1本は、そのホストの間（Crawl-delay・data の crawlDelaySec）だけ待つ（15秒まで。長い間のホストを読みきれるように）
      maxWait: Math.max(maxWait, Math.min(gap, TDM_WAIT_MAX_MS) + 1_000),
      count: false,
      markBlocked: false,
      rules: false,
      accept: 'application/json',
    })
    tdmStatus = tdm.ok ? tdm.status : (tdm.status ?? 0)
    if (tdm.ok) tdmEntries = parseTdmRep(responseText(tdm).text ?? '')
    else if (tdm.why === 'busy') return null
    else if (tdm.status !== 404 && tdm.status !== 410) unreadable = true
  }
  const now = core.now()
  const data = hostRulesData(
    { status: robotsStatus, text: robotsText, truncated: robots.ok && robots.truncated },
    { status: tdmStatus, entries: tdmEntries },
    prevData,
  )
  // 読んでいる間に、同じホストへのほかの呼び出しが書いた止め（本文の noai）と、今日の 403・確認画面を消さない（読み始めの前の行で書き直さない）
  const cur = store.hostRule(host)
  const curStop = (cur?.data as Partial<HostRulesData> | undefined)?.stop
  const stop = curStop ?? prevData?.stop
  if (stop) data.stop = stop
  const blockedMeanwhile = cur !== null && cur.day === jstDateOf(now) && cur.state === 'unreadable' && cur.checked >= startedAt
  const decided =
    unreadable || blockedMeanwhile
      ? { state: 'unreadable' as const, reasons: [] }
      : hostStateOf(data, hostPaths(env, host), acceptedOfHost(env, host))
  const changed = prevData && prevData.fp !== data.fp && !unreadable ? now : (prev?.changed ?? null)
  const row: HostRuleRow = {
    host,
    day: jstDateOf(now),
    state: decided.state,
    crawlDelay: crawlDelayOf(data),
    data: data as unknown as Record<string, unknown>,
    checked: now,
    changed,
  }
  store.putHostRule(row)
  // 新しい Crawl-delay で、tdmrep.json の後の間も進める
  settle(store, host, core.now(), hostGapMs(store, env.sources, host))
  log('host_rules', { host, result: decided.state, code: robotsStatus })
  return row
}

/** 今日の決まりがあればそれを、無ければ読む（読めなかった・待ちが長い時は null） */
export async function ensureHostRules(
  core: VaultCore,
  env: FetchEnv,
  host: string,
  maxWait: number,
): Promise<HostRuleRow | null> {
  const row = core.store.hostRule(host)
  if (row && row.day === jstDateOf(core.now())) return row
  return readHostRules(core, env, host, maxWait)
}

/**
 * 転送の行き先の道を、今日の決まりで取ってよいか（読まない。今日の決まりの無いホスト・読めない日・断る・止める道は false）
 */
export function hopAllowedByRules(core: VaultCore, env: FetchEnv, url: URL): boolean {
  const host = url.hostname.toLowerCase()
  const row = core.store.hostRule(host)
  if (!row || row.day !== jstDateOf(core.now()) || row.state === 'unreadable') return false
  const data = rulesDataOf(row)
  if (!data) return false
  return decidePath(data, `${url.pathname}${url.search}`, acceptedOfHost(env, host)).verdict === 'ok'
}

/**
 * その URL の道を取ってよいか（今日の決まりで。無ければ先に読む）。ok・robots（断る）・ai（止める）・unreadable（読めない・403・確認画面）・
 * busy（決まりを読む待ちが長い）
 */
export async function checkPath(
  core: VaultCore,
  env: FetchEnv,
  url: URL,
  _run: RunRow | null,
  maxWait: number,
): Promise<'ok' | 'robots' | 'ai' | 'unreadable' | 'busy'> {
  const host = url.hostname.toLowerCase()
  const row = await ensureHostRules(core, env, host, maxWait)
  if (!row) return 'busy'
  if (row.state === 'unreadable') return 'unreadable'
  const data = rulesDataOf(row)
  if (!data) return 'unreadable'
  const v = decidePath(data, `${url.pathname}${url.search}`, acceptedOfHost(env, host))
  return v.verdict === 'ok' ? 'ok' : v.verdict === 'refused' ? 'robots' : 'ai'
}

// ---------- 毎日の決まりの読み（rules） ----------

/** 日本時間の曜日（0 = 日曜） */
export const jstWeekday = (ms: number): number => new Date(ms + 9 * 3_600_000).getUTCDay()

/**
 * 毎日の決まりの読みを1歩進める（ホストごとの robots.txt と AI の意思表示。日曜は規約のページの見張りも）。1歩は外への要求6本まで。
 * 待ちが長いホストは後に回し、どのホストも待ちなら、いちばん早く取れる時刻を返す
 */
export async function rulesStep(core: VaultCore, now: number): Promise<TaskStep> {
  const env = envOf(core)
  const store = core.store
  const today = jstDateOf(now)
  let requests = 0
  let next: number | null = null
  const later = (host: string) => {
    const t = store.hostNext(host) ?? core.now()
    if (next === null || t < next) next = t
  }
  for (const host of hostsOfSources(env.sources)) {
    if (store.hostRule(host)?.day === today) continue
    if (requests + 2 > STEP_REQUESTS) return { done: false, next: core.now() }
    const row = await readHostRules(core, env, host, STEP_WAIT_MAX_MS)
    if (!row) later(host)
    else requests += 2
  }
  if (jstWeekday(now) === 0)
    for (const src of env.sources)
      for (const page of src.termsPages) {
        if (page.watch !== 'weekly' || !page.fingerprint) continue
        const seen = store.termsWatch(page.url)
        if (seen && jstDateOf(seen.checked) === today) continue
        if (requests + 1 > STEP_REQUESTS) return { done: false, next: core.now() }
        const r = await watchTermsPage(core, env, src, page.url, page.fingerprint, page.scopes)
        if (r === 'busy') {
          later(new URL(page.url).hostname)
          continue
        }
        requests += 1
      }
  if (next !== null) return { done: false, next }
  return { done: true }
}

/** 規約のページを1つ取り、data の指紋と比べて覚える（同じ・変わった・読めない） */
async function watchTermsPage(
  core: VaultCore,
  env: FetchEnv,
  src: SourceConfig,
  url: string,
  expected: string,
  scopes: readonly string[],
): Promise<'same' | 'changed' | 'unreadable' | 'busy'> {
  const store = core.store
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'unreadable'
  }
  const path = await checkPath(core, env, u, null, STEP_WAIT_MAX_MS)
  if (path === 'busy') return 'busy'
  let state: 'same' | 'changed' | 'unreadable' = 'unreadable'
  let fp: string | null = null
  if (path === 'ok') {
    const got = await sourceGet(core, env, { url, run: null, maxWait: STEP_WAIT_MAX_MS, count: false, accept: 'text/html' })
    if (!got.ok && got.why === 'busy') return 'busy'
    if (got.ok) {
      const { text } = responseText(got)
      if (text !== null) {
        fp = termsFingerprint(termsPageText(normalizeEvents(await env.html(text)), { scopes }))
        state = fp === expected ? 'same' : 'changed'
      }
    }
  }
  // 一度「変わった」と見たページは、data の指紋が新しくなるまで止めたまま（次の週に同じ・読めないでも外さない）。初めから・続けて読めない
  // ページ（規約を改めてページが移った・消えた・403・robots.txt で断る）は、2週続いたら「変わった」と同じに止める
  const prev = store.termsWatch(url)
  const sameData = prev !== null && (prev.expected ?? expected) === expected
  if (sameData && prev.state === 'changed') state = 'changed'
  else if (state === 'unreadable' && sameData && prev.state === 'unreadable' && jstDateOf(prev.checked) !== jstDateOf(core.now()))
    state = 'changed'
  store.putTermsWatch({
    url,
    source: src.id,
    fingerprint: fp ?? (sameData ? prev.fingerprint : null),
    state,
    checked: core.now(),
    expected,
  })
  if (state === 'changed') log('terms_changed', { source: src.id })
  return state
}

// ---------- 気象庁の見張り ----------

/** 気象庁の見張りを置いてよいか（気象庁の data が 'ok' で、規約のページの指紋がそろっている時だけ。'trial-only' の間は置かない） */
export function jmaWatchEnabled(env: FetchEnv): boolean {
  const src = jmaSourceOf(env.sources)
  return src !== null && src.terms.status === 'ok' && termsFingerprinted(src)
}

/** 気象庁の種類ごとの、最後に Atom で見た時刻（meta。行ごとの「7日見えない」の知らせ） */
export interface JmaSeen {
  since: number
  kinds: Record<string, number>
}

/** Atom で見た種類を覚える */
export function noteJmaSeen(store: MirrorStore, kindIds: readonly string[], now: number): void {
  const cur = store.getMeta<JmaSeen>('jmaSeen') ?? { since: now, kinds: {} }
  for (const k of kindIds) cur.kinds[k] = now
  store.setMeta('jmaSeen', cur)
}

/** 7日見えない種類の行（見始めて7日たつまでは空） */
export function jmaUnseen(store: MirrorStore, now: number): string[] {
  const cur = store.getMeta<JmaSeen>('jmaSeen')
  const week = 7 * 86_400_000
  if (!cur || now - cur.since < week) return []
  return JMA_KINDS.filter((k) => now - (cur.kinds[k.id] ?? 0) >= week).map((k) => k.id)
}

/** 気象庁の見張りを1回（短い Atom を1本。版に入れてよい種類の項目だけを24時間持つ。電文は読まない） */
export async function jmaWatchStep(core: VaultCore, now: number): Promise<TaskStep> {
  const env = envOf(core)
  if (!jmaWatchEnabled(env)) return { done: true }
  const src = jmaSourceOf(env.sources)!
  const store = core.store
  if (!sourceGate(src, store, now, null).ok) return { done: true }
  const list = src.lists.find((l) => l.kind === 'atom' && /extra\.xml$/.test(l.url)) ?? src.lists[0]
  if (!list) return { done: true }
  const u = new URL(list.url)
  const path = await checkPath(core, env, u, null, STEP_WAIT_MAX_MS)
  if (path === 'busy') return { done: false, next: (store.hostNext(u.hostname) ?? core.now()) + 100 }
  if (path !== 'ok') return { done: true }
  const got = await sourceGet(core, env, {
    url: list.url,
    run: null,
    maxWait: STEP_WAIT_MAX_MS,
    count: false,
    hop: (h) => listHopOk(src, list, h),
  })
  if (!got.ok) return got.why === 'busy' ? { done: false, next: core.now() + 2_000 } : { done: true }
  // 一覧の応答の AI への意思表示（候補集めの一覧と同じに止める）
  const stop = headerAiStop(got.headers)
  if (stop) {
    markBodyStop(store, u.hostname.toLowerCase(), core.now(), stop)
    return { done: true }
  }
  const { text } = responseText(got)
  if (text === null) return { done: true }
  const rows: { link: string; title: string; kind: string; at: number }[] = []
  const seen: string[] = []
  for (const it of parseFeed(text).items) {
    const kind = kindOfTitle(it.title)
    if (!kind) continue
    seen.push(kind.id)
    if (!hasNeedWord(kind, it.contentHtml ?? it.summary ?? '')) continue
    const at = timeOf(it.date).ms
    if (at === null || !it.link) continue
    rows.push({ link: it.link, title: it.title.slice(0, 80), kind: kind.id, at })
  }
  if (rows.length) store.putJmaWatch(rows, core.now())
  noteJmaSeen(store, [...new Set(seen)], core.now())
  log('jma_watch', { count: rows.length })
  return { done: true }
}

/** 日本時間の時刻（probe の「その日の 10:16〜18:16」の窓） */
export function dayWindow(ms: number): { since: number; until: number } {
  const p = jstParts(ms)
  const start = Date.UTC(p.y, p.m - 1, p.d) - 9 * 3_600_000
  return { since: start + (10 * 60 + 16) * 60_000, until: start + (18 * 60 + 16) * 60_000 }
}
