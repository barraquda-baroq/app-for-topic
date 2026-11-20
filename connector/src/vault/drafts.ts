// 下書き（段階3の設計の 1.2 の 9〜13・1.3・1.5）: 書く係が置いた下書きを DO の drafts の表に持ち、照合の係の直す所を当て、足す時に組み立て直す。
// 道具の答えの文は vault/tools/drafts.ts（下書きの道具）と vault/tools/write.ts（足す道具）。ここは決まりと表の読み書きだけ。
// - 組み立ては src/domain/assemble.ts の assembleTopic、照合の直す所は src/domain/patch.ts の applyPatches（どちらも B1。純粋な関数）。
//   辞書は core.dictionary.forInput（部分の辞書）、知ってるは core.mirror.known()、前の版の話題は tools/read.ts の recentTopics、
//   資料の控えは tools/fetch.ts の materialForRef（候補の c0012 か URL で引く）
// - 出典: この回で topic_read_article が読んでいない資料と、本文が200字未満の控え（PDF の資料だけの発表など）を出典にした下書きは断る
//   （assembleTopic が控えの read と bodyChars で断る。D23・5.10 の「実際に開いて読んだ記事だけ」を作りで守る）
// - 1つの回に15本まで（置き換えは数えない）。照合の前だけ置き換えられる（照合の後は置き換えない）。同じ中身を送り直したら同じ下書きを返す
//   （topic_save_draft は idempotentHint: true）。資料の印の文字列（<<< >>>）を含む欄は断る（get_draft で囲いを偽られないように）
// - 照合: topic_get_draft で読む前は断る・1つの下書きに5回まで・全部当たるか何も当てない（applyPatches）・当てた後に組み立て直して確かめる・
//   置いてから（置き換えた下書きは置き換えてから）照合済みになるまでが2分より短い下書きは「確かめが早すぎる」と数える（点検2 guard-G2-10。
//   版の答えと報告に出す）
// - 締め切り: 書く係の締め切りの後の置く物は置いて知らせ、照合の打ち切りの後の置く・照合は断る（回の覚え書きの writerMs・checkerMs。
//   答えの頭の「書く係の締め切りまで n分」と同じ値。定期実行の 10:16 の回は 11:46・12:46。B1 の open を決めた所）
// 同じ回の辞書の語（run_terms。語ごとに持ち主の下書き）の決まり（B1 の open「同じ回の revise の取り合い」を決めた所）:
// - 書く係が置く時: ほかの下書きが同じ語を別の説明で足している・新しくしている時は断る（assembleTopic の term-conflict。先に置いた方が勝つ）
// - 照合の係が当てた時: その下書きの新しい語・新しい説明が、その回の語になる（持ち主を移す。設計の 1.5「同じ回のほかの下書きのその語も
//   同じ説明になる」）。同じ回で足すだけの語（辞書に無い語）の説明を照合で直した時も、新しい語として持ち主を移す
// - 組み立て直す時（照合・下書きを読む・話題を足す）: ほかの下書きが持ち主の語は、その回の語の説明に合わせる（自分の下書きの古い説明は使わない。
//   followRunTerms）。辞書の束に書いた後の語（この回の束で辞書に入った語）は辞書の語として指す
// - 持ち主の下書きを置き換えた・照合で外した時、その語をほかの下書きが使っていれば語は残す（持ち主はそのまま）
// 照合で辞書の語の説明を直すと、patch.ts は語の指し方を「説明を新しくする」（{ termId, revise }）に替え、この話題での表記（別名など）が落ちる
// （B1 の open）。ここで直す前の表記を覚えて revise の指し方に添え（term。入力の形には無い、DO の中だけの欄）、組み立てた後に話題の表記へ戻す
// （その表記が新しい説明の語の表記か別名の時だけ。applySurfaces）。
import { assembleTopic, type AssembleResult, type SourceMaterial } from '../../../src/domain/assemble'
import { stableStringify } from '../../../src/domain/equal'
import { normalizeIdText, termIdOf, topicIdOf } from '../../../src/domain/ids'
import type { DraftPatch, PatchWhy, TermRefInput, TopicDraftInput } from '../../../src/domain/input'
import { RECORD_LIMITS, RECORD_NORMS } from '../../../src/domain/limits'
import { applyPatches, type PatchResult } from '../../../src/domain/patch'
import { applyPack, resolveTermRef, termFormsOf } from '../../../src/domain/terms'
import type { TermEntry, TopicCheck } from '../../../src/domain/types'
import { checkTopic, type Problem } from '../../../src/domain/validate'
import { envOf } from '../fetch/article'
import type { ToolCallContext, VaultCore } from './core'
import { ConnectorError } from './errors'
import type { DraftRow, MaterialRow, MirrorStore, RunRow } from './store'
import { hasMark, stripMarks } from './tools/common'
import { materialForRef } from './tools/fetch'
import { recentTopics } from './tools/read'

/** 1つの回に置ける下書きの数（置き換えは数えない。目安10本＋予備3本＋置き直しの余り。設計の 1.6） */
export const DRAFTS_PER_RUN = 15
/** 1つの下書きに照合を当てられる回数（断られた分も数える） */
export const CHECKS_PER_DRAFT = 5
/** 置いてから照合済みになるまでがこれより短い下書きは「確かめが早すぎる」 */
export const EARLY_CHECK_MS = 2 * 60_000
/** 照合で外す訳の字数 */
export const REJECT_REASON_MAX = 200

/** 状態の言葉 */
export const DRAFT_STATUS_TEXTS = { pending: '照合待ち', verified: '照合済み', rejected: '照合で外した' } as const

// ---------- id ----------

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 下書きの id（'d:01' から。回ごとに置いた順） */
export const draftIdOf = (seq: number): string => `d:${pad2(seq)}`

/** 下書きの指し方を読む（'d:01'・'d:1'・大文字も。形が違えば null） */
export function parseDraftRef(v: unknown): string | null {
  const m = typeof v === 'string' ? /^d:(\d{1,2})$/i.exec(v.trim()) : null
  return m && Number(m[1]) >= 1 ? draftIdOf(Number(m[1])) : null
}

/** 回の下書きを引く（無ければ draft_unknown） */
export function requireDraft(store: MirrorStore, run: RunRow, ref: unknown): DraftRow {
  const id = parseDraftRef(ref)
  const row = id ? store.draft(run.runId, id) : null
  if (!row)
    throw new ConnectorError(
      'draft_unknown',
      `この回に下書き「${typeof ref === 'string' ? stripMarks(ref).slice(0, 20) : ''}」はありません（topic_list_drafts で id を確かめてください）。`,
    )
  return row
}

export const inputOf = (row: DraftRow): TopicDraftInput => JSON.parse(row.input) as TopicDraftInput

// ---------- 締め切り ----------

/** 照合の打ち切りの後か（置く・照合は断る） */
export function pastVerifyBy(run: RunRow, now: number): boolean {
  return run.checkerMs !== null && now >= run.checkerMs
}

/** 書く係の締め切りの後か（置くが知らせる） */
export function pastWriteBy(run: RunRow, now: number): boolean {
  return run.writerMs !== null && now >= run.writerMs
}

const DEADLINE_REFUSAL =
  '照合の打ち切りを過ぎました（何も置いていません）。照合の済んだ下書きで版を出すか（topic_add_topics → topic_add_edition）、作れなかった印を足してください（topic_add_edition_fail）。'

// ---------- 資料の控え ----------

/** 控えを組み立ての形に（この回で読んだか・本文の字数。出典にできるかは assembleTopic が決める） */
export function sourceMaterialOf(m: MaterialRow): SourceMaterial {
  return {
    url: m.url,
    title: m.title,
    published: m.published,
    publishedNote: m.publishedNote,
    bodyChars: m.bodyChars,
    read: m.readAt !== null,
    author: m.author,
    via: m.via,
  }
}

/** 下書きの出典の控え（ref の順。引けない ref は飛ばす） */
export function draftMaterials(core: VaultCore, run: RunRow, input: TopicDraftInput): { ref: string; m: MaterialRow }[] {
  const sources = envOf(core).sources
  const out: { ref: string; m: MaterialRow }[] = []
  for (const s of Array.isArray(input.sources) ? input.sources : []) {
    const ref = typeof s?.ref === 'string' ? s.ref.trim() : ''
    const m = ref ? materialForRef(core.store, run.runId, ref, sources) : null
    if (m) out.push({ ref, m })
  }
  return out
}

// ---------- 同じ回の語（run_terms） ----------

export interface RunTerm {
  entry: TermEntry
  /** 持ち主の下書き */
  draft: string
}

/** 回の語（termId → 語と持ち主） */
export function runTermMap(store: MirrorStore, runId: string): Map<string, RunTerm> {
  return new Map(store.runTerms(runId).map((r) => [r.entry.termId, r]))
}

const sameEntry = (a: TermEntry, b: TermEntry): boolean =>
  stableStringify({ ...a, retired: a.retired === true }) === stableStringify({ ...b, retired: b.retired === true })

/** 指し方に添えた表記（入力の term。説明を新しくする指し方に添えた物も） */
const surfaceOf = (ref: TermRefInput): string | undefined => {
  const t = (ref as { term?: unknown }).term
  return typeof t === 'string' && t.trim() ? t : undefined
}

/** その語の表記か別名なら、表記を添えた辞書の語の指し方（違えば表記を添えない） */
function plainRef(termId: string, surface: string | undefined, entry: TermEntry): TermRefInput {
  return surface !== undefined && termFormsOf(entry).includes(normalizeIdText(surface)) ? { termId, term: surface } : { termId }
}

/** 指し方の語の id（新しい語は key から。表記だけの指し方は null） */
function termIdOfRef(ref: TermRefInput): string | null {
  if ('new' in ref) return typeof ref.new?.key === 'string' ? termIdOf(ref.new.key) : null
  if ('termId' in ref && typeof ref.termId === 'string') return ref.termId.trim()
  return null
}

/**
 * 組み立て直す前に、同じ回の語に合わせる: ほかの下書きが持ち主の語・この回の束で辞書に入った語は、自分の下書きの新しい語・新しい説明を
 * 辞書の語の指し方にする（その回の語の説明を使う。表記はその語の表記か別名の時だけ残す）
 */
export function followRunTerms(
  input: TopicDraftInput,
  draftId: string,
  runTerms: ReadonlyMap<string, RunTerm>,
  committed: (termId: string) => TermEntry | null,
): TopicDraftInput {
  if (!Array.isArray(input.terms)) return input
  const terms = input.terms.map((ref): TermRefInput => {
    if (!ref || typeof ref !== 'object') return ref
    // 表記だけの指し方・辞書の語の指し方は、組み立てで辞書と同じ回の語から解く（照合の前に pinTermIds が termId に固める）
    const t = termIdOfRef(ref)
    if (t === null || (!('new' in ref) && !('revise' in ref))) return ref
    const r = runTerms.get(t)
    if (!r) return ref
    const c = committed(t)
    const packed = c !== null && sameEntry(c, r.entry)
    if (r.draft === draftId && !packed) return ref
    // この話題での表記（照合で持ち主が移った新しい語の上の段の term も）を先に使う
    return plainRef(t, surfaceOf(ref) ?? ('new' in ref ? ref.new.term : undefined), r.entry)
  })
  return { ...input, terms }
}

/** 照合の前に、表記だけの指し方を termId に固める（説明を直す時に表記を覚えておけるように） */
export function pinTermIds(input: TopicDraftInput, effective: ReadonlyMap<string, TermEntry>): TopicDraftInput {
  if (!Array.isArray(input.terms)) return input
  return {
    ...input,
    terms: input.terms.map((ref) => {
      if (!ref || typeof ref !== 'object' || 'new' in ref || 'termId' in ref) return ref
      const r = resolveTermRef(ref, effective)
      return r.ok ? { termId: r.entry.termId, term: ref.term } : ref
    }),
  }
}

/** 照合で説明を新しくする指し方に替わった語に、直す前の表記を添える（B1 の open「照合で辞書の語の表記が落ちる」） */
export function keepSurfaces(before: TopicDraftInput, after: TopicDraftInput): TopicDraftInput {
  const surfaces = new Map<string, string>()
  for (const ref of before.terms ?? []) {
    if (!ref || typeof ref !== 'object' || 'new' in ref || 'revise' in ref) continue
    const s = surfaceOf(ref)
    if (s !== undefined && 'termId' in ref && typeof ref.termId === 'string') surfaces.set(ref.termId.trim(), s)
  }
  if (!surfaces.size) return after
  return {
    ...after,
    terms: after.terms.map((ref) =>
      ref && typeof ref === 'object' && 'revise' in ref && surfaceOf(ref) === undefined && surfaces.has(ref.termId)
        ? ({ ...ref, term: surfaces.get(ref.termId) } as TermRefInput)
        : ref,
    ),
  }
}

/**
 * 照合で、同じ回で足すだけの語（辞書に無い語）の説明を直した時: 説明を新しくする指し方を、新しい語の指し方にする（持ち主を移す）。
 * key・表記はその回の語のまま
 */
export function reviseToNew(
  input: TopicDraftInput,
  runTerms: ReadonlyMap<string, RunTerm>,
  committed: (termId: string) => TermEntry | null,
): TopicDraftInput {
  return {
    ...input,
    terms: input.terms.map((ref): TermRefInput => {
      if (!ref || typeof ref !== 'object' || !('revise' in ref) || committed(ref.termId)) return ref
      const r = runTerms.get(ref.termId)
      if (!r) return ref
      const s = surfaceOf(ref)
      const next = {
        new: {
          key: r.entry.key,
          term: r.entry.term,
          aliases: ref.revise.aliases !== undefined ? [...ref.revise.aliases] : [...r.entry.aliases],
          explanation: ref.revise.explanation,
          asOf: ref.revise.asOf,
        },
      }
      return (s !== undefined ? { ...next, term: s } : next) as TermRefInput
    }),
  }
}

/** 入力の新しい語・新しい説明の termId */
export function ownTermIds(input: TopicDraftInput): Set<string> {
  const out = new Set<string>()
  for (const ref of input.terms ?? []) {
    if (!ref || typeof ref !== 'object' || (!('new' in ref) && !('revise' in ref))) continue
    const t = termIdOfRef(ref)
    if (t) out.add(t)
  }
  return out
}

/** 入力が使う語の termId（表記だけの指し方は、回の語の表記に当たる物） */
function usedTermIds(input: TopicDraftInput, runTerms: ReadonlyMap<string, RunTerm>): Set<string> {
  const out = new Set<string>()
  for (const ref of input.terms ?? []) {
    if (!ref || typeof ref !== 'object') continue
    const t = termIdOfRef(ref)
    if (t) {
      out.add(t)
      continue
    }
    const s = surfaceOf(ref)
    if (s === undefined) continue
    for (const r of runTerms.values()) if (termFormsOf(r.entry).includes(normalizeIdText(s))) out.add(r.entry.termId)
  }
  return out
}

/**
 * 回の語の持ち主を決め直す（置いた・照合を当てた・外した後）: entries をこの下書きの語にする（overwrite = false なら、ほかの下書きが
 * 持ち主の語はそのまま）。この下書きが持ち主で entries に無い語は、ほかの下書き（外した物を除く）が使っていなければ消す
 */
export function claimRunTerms(
  store: MirrorStore,
  runId: string,
  draftId: string,
  entries: readonly TermEntry[],
  overwrite: boolean,
): void {
  const map = runTermMap(store, runId)
  const keep = new Set<string>()
  for (const e of entries) {
    keep.add(e.termId)
    const cur = map.get(e.termId)
    if (cur && cur.draft !== draftId && !overwrite) continue
    if (cur && cur.draft === draftId && sameEntry(cur.entry, e)) continue
    store.putRunTerm(runId, e, draftId)
  }
  const others = store.drafts(runId).filter((d) => d.draftId !== draftId && d.status !== 'rejected')
  for (const [t, r] of map) {
    if (r.draft !== draftId || keep.has(t)) continue
    const used = others.some((d) => usedTermIds(inputOf(d), map).has(t))
    if (!used) store.deleteRunTerm(runId, t)
  }
}

// ---------- 組み立て ----------

export interface DraftBuild {
  /** 組み立てに使った入力（同じ回の語に合わせた後） */
  input: TopicDraftInput
  result: AssembleResult
  /** 同じ回のほかの下書きの語（組み立てに重ねた物） */
  runEntries: TermEntry[]
  /** 辞書の今の形に同じ回の語を重ねた部分の辞書（表示・照合の語を引く） */
  effective: Map<string, TermEntry>
}

export interface BuildOptions {
  now: number
  /** 同じ回の語に合わせる（照合・読む・足す時。置く時は合わせない: ほかの下書きと違う説明は断る） */
  follow: boolean
  /** 照合で持ち主を移す語（ほかの下書きの語を重ねない） */
  takeover?: ReadonlySet<string>
  check?: TopicCheck | null
  /** 足す時の順位 */
  rank?: number
  /** 記録の model（書いた係） */
  model: string
}

/** 下書きの入力を組み立てる（記録の形と、断る物・知らせる物） */
export function buildDraft(
  core: VaultCore,
  run: RunRow,
  draftId: string,
  input: TopicDraftInput,
  opts: BuildOptions,
): DraftBuild {
  const runTerms = runTermMap(core.store, run.runId)
  const committed = (t: string) => core.dictionary.get(t)
  const followed = opts.follow ? followRunTerms(input, draftId, runTerms, committed) : input
  // 重ねない語: この入力が新しい語・新しい説明として作り直す自分の語（前の説明と取り合わないように）と、照合で持ち主を移す語
  const own = ownTermIds(followed)
  const runEntries = [...runTerms.values()]
    .filter((r) => !(r.draft === draftId && own.has(r.entry.termId)) && !opts.takeover?.has(r.entry.termId))
    .map((r) => r.entry)
  const dict = core.dictionary.forInput(followed, runEntries)
  const effective = applyPack(dict, runEntries)
  const used = opts.rank !== undefined ? { ...followed, rank: opts.rank } : followed
  const sources = envOf(core).sources
  const recent = recentTopics(core, opts.now).flatMap((g) => g.topics.map((t) => ({ id: t.id, threadId: t.threadId })))
  const result = assembleTopic(used, {
    editionId: run.editionId ?? '',
    runId: run.runId,
    model: opts.model,
    createdAt: opts.now,
    check: opts.check ?? null,
    dict,
    runEntries,
    known: core.mirror.known(),
    recentTopics: recent,
    material: (ref) => {
      const m = materialForRef(core.store, run.runId, ref, sources)
      return m ? sourceMaterialOf(m) : null
    },
    outlets: core.outlets,
  })
  return { input: used, result: applySurfaces(result, used, core), runEntries, effective }
}

/**
 * 説明を新しくする指し方・新しい語の指し方に添えた表記（keepSurfaces）を、組み立てた話題の表記に戻す（その語の表記か別名の時だけ）。
 * 表記を替えたら id を作り直し（続報でなければ threadId も）、確かめ直す
 */
function applySurfaces(result: AssembleResult, input: TopicDraftInput, core: VaultCore): AssembleResult {
  const topic = result.topic
  if (!topic) return result
  let changed = false
  for (const ref of input.terms ?? []) {
    if (!ref || typeof ref !== 'object' || (!('revise' in ref) && !('new' in ref))) continue
    const s = surfaceOf(ref)
    const t = termIdOfRef(ref)
    if (s === undefined || t === null) continue
    const term = topic.terms.find((x) => x.termId === t)
    const entry = result.termEntries.find((e) => e.termId === t)
    if (!term || !entry || term.term === s.trim() || !termFormsOf(entry).includes(normalizeIdText(s))) continue
    term.term = s.trim()
    changed = true
  }
  if (!changed) return result
  const oldId = topic.id
  topic.id = topicIdOf(topic)
  if (topic.threadId === oldId) topic.threadId = topic.id
  const checked = checkTopic(topic, { outlets: core.outlets })
  if (!checked.errors.length) return result
  return { ...result, topic: null, errors: [...result.errors, ...checked.errors] }
}

// ---------- 置く（topic_save_draft） ----------

/** 資料の印の文字列を含む欄の道（入力の全部の文字の欄） */
export function markedPaths(v: unknown, path = ''): string[] {
  if (typeof v === 'string') return hasMark(v) ? [path || 'topic'] : []
  if (Array.isArray(v)) return v.flatMap((x, i) => markedPaths(x, path ? `${path}.${i}` : String(i)))
  if (v && typeof v === 'object')
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
      markedPaths(x, path ? `${path}.${k}` : k).concat(hasMark(k) ? [path ? `${path}.${k}` : k] : []),
    )
  return []
}

export type SaveOutcome =
  | { kind: 'refused'; errors: Problem[] }
  | { kind: 'saved' | 'same'; row: DraftRow; build: DraftBuild | null; late: boolean; replaced: boolean }

/** 回の数え（知らせる物の数など）を n にそろえる */
function setRunCount(store: MirrorStore, runId: string, key: string, n: number): void {
  const cur = store.runCount(runId, key)
  if (cur !== n) store.addRunCount(runId, key, n - cur)
}

/** 下書きを置く（断る時は投げるか refused。同じ中身なら same） */
export function saveDraft(
  core: VaultCore,
  ctx: ToolCallContext,
  run: RunRow,
  args: { model: string; topic: unknown; replace?: unknown },
): SaveOutcome {
  const now = ctx.now
  const store = core.store
  if (pastVerifyBy(run, now)) throw new ConnectorError('draft_deadline', DEADLINE_REFUSAL)
  const topic = args.topic
  if (!topic || typeof topic !== 'object' || Array.isArray(topic))
    throw new ConnectorError('invalid', 'topic に下書き（話題の入力の形）を渡してください。')
  const marked = markedPaths(topic)
  if (marked.length)
    return {
      kind: 'refused',
      errors: marked.map((path) => ({
        path,
        code: 'mark',
        message: '資料の印の文字列（<<< か >>>）は使えません（この欄を直してください）',
      })),
    }
  const input = topic as TopicDraftInput
  const late = pastWriteBy(run, now)
  const target = args.replace !== undefined ? requireDraft(store, run, args.replace) : null
  if (target && target.status !== 'pending')
    throw new ConnectorError(
      'draft_state',
      `${target.draftId} は${DRAFT_STATUS_TEXTS[target.status]}です。照合の後の下書きは置き換えられません（新しい下書きとして置いてください）。`,
    )
  // 同じ中身の送り直しは同じ下書き（照合で外した物は除く）
  const key = stableStringify(input)
  const drafts = store.drafts(run.runId)
  const same = (target ? [target] : drafts).find((d) => d.status !== 'rejected' && stableStringify(inputOf(d)) === key)
  if (same) return { kind: 'same', row: same, build: null, late, replaced: false }
  if (!target && drafts.length >= DRAFTS_PER_RUN)
    throw new ConnectorError(
      'draft_limit',
      `1つの回に置ける下書きは${DRAFTS_PER_RUN}本までです（置き換えは replace で。数えません）。照合の済んだ下書きで版を作ってください。`,
    )
  const draftId = target?.draftId ?? draftIdOf(drafts.reduce((n, d) => Math.max(n, d.seq), 0) + 1)
  const build = buildDraft(core, run, draftId, input, { now, follow: false, model: args.model })
  if (build.result.errors.length) return { kind: 'refused', errors: build.result.errors }
  const row: DraftRow = {
    runId: run.runId,
    draftId,
    seq: target?.seq ?? Number(draftId.slice(2)),
    rank: typeof input.rank === 'number' ? input.rank : 0,
    model: args.model,
    input: JSON.stringify(input),
    status: 'pending',
    rejectReason: null,
    // created は初めに置いた時刻（表は置き換えで created を替えない）。updated は今の中身を置いた時刻で、照合済みになるまでは置く・置き換える
    // 時だけ進める（読む・断られた照合では進めない）。「確かめが早すぎる」は updated から数える（置き換えた中身を、置き換えてすぐ照合済みに
    // できないように。点検2 guard-G2-10）
    created: target?.created ?? now,
    updated: now,
    // 置き換えた下書きは、照合の前にもう一度読む
    readAt: null,
    verifiedAt: null,
    checks: target?.checks ?? 0,
    claims: null,
    fixed: null,
    checkModel: null,
    topicId: null,
  }
  store.transaction(() => {
    store.putDraft(row)
    claimRunTerms(store, run.runId, draftId, build.result.termEntries, false)
    setRunCount(store, run.runId, `warn:${draftId}`, build.result.warnings.length)
  })
  return { kind: 'saved', row, build, late, replaced: target !== null }
}

// ---------- 読む（topic_get_draft） ----------

/** 読んだ時刻を覚える（初めて読んだ時だけ。読む前の照合は断る） */
export function markDraftRead(store: MirrorStore, row: DraftRow, now: number): DraftRow {
  if (row.readAt !== null) return row
  const next = { ...row, readAt: now }
  store.putDraft(next)
  return next
}

// ---------- 照合（topic_check_draft） ----------

export type CheckOutcome =
  | { kind: 'refused'; errors: Problem[]; dropped?: PatchResult['droppedEmphasis'] }
  | { kind: 'rejected'; row: DraftRow }
  | {
      kind: 'verified'
      row: DraftRow
      build: DraftBuild
      patch: PatchResult
      /** 置いてから2分未満で照合済みになった */
      early: boolean
    }

/** 照合の結果を当てる */
export function checkDraft(
  core: VaultCore,
  ctx: ToolCallContext,
  run: RunRow,
  args: { draft: unknown; model: string; claims: number; patches: readonly DraftPatch[]; reject?: string },
): CheckOutcome {
  const now = ctx.now
  const store = core.store
  if (pastVerifyBy(run, now)) throw new ConnectorError('draft_deadline', DEADLINE_REFUSAL)
  const row = requireDraft(store, run, args.draft)
  if (row.status !== 'pending')
    throw new ConnectorError(
      'draft_state',
      `${row.draftId} は${DRAFT_STATUS_TEXTS[row.status]}です（照合は1つの下書きに1度だけ当てます）。`,
    )
  if (row.readAt === null)
    throw new ConnectorError(
      'draft_unread',
      `先に topic_get_draft で ${row.draftId} を読んでください（読む前の照合は断ります。置き換えた下書きも読み直します）。`,
    )
  if (row.checks >= CHECKS_PER_DRAFT)
    throw new ConnectorError(
      'draft_limit',
      `${row.draftId} の照合は${CHECKS_PER_DRAFT}回までです。直せない時は reject（版に入れない訳）で外してください。`,
    )
  const claims = Math.max(0, Math.min(RECORD_LIMITS.topic.checkClaims, Math.floor(args.claims)))
  // 断られた照合も回数に数える（updated は今の中身を置いた時刻のまま。照合済み・外した時に進める）
  const counted: DraftRow = { ...row, checks: row.checks + 1 }
  store.putDraft(counted)

  if (typeof args.reject === 'string' && args.reject.trim()) {
    const reason = Array.from(stripMarks(args.reject.replace(/\s+/g, ' ').trim()))
      .slice(0, REJECT_REASON_MAX)
      .join('')
    const rejected: DraftRow = {
      ...counted,
      status: 'rejected',
      rejectReason: reason,
      claims,
      checkModel: args.model,
      updated: now,
    }
    store.transaction(() => {
      store.putDraft(rejected)
      claimRunTerms(store, run.runId, row.draftId, [], false)
      store.addRunCount(run.runId, 'rejected')
    })
    return { kind: 'rejected', row: rejected }
  }

  const runTerms = runTermMap(store, run.runId)
  const committed = (t: string) => core.dictionary.get(t)
  const stored = inputOf(row)
  const allEntries = [...runTerms.values()].map((r) => r.entry)
  const effective = applyPack(core.dictionary.forInput(stored, allEntries), allEntries)
  const base = pinTermIds(followRunTerms(stored, row.draftId, runTerms, committed), effective)
  const termEntry = (ref: TermRefInput): TermEntry | null => {
    const r = resolveTermRef(ref as { termId?: string; term?: string }, effective)
    return r.ok ? r.entry : null
  }
  const patch = applyPatches(base, args.patches, { termEntry })
  if (!patch.ok) return { kind: 'refused', errors: patch.errors }
  // 直した文にも資料の印の文字列を入れない（置く時と同じ。下書きを読む時に囲いを偽られないように）
  const marked = markedPaths(patch.input)
  if (marked.length)
    return {
      kind: 'refused',
      errors: marked.map((path) => ({ path, code: 'mark', message: '資料の印の文字列（<<< か >>>）は使えません' })),
    }
  if (patch.fixed > claims)
    return {
      kind: 'refused',
      errors: [
        {
          path: 'claims',
          code: 'claims',
          message: `claims（照合した主張の件数）は、直した数（${patch.fixed}）より少なくできません`,
        },
      ],
    }
  const patched = reviseToNew(keepSurfaces(base, patch.input), runTerms, committed)
  const takeover = new Set([...ownTermIds(patched)].filter((t) => runTerms.has(t) && runTerms.get(t)!.draft !== row.draftId))
  const check: TopicCheck = { claims, fixed: patch.fixed, model: args.model }
  const build = buildDraft(core, run, row.draftId, patched, { now, follow: false, takeover, check, model: row.model })
  if (build.result.errors.length) return { kind: 'refused', errors: build.result.errors, dropped: patch.droppedEmphasis }
  // 今の中身を置いて（置き換えて）から数える
  const early = now - row.updated < EARLY_CHECK_MS
  const verified: DraftRow = {
    ...counted,
    updated: now,
    input: JSON.stringify(patched),
    status: 'verified',
    claims,
    fixed: patch.fixed,
    checkModel: args.model,
    verifiedAt: now,
  }
  store.transaction(() => {
    store.putDraft(verified)
    claimRunTerms(store, run.runId, row.draftId, build.result.termEntries, true)
    setRunCount(store, run.runId, `warn:${row.draftId}`, build.result.warnings.length)
    for (const [w, n] of Object.entries(patch.why) as [PatchWhy, number][]) store.addRunCount(run.runId, `why:${w}`, n)
    store.addRunCount(run.runId, 'claims', claims)
    store.addRunCount(run.runId, 'fixed', patch.fixed)
    if (early) store.addRunCount(run.runId, 'early')
  })
  return { kind: 'verified', row: verified, build, patch, early }
}

// ---------- 数え ----------

/** 照合済みの数と、数の門（RECORD_NORMS.editionGate）まであと何本か */
export function verifiedCount(store: MirrorStore, runId: string): { verified: number; left: number } {
  const verified = store.drafts(runId).filter((d) => d.status === 'verified').length
  return { verified, left: Math.max(0, RECORD_NORMS.editionGate - verified) }
}

/** 断る物・知らせる物の行（欄の道と訳） */
export function problemLines(problems: readonly Problem[], max = 40): string[] {
  const lines = problems.slice(0, max).map((p) => `- ${p.path}: ${p.message}`)
  if (problems.length > max) lines.push(`- ほか ${problems.length - max}件`)
  return lines
}
