// 読み取りの確かめ（表示用の写しを作る。docs/SPEC.md の 7.1・7.8 の「版と話題を受け取る」）。受け取った記録は端末に受け取ったまま入れ
// （知らない値・知らない欄も）、画面にはここで直した写しを渡す。受け取った記録は変えない・書き戻さない（コネクタの記録はアプリが書き戻さない。
// アプリの記録（知ってる・既読）を直す時も、写しではなく端末の記録に重ねる。src/domain/known.ts）。
// - 知らない欄は写しにも残す（後の版のアプリが足した欄を壊さない。DS の形3）。知らない決まった値（genre: 'novel' など）も残し、画面の言葉は
//   src/domain/fixedTexts.ts の関数が決める（総合にだけ出す・ラベルを出さない など）。形の分からない値は、決まった空の値にする
// - 記録の v が 1 より大きい物は、中身を読まずに「新しい形の記録」（kind: 'newer'）として返す（画面は「新しい形の記録（アプリを更新して
//   ください）」と出す。書き戻さない。NS の「新しいコネクタの記録」と同じ考え）
// - 強調は src/domain/emphasis.ts の repairEmphasis で、合わない語句・鍵を写しから捨てる。鍵の番号は受け取った記録の並びの番号で解き、
//   壊れた当事者・経緯の行を出さない時は、写しの並びの番号に付け替える（語句が付く要素は変わらない。番号を詰めて別の要素に付けない）
// - 出典の URL は、社か読んだ所の決まったホストの https: の物だけを link にする（ほかは文として出す。src/domain/outlets.ts）
// DS・NS の src/domain/repair.ts の作り（小さな関数・知らない項目を残す）を写し、表の直しは TS の表で書き直した。
import { parseEmphasisKey, repairEmphasis } from './emphasis'
import { editionIdOfRecordId, parseEditionId, TOPIC_ID_RE } from './ids'
import { isJstDateTime, isPublishedAt, isTimelineWhen, isYm, isYmd } from './jst'
import { DEFAULT_OUTLETS, sourceLinkUrl, type OutletDirectory } from './outlets'
import type {
  Emphasis,
  FollowUp,
  NoneView,
  NotChosen,
  OpposedView,
  SoWhat,
  Source,
  TimelineEntry,
  TopicCheck,
  TopicTerm,
} from './types'

/** 直した結果: 読めた（写し）・新しい形の記録（v > 1）・形が分からない（オブジェクトでない・id が無い） */
export type RepairOutcome<T> = { kind: 'ok'; value: T } | { kind: 'newer'; id: string; v: number } | { kind: 'broken' }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const uniqueStrings = (v: unknown): string[] => [...new Set(strings(v))]

/** 記録の形の版（無い・数でない時は 1） */
const versionOf = (r: Obj): number => num(r.v, 1)

/** 共通の入口: オブジェクトで id があり、v が 1 以下の物だけを直す */
function open<T>(raw: unknown, repair: (r: Obj, id: string) => T | null): RepairOutcome<T> {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) return { kind: 'broken' }
  const v = versionOf(raw)
  if (v > 1) return { kind: 'newer', id: raw.id, v }
  const value = repair(raw, raw.id)
  return value === null ? { kind: 'broken' } : { kind: 'ok', value }
}

/** コネクタの記録に共通の欄の写し（知らない ai も残し、画面は「AI」と出す） */
export interface ShownConnectorBase {
  id: string
  v: number
  createdAt: number
  by: string
  ai: string
  model: string
  runId: string
}

function connectorBase(r: Obj, id: string): ShownConnectorBase {
  return {
    id,
    v: versionOf(r),
    createdAt: num(r.createdAt),
    by: str(r.by),
    ai: str(r.ai),
    model: str(r.model),
    runId: str(r.runId),
  }
}

/** 版の id（欄が壊れていれば、記録の id の頭から） */
const editionIdFrom = (r: Obj, id: string): string =>
  parseEditionId(r.editionId) ? (r.editionId as string) : (editionIdOfRecordId(id) ?? str(r.editionId))

// ---------- 話題 ----------

/** 当事者の写し（立場は知らない値も残す。画面は「不明」と同じに出す） */
export interface ShownStakeholder {
  name: string
  stance: string
  stanceNote: string | null
  claim: string | null
  reason: string | null
}

/** 出典の写し（link = 画面でリンクにする URL。決まったホストでない URL は null で、文として出す） */
export interface ShownSource extends Source {
  link: string | null
}

/** 話題の写し（画面に渡す物。知らない欄も残っている） */
export interface ShownTopic extends ShownConnectorBase {
  editionId: string
  threadId: string
  rank: number
  rankReason: string
  /** 知らない値も残す（国内・世界のどちらにも並べず、総合にだけ出す） */
  region: string
  /** 知らない値も残す（総合にだけ出す） */
  genre: string
  major: boolean
  headline: string
  summary: string
  /** label は知らない値も残す（ラベルを出さない） */
  conclusion: { label: string; note: string; breaking: boolean }
  soWhat: SoWhat
  stakeholders: ShownStakeholder[]
  /** null = 見解の所を出さない（知らない kind・形の分からない値） */
  view: OpposedView | NoneView | null
  timeline: TimelineEntry[]
  followUp: FollowUp | null
  terms: TopicTerm[]
  sources: ShownSource[]
  outletNames: string[]
  unverified: string[]
  check: TopicCheck | null
  /** 表示に使う強調（合わない語句・鍵を捨てた物。番号は写しの並びの番号） */
  emphasis: Emphasis
}

export interface TopicRepairOptions {
  /** 社の名前の一覧（作り物の版では作り物の一覧） */
  outlets?: OutletDirectory
}

function repairView(v: unknown): OpposedView | NoneView | null {
  if (!isObj(v)) return null
  if (v.kind === 'opposed')
    return {
      ...v,
      kind: 'opposed',
      axis: str(v.axis),
      issue: strOrNull(v.issue),
      aiView: str(v.aiView),
      counterView: str(v.counterView),
    }
  if (v.kind === 'none') return { ...v, kind: 'none', noneReason: strOrNull(v.noneReason) }
  return null
}

/**
 * 並びを直す（壊れた要素は出さない）。map は受け取った記録の番号 → 写しの番号（強調の鍵を付け替える）
 */
function repairList<T>(list: unknown, repair: (el: Obj) => T | null): { items: T[]; map: Map<number, number> } {
  const items: T[] = []
  const map = new Map<number, number>()
  if (!Array.isArray(list)) return { items, map }
  list.forEach((el, i) => {
    const v = isObj(el) ? repair(el) : null
    if (v === null) return
    map.set(i, items.length)
    items.push(v)
  })
  return { items, map }
}

/** 話題の表示用の写し */
export function repairTopic(raw: unknown, opts: TopicRepairOptions = {}): RepairOutcome<ShownTopic> {
  const dir = opts.outlets ?? DEFAULT_OUTLETS
  return open(raw, (r, id) => {
    const conclusion = isObj(r.conclusion) ? r.conclusion : {}
    const soWhat = isObj(r.soWhat) ? r.soWhat : {}
    const stakeholders = repairList(r.stakeholders, (s) =>
      typeof s.name === 'string'
        ? {
            ...s,
            name: s.name,
            stance: str(s.stance),
            stanceNote: strOrNull(s.stanceNote),
            claim: strOrNull(s.claim),
            reason: strOrNull(s.reason),
          }
        : null,
    )
    const timeline = repairList(r.timeline, (e) =>
      typeof e.text === 'string' ? { ...e, when: isTimelineWhen(e.when) ? e.when : null, text: e.text } : null,
    )
    const terms = repairList(r.terms, (t) =>
      typeof t.term === 'string' && typeof t.explanation === 'string'
        ? {
            ...t,
            termId: str(t.termId),
            term: t.term,
            aliases: strings(t.aliases),
            explanation: t.explanation,
            asOf: isYm(t.asOf) ? t.asOf : null,
          }
        : null,
    )
    const sources = repairList(r.sources, (s) => {
      if (typeof s.outlet !== 'string' || typeof s.title !== 'string') return null
      const source: Source = {
        ...s,
        outlet: s.outlet,
        title: s.title,
        url: str(s.url),
        publishedAt: isPublishedAt(s.publishedAt) ? s.publishedAt : null,
        publishedNote: strOrNull(s.publishedNote),
        via: strOrNull(s.via),
      }
      return { ...source, link: sourceLinkUrl(source, dir) }
    })
    const followUp =
      isObj(r.followUp) && typeof r.followUp.whatsNew === 'string'
        ? { ...r.followUp, prevTopicId: str(r.followUp.prevTopicId), whatsNew: r.followUp.whatsNew }
        : null
    const check = isObj(r.check)
      ? { ...r.check, claims: num(r.check.claims), fixed: num(r.check.fixed), model: strOrNull(r.check.model) }
      : null
    const shown: ShownTopic = {
      ...r,
      ...connectorBase(r, id),
      editionId: editionIdFrom(r, id),
      threadId: typeof r.threadId === 'string' && TOPIC_ID_RE.test(r.threadId) ? r.threadId : id,
      rank: num(r.rank),
      rankReason: str(r.rankReason),
      region: str(r.region),
      genre: str(r.genre),
      major: r.major === true,
      headline: str(r.headline),
      summary: str(r.summary),
      conclusion: {
        ...conclusion,
        label: str(conclusion.label),
        note: str(conclusion.note),
        breaking: conclusion.breaking === true,
      },
      soWhat: {
        ...soWhat,
        life: strOrNull(soWhat.life),
        system: strOrNull(soWhat.system),
        world: strOrNull(soWhat.world),
        whyNews: strOrNull(soWhat.whyNews),
      },
      stakeholders: stakeholders.items,
      view: repairView(r.view),
      timeline: timeline.items,
      followUp,
      terms: terms.items,
      sources: sources.items,
      outletNames: strings(r.outletNames),
      unverified: strings(r.unverified),
      check,
      emphasis: {},
    }
    // 強調は受け取った記録の番号で解き、写しの番号に付け替える（文は受け取った記録と写しで同じなので、語句の所も同じ）
    for (const [key, phrases] of Object.entries(repairEmphasis(r))) {
      const k = parseEmphasisKey(key)
      if (!k) continue
      if (k.path === 'stakeholders.{i}.claim' || k.path === 'timeline.{i}.text') {
        const j = (k.path === 'stakeholders.{i}.claim' ? stakeholders : timeline).map.get(k.index ?? -1)
        if (j !== undefined) shown.emphasis[k.path.replace('{i}', String(j))] = phrases
      } else shown.emphasis[key] = phrases
    }
    return shown
  })
}

// ---------- 版・作れなかった印・訂正 ----------

/** 版の写し（slot は知らない値も残す。画面は版として出さない） */
export interface ShownEdition extends ShownConnectorBase {
  date: string
  slot: string
  order: string[]
  candidateCount: number | null
  notChosen: NotChosen[]
  window: { since: string; until: string } | null
  usage: { tokens?: number; toolCalls?: number; minutes?: number } | null
}

/** 版の表示用の写し（date・slot が壊れていれば、id から） */
export function repairEdition(raw: unknown): RepairOutcome<ShownEdition> {
  return open(raw, (r, id) => {
    const fromId = parseEditionId(id)
    const collected =
      isObj(r.window) && isJstDateTime(r.window.since) && isJstDateTime(r.window.until)
        ? { ...r.window, since: r.window.since, until: r.window.until }
        : null
    let usage: ShownEdition['usage'] = null
    if (isObj(r.usage)) {
      usage = { ...r.usage }
      for (const k of ['tokens', 'toolCalls', 'minutes'] as const) {
        const v = numOrNull(r.usage[k])
        if (v === null) delete usage[k]
        else usage[k] = v
      }
    }
    return {
      ...r,
      ...connectorBase(r, id),
      date: isYmd(r.date) ? r.date : (fromId?.date ?? ''),
      slot: typeof r.slot === 'string' ? r.slot : (fromId?.slot ?? ''),
      order: uniqueStrings(r.order),
      candidateCount: numOrNull(r.candidateCount),
      notChosen: repairList(r.notChosen, (n) => ({ ...n, headline: str(n.headline), whyNot: str(n.whyNot) })).items,
      window: collected,
      usage,
    }
  })
}

/** 作れなかった印の写し（reasonKind は知らない値も残す。画面は「そのほか」と出す） */
export interface ShownEditionFail extends ShownConnectorBase {
  editionId: string
  reasonKind: string
  reason: string
}

export function repairEditionFail(raw: unknown): RepairOutcome<ShownEditionFail> {
  return open(raw, (r, id) => ({
    ...r,
    ...connectorBase(r, id),
    editionId: editionIdFrom(r, id),
    reasonKind: str(r.reasonKind),
    reason: str(r.reason),
  }))
}

/** 訂正の写し */
export interface ShownCorrection extends ShownConnectorBase {
  topicId: string
  editionId: string
  text: string
}

/** 訂正の表示用の写し（付ける話題が分からない訂正は出さない） */
export function repairCorrection(raw: unknown): RepairOutcome<ShownCorrection> {
  return open(raw, (r, id) => {
    const topicId =
      typeof r.topicId === 'string' && TOPIC_ID_RE.test(r.topicId)
        ? r.topicId
        : TOPIC_ID_RE.test(id.slice(0, -9))
          ? id.slice(0, -9)
          : null
    if (topicId === null || typeof r.text !== 'string') return null
    return { ...r, ...connectorBase(r, id), topicId, editionId: topicId.slice(0, 13), text: r.text }
  })
}

// ---------- アプリの記録（知ってる・既読） ----------

/** アプリの記録に共通の欄の写し */
export interface ShownUserBase {
  id: string
  v: number
  createdAt: number
  updatedAt: number
  by: string
  ai: string | null
}

function userBase(r: Obj, id: string): ShownUserBase {
  const createdAt = num(r.createdAt)
  return { id, v: versionOf(r), createdAt, updatedAt: num(r.updatedAt, createdAt), by: str(r.by), ai: strOrNull(r.ai) }
}

export interface ShownKnownTerm extends ShownUserBase {
  term: string
  asOf: string | null
  on: boolean
}

/** 知ってるの表示用の写し（判定は src/domain/known.ts の isKnownTerm） */
export function repairKnownTerm(raw: unknown): RepairOutcome<ShownKnownTerm> {
  return open(raw, (r, id) => ({
    ...r,
    ...userBase(r, id),
    term: str(r.term),
    asOf: isYm(r.asOf) ? r.asOf : null,
    on: r.on === true,
  }))
}

export interface ShownReadMark extends ShownUserBase {
  editionId: string
  topicIds: string[]
  seen: boolean
}

/** 既読の表示用の写し（読んだ話題は重なりを除く） */
export function repairReadMark(raw: unknown): RepairOutcome<ShownReadMark> {
  return open(raw, (r, id) => ({
    ...r,
    ...userBase(r, id),
    editionId: parseEditionId(r.editionId) ? (r.editionId as string) : id,
    topicIds: uniqueStrings(r.topicIds),
    seen: r.seen === true,
  }))
}
