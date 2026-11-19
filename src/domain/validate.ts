// 記録の確かめ（コネクタが送る直前。docs/SPEC.md の 7.1 の「上限の一覧と決まりの範囲」の「確かめる場所」）。
// 上限（RECORD_LIMITS）・形・決まった値・名札（id）・表どうしの決まりに合わない物は断る物（errors）、決まりの範囲（RECORD_NORMS）の外は
// 知らせる物（warnings。断らない。定期実行の報告に書く）として分けて返す（docs/SPEC.md の 16.6 の 13）。強調は src/domain/emphasis.ts。
// アプリの読み取りは、ここでは断らずに src/domain/repair.ts で表示用に直す（壊さない・書き戻さない）。
// 段階3のコネクタは、入力の形（JSON Schema）と、記録を組み立てる所でも確かめる（重ねる）。今の辞書との表記の重なり・30日の内の話題かなど、
// クラウドや DO の写しを見ないと分からない決まりは、ここでは見ない（段階3）。
import { checkEmphasis } from './emphasis'
import { stableStringify } from './equal'
import {
  correctionIdOf,
  CORRECTION_ID_RE,
  editionFailIdOf,
  editionIdOf,
  editionIdOfRecordId,
  EDITION_ID_RE,
  parseEditionId,
  READ_ID_RE,
  termIdOf,
  termPackIdOf,
  TERM_ID_RE,
  topicIdOf,
  TOPIC_ID_RE,
} from './ids'
import { isJstDateTime, isPublishedAt, isTimelineWhen, isYm, isYmd } from './jst'
import { countChars, countNonSpace, RECORD_LIMITS, RECORD_NORMS } from './limits'
import { DEFAULT_OUTLETS, isAllowedSourceUrl, type OutletDirectory } from './outlets'
import {
  CONCLUSION_LABEL_VALUES,
  GENRE_VALUES,
  isOneOf,
  REASON_KIND_VALUES,
  REGION_VALUES,
  SLOT_VALUES,
  STANCE_VALUES,
  type Edition,
  type Genre,
  type TableName,
  type TermEntry,
  type Topic,
} from './types'

/** 断る訳・知らせる訳（path は欄の道。例 'stakeholders[2].claim'・'emphasis["summary"]'） */
export interface Problem {
  path: string
  code: string
  message: string
}

export interface CheckResult {
  errors: Problem[]
  warnings: Problem[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 確かめた訳を集める */
class Collector {
  readonly errors: Problem[] = []
  readonly warnings: Problem[] = []

  err(path: string, code: string, message: string): void {
    this.errors.push({ path, code, message })
  }

  warn(path: string, code: string, message: string): void {
    this.warnings.push({ path, code, message })
  }

  /** 文字の欄（字数は countChars。nullable なら null も通す） */
  text(path: string, v: unknown, min: number, max: number, nullable = false): v is string {
    if (v === null && nullable) return false
    if (typeof v !== 'string') {
      this.err(path, 'type', `${path} は文字${nullable ? 'か null' : ''}にしてください`)
      return false
    }
    const n = countChars(v)
    if (n < min || n > max) {
      this.err(path, 'length', `${path} は ${min}〜${max}字にしてください（${n}字）`)
      return false
    }
    return true
  }

  /** 整数の欄 */
  int(path: string, v: unknown, min: number, max: number, nullable = false): void {
    if (v === null && nullable) return
    if (typeof v !== 'number' || !Number.isInteger(v))
      this.err(path, 'type', `${path} は整数${nullable ? 'か null' : ''}にしてください`)
    else if (v < min || v > max) this.err(path, 'range', `${path} は ${min}〜${max} にしてください（${v}）`)
  }

  bool(path: string, v: unknown): void {
    if (typeof v !== 'boolean') this.err(path, 'type', `${path} は true か false にしてください`)
  }

  oneOf(path: string, values: readonly string[], v: unknown): void {
    if (!isOneOf(values, v)) this.err(path, 'value', `${path} は ${values.join('・')} のどれかにしてください`)
  }

  /** 並びの欄（数の上限も見る） */
  list(path: string, v: unknown, min: number, max: number): v is unknown[] {
    if (!Array.isArray(v)) {
      this.err(path, 'type', `${path} は並びにしてください`)
      return false
    }
    if (v.length < min || v.length > max) this.err(path, 'count', `${path} は ${min}〜${max}件にしてください（${v.length}件）`)
    return true
  }

  obj(path: string, v: unknown, nullable = false): v is Obj {
    if (v === null && nullable) return false
    if (!isObj(v)) {
      this.err(path, 'type', `${path} はオブジェクト${nullable ? 'か null' : ''}にしてください`)
      return false
    }
    return true
  }

  /** 文字の並びの欄（各要素の字数も見る） */
  texts(path: string, v: unknown, minCount: number, maxCount: number, minChars: number, maxChars: number): string[] {
    if (!this.list(path, v, minCount, maxCount)) return []
    const out: string[] = []
    v.forEach((s, i) => {
      if (this.text(`${path}[${i}]`, s, minChars, maxChars)) out.push(s)
    })
    return out
  }

  /** 記録の json の長さ（docs/SPEC.md の 7.7） */
  json(table: TableName, record: unknown): void {
    const n = stableStringify(record).length
    const max = RECORD_LIMITS.json[table]
    if (n > max) this.err('', 'json', `記録の json が ${n}字です（${table} は ${max}字まで）`)
  }

  result(): CheckResult {
    return { errors: this.errors, warnings: this.warnings }
  }
}

/** 改行・URL・記法の記号を含まない、ふつうの文か（辞書の文・訂正の文。docs/SPEC.md の 7.1・7.3。4.6） */
export function isPlainText(s: string): boolean {
  if (/[\r\n\u2028\u2029]/.test(s)) return false
  if (/https?:\/\/|www\./i.test(s)) return false
  // Markdown・HTML の記法（コード・太字・取り消し線・リンク・タグ・見出し・引用）
  return !/`|\*\*|__|~~|\]\(|<\/?[a-z!]|^\s*#{1,6}\s|^\s*>/i.test(s)
}

function connectorBase(c: Collector, r: Obj): void {
  if (r.v !== 1) c.err('v', 'value', 'v は 1 にしてください')
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt) || r.createdAt < 0)
    c.err('createdAt', 'type', 'createdAt はミリ秒の数にしてください')
  if (r.by !== 'connector') c.err('by', 'value', "by は 'connector' にしてください")
  if (r.ai !== 'claude') c.err('ai', 'value', "ai は 'claude' にしてください")
  c.text('model', r.model, 1, RECORD_LIMITS.base.model)
  c.text('runId', r.runId, 1, RECORD_LIMITS.base.runId)
}

function userBase(c: Collector, r: Obj): void {
  if (r.v !== 1) c.err('v', 'value', 'v は 1 にしてください')
  for (const k of ['createdAt', 'updatedAt'] as const)
    if (typeof r[k] !== 'number' || !Number.isFinite(r[k]) || (r[k] as number) < 0)
      c.err(k, 'type', `${k} はミリ秒の数にしてください`)
  if (r.by !== 'user') c.err('by', 'value', "by は 'user' にしてください")
  if (r.ai !== null) c.err('ai', 'value', 'ai は null にしてください')
}

const safe = <T>(f: () => T): T | null => {
  try {
    return f()
  } catch {
    return null
  }
}

// ---------- 話題（docs/SPEC.md の 7.1） ----------

export interface TopicCheckOptions {
  /** 社の名前の一覧（作り物の版では作り物の一覧） */
  outlets?: OutletDirectory
}

/** 話題を確かめる（コネクタが送る直前。強調も確かめる） */
export function checkTopic(topic: unknown, opts: TopicCheckOptions = {}): CheckResult {
  const c = new Collector()
  if (!c.obj('', topic)) return c.result()
  const t = topic
  const T = RECORD_LIMITS.topic
  connectorBase(c, t)
  // 名札（id）: 版の id ＋ 中身の指紋8字（docs/SPEC.md の 7.7）
  const idOk = typeof t.id === 'string' && TOPIC_ID_RE.test(t.id)
  if (!idOk) c.err('id', 'id', "id は '{版の id}-{指紋8字}' の形にしてください")
  if (!parseEditionId(t.editionId)) c.err('editionId', 'id', 'editionId は版の id（YYYY-MM-DD-12・20）にしてください')
  else if (idOk && !(t.id as string).startsWith(`${t.editionId}-`)) c.err('id', 'id', 'id は editionId で始めてください')
  if (idOk) {
    const expected = safe(() => topicIdOf(t as unknown as Topic))
    if (expected !== t.id) c.err('id', 'id', `id が中身の指紋と合いません（中身からは ${expected ?? '作れません'}）`)
  }
  if (typeof t.threadId !== 'string' || !TOPIC_ID_RE.test(t.threadId))
    c.err('threadId', 'id', 'threadId は話題の id の形にしてください')
  else if (t.followUp === null && t.threadId !== t.id)
    c.err('threadId', 'rule', '続報でない話題の threadId は自分の id にしてください')
  else if (isObj(t.followUp) && typeof t.editionId === 'string') {
    // 続報の threadId は前の話題の threadId を写す（docs/SPEC.md の 7.8 の「続報のつなぎ」の 2.）。前の話題は前の版の物なので、
    // 自分の id にはならず、自分の版より前の版の id で始まる（版の id は文字の順で比べられる）。写し忘れると続報の鎖が切れ、後から直せない（同 5.）
    const threadEdition = editionIdOfRecordId(t.threadId)
    if (t.threadId === t.id || threadEdition === null || threadEdition >= t.editionId)
      c.err('threadId', 'rule', '続報の threadId は前の話題の threadId にしてください（自分より前の版の id で始まる）')
  }

  c.int('rank', t.rank, T.rankMin, T.rankMax)
  c.text('rankReason', t.rankReason, 1, T.rankReason)
  c.oneOf('region', REGION_VALUES, t.region)
  c.oneOf('genre', GENRE_VALUES, t.genre)
  c.bool('major', t.major)
  if (c.text('headline', t.headline, 1, T.headline)) {
    const n = countChars(t.headline)
    const H = RECORD_NORMS.headline
    if (n < H.min || n > H.max) c.warn('headline', 'norm', `見出しが ${n}字です（目安は30字台）`)
  }
  if (c.text('summary', t.summary, 1, T.summary)) {
    const n = countNonSpace(t.summary)
    const S = RECORD_NORMS.summaryNonSpace
    if (n < S.min || n > S.max) c.warn('summary', 'norm', `要約が空白を除いて ${n}字です（目安は ${S.min}〜${S.max}字）`)
  }
  if (c.obj('conclusion', t.conclusion)) {
    c.oneOf('conclusion.label', CONCLUSION_LABEL_VALUES, t.conclusion.label)
    c.text('conclusion.note', t.conclusion.note, 0, T.conclusionNote)
    c.bool('conclusion.breaking', t.conclusion.breaking)
  }
  if (c.obj('soWhat', t.soWhat))
    for (const k of ['life', 'system', 'world', 'whyNews'] as const) c.text(`soWhat.${k}`, t.soWhat[k], 1, T.soWhat, true)

  if (c.list('stakeholders', t.stakeholders, 0, T.stakeholders))
    t.stakeholders.forEach((s, i) => {
      const p = `stakeholders[${i}]`
      if (!c.obj(p, s)) return
      c.text(`${p}.name`, s.name, 1, T.stakeholderName)
      c.oneOf(`${p}.stance`, STANCE_VALUES, s.stance)
      c.text(`${p}.stanceNote`, s.stanceNote, 1, T.stanceNote, true)
      c.text(`${p}.claim`, s.claim, 1, T.claim, true)
      c.text(`${p}.reason`, s.reason, 1, T.claimReason, true)
      // 主張を確かめられなかった時は stance 'unknown'・stanceNote null・reason null（docs/SPEC.md の 7.1）
      if (s.claim === null && (s.stance !== 'unknown' || s.stanceNote !== null || s.reason !== null))
        c.err(p, 'rule', `${p} は主張が null なので、stance を 'unknown'、stanceNote と reason を null にしてください`)
    })

  if (c.obj('view', t.view)) {
    const v = t.view
    if (v.kind === 'opposed') {
      c.text('view.axis', v.axis, 1, T.axis)
      c.text('view.issue', v.issue, 1, T.issue, true)
      const a = c.text('view.aiView', v.aiView, 1, T.aiView)
      const b = c.text('view.counterView', v.counterView, 1, T.counterView)
      if (a && b) {
        const x = countChars(v.aiView as string)
        const y = countChars(v.counterView as string)
        if (Math.abs(x - y) * 100 > Math.max(x, y) * Math.round(RECORD_NORMS.viewDiffRatio * 100))
          c.warn('view', 'norm', `AI の見解（${x}字）と対立見解（${y}字）の分量の差が1割を超えています`)
      }
    } else if (v.kind === 'none') c.text('view.noneReason', v.noneReason, 1, T.noneReason, true)
    else c.err('view.kind', 'value', "view.kind は 'opposed' か 'none' にしてください")
  }

  const timeline = t.timeline
  const timelineOk = c.list('timeline', timeline, 0, T.timeline)
  if (timelineOk)
    timeline.forEach((e, i) => {
      const p = `timeline[${i}]`
      if (!c.obj(p, e)) return
      if (e.when !== null && !isTimelineWhen(e.when))
        c.err(`${p}.when`, 'format', `${p}.when は 'YYYY'・'YYYY-MM'・'YYYY-MM-DD' か null にしてください`)
      c.text(`${p}.text`, e.text, 1, T.timelineText)
    })

  if (c.obj('followUp', t.followUp, true)) {
    const f = t.followUp
    if (typeof f.prevTopicId !== 'string' || !TOPIC_ID_RE.test(f.prevTopicId))
      c.err('followUp.prevTopicId', 'id', 'followUp.prevTopicId は話題の id の形にしてください')
    else if (f.prevTopicId === t.id) c.err('followUp.prevTopicId', 'rule', 'followUp.prevTopicId に自分の id は使えません')
    c.text('followUp.whatsNew', f.whatsNew, 1, T.whatsNew)
    // 続報には何が新しいかと経緯を必ず持たせる（docs/SPEC.md の 7.8 の「続報のつなぎ」）
    if (timelineOk && (timeline as unknown[]).length === 0)
      c.err('timeline', 'rule', '続報には経緯（timeline）を1行以上書いてください')
  }

  if (c.list('terms', t.terms, 0, T.terms)) {
    const R = RECORD_NORMS.terms
    if (t.terms.length < R.min || t.terms.length > R.max)
      c.warn('terms', 'norm', `用語が ${t.terms.length}語です（目安は ${R.min}〜${R.max}語）`)
    const seenIds = new Set<string>()
    const surfaces = new Map<string, string>()
    t.terms.forEach((e, i) => {
      const p = `terms[${i}]`
      if (!c.obj(p, e)) return
      const idOkTerm = typeof e.termId === 'string' && TERM_ID_RE.test(e.termId)
      if (!idOkTerm) c.err(`${p}.termId`, 'id', `${p}.termId は 't' ＋ 12字にしてください`)
      else if (seenIds.has(e.termId as string)) c.err(`${p}.termId`, 'rule', `${p} の語は、もう前に出ています`)
      else seenIds.add(e.termId as string)
      const forms: string[] = []
      if (c.text(`${p}.term`, e.term, 1, T.term)) forms.push(e.term)
      forms.push(...c.texts(`${p}.aliases`, e.aliases, 0, T.termAliases, 1, T.termAlias))
      c.text(`${p}.explanation`, e.explanation, 1, T.termExplanation)
      if (e.asOf !== null && !isYm(e.asOf)) c.err(`${p}.asOf`, 'format', `${p}.asOf は 'YYYY-MM' か null にしてください`)
      // 1つの話題の中で、1つの表記は1つの語にだけ属する（docs/SPEC.md の 7.1）
      if (idOkTerm)
        for (const s of new Set(forms)) {
          const other = surfaces.get(s)
          if (other !== undefined && other !== e.termId) c.err(`${p}.term`, 'rule', `表記「${s}」が2つの語に属しています`)
          else surfaces.set(s, e.termId as string)
        }
    })
  }

  const dir = opts.outlets ?? DEFAULT_OUTLETS
  const sourceOutlets: string[] = []
  if (c.list('sources', t.sources, T.sourcesMin, T.sources))
    t.sources.forEach((s, i) => {
      const p = `sources[${i}]`
      if (!c.obj(p, s)) return
      const outletOk = c.text(`${p}.outlet`, s.outlet, 1, T.outlet)
      if (outletOk) sourceOutlets.push(s.outlet as string)
      c.text(`${p}.title`, s.title, 1, T.sourceTitle)
      const viaOk = s.via === null || c.text(`${p}.via`, s.via, 1, T.via, true)
      if (c.text(`${p}.url`, s.url, 1, T.url) && outletOk && viaOk) {
        const src = { outlet: s.outlet as string, url: s.url, via: s.via as string | null }
        if (!isAllowedSourceUrl(src, dir))
          c.err(
            `${p}.url`,
            'url',
            `${p}.url は https: で、ホストが社（${s.outlet}）か読んだ所の決まったホストの URL にしてください`,
          )
      }
      if (s.publishedAt !== null && !isPublishedAt(s.publishedAt))
        c.err(
          `${p}.publishedAt`,
          'format',
          `${p}.publishedAt は 'YYYY-MM-DDTHH:MM(:SS)?+09:00' か 'YYYY-MM-DD' か null にしてください`,
        )
      c.text(`${p}.publishedNote`, s.publishedNote, 1, T.publishedNote, true)
      // 著者（段階3で足した欄。無い・null・1〜80字の文字だけ）
      if (s.author !== undefined) c.text(`${p}.author`, s.author, 1, T.author, true)
    })

  const names = c.texts('outletNames', t.outletNames, T.outletNamesMin, T.outletNames, 1, T.outletName)
  if (names.length) {
    if (new Set(names).size !== names.length) c.err('outletNames', 'rule', 'outletNames に同じ社が2回あります')
    // 出典の社（sources の順・重なりを除く）を並びの頭に置く（docs/SPEC.md の 7.1・5.10）
    const head = [...new Set(sourceOutlets)]
    if (head.some((o, i) => names[i] !== o))
      c.err('outletNames', 'rule', `outletNames の頭は出典の社（${head.join('・')}）の順にしてください`)
  }

  c.texts('unverified', t.unverified, 0, T.unverified, 1, T.unverifiedText)

  if (c.obj('check', t.check, true)) {
    c.int('check.claims', t.check.claims, 0, T.checkClaims)
    c.int('check.fixed', t.check.fixed, 0, typeof t.check.claims === 'number' ? Math.max(0, t.check.claims) : T.checkClaims)
    c.text('check.model', t.check.model, 1, T.checkModel, true)
  }

  // 強調（docs/SPEC.md の 7.1 の「強調」）。記録では欄が必須で、強調が無い時も {} を入れる（入力で省けるのはコネクタの入力だけ）。
  // 欄が無い記録と {} の記録は同じ中身なのに指紋が別になり、7.7 の「同じ中身を送り直しても1件」が崩れるので断る
  if (t.emphasis === undefined) c.err('emphasis', 'type', 'emphasis はオブジェクトにしてください（強調が無い時は {}）')
  const emph = checkEmphasis(topic)
  const at = (key: string) => (key ? `emphasis["${key}"]` : 'emphasis')
  for (const e of emph.errors) c.err(at(e.key), `emphasis:${e.code}`, e.message)
  for (const w of emph.warnings) c.warn(at(w.key), `emphasis:${w.code}`, w.message)

  c.json('topics', topic)
  return c.result()
}

// ---------- 版・作れなかった印（docs/SPEC.md の 7.2） ----------

/** 版を確かめる（コネクタが送る直前。order の話題がクラウドにあるかは、コネクタが別に確かめる） */
export function checkEdition(edition: unknown): CheckResult {
  const c = new Collector()
  if (!c.obj('', edition)) return c.result()
  const e = edition
  const E = RECORD_LIMITS.edition
  connectorBase(c, e)
  if (!isYmd(e.date)) c.err('date', 'format', "date は 'YYYY-MM-DD' にしてください")
  c.oneOf('slot', SLOT_VALUES, e.slot)
  if (typeof e.id !== 'string' || !EDITION_ID_RE.test(e.id) || !parseEditionId(e.id))
    c.err('id', 'id', "id は 'YYYY-MM-DD-12' か '-20' にしてください")
  else if (isYmd(e.date) && isOneOf(SLOT_VALUES, e.slot) && e.id !== editionIdOf(e.date, e.slot))
    c.err('id', 'id', 'id は date と slot から作ってください')
  if (c.list('order', e.order, E.orderMin, E.order)) {
    const seen = new Set<string>()
    e.order.forEach((id, i) => {
      if (typeof id !== 'string' || !TOPIC_ID_RE.test(id)) c.err(`order[${i}]`, 'id', `order[${i}] は話題の id にしてください`)
      else if (typeof e.id === 'string' && !id.startsWith(`${e.id}-`))
        c.err(`order[${i}]`, 'rule', `order[${i}] はこの版の話題にしてください`)
      else if (seen.has(id)) c.err(`order[${i}]`, 'rule', `order[${i}] の話題が2回あります`)
      else seen.add(id)
    })
  }
  c.int('candidateCount', e.candidateCount, 0, E.candidateCount, true)
  if (c.list('notChosen', e.notChosen, 0, E.notChosen))
    e.notChosen.forEach((n, i) => {
      const p = `notChosen[${i}]`
      if (!c.obj(p, n)) return
      c.text(`${p}.headline`, n.headline, 1, E.notChosenHeadline)
      c.text(`${p}.whyNot`, n.whyNot, 1, E.whyNot)
    })
  if (c.obj('window', e.window, true)) {
    const { since, until } = e.window
    if (!isJstDateTime(since)) c.err('window.since', 'format', 'window.since は日本時間の時差つきの日時にしてください')
    if (!isJstDateTime(until)) c.err('window.until', 'format', 'window.until は日本時間の時差つきの日時にしてください')
    if (isJstDateTime(since) && isJstDateTime(until) && Date.parse(since) > Date.parse(until))
      c.err('window', 'rule', 'window.since は window.until より前にしてください')
  }
  if (c.obj('usage', e.usage, true))
    for (const k of ['tokens', 'toolCalls', 'minutes'] as const) {
      const v = e.usage[k]
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0))
        c.err(`usage.${k}`, 'type', `usage.${k} は 0 以上の数にしてください`)
    }
  c.json('editions', edition)
  return c.result()
}

/**
 * 版の決まりの範囲（知らせるだけ。docs/SPEC.md の 6.1・7.1 の「決まりの範囲」）: 話題 10本（目安。段階3の設計の 4.13。段階2までは 20本）、
 * ジャンルは最大5本（最低は 0 で知らせない。候補に無いジャンルを知らせ続けないため）、重大印はいちばん上。
 * topics は order の話題（足りない話題は数えない）
 */
export function checkEditionNorms(
  edition: Pick<Edition, 'order'>,
  topics: readonly Pick<Topic, 'id' | 'genre' | 'major'>[],
): Problem[] {
  const c = new Collector()
  const n = RECORD_NORMS
  if (edition.order.length !== n.editionTopics)
    c.warn('order', 'norm', `話題が ${edition.order.length}本です（目安は ${n.editionTopics}本）`)
  const byId = new Map(topics.map((t) => [t.id, t]))
  const inOrder = edition.order
    .map((id) => byId.get(id))
    .filter((t): t is Pick<Topic, 'id' | 'genre' | 'major'> => t !== undefined)
  const counts = new Map<Genre, number>(GENRE_VALUES.map((g) => [g, 0]))
  for (const t of inOrder) if (counts.has(t.genre)) counts.set(t.genre, (counts.get(t.genre) ?? 0) + 1)
  for (const [g, k] of counts)
    if (k < n.genrePerEdition.min || k > n.genrePerEdition.max)
      c.warn('order', 'norm', `ジャンル ${g} が ${k}本です（${n.genrePerEdition.min}〜${n.genrePerEdition.max}本）`)
  const firstPlain = inOrder.findIndex((t) => !t.major)
  if (firstPlain >= 0 && inOrder.slice(firstPlain).some((t) => t.major))
    c.warn('order', 'norm', '重大印の話題が、いちばん上にそろっていません')
  return c.warnings
}

/** 1日の重大印の数（知らせるだけ。0〜3件。topics はその日の版の話題） */
export function checkMajorsPerDay(topics: readonly Pick<Topic, 'major'>[]): Problem[] {
  const k = topics.filter((t) => t.major).length
  const M = RECORD_NORMS.majorPerDay
  return k < M.min || k > M.max
    ? [{ path: 'major', code: 'norm', message: `重大印が1日に ${k}件です（${M.min}〜${M.max}件）` }]
    : []
}

/** 作れなかった印を確かめる */
export function checkEditionFail(fail: unknown): CheckResult {
  const c = new Collector()
  if (!c.obj('', fail)) return c.result()
  const f = fail
  connectorBase(c, f)
  const ed = parseEditionId(f.editionId)
  if (!ed) c.err('editionId', 'id', 'editionId は版の id にしてください')
  c.oneOf('reasonKind', REASON_KIND_VALUES, f.reasonKind)
  c.text('reason', f.reason, 1, RECORD_LIMITS.editionFail.reason)
  if (typeof f.id !== 'string' || !TOPIC_ID_RE.test(f.id)) c.err('id', 'id', "id は '{版の id}-{指紋8字}' の形にしてください")
  else if (ed) {
    const expected = safe(() =>
      editionFailIdOf({
        editionId: f.editionId as string,
        runId: f.runId as string,
        reasonKind: f.reasonKind as never,
        reason: f.reason as string,
      }),
    )
    if (expected !== f.id) c.err('id', 'id', `id が runId・reasonKind・reason の指紋と合いません（${expected ?? '作れません'}）`)
  }
  c.json('editionFails', fail)
  return c.result()
}

// ---------- 用語の辞書の束（docs/SPEC.md の 7.3） ----------

/** 辞書の1語を確かめる（束の確かめと、段階3の組み立てで下書きの新しい語・新しい説明を確かめる所で同じ物を使う） */
function termEntryInto(c: Collector, q: string, e: unknown): void {
  const P = RECORD_LIMITS.termPack
  if (!c.obj(q, e)) return
  if (c.text(`${q}.key`, e.key, 1, P.key)) {
    if (typeof e.termId !== 'string' || e.termId !== termIdOf(e.key))
      c.err(`${q}.termId`, 'id', `${q}.termId は key の指紋（${termIdOf(e.key)}）にしてください`)
  } else if (typeof e.termId !== 'string' || !TERM_ID_RE.test(e.termId))
    c.err(`${q}.termId`, 'id', `${q}.termId は 't' ＋ 12字にしてください`)
  const plain = (path: string, s: unknown) => {
    if (typeof s === 'string' && !isPlainText(s)) c.err(path, 'plain', `${path} に改行・URL・記法の記号は使えません`)
  }
  c.text(`${q}.term`, e.term, 1, P.term)
  plain(`${q}.key`, e.key)
  plain(`${q}.term`, e.term)
  c.texts(`${q}.aliases`, e.aliases, 0, P.aliases, 1, P.alias).forEach((a, j) => plain(`${q}.aliases[${j}]`, a))
  if (c.text(`${q}.explanation`, e.explanation, 1, P.explanation)) plain(`${q}.explanation`, e.explanation)
  if (e.asOf !== null && !isYm(e.asOf)) c.err(`${q}.asOf`, 'format', `${q}.asOf は 'YYYY-MM' か null にしてください`)
  c.int(`${q}.rev`, e.rev, 1, Number.MAX_SAFE_INTEGER)
  if (e.retired !== undefined && e.retired !== true) c.err(`${q}.retired`, 'value', `${q}.retired は true か、書かないでください`)
}

/** 辞書の語を1つずつ確かめる（束の id・数・重なりは見ない。path は欄の道の頭。段階3の組み立て。src/domain/assemble.ts） */
export function checkTermEntry(entry: unknown, path = 'entry'): CheckResult {
  const c = new Collector()
  termEntryInto(c, path, entry)
  return c.result()
}

/** 辞書の束を確かめる（今の辞書との表記の重なりは、コネクタが DO の写しで確かめる。段階3） */
export function checkTermPack(pack: unknown): CheckResult {
  const c = new Collector()
  if (!c.obj('', pack)) return c.result()
  const p = pack
  const P = RECORD_LIMITS.termPack
  connectorBase(c, p)
  const ed = parseEditionId(p.editionId)
  if (!ed) c.err('editionId', 'id', 'editionId は版の id にしてください')
  if (c.list('entries', p.entries, P.entriesMin, P.entries)) {
    const seen = new Set<string>()
    p.entries.forEach((e, i) => {
      const q = `entries[${i}]`
      termEntryInto(c, q, e)
      if (isObj(e) && typeof e.termId === 'string') {
        if (seen.has(e.termId)) c.err(`${q}.termId`, 'rule', `${q} の語が束の中に2回あります`)
        seen.add(e.termId)
      }
    })
  }
  if (typeof p.id !== 'string' || !TOPIC_ID_RE.test(p.id)) c.err('id', 'id', "id は '{版の id}-{指紋8字}' の形にしてください")
  else if (ed && Array.isArray(p.entries)) {
    const expected = safe(() => termPackIdOf(p.editionId as string, p.entries as TermEntry[]))
    if (expected !== p.id) c.err('id', 'id', `id が entries の指紋と合いません（${expected ?? '作れません'}）`)
  }
  c.json('termPacks', pack)
  return c.result()
}

// ---------- 訂正（docs/SPEC.md の 7.1 の「訂正」） ----------

export interface CorrectionCheckOptions {
  /** その話題に今ある訂正の数（10件まで。案） */
  existingForTopic?: number
}

/** 訂正を確かめる（30日の内で版の記録がある版の order にある話題かは、コネクタが確かめる。段階3） */
export function checkCorrection(correction: unknown, opts: CorrectionCheckOptions = {}): CheckResult {
  const c = new Collector()
  if (!c.obj('', correction)) return c.result()
  const r = correction
  connectorBase(c, r)
  const topicOk = typeof r.topicId === 'string' && TOPIC_ID_RE.test(r.topicId)
  if (!topicOk) c.err('topicId', 'id', 'topicId は話題の id にしてください')
  else if (r.editionId !== (r.topicId as string).slice(0, 13))
    c.err('editionId', 'id', 'editionId は話題の版の id（topicId の頭）にしてください')
  if (c.text('text', r.text, 1, RECORD_LIMITS.correction.text) && !isPlainText(r.text))
    c.err('text', 'plain', 'text に改行・URL・記法の記号は使えません')
  if (typeof r.id !== 'string' || !CORRECTION_ID_RE.test(r.id))
    c.err('id', 'id', "id は '{話題の id}-{指紋8字}' の形にしてください")
  else if (topicOk && typeof r.text === 'string' && r.id !== correctionIdOf({ topicId: r.topicId as string, text: r.text }))
    c.err('id', 'id', 'id が topicId と text の指紋と合いません')
  if ((opts.existingForTopic ?? 0) >= RECORD_LIMITS.correction.perTopic)
    c.err('topicId', 'count', `1つの話題に訂正は ${RECORD_LIMITS.correction.perTopic}件までです`)
  c.json('corrections', correction)
  return c.result()
}

// ---------- アプリの記録（docs/SPEC.md の 7.4） ----------

/** 知ってるを確かめる（アプリが送る前） */
export function checkKnownTerm(known: unknown): CheckResult {
  const c = new Collector()
  if (!c.obj('', known)) return c.result()
  const k = known
  userBase(c, k)
  if (typeof k.id !== 'string' || !TERM_ID_RE.test(k.id)) c.err('id', 'id', "id は 't' ＋ 12字にしてください")
  c.text('term', k.term, 1, RECORD_LIMITS.knownTerm.term)
  if (k.asOf !== null && !isYm(k.asOf)) c.err('asOf', 'format', "asOf は 'YYYY-MM' か null にしてください")
  c.bool('on', k.on)
  c.json('knownTerms', known)
  return c.result()
}

/** 既読を確かめる（アプリが送る前） */
export function checkReadMark(read: unknown): CheckResult {
  const c = new Collector()
  if (!c.obj('', read)) return c.result()
  const r = read
  userBase(c, r)
  const idOk = typeof r.id === 'string' && READ_ID_RE.test(r.id) && parseEditionId(r.id) !== null
  if (!idOk) c.err('id', 'id', 'id は版の id にしてください')
  else if (r.editionId !== r.id) c.err('editionId', 'id', 'editionId は id と同じ版の id にしてください')
  if (c.list('topicIds', r.topicIds, 0, RECORD_LIMITS.read.topicIds)) {
    const seen = new Set<string>()
    r.topicIds.forEach((id, i) => {
      if (typeof id !== 'string' || !TOPIC_ID_RE.test(id))
        c.err(`topicIds[${i}]`, 'id', `topicIds[${i}] は話題の id にしてください`)
      else if (idOk && !id.startsWith(`${r.id}-`)) c.err(`topicIds[${i}]`, 'rule', `topicIds[${i}] はこの版の話題にしてください`)
      else if (seen.has(id)) c.err(`topicIds[${i}]`, 'rule', `topicIds[${i}] が2回あります`)
      else seen.add(id)
    })
  }
  c.bool('seen', r.seen)
  c.json('reads', read)
  return c.result()
}

/** 表の名前で確かめ方を選ぶ */
export function checkRecord(table: TableName, record: unknown, opts: TopicCheckOptions = {}): CheckResult {
  switch (table) {
    case 'topics':
      return checkTopic(record, opts)
    case 'editions':
      return checkEdition(record)
    case 'editionFails':
      return checkEditionFail(record)
    case 'termPacks':
      return checkTermPack(record)
    case 'corrections':
      return checkCorrection(record)
    case 'knownTerms':
      return checkKnownTerm(record)
    case 'reads':
      return checkReadMark(record)
  }
}
