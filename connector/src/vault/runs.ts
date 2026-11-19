// 回（runId・枠・窓・締め切り・期限・種類。設計の 1.3）と、alarm のやる事の表（設計の 1.1 の「DO の殻」）。
// - 回の id は runIdAt（src/domain/ids.ts。乱数は crypto.getRandomValues の [0-9a-z] 4字）、枠は runSlotAt、締め切りは runDeadlinesAt
//   （試しの回は null を渡して始めて90分・150分）、期限は RUN_TTL_MS（どの種類も12時間）。訂正だけの回は枠も締め切りも持たない
// - 道具ごとに使える回の種類の表（TOOL_RUN_KINDS）。種類で使えない道具は「この回（訂正だけの回）では使えません」
// - 始める時に断る物: 版の回は 書き込みの許可がオフ・データの形の版が違う・その枠の版がもうある・同じ枠の版の回が動いている（最後の呼び出しが
//   10分以内）。訂正だけの回は 書き込みの許可がオフ・データの形の版が違う。1日の回の数は種類を分けない合計 30（候補を集める回は版の回と
//   試しの回を合わせて 8）。断る答えに種類ごとの数を出さない（D21・点検 guard-G9）
// - 回の物を消す時: 版か作れなかった印を足した時（finishRun。回の覚え書きだけ期限まで残す）と、回の期限（expireRuns。覚え書きごと）。
//   訂正だけの回の資料の控えは、最後に読んでから1時間で消す
// - alarm のやる事（tasks の表の鍵）: 'mirror'（写しの続き・読み直し・辞書の作り直し）・'collect:{runId}'（候補集めの続き）・
//   'rules'（毎日の決まりの読み。robots.txt と AI の意思表示、日曜は規約のページの見張り）・'jma'（気象庁の見張り。3時間ごと。
//   気象庁の data が 'ok' の時だけ置く）・'expire'（回の期限・訂正だけの回の控え・日付だけの項目と気象庁の見張りの控えの片付け）。
//   alarm は1つの DO に1つだけなので、いちばん早い物の時刻に置き直す（core.ts の #reschedule）
// - 取りに行く中身（候補集め・決まりの読み・気象庁の見張り・topic_status の出どころの data）は B4 が作る（FetchWork。既定は
//   vault/tools/fetch.ts の FETCH_WORK）。ここは呼ぶ口の型だけを置く
import { editionShortId, parseEditionId, runIdAt } from '../../../src/domain/ids'
import { jstDateOf, jstParts, runDeadlinesAt, runSlotAt, RUN_TTL_MS, slotWindowFallbackSinceMs } from '../../../src/domain/jst'
import { SLOT_LABELS } from '../../../src/domain/fixedTexts'
import { RECORD_LIMITS } from '../../../src/domain/limits'
import type { Slot } from '../../../src/domain/types'
import { log } from '../log'
import type { ToolCallContext, ToolHandler, VaultCore } from './core'
import { ConnectorError, MESSAGES } from './errors'
import type { EditionLite, Lite } from './mirror'
import type { MirrorStore, RunRow } from './store'
import { ok, str, strList, type ToolResult } from './tools/common'

/** 回の種類（版の回・試しの回・訂正だけの回） */
export const RUN_KINDS = ['edition', 'trial', 'correction'] as const
export type RunKind = (typeof RUN_KINDS)[number]

/** 試しの回の probe（'sources' は候補集めと一緒に出どころごとの数、'hosts' は今は取らない府省の robots.txt の番号、'terms' は規約のページ） */
export const PROBE_KINDS = ['sources', 'hosts', 'terms'] as const
export type ProbeKind = (typeof PROBE_KINDS)[number]

export const RUN_KIND_LABELS: Readonly<Record<RunKind, string>> = {
  edition: '版の回',
  trial: '試しの回',
  correction: '訂正だけの回',
}

/** 1日（日本時間）に始められる回の数（種類を分けない合計）と、そのうち候補を集める回（版の回・試しの回）の数。設計の 1.6 */
export const RUN_DAILY_LIMIT = 30
export const COLLECT_DAILY_LIMIT = 8
/** 同じ枠の版の回が動いているとみなす間（最後の道具の呼び出しから） */
export const RUN_BUSY_MS = 10 * 60_000
/** 直前の版の window.until を窓の始まりに使う新しさ */
export const WINDOW_PREV_MAX_MS = 36 * 3_600_000
/** 訂正だけの回の資料の控えを消すまで（最後に読んでから） */
export const CORRECTION_MATERIAL_TTL_MS = 3_600_000
/** 日付だけの項目を初めて見た時刻を持つ間 */
export const FIRST_SEEN_TTL_MS = 3 * 24 * 3_600_000
/** 気象庁の見張りの控えを持つ間・見張りの間 */
export const JMA_WATCH_TTL_MS = 24 * 3_600_000
export const JMA_WATCH_EVERY_MS = 3 * 3_600_000
/** topic_list_candidates・topic_status(runId) が、集め終わるまで待つ上限 */
export const COLLECT_WAIT_MS = 20_000

/**
 * 道具ごとに使える回の種類（設計の 1.3 の表）。null = 回を受けない・どの種類の回でもよい（topic_status・topic_lookup_terms の runId は
 * どの種類でも受ける）。並びに無い種類の回で呼ぶと run_kind で断る
 */
export const TOOL_RUN_KINDS: Readonly<Record<string, readonly RunKind[] | null>> = {
  topic_status: null,
  topic_get_guide: null,
  topic_list_candidates: ['edition', 'trial'],
  topic_read_article: ['edition', 'trial', 'correction'],
  topic_list_recent: null,
  topic_lookup_terms: null,
  topic_find_topics: null,
  topic_list_drafts: ['edition', 'trial'],
  topic_get_draft: ['edition', 'trial'],
  topic_begin_run: null,
  topic_save_draft: ['edition', 'trial'],
  topic_check_draft: ['edition', 'trial'],
  // 試しの回は確かめだけ（足すと何件か・断る物を返し、書かない。B5）
  topic_add_topics: ['edition', 'trial'],
  topic_add_edition: ['edition', 'trial'],
  topic_add_edition_fail: ['edition'],
  topic_add_correction: ['edition', 'correction'],
}

export const isRunKind = (v: unknown): v is RunKind => typeof v === 'string' && (RUN_KINDS as readonly string[]).includes(v)

// ---------- 取りに行く中身の呼ぶ口（B4） ----------

/** やる事の1歩の結果（done = 終わった・next = 続きの時刻） */
export type TaskStep = { done: true } | { done: false; next: number }

/** topic_status の出どころの状態に要る data（connector/src/fetch/sources.ts の SourceConfig の一部。B4 の data がそのまま入る形） */
export interface SourceView {
  /** 'kantei' など（ASCII。ログに出してよい印） */
  id: string
  /** outlets.ts の決まった書き方 */
  outlet: string
  hosts: { list: readonly string[]; body: readonly string[] }
  terms: { status: 'ok' | 'permitted' | 'trial-only' }
  termsPages: readonly { url: string; fingerprint?: string; watch: 'weekly' | 'probe-only' }[]
  permit?: { until?: string }
}

/** 取りに行く中身（B4 が vault/tools/fetch.ts の FETCH_WORK に作る。テストは作り物を VaultCore に渡す） */
export interface FetchWork {
  /** 出どころの data（topic_status の出どころの状態に使う） */
  readonly sources: readonly SourceView[]
  /** 候補集めを1歩進める（1回の alarm で外への要求6本・読む字数30万字まで）。終われば回の collect を done にして { done: true } */
  collectStep(core: VaultCore, runId: string, now: number): Promise<TaskStep>
  /** 毎日の決まりの読み（ホストごとの robots.txt と AI の意思表示。日曜は規約のページの見張りも）を1歩進める */
  rulesStep(core: VaultCore, now: number): Promise<TaskStep>
  /** 気象庁の見張りを置いてよいか（気象庁の data の terms.status が 'ok' で、規約のページの指紋がそろっている時だけ） */
  jmaWatchEnabled(): boolean
  /** 気象庁の見張りを1回（短い Atom を読み、版に入れてよい種類の項目だけを控えに置く。電文は読まない） */
  jmaWatchStep(core: VaultCore, now: number): Promise<TaskStep>
}

// ---------- 言葉 ----------

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 「11:45」（日本時間） */
export function clockText(ms: number): string {
  const p = jstParts(ms)
  return `${pad2(p.hour)}:${pad2(p.minute)}`
}

/** 「11/19 22:16」（日本時間） */
export function dateTimeText(ms: number): string {
  const p = jstParts(ms)
  return `${p.m}/${p.d} ${pad2(p.hour)}:${pad2(p.minute)}`
}

/** 「11/19 12:00版」（版の id から。読めなければ id のまま） */
export function editionText(editionId: string): string {
  const e = parseEditionId(editionId)
  if (!e) return editionId
  const [, m, d] = e.date.split('-').map(Number)
  return `${m}/${d} ${SLOT_LABELS[e.slot]}版`
}

// ---------- 窓 ----------

/**
 * 候補を集める窓（ms）: 始まり = 直前の版（この枠より前の版）の window.until（写しにあり、36時間より新しく、始めた時刻より前）、無ければ前の枠の境。
 * 終わり = 回を始めた時刻。「始まりより後で、終わりまで」（設計の 1.3・1.7 の (8)）
 */
export function runWindow(
  startMs: number,
  slot: { date: string; slot: Slot },
  editions: readonly Lite<'editions'>[],
): { sinceMs: number; untilMs: number } {
  const current = `${slot.date}-${slot.slot}`
  let prev: (EditionLite & { id: string }) | null = null
  for (const e of editions) if (e.id < current && (!prev || e.id > prev.id)) prev = e
  const until = prev?.window ? Date.parse(prev.window.until) : NaN
  const sinceMs =
    Number.isFinite(until) && until < startMs && startMs - until <= WINDOW_PREV_MAX_MS
      ? until
      : slotWindowFallbackSinceMs(slot.date, slot.slot)
  return { sinceMs, untilMs: startMs }
}

// ---------- 回の確かめ ----------

/**
 * 回を使う前の確かめ（形・期限・終わった回・種類）。通れば回の覚え書き、断る時は ConnectorError を投げる。
 * kinds が null の道具はどの種類の回でもよい
 */
export function checkRun(store: MirrorStore, runId: unknown, tool: string, now: number): RunRow {
  const id = typeof runId === 'string' ? runId.trim() : ''
  const run = id ? store.getRun(id) : null
  if (!run) throw new ConnectorError('run_unknown', MESSAGES.runUnknown)
  if (now >= run.expires) throw new ConnectorError('run_expired', MESSAGES.runExpired)
  if (run.done) throw new ConnectorError('run_done', MESSAGES.runDone)
  const kinds = Object.hasOwn(TOOL_RUN_KINDS, tool) ? TOOL_RUN_KINDS[tool] : null
  if (kinds && !(kinds as readonly string[]).includes(run.kind)) {
    const label = isRunKind(run.kind) ? RUN_KIND_LABELS[run.kind] : run.kind
    throw new ConnectorError('run_kind', `この回（${label}）では使えません（${tool}）。`)
  }
  return run
}

/** 回の締め切り（答えの頭の1行。訂正だけの回は null） */
export function runDeadlines(run: RunRow): { writeBy: number; verifyBy: number } | null {
  return run.writerMs !== null && run.checkerMs !== null ? { writeBy: run.writerMs, verifyBy: run.checkerMs } : null
}

// ---------- 回の物を消す ----------

/**
 * 回の物を消す（版か作れなかった印を足した時。回の覚え書きだけ期限まで残し、その後の呼び出しには「この回は終わりました」）。
 * 覚え書きの候補集めの様子（collector.ts が置く取る物の URL・気象庁の EventID の組など）も、状態だけを残して置き直す
 * （訂正だけの回は 'none'、ほかは 'done'。回の期限まで、取った資料の URL を残さない）
 */
export function finishRun(store: MirrorStore, runId: string): void {
  store.transaction(() => {
    const run = store.getRun(runId)
    store.deleteRunItems(runId)
    if (run) store.setRunCollect(runId, { state: run.kind === 'correction' ? 'none' : 'done' })
    store.markRunDone(runId)
  })
  log('run_finished')
}

/**
 * 期限の片付け（alarm の 'expire'・毎日の cron）: 期限を過ぎた回は覚え書きごと消す。訂正だけの回の資料の控えは、最後に読んでから
 * （読んでいなければ取ってから）1時間で消す。日付だけの項目を初めて見た時刻（3日）・気象庁の見張りの控え（24時間）も片付ける。
 * 次に片付ける時刻を返す（無ければ null）
 */
export function expireRuns(store: MirrorStore, now: number): number | null {
  let next: number | null = null
  const later = (t: number) => {
    if (next === null || t < next) next = t
  }
  let gone = 0
  for (const run of store.runs()) {
    if (now >= run.expires) {
      store.deleteRun(run.runId)
      gone += 1
      continue
    }
    later(run.expires)
    if (run.kind === 'correction')
      for (const m of store.materials(run.runId)) {
        const at = (m.readAt ?? m.fetched) + CORRECTION_MATERIAL_TTL_MS
        if (now >= at) store.deleteMaterial(run.runId, m.url)
        else later(at)
      }
  }
  store.pruneFirstSeen(now - FIRST_SEEN_TTL_MS)
  store.pruneJmaWatch(now - JMA_WATCH_TTL_MS)
  // 前の日の回の数（合計と候補を集める回）も残さない（差から、その日の訂正だけの回の数が分かるため。D21 の守り 7）
  const daily = store.getMeta<RunDaily>('runDaily')
  if (daily && daily.day !== jstDateOf(now)) store.deleteMeta('runDaily')
  else if (daily) later(nextJstMidnight(now))
  if (gone) log('runs_expired', { count: gone })
  return next
}

/** 日本時間の次の 0時（ms） */
function nextJstMidnight(ms: number): number {
  const d = new Date(ms + 9 * 3_600_000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 9 * 3_600_000
}

/**
 * topic_read_article が資料を読んだ（B4 が呼ぶ）: 読んだ時刻を覚え、訂正だけの回は、最後に読んでから1時間で控えを消すやる事を置く
 * （置いた後に core.reschedule() で alarm を置き直す）
 */
export function markMaterialRead(store: MirrorStore, run: RunRow, url: string, at: number): void {
  store.markMaterialRead(run.runId, url, at)
  if (run.kind === 'correction') store.putTask('expire', at + CORRECTION_MATERIAL_TTL_MS)
}

// ---------- 1日の回の数（日本時間。種類を分けない合計） ----------

interface RunDaily {
  day: string
  total: number
  collect: number
}

function runDaily(store: MirrorStore, now: number): RunDaily {
  const day = jstDateOf(now)
  const cur = store.getMeta<RunDaily>('runDaily')
  return cur && cur.day === day ? cur : { day, total: 0, collect: 0 }
}

// ---------- topic_begin_run ----------

/** 乱数の4字（[0-9a-z]） */
export function randomRunSuffix(): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz'
  const buf = new Uint8Array(4)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => chars[b % 36]).join('')
}

/** この回でできる事（答えに書く） */
const CAN_DO: Readonly<Record<RunKind, string>> = {
  edition:
    '候補を見る・資料を読む・前の版と辞書を引く・下書きを置く・照合を当てる・話題と版を足す・作れなかった印を足す・訂正を足す（1つの回に3件まで）',
  trial:
    '候補を見る・資料を読む・前の版と辞書を引く・下書きを置く・照合を当てる・話題と版は確かめだけ（クラウドに何も書きません。足すと何件になるかだけを返します）',
  correction:
    '資料を読む・前の版と辞書を引く・訂正する話題を探す・訂正を足す（1つの回に5件まで）。版・話題・辞書・作れなかった印は足せません',
}

/** 回を始める（topic_begin_run） */
export const topicBeginRun: ToolHandler = async (core, args, ctx) => {
  const kind = args.kind
  if (!isRunKind(kind)) throw new ConnectorError('invalid', 'kind は edition・trial・correction のどれかです。')
  const model = str(args.model)?.trim() ?? ''
  if (!model || Array.from(model).length > RECORD_LIMITS.base.model)
    throw new ConnectorError('invalid', `model は1〜${RECORD_LIMITS.base.model}字で、使っているモデルの名前を書いてください。`)
  const probe = kind === 'trial' && typeof args.probe === 'string' ? args.probe : null
  if (probe !== null && !(PROBE_KINDS as readonly string[]).includes(probe))
    throw new ConnectorError('invalid', 'probe は sources・hosts・terms のどれかです（試しの回だけ）。')
  if (kind !== 'trial' && (args.probe !== undefined || args.skip !== undefined))
    throw new ConnectorError('invalid', 'probe・skip は試しの回（kind: trial）だけで使えます。')
  const skip = kind === 'trial' ? (strList(args.skip) ?? []).slice(0, 20) : []
  // 書き込みの許可・データの形の版（版の回・訂正だけの回。その場で止められるように）
  if (kind !== 'trial') await ctx.requireWrites()
  // 写しを新しくする（15秒以内に最後まで読んでいればそのまま。初めての取り込みの途中なら「取り込み中」で断る）
  const { note } = await ctx.fresh(false)
  const now = ctx.now
  const store = core.store
  const daily = runDaily(store, now)
  const collects = kind !== 'correction'
  if (daily.total >= RUN_DAILY_LIMIT)
    throw new ConnectorError(
      'run_limit',
      `今日（日本時間）はこれ以上回を始められません（1日${RUN_DAILY_LIMIT}回まで）。明日また始めてください。`,
    )
  if (collects && daily.collect >= COLLECT_DAILY_LIMIT)
    throw new ConnectorError(
      'run_limit',
      `今日（日本時間）は、候補を集める回をこれ以上始められません（1日${COLLECT_DAILY_LIMIT}回まで）。明日また始めてください。`,
    )
  const slot = kind === 'correction' ? null : runSlotAt(now)
  const editionId = slot ? `${slot.date}-${slot.slot}` : null
  if (kind === 'edition' && editionId) {
    if (core.mirror.has('editions', editionId))
      throw new ConnectorError(
        'slot_taken',
        `この枠の版はもうあります（${editionShortId(editionId)}。${editionText(editionId)}）。1つの枠に版は1つで、作り直しません。`,
      )
    for (const r of store.runs()) {
      if (r.kind !== 'edition' || r.editionId !== editionId || r.done || now >= r.expires) continue
      if (now - r.lastCall < RUN_BUSY_MS) {
        const ago = Math.max(0, Math.floor((now - r.lastCall) / 60_000))
        throw new ConnectorError(
          'run_busy',
          `同じ枠の回が動いています（最後の呼び出しは ${ago}分前）。10分たっても動きが無ければ始められます。`,
        )
      }
    }
  }
  // 同じ分に始めた回の id と重ならないように（乱数4字が重なったら引き直す）
  let runId = runIdAt(now, core.randomSuffix())
  for (let i = 0; i < 5 && store.getRun(runId); i++) runId = runIdAt(now, core.randomSuffix())
  if (store.getRun(runId)) throw new ConnectorError('unavailable', MESSAGES.unavailable)
  const deadlines = kind === 'correction' ? null : runDeadlinesAt(now, kind === 'edition' ? slot : null)
  const window = slot ? runWindow(now, slot, core.mirror.rows('editions')) : null
  const run: RunRow = {
    runId,
    kind,
    model,
    started: now,
    expires: now + RUN_TTL_MS,
    lastCall: now,
    editionId,
    writerMs: deadlines?.writerMs ?? null,
    checkerMs: deadlines?.checkerMs ?? null,
    sinceMs: window?.sinceMs ?? null,
    untilMs: window?.untilMs ?? null,
    done: false,
    probe,
    skip,
    collect: { state: collects ? 'collecting' : 'none' },
    notes: {},
  }
  store.transaction(() => {
    store.putRun(run)
    store.setMeta('runDaily', {
      ...daily,
      total: daily.total + 1,
      collect: daily.collect + (collects ? 1 : 0),
    } satisfies RunDaily)
    store.putTask('expire', run.expires)
    if (collects) store.putTask(`collect:${runId}`, now)
  })
  await core.afterRunBegan(now, collects)
  ctx.deadlines = runDeadlines(run)
  // ログには種類・回の id・モデルを出さない（D21。log.ts も落とす）
  log('run_started')
  const lines = [`回を始めました（${RUN_KIND_LABELS[kind]}）。runId: ${runId}`]
  lines.push(`回の期限: ${dateTimeText(run.expires)}（始めて12時間。過ぎたら回を始め直してください）`)
  if (editionId) lines.push(`枠: ${editionText(editionId)}（${editionShortId(editionId)}）`)
  // probe の 'hosts'・'terms' は候補を集めず、その probe だけをする（collectStep。終わると topic_status(runId) に probe の表が出る）
  const probeOnly = probe === 'hosts' || probe === 'terms'
  if (window)
    lines.push(
      probeOnly
        ? `probe（${probe}）を進めています（候補は集めません）。topic_status に runId を渡すと、終わった後に probe の表が出ます`
        : `候補を集める窓: ${dateTimeText(window.sinceMs)} より後〜${dateTimeText(window.untilMs)}（候補を集めています。topic_status に runId を渡すと、読める候補の数が分かります）`,
    )
  if (deadlines)
    lines.push(
      `書く係の締め切り: ${clockText(deadlines.writerMs)}・照合の打ち切り: ${clockText(deadlines.checkerMs)}（どの答えの頭にも残りの分が出ます）`,
    )
  lines.push(`この回でできる事: ${CAN_DO[kind]}`)
  if (kind === 'edition')
    lines.push('版の回は定期実行の依頼だけで使います。チャットで頼まれた訂正は、訂正だけの回（kind: correction）で。')
  lines.push(
    probeOnly
      ? `次: topic_status（runId: ${runId}）で probe の表を見る`
      : collects
        ? `次: topic_status（runId: ${runId}）で読める候補の数を見てから、選ぶ係に渡す`
        : `次: topic_find_topics で訂正する話題を探す`,
  )
  if (note) lines.unshift(note)
  const result: ToolResult = ok(lines.join('\n'))
  return { ...result, structured: { created: [{ id: runId, label: RUN_KIND_LABELS[kind] }], skipped: [] } }
}

/** 回を使う呼び出し（ctx.useRun の中身）: 確かめ・最後の呼び出しの時刻・答えの頭の締め切り */
export function useRun(store: MirrorStore, ctx: ToolCallContext, runId: unknown): RunRow {
  const run = checkRun(store, runId, ctx.tool, ctx.now)
  store.touchRun(run.runId, ctx.now)
  ctx.deadlines = runDeadlines(run)
  return { ...run, lastCall: ctx.now }
}
