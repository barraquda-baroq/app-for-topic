// 取りに行く道具の中身（段階3の設計の 1.2 の 3・4・1.7。B4）: topic_list_candidates（候補を見る）・topic_read_article（資料を読む）と、
// VaultCore が alarm・回の始め・topic_status から呼ぶ中身（FETCH_WORK: 候補集め・毎日の決まりの読み・気象庁の見張り。vault/runs.ts の FetchWork）。
// topic_status(runId) の候補の数と probe の表は vault/tools/read.ts が DO の表（candidates・probe）から返し、その中身はここの候補集め
// （connector/src/fetch/collector.ts）が書く。
// - 出どころの data は connector/src/fetch/sources.ts、取りに行く部品は connector/src/fetch/。テストは作り物の出どころと HTML の小さな読み取りを
//   createFetchWork に渡す（test/support/fakeNews.ts）
// - 候補の題・資料の本文は資料の印で囲む（中の印の文字列の行は落とす）。答えに出すのは候補の一覧・頭の行・本文だけで、題・本文はログに出さない
import { jstParts } from '../../../../src/domain/jst'
import { SOURCE_BODY_MIN_CHARS } from '../../../../src/domain/limits'
import {
  BODY_REFUSAL_TEXTS,
  DEFAULT_FETCH_ENV,
  envOf,
  feedBody,
  fetchBody,
  materialOf,
  responseText,
  sourceGet,
  type FetchEnv,
} from '../../fetch/article'
import { collectStep } from '../../fetch/collector'
import { TOOL_WAIT_MAX_MS } from '../../fetch/pace'
import { parseFeed } from '../../fetch/rss'
import { sourceById, sourceForUrl, type SourceConfig } from '../../fetch/sources'
import { sourceGate } from '../../fetch/terms'
import { checkListUrl, itemUrl, listHopOk } from '../../fetch/urlPolicy'
import { checkPath, jmaWatchEnabled, jmaWatchStep, markBodyStop, rulesStep } from '../../fetch/watch'
import { headerAiStop } from '../../fetch/aiSignals'
import type { ToolHandler, VaultCore } from '../core'
import { ConnectorError } from '../errors'
import { COLLECT_WAIT_MS, dateTimeText, markMaterialRead, type FetchWork } from '../runs'
import type { CandidateRow, MaterialRow, MirrorStore, RunRow } from '../store'
import { fail, fenced, FENCE_LABELS, num, ok, sliceByChars, str, stripMarks, DEFAULT_ITEM_BUDGET } from './common'
import { SOURCE_STATE_TEXTS, sourceStateOf, type SourceStateKind } from './read'

/** 取りに行く中身（出どころの data と部品を持つ。FetchWork の形） */
export type TopicFetchWork = FetchWork & { readonly env: FetchEnv }

/** 取りに行く中身を作る（テストは作り物の出どころ・HTML の読み取りを渡す） */
export function createFetchWork(env: FetchEnv): TopicFetchWork {
  return {
    env,
    sources: env.sources,
    collectStep: (core, runId) => collectStep(core, runId),
    rulesStep: (core, now) => rulesStep(core, now),
    jmaWatchEnabled: () => jmaWatchEnabled(env),
    jmaWatchStep: (core, now) => jmaWatchStep(core, now),
  }
}

/** 本番の中身（府省・庁の7つと Global Voices。HTML は HTMLRewriter で読む） */
export const FETCH_WORK: TopicFetchWork = createFetchWork(DEFAULT_FETCH_ENV)

// ---------- 控えを引く（B5 の下書き・照合も使う） ----------

/** 候補の id の形 */
const CID_RE = /^c\d{4}$/

/**
 * 資料の控えを ref（候補の c0012 か URL）で引く（無ければ null）。URL は # の後を落とし（消防庁の #番号 は残す）、http: を https: にそろえて
 * 引く。転送の後の URL で控えた資料は、転送の後の URL か候補の id で引く
 */
export function materialForRef(
  store: MirrorStore,
  runId: string,
  ref: string,
  sources = DEFAULT_FETCH_ENV.sources,
): MaterialRow | null {
  const r = ref.trim()
  if (CID_RE.test(r)) {
    const c = store.candidate(runId, r)
    return c ? store.material(runId, c.url) : null
  }
  const direct = store.material(runId, r)
  if (direct) return direct
  let u: URL
  try {
    u = new URL(r)
  } catch {
    return null
  }
  const src = sourceForUrl(sources, u)
  const url = src ? itemUrl(src, r, r, src.body.kind === 'anchor') : null
  return url ? store.material(runId, url) : null
}

// ---------- topic_list_candidates ----------

/** 出どころごとの数の言葉（候補の一覧の頭・回の報告） */
export const COUNT_LABELS: Readonly<Record<string, string>> = {
  ok: '取れた',
  pdf: 'PDF だけ',
  short: '本文が短い',
  'other-host': 'ほかのホスト',
  cond: '別の条件',
  'no-author': '著者なし',
  drill: '訓練・取消',
  undated: '日付なし',
  category: 'カテゴリーで外した',
  deny: '取らない道',
  prev: '前の版の出典',
  qa: '会見の記録（試しの回だけ）',
  robots: '取らない（robots.txt）',
  ai: '取りを止めた（AI への意思表示）',
  'jma-kind': '種類で外した',
  'jma-cond': '条件で外した',
  'jma-dup': '同じ出来事の古い電文',
  'jma-over': 'ほかに（電文を読んでいない）',
  budget: '取りに行く本数の上限',
  'nobody:budget': '本文を先に読めなかった（本数の上限）',
  'nobody:permit': '本文を先に読めなかった（許しの本数）',
  'list-fail': '一覧を取れなかった',
  feed: '一覧の道が RSS・Atom を返した（RSS の利用条件の断り。読まない）',
  charset: '文字の符号が読めない',
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 候補の行の日付（時刻が分かる時だけ時刻も） */
function candDate(c: CandidateRow): string {
  if (c.tags.includes('@d') && c.published) {
    const [, m, d] = c.published.split('-').map(Number)
    return `${m}/${d}`
  }
  if (c.atMs === null) return '日付不明'
  const p = jstParts(c.atMs)
  return `${p.m}/${p.d} ${pad2(p.hour)}:${pad2(p.minute)}`
}

/** 候補の1行（c0012 社 一覧 日付 題 [印]） */
export function candidateLine(c: CandidateRow, sources: readonly SourceConfig[]): string {
  const src = sourceById(sources, c.source)
  const list = c.tags.find((t) => t.startsWith('@l:'))?.slice(3) ?? ''
  const marks = c.tags.filter((t) => !t.startsWith('@')).map((t) => `[${stripMarks(t)}]`)
  return [c.cid, src?.outlet ?? c.source, list, candDate(c), stripMarks(c.title), ...marks].filter(Boolean).join(' ')
}

/** 出どころごとの数の1行 */
function sourceCountLine(core: VaultCore, run: RunRow, src: SourceConfig, okCount: number): string {
  const counts = core.store.runCounts(run.runId, `src:${src.id}:`)
  const key = (k: string) => k.slice(`src:${src.id}:`.length)
  const gates = Object.keys(counts)
    .map(key)
    .filter((k) => k.startsWith('gate:'))
    .map((k) => k.slice(5) as SourceStateKind)
  const st = sourceStateOf(src, core.store, run.started, { trial: run.kind === 'trial' })
  const flags = [
    st.robotsChanged ? 'robots.txt が変わりました' : '',
    st.structure ? '一覧の作りが変わったかもしれません（取りは続けます）' : '',
  ].filter(Boolean)
  if (Object.keys(counts).some((k) => key(k) === 'skip')) return `- ${src.outlet}: 取らない（この回の probe から外した）`
  if (gates.length && okCount === 0) {
    const g = gates[0]
    const text = Object.hasOwn(SOURCE_STATE_TEXTS, g) ? SOURCE_STATE_TEXTS[g] : g
    return `- ${src.outlet}: ${text}${flags.length ? `・${flags.join('・')}` : ''}`
  }
  const parts = [`取れた ${okCount}`]
  for (const [k, n] of Object.entries(counts)) {
    const kk = key(k)
    if (kk.startsWith('gate:') || !n) continue
    const label = COUNT_LABELS[kk]
    if (label) parts.push(`${label} ${n}`)
  }
  return `- ${src.outlet}: ${parts.join('・')}${flags.length ? `・${flags.join('・')}` : ''}`
}

/** 候補を見る（topic_list_candidates） */
export const topicListCandidates: ToolHandler = async (core, args, ctx) => {
  const run0 = ctx.run!
  if (run0.probe === 'hosts' || run0.probe === 'terms')
    throw new ConnectorError(
      'invalid',
      `この回（probe: ${run0.probe}）は候補を集めません。topic_status に runId を渡すと probe の表が出ます。`,
    )
  if (run0.collect.state === 'collecting') await core.waitForCollect(run0.runId, COLLECT_WAIT_MS)
  const run = core.store.getRun(run0.runId) ?? run0
  const env = envOf(core)
  if (run.collect.state !== 'done') {
    const p = run.collect.progress
    return ok(
      `集めています${p ? `（${p.done}/${p.total}）` : ''}。少し待ってから、もう一度呼んでください（topic_list_candidates）。`,
    )
  }
  const cands = core.store.candidates(run.runId).filter((c) => c.readable && CID_RE.test(c.cid))
  const lines: string[] = []
  if (run.sinceMs !== null && run.untilMs !== null)
    lines.push(
      `窓: ${dateTimeText(run.sinceMs)} より後〜${dateTimeText(run.untilMs)}${run.collect.widenedSinceMs ? '（窓を広げました（候補が少ないため））' : ''}`,
    )
  lines.push(`読める候補: ${cands.length}件（本文が${SOURCE_BODY_MIN_CHARS}字未満の物・PDF だけの物は入れていません）`)
  lines.push('出どころごとの数:')
  for (const src of env.sources) lines.push(sourceCountLine(core, run, src, cands.filter((c) => c.source === src.id).length))
  if (!cands.length) {
    lines.push('候補はありません（読める資料がありません）。')
    return ok(lines.join('\n'))
  }
  const body = cands.map((c) => candidateLine(c, env.sources)).join('\n')
  const part = sliceByChars(body, args.cursor, DEFAULT_ITEM_BUDGET)
  lines.push(fenced(FENCE_LABELS.candidates, part.text.replace(/\n$/, '')))
  if (part.next) lines.push(`続きがあります（cursor: ${part.next}）`)
  lines.push(
    '本文は topic_read_article で読みます（候補の id を ref に）。[似た題 …] の候補は、1つの話題に束ねるかを先に考えます。',
  )
  return ok(lines.join('\n'))
}

// ---------- topic_read_article ----------

/** ref から出どころと URL を決める（候補の id か、許したホストの URL。決められなければ null） */
function resolveRef(
  store: MirrorStore,
  run: RunRow,
  env: FetchEnv,
  ref: string,
): { src: SourceConfig; url: string; cand: CandidateRow | null } | null {
  if (CID_RE.test(ref)) {
    const cand = store.candidate(run.runId, ref)
    if (!cand || !cand.readable) return null
    const src = sourceById(env.sources, cand.source)
    return src ? { src, url: cand.url, cand } : null
  }
  let u: URL
  try {
    u = new URL(ref)
  } catch {
    return null
  }
  const src = sourceForUrl(env.sources, u)
  if (!src) return null
  const url = itemUrl(src, ref, ref, src.body.kind === 'anchor')
  if (!url) return null
  const cand = store.candidates(run.runId).find((c) => c.url === url && CID_RE.test(c.cid)) ?? null
  return { src, url, cand }
}

/** Global Voices の記事の URL: 記事のページを取らず、/feed/ の中の同じリンクの項目の全文を返す（無ければ断る） */
async function feedMaterial(
  core: VaultCore,
  env: FetchEnv,
  src: SourceConfig,
  url: string,
  run: RunRow,
): Promise<MaterialRow | { refusal: string }> {
  const list = src.lists.find((l) => l.kind === 'rss')
  if (!list) return { refusal: BODY_REFUSAL_TEXTS.url }
  const gate = sourceGate(src, core.store, core.now(), run)
  if (!gate.ok) return { refusal: gate.text }
  const check = checkListUrl(src, list, list.url)
  if (!check.ok) return { refusal: BODY_REFUSAL_TEXTS.url }
  const path = await checkPath(core, env, check.url, run, TOOL_WAIT_MAX_MS)
  if (path !== 'ok') return { refusal: BODY_REFUSAL_TEXTS[path] }
  const got = await sourceGet(core, env, {
    url: check.url.href,
    run,
    maxWait: TOOL_WAIT_MAX_MS,
    hop: (u) => listHopOk(src, list, u),
  })
  if (!got.ok) return { refusal: BODY_REFUSAL_TEXTS[got.why === 'host-budget' ? 'budget' : got.why] }
  // RSS の全文が本文なので、この応答の AI への意思表示（X-Robots-Tag の noai・TDMRep の見出し）で止める
  const stop = headerAiStop(got.headers)
  if (stop) {
    markBodyStop(core.store, check.url.hostname.toLowerCase(), core.now(), stop)
    return { refusal: BODY_REFUSAL_TEXTS.ai }
  }
  const { text } = responseText(got)
  if (text === null) return { refusal: BODY_REFUSAL_TEXTS.charset }
  const same = (a: string, b: string) => a.replace(/\/$/, '') === b.replace(/\/$/, '')
  const item = parseFeed(text).items.find((it) => {
    const link = itemUrl(src, it.link, list.url)
    return link !== null && same(link, url)
  })
  if (!item) return { refusal: 'この出どころは記事のページを取りません（RSS に無い記事は読めません）' }
  const fb = await feedBody(env, src, item)
  if (!fb.ok)
    return {
      refusal:
        fb.why === 'no-author'
          ? 'この記事には著者の名前がありません（出典にできません）'
          : 'この記事は、ほかの条件が書かれた記事の見込みです（出典にできません）',
    }
  return materialOf(run.runId, src, { url, title: fb.title, published: fb.published, lines: fb.lines }, core.now(), {
    author: fb.author,
  })
}

/** 資料を読む（topic_read_article） */
export const topicReadArticle: ToolHandler = async (core, args, ctx) => {
  const run = ctx.run!
  const ref = str(args.ref)?.trim()
  if (!ref) throw new ConnectorError('invalid', 'ref に候補の id（c0012）か、許した出どころの https:// の URL を渡してください。')
  const maxChars = Math.min(6_000, Math.max(1_500, Math.floor(num(args.maxChars) ?? 6_000)))
  const env = envOf(core)
  const store = core.store
  const hit = resolveRef(store, run, env, ref)
  if (!hit) {
    return fail(
      CID_RE.test(ref)
        ? `この回の候補に「${ref}」はありません（topic_list_candidates の候補の id を渡してください）。`
        : `${BODY_REFUSAL_TEXTS.url}。`,
    )
  }
  const { src, cand } = hit
  let m = store.material(run.runId, hit.url)
  if (!m) {
    if (src.body.kind === 'feed') {
      const r = await feedMaterial(core, env, src, hit.url, run)
      if ('refusal' in r) return fail(`${r.refusal}。`)
      m = r
    } else {
      const r = await fetchBody(core, env, src, hit.url, run, {
        maxWait: TOOL_WAIT_MAX_MS,
        fallback: { title: cand?.title, published: cand?.published },
      })
      if (!r.ok) return fail(`${r.why === 'gate' && r.detail ? r.detail : BODY_REFUSAL_TEXTS[r.why]}。`)
      m = materialOf(run.runId, src, r.read, core.now(), { fallbackTitle: cand?.title })
      if (cand && r.read.url !== cand.url) store.putCandidates([{ ...cand, url: r.read.url }])
    }
    store.putMaterial(m)
  }
  markMaterialRead(store, run, m.url, ctx.now)
  core.reschedule()
  const host = new URL(m.url).hostname
  const lines: string[] = []
  lines.push(`資料: ${stripMarks(m.title) || '（題なし）'}`)
  lines.push(
    `社: ${src.outlet}（${host}）・掲載: ${m.published ? stripMarks(m.published) : '不明'}・本文: ${m.bodyChars.toLocaleString('ja-JP')}字${m.author ? `・著者: ${stripMarks(m.author)}` : ''}`,
  )
  if (src.notes.length) lines.push(`この出どころの決まり: ${src.notes.join('／')}`)
  lines.push(`URL: ${m.url}（出典の ref には ${cand ? `${cand.cid} か ` : ''}この URL を書く）`)
  if (m.cut) lines.push('本文は 12,000字で切ってあります。')
  if (m.bodyChars < SOURCE_BODY_MIN_CHARS) {
    lines.push('本文がほとんど取れませんでした（PDF の資料だけの発表など）。この資料は出典にできません。')
    if (m.body) lines.push(fenced(FENCE_LABELS.article, m.body))
    return ok(lines.join('\n'))
  }
  const part = sliceByChars(m.body, args.cursor, maxChars)
  lines.push(fenced(FENCE_LABELS.article, part.text.replace(/\n$/, '')))
  if (part.next) lines.push(`続きがあります（cursor: ${part.next}）`)
  return ok(lines.join('\n'))
}
