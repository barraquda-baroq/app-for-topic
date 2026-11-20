// 足す道具と訂正する話題を探す道具の中身（B5。設計の 1.2 の 8・14〜17・1.3・1.8）: topic_add_topics・topic_add_edition・
// topic_add_edition_fail・topic_add_correction・topic_find_topics。
// - 書き込みは ctx.add（書き込みの順番・許可とデータの形の版・写しを最後まで読む・「もうある」の時は名前で読み直して build を呼び直す）。
//   build は写し（core.mirror.has など）で「もうある」を見分ける。話題・版・辞書の束は書き込みの日枠を WRITE_RESERVE（vault/quota.ts）残し、
//   作れなかった印と訂正は 0（設計の 1.6）
// - 足す順（7.8 の「辞書の束 → 話題 → 版」）: topic_add_topics が、その回の照合済みの下書きが使う新しい語・新しい説明を束（200語ごと）に
//   して、話題と同じ commit の頭に入れる（束が話題より先・同じ時に入る。後の呼び出しで新しい語が出た時だけ、もう1つ束を足す）。版は最後
//   （order の話題がすべて写しにある時だけ）
// - 数の門（RECORD_NORMS.editionGate。Q17 の今の決め方 A で 5）: 版の回は、その回の照合済みの下書きが門に届くまで topic_add_topics を断り
//   （辞書の束も書かない）、order が門より少ない版を断る。試しの回は知らせるだけで、何も書かない（足すと何件かを返す）
// - 照合の済んでいない下書きは足さない（Q7 の今の決め方 A）
// - 版か作れなかった印が通ったら、回の物（候補・控え・下書き・数え・新しい語）を消す（vault/runs.ts の finishRun）
// - 答えに、その回で足した訂正の全部（話題の短い id と文の頭20字）を出す（点検 guard-G1。作者が気づけるように）。記録の作った時刻・回・
//   モデルは出さない（D21）。訂正の id は回の覚え書き（notes.corrections）に持ち、文は写しから引く（覚え書きに文を持たない）
import { SLOT_LABELS } from '../../../../src/domain/fixedTexts'
import {
  correctionIdOf,
  editionFailIdOf,
  editionShortId,
  normalizeIdText,
  parseEditionId,
  resolveEditionRef,
  resolveTopicRef,
  termIdOf,
  termPackIdOf,
  topicShortId,
} from '../../../../src/domain/ids'
import { jstDateOf, jstDateTimeOf } from '../../../../src/domain/jst'
import { RECORD_LIMITS, RECORD_NORMS } from '../../../../src/domain/limits'
import { termOverlapProblems } from '../../../../src/domain/terms'
import {
  isOneOf,
  REASON_KIND_VALUES,
  type CorrectionRecord,
  type Edition,
  type EditionFail,
  type TermEntry,
  type TermPack,
  type Topic,
} from '../../../../src/domain/types'
import {
  checkCorrection,
  checkEdition,
  checkEditionFail,
  checkEditionNorms,
  checkTermPack,
  isPlainText,
  type Problem,
} from '../../../../src/domain/validate'
import { CONNECTOR_DEVICE } from '../../version'
import type { ToolHandler, VaultCore } from '../core'
import { buildDraft, inputOf, parseDraftRef, problemLines, runTermMap, verifiedCount } from '../drafts'
import { ConnectorError } from '../errors'
import { WRITE_RESERVE } from '../quota'
import { editionText, finishRun, RUN_KIND_LABELS, type RunKind } from '../runs'
import type { DraftRow, RunRow } from '../store'
import type { WritableRecord } from '../writer'
import {
  DEFAULT_ITEM_BUDGET,
  fail,
  fenced,
  FENCE_LABELS,
  head,
  num,
  ok,
  str,
  strList,
  stripMarks,
  type AddStructured,
  type ToolResult,
} from './common'
import { topicLine } from './read'

/** 1つの回に足せる話題の数（設計の 1.6） */
export const TOPICS_PER_RUN = 15
/** 訂正の上限（1つの回: 版の回・訂正だけの回、1日。設計の 1.6。1つの話題には RECORD_LIMITS.correction.perTopic） */
export const CORRECTIONS_PER_RUN: Readonly<Record<'edition' | 'correction', number>> = { edition: 3, correction: 5 }
export const CORRECTIONS_PER_DAY = 10
/** 訂正の文の頭の字数（答えと報告） */
const CORRECTION_HEAD_CHARS = 20
/** 訂正する話題を1回に返す数（字数は DEFAULT_ITEM_BUDGET まで） */
export const FIND_TOPICS_MAX = 60

// ---------- 回の覚え書き ----------

interface WriteNotes {
  /** 足した訂正の id */
  corrections?: string[]
  /**
   * 書こうとした訂正の id（commit の前に置く。答えが届かずに試し直して「もうある」になった時も、送り直した時も、この回の物として数える）
   */
  correctionsTried?: string[]
  /** 足した辞書の束の id */
  packs?: string[]
  /**
   * 下書きごとに書こうとした話題の id と順位（commit の前に置く。答えが届かずに順位を替えて送り直されても、前の話題がクラウドにあれば
   * 2本目を書かない）
   */
  topicsTried?: Record<string, { id: string; rank: number }>
}

const notesOf = (core: VaultCore, runId: string): WriteNotes => (core.store.getRun(runId)?.notes ?? {}) as WriteNotes

function addNote(
  core: VaultCore,
  runId: string,
  key: 'corrections' | 'correctionsTried' | 'packs',
  ids: readonly string[],
): void {
  if (!ids.length) return
  const notes = core.store.getRun(runId)?.notes ?? {}
  const cur = Array.isArray(notes[key]) ? (notes[key] as string[]) : []
  core.store.setRunNotes(runId, { ...notes, [key]: [...cur, ...ids.filter((id) => !cur.includes(id))] })
}

/** その回で足した訂正の行（話題の短い id と文の頭20字。作った時刻は出さない） */
function correctionLines(core: VaultCore, runId: string): string[] {
  const ids = notesOf(core, runId).corrections ?? []
  if (!ids.length) return ['この回で足した訂正: 0件']
  const lines = [`この回で足した訂正: ${ids.length}件`]
  for (const id of ids) {
    const c = core.mirror.get('corrections', id)
    lines.push(
      c
        ? `- ${topicShortId(c.topicId)}「${head(stripMarks(c.text), CORRECTION_HEAD_CHARS)}」`
        : `- ${topicShortId(id.slice(0, -9))}`,
    )
  }
  return lines
}

const structured = (created: AddStructured['created'], skipped: AddStructured['skipped'] = []): AddStructured => ({
  created,
  skipped,
})

const withStructured = (r: ToolResult, s: AddStructured): ToolResult => ({ ...r, structured: s })

// ---------- topic_add_topics ----------

/** 回の語のうち、照合済みの下書きが使う、まだ辞書に無い語・新しい説明（束にする語。termId の順） */
export function packEntriesFor(core: VaultCore, run: RunRow, drafts: readonly DraftRow[]): TermEntry[] {
  const runTerms = runTermMap(core.store, run.runId)
  const out = new Map<string, TermEntry>()
  for (const d of drafts) {
    if (d.status !== 'verified') continue
    for (const ref of inputOf(d).terms ?? []) {
      if (!ref || typeof ref !== 'object') continue
      const tid =
        'new' in ref ? termIdOf(ref.new.key) : 'termId' in ref && typeof ref.termId === 'string' ? ref.termId.trim() : null
      const r = tid ? runTerms.get(tid) : undefined
      if (!r) continue
      const c = core.dictionary.get(r.entry.termId)
      if (!c || c.rev < r.entry.rev) out.set(r.entry.termId, r.entry)
    }
  }
  return [...out.values()].sort((a, b) => (a.termId < b.termId ? -1 : a.termId > b.termId ? 1 : 0))
}

/** 辞書の束（200語ごと） */
function packsOf(run: RunRow, entries: readonly TermEntry[], now: number): TermPack[] {
  const size = RECORD_LIMITS.termPack.entries
  const out: TermPack[] = []
  for (let i = 0; i < entries.length; i += size) {
    const part = entries.slice(i, i + size)
    out.push({
      id: termPackIdOf(run.editionId!, part),
      v: 1,
      createdAt: now,
      by: 'connector',
      ai: 'claude',
      model: run.model,
      runId: run.runId,
      editionId: run.editionId!,
      entries: part,
    })
  }
  return out
}

interface ItemPlan {
  draft: DraftRow
  rank: number
  topic: Topic
}

/** 話題を足す（topic_add_topics） */
export const topicAddTopics: ToolHandler = async (core, args, ctx) => {
  const run = ctx.run!
  const trial = run.kind === 'trial'
  const items = Array.isArray(args.items) ? (args.items as { draft?: unknown; rank?: unknown }[]) : []
  if (!items.length)
    throw new ConnectorError('invalid', 'items に足す照合済みの下書き（{ draft, rank }）を1〜5件渡してください。')
  const gate = verifiedCount(core.store, run.runId)
  const gateNote = `照合済み ${gate.verified}本（数の門は${RECORD_NORMS.editionGate}本）`
  if (gate.left && !trial)
    throw new ConnectorError(
      'draft_state',
      `照合済みの下書きが${RECORD_NORMS.editionGate}本そろうまで、話題は足せません（${gateNote}。辞書の束も書いていません）。照合を待つか、そろわなければ作れなかった印（topic_add_edition_fail）を足してください。`,
    )
  const skipped: AddStructured['skipped'] = []
  const picked: { draft: DraftRow; rank: number }[] = []
  const seen = new Set<string>()
  for (const it of items) {
    const id = parseDraftRef(it.draft)
    const ref = typeof it.draft === 'string' ? stripMarks(it.draft).slice(0, 20) : '?'
    const row = id ? core.store.draft(run.runId, id) : null
    const rank = num(it.rank)
    if (!row) skipped.push({ ref, reason: 'この回に無い下書きです' })
    else if (seen.has(row.draftId)) skipped.push({ ref: row.draftId, reason: '同じ下書きが2回あります' })
    else if (row.status !== 'verified')
      skipped.push({ ref: row.draftId, reason: `${row.status === 'pending' ? '照合待ち' : '照合で外した'}の下書きは足しません` })
    else if (row.topicId && (trial || core.mirror.has('topics', row.topicId)))
      skipped.push({ ref: row.draftId, reason: `もう足してあります（${topicShortId(row.topicId)}）` })
    else if (rank === undefined || !Number.isInteger(rank))
      skipped.push({ ref: row.draftId, reason: 'rank（版の中の順位）がありません' })
    else picked.push({ draft: row, rank })
    if (row) seen.add(row.draftId)
  }
  const addedBefore = core.store
    .drafts(run.runId)
    .filter((d) => d.topicId !== null && !picked.some((p) => p.draft.draftId === d.draftId))
  const room = Math.max(0, TOPICS_PER_RUN - addedBefore.length)
  for (const p of picked.splice(room))
    skipped.push({ ref: p.draft.draftId, reason: `1つの回に足せる話題は${TOPICS_PER_RUN}本までです` })

  /** 下書きを組み立て直す（照合の数え・足す時の順位） */
  const plan = (now: number): { plans: ItemPlan[]; failed: { ref: string; reason: string; problems: Problem[] }[] } => {
    const plans: ItemPlan[] = []
    const failed: { ref: string; reason: string; problems: Problem[] }[] = []
    for (const p of picked) {
      const d = p.draft
      const check = { claims: d.claims ?? 0, fixed: d.fixed ?? 0, model: d.checkModel }
      const b = buildDraft(core, run, d.draftId, inputOf(d), { now, follow: true, check, rank: p.rank, model: d.model })
      if (b.result.topic) plans.push({ draft: d, rank: p.rank, topic: b.result.topic })
      else failed.push({ ref: d.draftId, reason: '組み立て直すと断られます', problems: b.result.errors })
    }
    return { plans, failed }
  }

  if (trial) {
    await ctx.fresh(false)
    const { plans, failed } = plan(ctx.now)
    const entries = packEntriesFor(core, run, core.store.drafts(run.runId))
    const packs = packsOf(run, entries, ctx.now)
    core.store.transaction(() => {
      for (const p of plans) core.store.putDraft({ ...p.draft, rank: p.rank, topicId: p.topic.id, updated: ctx.now })
    })
    const lines = [
      `試しの回なので、クラウドには何も書きません（足すと: 話題 ${plans.length}件・辞書の束 ${packs.length}つ（語 ${entries.length}））。`,
    ]
    if (gate.left) lines.push(`版の回なら断ります: ${gateNote}。`)
    for (const p of plans) lines.push(`- ${p.draft.draftId} → ${topicShortId(p.topic.id)}（順位 ${p.rank}）`)
    for (const f of failed) lines.push(`- ${f.ref}: ${f.reason}`, ...problemLines(f.problems).map((l) => `  ${l}`))
    for (const s of skipped) lines.push(`- ${s.ref}: とばしました（${s.reason}）`)
    lines.push('次: 全部の確かめが済んだら topic_add_edition（試しの回は確かめだけ）')
    return withStructured(
      ok(lines.join('\n')),
      structured(
        plans.map((p) => ({ id: topicShortId(p.topic.id), label: `${p.draft.draftId}（試し・書いていない）` })),
        [...skipped, ...failed.map((f) => ({ ref: f.ref, reason: f.reason }))],
      ),
    )
  }

  if (!picked.length) {
    const lines = skipped.map((s) => `- ${s.ref}: ${s.reason}`)
    // 送り直し（どれももう足してある）は失敗にしない
    if (skipped.every((s) => s.reason.startsWith('もう足してあります')))
      return withStructured(
        ok(['どの下書きも、もう足してあります（何も書いていません）:', ...lines].join('\n')),
        structured([], skipped),
      )
    return withStructured(fail(['足せる下書きがありません（何も書いていません）:', ...lines].join('\n')), structured([], skipped))
  }

  /** 前の呼び出しで書けていた話題（答えが届かずに、順位を替えて送り直された下書き） */
  type Reused = { draft: DraftRow; rank: number; topicId: string }
  let last: {
    plans: ItemPlan[]
    failed: { ref: string; reason: string; problems: Problem[] }[]
    packs: TermPack[]
    reused: Reused[]
  } = {
    plans: [],
    failed: [],
    packs: [],
    reused: [],
  }
  const out = await ctx.add(
    () => {
      const now = core.now()
      const built = plan(now)
      const failed = built.failed
      // 前に書こうとした話題（別の順位）がクラウドにある下書きは、2本目を書かずに前の話題を足した物として扱う
      const tried = notesOf(core, run.runId).topicsTried ?? {}
      const reused: Reused[] = []
      const plans: ItemPlan[] = []
      for (const p of built.plans) {
        const prev = tried[p.draft.draftId]
        if (prev && prev.id !== p.topic.id && core.mirror.has('topics', prev.id))
          reused.push({ draft: p.draft, rank: prev.rank, topicId: prev.id })
        else plans.push(p)
      }
      const entries = packEntriesFor(core, run, core.store.drafts(run.runId))
      const overlap = termOverlapProblems(entries, core.dictionary.subsetFor({ entries }))
      if (overlap.length)
        return {
          ok: false,
          result: fail(
            [
              '辞書に足す語の表記が、辞書のほかの語と重なります（何も書いていません）:',
              ...overlap.map((o) => `- ${o.termId}: ${o.message}`),
            ].join('\n'),
          ),
        }
      const packs = packsOf(run, entries, now).filter((p) => !core.mirror.has('termPacks', p.id))
      for (const p of packs) {
        const c = checkTermPack(p)
        if (c.errors.length)
          return {
            ok: false,
            result: fail(['辞書の束を作れません（何も書いていません）:', ...problemLines(c.errors)].join('\n')),
          }
      }
      last = { plans, failed, packs, reused }
      const writing = plans.filter((p) => !core.mirror.has('topics', p.topic.id))
      if (writing.length) {
        const notes = core.store.getRun(run.runId)?.notes ?? {}
        const next = { ...tried }
        for (const p of writing) next[p.draft.draftId] = { id: p.topic.id, rank: p.rank }
        core.store.setRunNotes(run.runId, { ...notes, topicsTried: next })
      }
      const records: WritableRecord[] = [
        ...packs.map((p) => ({ table: 'termPacks' as const, record: p })),
        ...writing.map((p) => ({ table: 'topics' as const, record: p.topic })),
      ]
      return { ok: true, records }
    },
    { reserve: WRITE_RESERVE },
  )
  if (!out.ok) return out.result
  const added = last.plans.filter((p) => core.mirror.has('topics', p.topic.id))
  core.store.transaction(() => {
    for (const p of added) core.store.putDraft({ ...p.draft, rank: p.rank, topicId: p.topic.id, updated: core.now() })
    for (const r of last.reused) core.store.putDraft({ ...r.draft, rank: r.rank, topicId: r.topicId, updated: core.now() })
    addNote(
      core,
      run.runId,
      'packs',
      last.packs.filter((p) => core.mirror.has('termPacks', p.id)).map((p) => p.id),
    )
  })
  const remaining = core.store.drafts(run.runId).filter((d) => d.status === 'verified' && d.topicId === null).length
  const lines = [`話題を足しました: ${added.length}件`]
  for (const p of added) lines.push(`- ${topicShortId(p.topic.id)}（${p.draft.draftId}・順位 ${p.rank}）`)
  for (const r of last.reused)
    lines.push(`- ${topicShortId(r.topicId)}（${r.draft.draftId}・もう足してありました。順位は前の ${r.rank} のまま）`)
  const packWords = last.packs.reduce((n, p) => n + p.entries.length, 0)
  if (last.packs.length) lines.push(`辞書の束: ${last.packs.length}つ（語 ${packWords}）を話題より先に足しました`)
  const notAdded = last.plans.filter((p) => !core.mirror.has('topics', p.topic.id))
  for (const p of notAdded) skipped.push({ ref: p.draft.draftId, reason: '書けませんでした' })
  for (const f of last.failed) {
    skipped.push({ ref: f.ref, reason: f.reason })
    lines.push(`- ${f.ref}: ${f.reason}`, ...problemLines(f.problems).map((l) => `  ${l}`))
  }
  for (const s of skipped.filter((s) => !last.failed.some((f) => f.ref === s.ref)))
    lines.push(`- ${s.ref}: とばしました（${s.reason}）`)
  if (out.failed) lines.push(`途中の組が書けませんでした: ${out.failed}`)
  lines.push(
    remaining
      ? `照合済みの残り ${remaining}本。全部足したら topic_add_edition（order は p:… か d:…）`
      : '照合済みの下書きは全部足しました。次: topic_add_edition（order は p:… か d:…）',
  )
  return withStructured(
    ok(lines.join('\n')),
    structured(
      [
        ...added.map((p) => ({ id: topicShortId(p.topic.id), label: `${p.draft.draftId}・順位 ${p.rank}` })),
        ...last.reused.map((r) => ({ id: topicShortId(r.topicId), label: `${r.draft.draftId}・順位 ${r.rank}（前の呼び出し）` })),
      ],
      skipped,
    ),
  )
}

// ---------- topic_add_edition ----------

/** order の指し方を話題の id にする（d:… は足した下書き、p:… と id はこの版の話題） */
function resolveOrder(
  core: VaultCore,
  run: RunRow,
  order: readonly string[],
): { ids: string[]; errors: string[]; byDraft: Map<string, DraftRow> } {
  const drafts = core.store.drafts(run.runId)
  const byTopic = new Map<string, DraftRow>()
  for (const d of drafts) if (d.topicId) byTopic.set(d.topicId, d)
  const editionTopics = [
    ...new Set([
      ...core.mirror
        .rows('topics')
        .filter((t) => t.editionId === run.editionId)
        .map((t) => t.id),
      ...byTopic.keys(),
    ]),
  ]
  const ids: string[] = []
  const errors: string[] = []
  order.forEach((raw, i) => {
    const ref = String(raw).trim()
    const at = `order.${i}（${stripMarks(ref).slice(0, 20)}）`
    const did = parseDraftRef(ref)
    let id: string | null = null
    if (did) {
      const d = drafts.find((x) => x.draftId === did)
      if (!d) errors.push(`${at}: この回に無い下書きです`)
      else if (!d.topicId) errors.push(`${at}: まだ足していない下書きです（先に topic_add_topics）`)
      else id = d.topicId
    } else {
      const r = resolveTopicRef(ref, editionTopics)
      if (r.ok) id = r.id
      else
        errors.push(
          `${at}: ${r.reason === 'ambiguous' ? '2つ以上の話題に当たります（話題の id で指してください）' : 'この版の話題にありません'}`,
        )
    }
    if (id === null) return
    if (ids.includes(id)) errors.push(`${at}: 同じ話題が2回あります`)
    else ids.push(id)
  })
  return { ids, errors, byDraft: byTopic }
}

/** 照合のまとめ（主張・直した数・種類・外した本数・確かめが早すぎる下書きの数） */
function checkSummary(core: VaultCore, run: RunRow): string[] {
  const s = core.store
  const why = s.runCounts(run.runId, 'why:')
  const WHY: Record<string, string> = {
    name: '固有名',
    date: '日付',
    number: '数字',
    quote: '引用',
    reason: '理由',
    overstate: '言い過ぎ',
    notInSource: '資料に無い',
    rule: '決まり',
    term: '用語',
    subject: '主体',
    area: '区域',
    other: 'その他',
  }
  const kinds = Object.entries(why)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${WHY[k.slice(4)] ?? k.slice(4)} ${n}`)
  return [
    `照合のまとめ: 主張 ${s.runCount(run.runId, 'claims')}件・直した ${s.runCount(run.runId, 'fixed')}件${kinds.length ? `（${kinds.join('・')}）` : ''}・照合で外した ${s.runCount(run.runId, 'rejected')}本`,
    `確かめが早すぎる下書き: ${s.runCount(run.runId, 'early')}本（置いてから2分たたずに照合済みになった物）`,
  ]
}

/** かかった分と道具の回数 */
function usageOf(core: VaultCore, run: RunRow, now: number, tokens: number | undefined): Edition['usage'] {
  const calls = core.store.runCount(run.runId, 'calls')
  return {
    minutes: Math.max(0, Math.round((now - run.started) / 60_000)),
    ...(calls > 0 ? { toolCalls: calls } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
  }
}

/** 版を出す（topic_add_edition） */
export const topicAddEdition: ToolHandler = async (core, args, ctx) => {
  const run = core.store.getRun(ctx.run!.runId) ?? ctx.run!
  const trial = run.kind === 'trial'
  const order = strList(args.order) ?? []
  const candidateCount = num(args.candidateCount)
  const notChosen = (Array.isArray(args.notChosen) ? args.notChosen : []) as { headline?: unknown; whyNot?: unknown }[]
  const tokens = num(args.tokens)
  if (!order.length) throw new ConnectorError('invalid', 'order に版の話題の並び（p:… か d:…）を渡してください。')
  const parsed = parseEditionId(run.editionId)
  if (!parsed) throw new ConnectorError('invalid', 'この回には版の枠がありません。')
  const gateMsg = `版の話題は${RECORD_NORMS.editionGate}本から出せます（order ${order.length}本）`

  const make = (ids: string[], now: number): Edition => ({
    id: run.editionId!,
    v: 1,
    createdAt: now,
    by: 'connector',
    ai: 'claude',
    model: run.model,
    runId: run.runId,
    date: parsed.date,
    slot: parsed.slot,
    order: ids,
    candidateCount: candidateCount !== undefined ? Math.floor(candidateCount) : null,
    notChosen: notChosen.map((n) => ({
      headline: typeof n.headline === 'string' ? n.headline.trim() : '',
      whyNot: typeof n.whyNot === 'string' ? n.whyNot.trim() : '',
    })),
    window:
      run.sinceMs !== null && run.untilMs !== null
        ? { since: jstDateTimeOf(run.sinceMs, true), until: jstDateTimeOf(run.untilMs, true) }
        : null,
    usage: usageOf(core, run, now, tokens),
  })

  const norms = (edition: Edition, byDraft: Map<string, DraftRow>): Problem[] =>
    checkEditionNorms(
      edition,
      edition.order.map((id) => {
        const lite = core.mirror.get('topics', id)
        const d = byDraft.get(id)
        let major = false
        try {
          major = d ? inputOf(d).major === true : false
        } catch {
          major = false
        }
        return { id, genre: (lite?.genre ?? (d ? inputOf(d).genre : 'politics')) as Topic['genre'], major }
      }),
    )

  const report = (edition: Edition, warnings: readonly Problem[], wrote: boolean): string[] => {
    const lines = [
      wrote
        ? `版を出しました: ${editionShortId(edition.id)}（${editionText(edition.id)}。話題 ${edition.order.length}本）`
        : `試しの回なので、クラウドには何も書きません（出すと: ${editionShortId(edition.id)}（${editionText(edition.id)}）・話題 ${edition.order.length}本）`,
    ]
    if (warnings.length) lines.push('知らせる物（断りません。報告に書く）:', ...problemLines(warnings))
    lines.push(...checkSummary(core, run))
    lines.push(...correctionLines(core, run.runId))
    const u = edition.usage
    lines.push(`かかった分: ${u?.minutes ?? 0}分${u?.toolCalls ? `（道具の呼び出し ${u.toolCalls}回）` : ''}`)
    return lines
  }

  if (trial) {
    await ctx.fresh(false)
    const { ids, errors, byDraft } = resolveOrder(core, run, order)
    if (errors.length)
      return fail(['版の並びに直す所があります（試しの回。何も書いていません）:', ...errors.map((e) => `- ${e}`)].join('\n'))
    const edition = make(ids, ctx.now)
    const checked = checkEdition(edition)
    if (checked.errors.length) return fail(['版の記録を作れません（試しの回）:', ...problemLines(checked.errors)].join('\n'))
    const warnings = [
      ...norms(edition, byDraft),
      ...(ids.length < RECORD_NORMS.editionGate
        ? [{ path: 'order', code: 'gate', message: `版の回なら断ります（${gateMsg}）` }]
        : []),
    ]
    const lines = report(edition, warnings, false)
    finishRun(core.store, run.runId)
    lines.push('この回の作業は終わりです（報告を書く）。候補・資料の控え・下書きは消しました。')
    return withStructured(ok(lines.join('\n')), structured([]))
  }

  if (order.length < RECORD_NORMS.editionGate)
    throw new ConnectorError(
      'draft_state',
      `${gateMsg}。照合済みの話題が足りなければ、作れなかった印（topic_add_edition_fail）を足してください。`,
    )

  let edition: Edition | null = null
  let byDraftLast = new Map<string, DraftRow>()
  let already = false
  const out = await ctx.add(
    () => {
      const now = core.now()
      const existing = core.mirror.get('editions', run.editionId!)
      const { ids, errors, byDraft } = resolveOrder(core, run, order)
      byDraftLast = byDraft
      if (errors.length)
        return {
          ok: false,
          result: fail(['版の並びに直す所があります（何も書いていません）:', ...errors.map((e) => `- ${e}`)].join('\n')),
        }
      if (existing) {
        if (existing.order.length === ids.length && existing.order.every((x, i) => x === ids[i])) {
          already = true
          edition = make(ids, now)
          return { ok: true, records: [] }
        }
        return {
          ok: false,
          result: fail(
            `この枠の版はもうあります（${editionShortId(existing.id)}。${editionText(existing.id)}）。1つの枠に版は1つで、作り直しません。`,
          ),
        }
      }
      const missing = ids.filter((id) => !core.mirror.has('topics', id))
      if (missing.length)
        return {
          ok: false,
          result: fail(
            `order の話題がクラウドにありません（${missing.map(topicShortId).join('・')}）。先に topic_add_topics で足してください（何も書いていません）。`,
          ),
        }
      const e = make(ids, now)
      const checked = checkEdition(e)
      if (checked.errors.length)
        return {
          ok: false,
          result: fail(['版の記録を作れません（何も書いていません）:', ...problemLines(checked.errors)].join('\n')),
        }
      edition = e
      return { ok: true, records: [{ table: 'editions', record: e }] }
    },
    { reserve: WRITE_RESERVE },
  )
  if (!out.ok) return out.result
  const e = edition as Edition | null
  if (!e || (!already && !core.mirror.has('editions', e.id)))
    return fail(
      `版を書けませんでした${out.failed ? `（${out.failed}）` : ''}。少し待ってから、もう一度 topic_add_edition を呼んでください。`,
    )
  const lines = report(e, norms(e, byDraftLast), true)
  if (already) lines.splice(0, 1, `この版はもう出してあります: ${editionShortId(e.id)}（${editionText(e.id)}。同じ並び）`)
  finishRun(core.store, run.runId)
  lines.push('この回の作業は終わりです（報告を書く）。候補・資料の控え・下書きは消しました。')
  return withStructured(ok(lines.join('\n')), structured([{ id: editionShortId(e.id), label: editionText(e.id) }]))
}

// ---------- topic_add_edition_fail ----------

/** 作れなかった印を足す（topic_add_edition_fail） */
export const topicAddEditionFail: ToolHandler = async (core, args, ctx) => {
  const run = ctx.run!
  const reasonKind = args.reasonKind
  if (!isOneOf(REASON_KIND_VALUES, reasonKind))
    throw new ConnectorError('invalid', `reasonKind は ${REASON_KIND_VALUES.join('・')} のどれかです。`)
  const reason = str(args.reason)?.replace(/\s+/g, ' ').trim() ?? ''
  if (!reason)
    throw new ConnectorError(
      'invalid',
      `reason に画面に出す短い訳（${RECORD_LIMITS.editionFail.reason}字まで）を書いてください。`,
    )
  let fail0: EditionFail | null = null
  let already = false
  const out = await ctx.add(() => {
    if (core.mirror.has('editions', run.editionId!))
      return {
        ok: false,
        result: fail(`この枠の版はもうあります（${editionShortId(run.editionId!)}）。作れなかった印は足しません。`),
      }
    const base = { editionId: run.editionId!, runId: run.runId, reasonKind, reason }
    const f: EditionFail = {
      id: editionFailIdOf(base),
      v: 1,
      createdAt: core.now(),
      by: 'connector',
      ai: 'claude',
      model: run.model,
      ...base,
    }
    const checked = checkEditionFail(f)
    if (checked.errors.length)
      return { ok: false, result: fail(['作れなかった印を作れません:', ...problemLines(checked.errors)].join('\n')) }
    fail0 = f
    if (core.mirror.has('editionFails', f.id)) {
      already = true
      return { ok: true, records: [] }
    }
    return { ok: true, records: [{ table: 'editionFails', record: f }] }
  })
  if (!out.ok) return out.result
  const f = fail0 as EditionFail | null
  if (!f || !core.mirror.has('editionFails', f.id))
    return fail(
      `作れなかった印を書けませんでした${out.failed ? `（${out.failed}）` : ''}。少し待ってから、もう一度呼んでください。`,
    )
  const lines = [
    `${already ? '作れなかった印はもうあります' : '作れなかった印を足しました'}: ${f.id}（${editionText(f.editionId)}。${SLOT_LABELS[parseEditionId(f.editionId)!.slot]}の枠）`,
    ...correctionLines(core, run.runId),
  ]
  finishRun(core.store, run.runId)
  lines.push('この回の作業は終わりです（報告を書く）。候補・資料の控え・下書きは消しました。')
  return withStructured(ok(lines.join('\n')), structured([{ id: f.id, label: editionText(f.editionId) }]))
}

// ---------- 訂正 ----------

/** 訂正できる話題（30日の内で、版の記録がある版の order にある話題。写しは30日を過ぎた行を持たない） */
function correctableTopics(core: VaultCore): string[] {
  const out = new Set<string>()
  for (const e of core.mirror.rows('editions')) for (const id of e.order) if (core.mirror.has('topics', id)) out.add(id)
  return [...out]
}

/** 今日（日本時間）コネクタが足した訂正の数（写しの updated で数える。回の種類で分けない） */
function correctionsToday(core: VaultCore, now: number): number {
  const today = jstDateOf(now)
  return core.store
    .mirrorRows('corrections')
    .filter((r) => r.device === CONNECTOR_DEVICE && jstDateOf(Date.parse(r.updated)) === today).length
}

/** 訂正を足す（topic_add_correction） */
export const topicAddCorrection: ToolHandler = async (core, args, ctx) => {
  const run = ctx.run!
  const kind = run.kind as RunKind
  const model = str(args.model)?.trim() ?? ''
  const ref = str(args.topic)?.trim() ?? ''
  const text = str(args.text)?.trim() ?? ''
  if (!model) throw new ConnectorError('invalid', 'model に使っているモデルの名前を書いてください。')
  if (!ref) throw new ConnectorError('invalid', 'topic に訂正する話題（p:…）を渡してください。')
  if (!text)
    throw new ConnectorError(
      'invalid',
      `text に、何がどう誤りで正しくは何かを、ふつうの文で${RECORD_LIMITS.correction.text}字まで書いてください。`,
    )
  if (!isPlainText(text))
    throw new ConnectorError('invalid', 'text に改行・URL・記法の記号は使えません（ふつうの文で書いてください）。')
  const perRun = kind === 'correction' ? CORRECTIONS_PER_RUN.correction : CORRECTIONS_PER_RUN.edition
  const perRunText = `1つの回に足せる訂正は${perRun}件までです（${RUN_KIND_LABELS[kind] ?? 'この回'}）。`
  // 書く前の確かめ（読み取りを使わない）。もうある訂正の送り直しは、上限に届いていても「もうある」と答える（下の build の中で）
  const pre = resolveTopicRef(ref, correctableTopics(core))
  const known = pre.ok && core.mirror.has('corrections', correctionIdOf({ topicId: pre.id, text }))
  if (!known && core.store.runCount(run.runId, 'corrections') >= perRun) throw new ConnectorError('draft_limit', perRunText)
  let record: CorrectionRecord | null = null
  let already = false
  const out = await ctx.add(() => {
    const r = resolveTopicRef(ref, correctableTopics(core))
    if (!r.ok)
      return {
        ok: false,
        result: fail(
          r.reason === 'ambiguous'
            ? `「${stripMarks(ref).slice(0, 20)}」が2つ以上の話題に当たります（話題の id で指してください）。`
            : `「${stripMarks(ref).slice(0, 20)}」は訂正できる話題にありません（30日の内の、版の記録がある版の話題だけ。topic_find_topics で探してください）。`,
        ),
      }
    const c: CorrectionRecord = {
      id: correctionIdOf({ topicId: r.id, text }),
      v: 1,
      createdAt: core.now(),
      by: 'connector',
      ai: 'claude',
      model,
      runId: run.runId,
      topicId: r.id,
      editionId: r.id.slice(0, 13),
      text,
    }
    record = c
    if (core.mirror.has('corrections', c.id)) {
      already = true
      return { ok: true, records: [] }
    }
    // 1つの回の数は、書き込みの順番の中でもう一度見る（同時に呼ばれた訂正が、前の呼び出しの数えの前に上の確かめを通っても超えない）
    if (core.store.runCount(run.runId, 'corrections') >= perRun) return { ok: false, result: fail(perRunText) }
    const existing = core.mirror.rows('corrections').filter((x) => x.topicId === r.id).length
    const checked = checkCorrection(c, { existingForTopic: existing })
    if (checked.errors.length)
      return { ok: false, result: fail(['訂正を足せません:', ...problemLines(checked.errors)].join('\n')) }
    if (correctionsToday(core, core.now()) >= CORRECTIONS_PER_DAY)
      return { ok: false, result: fail(`今日（日本時間）足せる訂正は${CORRECTIONS_PER_DAY}件までです。明日また足してください。`) }
    // 書く前に、この回が書こうとした訂正として覚える（答えが届かずに試し直した・送り直した時も、この回の物として数えるため）
    addNote(core, run.runId, 'correctionsTried', [c.id])
    return { ok: true, records: [{ table: 'corrections', record: c }] }
  })
  if (!out.ok) return out.result
  const c = record as CorrectionRecord | null
  if (!c || !core.mirror.has('corrections', c.id))
    return fail(`訂正を書けませんでした${out.failed ? `（${out.failed}）` : ''}。少し待ってから、もう一度呼んでください。`)
  // この呼び出しで書けた（試し直しで「もうある」になった時も）・この回が前に書こうとした訂正は、まだ数えていなければ、この回の訂正として数える
  const notes = notesOf(core, run.runId)
  const mine = out.created.has(`corrections:${c.id}`) || (notes.correctionsTried ?? []).includes(c.id)
  const counted = (notes.corrections ?? []).includes(c.id)
  const added = mine && !counted
  if (added) {
    core.store.addRunCount(run.runId, 'corrections')
    addNote(core, run.runId, 'corrections', [c.id])
  }
  return withStructured(
    ok(
      `${added || !already ? '訂正を足しました' : '同じ訂正はもうあります'}: ${c.id}（${topicShortId(c.topicId)} への訂正。話題は書き換えていません）`,
    ),
    structured([{ id: c.id, label: topicShortId(c.topicId) }]),
  )
}

// ---------- topic_find_topics ----------

/** 訂正する話題を探す（topic_find_topics） */
export const topicFindTopics: ToolHandler = async (core, args, ctx) => {
  const { note } = await ctx.fresh(false)
  const edition = str(args.edition) ? resolveEditionRef(String(args.edition)) : null
  if (str(args.edition) && !edition)
    throw new ConnectorError('invalid', 'edition は e:2026-11-15-12 の形か版の id で渡してください。')
  const date = str(args.date)
  const slot = str(args.slot)
  const words = (strList(args.words) ?? []).map((w) => normalizeIdText(w)).filter(Boolean)
  const editions = core.mirror
    .rows('editions')
    .filter((e) => (!edition || e.id === edition) && (!date || e.date === date) && (!slot || e.slot === slot))
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const corrections = new Map<string, string[]>()
  for (const c of core.mirror.rows('corrections')) corrections.set(c.topicId, [...(corrections.get(c.topicId) ?? []), c.text])
  const body: string[] = []
  let n = 0
  let more = 0
  let chars = 0
  for (const e of editions) {
    const topics = e.order
      .map((id) => core.mirror.get('topics', id))
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .filter((t) => words.every((w) => normalizeIdText(`${t.headline} ${t.summaryHead}`).includes(w)))
    if (!topics.length) continue
    for (const t of topics) {
      const part: string[] = []
      if (!body.length || !body.some((l) => l.startsWith(editionShortId(e.id))))
        part.push(`${editionShortId(e.id)}（${editionText(e.id)}）`)
      part.push(topicLine(t))
      for (const text of corrections.get(t.id) ?? []) part.push(`  今ある訂正: ${stripMarks(text)}`)
      const size = part.reduce((k, l) => k + l.length + 1, 0)
      // 1回に返すのは FIND_TOPICS_MAX 本・DEFAULT_ITEM_BUDGET 字まで（残りは数だけ。版・日付・語で絞ってもらう）
      if (n >= FIND_TOPICS_MAX || (n > 0 && chars + size > DEFAULT_ITEM_BUDGET)) {
        more += 1
        continue
      }
      body.push(...part)
      chars += size
      n += 1
    }
  }
  const lines: string[] = []
  if (note) lines.push(note)
  if (!n) {
    lines.push(
      '訂正できる話題は見つかりませんでした（30日の内の、版の記録がある版の話題だけを探します。版・日付・枠・語を替えてください）。',
    )
    return ok(lines.join('\n'))
  }
  lines.push(
    `訂正する話題（30日の内・版の記録がある版の並びの話題。${n}本${more ? `・ほかに ${more}本（版・日付・語で絞ってください）` : ''}）`,
  )
  lines.push(fenced(FENCE_LABELS.topics, body))
  lines.push('次: 話題の誤りを topic_read_article で資料と照らしてから、topic_add_correction（topic: p:…）')
  return ok(lines.join('\n'))
}
