// 強調（D24。docs/SPEC.md の 7.1 の「強調」・5.12）。記録の文はふつうの文のままにし、強調する語句を欄ごとに別に持つ（話題の emphasis）。
// アプリが欄の文の中から語句を探して付ける（位置は持たない）。アプリと段階3のコネクタで同じ物を使う。
// - EMPHASIS_PATHS: 付けられる欄の道の並び（この順が、全体の60を数える順。docs/SPEC.md の 7.1 の「強調」の表と同じ順）
// - checkEmphasis: コネクタの確かめ。断る物（errors）と知らせる物（warnings）を分けて返す
// - repairEmphasis: アプリの直し。合わない語句・鍵を捨てて出す（受け取った記録は変えない。書き戻さない）
// - splitEmphasis: 画面用に、欄の文を「ふつう」と「強調」の区切りに分ける（文は文のまま。HTML として読まない。4.6）
// 字数は Unicode の文字（コードポイント）で数える（src/domain/limits.ts の countChars）。語句を探す・重なりを見るのは、そのままの文字で比べる
// （文字をそろえない）。
import { countChars, RECORD_LIMITS, RECORD_NORMS } from './limits'
import type { Emphasis } from './types'

/** 強調を付けられる欄の道（{i} は並びの番号。0 から数える） */
export const EMPHASIS_PATHS = [
  'summary',
  'conclusion.note',
  'soWhat.life',
  'soWhat.system',
  'soWhat.world',
  'soWhat.whyNews',
  'stakeholders.{i}.claim',
  'view.aiView',
  'view.counterView',
  'timeline.{i}.text',
  'followUp.whatsNew',
] as const
export type EmphasisPath = (typeof EMPHASIS_PATHS)[number]

/** 読んだ鍵（path は EMPHASIS_PATHS の1つ、index は {i} の番号（並びの無い道は null）、rank は EMPHASIS_PATHS の中の位置） */
export interface EmphasisKey {
  key: string
  path: EmphasisPath
  index: number | null
  rank: number
}

const FIXED_PATHS = new Set<string>(EMPHASIS_PATHS.filter((p) => !p.includes('{i}')))
/** 並びの番号は 0 か、0 で始まらない数だけ（'01' は知らない鍵） */
const INDEXED_KEY = /^(stakeholders\.(0|[1-9][0-9]*)\.claim|timeline\.(0|[1-9][0-9]*)\.text)$/

/** 鍵を読む（上の形に当たらない鍵は null = 知らない鍵） */
export function parseEmphasisKey(key: string): EmphasisKey | null {
  if (FIXED_PATHS.has(key)) {
    const path = key as EmphasisPath
    return { key, path, index: null, rank: EMPHASIS_PATHS.indexOf(path) }
  }
  const m = INDEXED_KEY.exec(key)
  if (!m) return null
  const path: EmphasisPath = m[2] !== undefined ? 'stakeholders.{i}.claim' : 'timeline.{i}.text'
  return { key, path, index: Number(m[2] ?? m[3]), rank: EMPHASIS_PATHS.indexOf(path) }
}

/** 鍵の並べ方（EMPHASIS_PATHS の順、同じ道の中は番号の順） */
export function compareEmphasisKeys(a: EmphasisKey, b: EmphasisKey): number {
  return a.rank - b.rank || (a.index ?? 0) - (b.index ?? 0)
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** 並びの番号の要素（並びの外・オブジェクトでない要素は null） */
function elementAt(list: unknown, index: number | null): Obj | null {
  if (!Array.isArray(list) || index === null || !Number.isSafeInteger(index) || index >= list.length) return null
  const el: unknown = list[index]
  return isObj(el) ? el : null
}

/**
 * 欄の道の文（受け取った記録の並びの番号で解く）。無い欄・null の欄・並びの外の番号・view.kind が 'opposed' でない時の見解・
 * followUp が null の時は null。知らない鍵も null（見分けは parseEmphasisKey）
 */
export function emphasisFieldText(topic: unknown, key: string | EmphasisKey): string | null {
  const k = typeof key === 'string' ? parseEmphasisKey(key) : key
  if (!k || !isObj(topic)) return null
  switch (k.path) {
    case 'summary':
      return strOrNull(topic.summary)
    case 'conclusion.note':
      return isObj(topic.conclusion) ? strOrNull(topic.conclusion.note) : null
    case 'soWhat.life':
    case 'soWhat.system':
    case 'soWhat.world':
    case 'soWhat.whyNews':
      return isObj(topic.soWhat) ? strOrNull(topic.soWhat[k.path.slice('soWhat.'.length)]) : null
    case 'stakeholders.{i}.claim':
      return strOrNull(elementAt(topic.stakeholders, k.index)?.claim)
    case 'view.aiView':
    case 'view.counterView':
      return isObj(topic.view) && topic.view.kind === 'opposed' ? strOrNull(topic.view[k.path.slice('view.'.length)]) : null
    case 'timeline.{i}.text':
      return strOrNull(elementAt(topic.timeline, k.index)?.text)
    case 'followUp.whatsNew':
      return isObj(topic.followUp) ? strOrNull(topic.followUp.whatsNew) : null
  }
}

/** 文のある欄の鍵と文（EMPHASIS_PATHS の順。画面とテストで、付けられる欄を並べる） */
export function emphasisFields(topic: unknown): { key: EmphasisKey; text: string }[] {
  const out: { key: EmphasisKey; text: string }[] = []
  if (!isObj(topic)) return out
  const lengthOf = (v: unknown) => (Array.isArray(v) ? v.length : 0)
  for (const path of EMPHASIS_PATHS) {
    const keys =
      path === 'stakeholders.{i}.claim'
        ? Array.from({ length: lengthOf(topic.stakeholders) }, (_, i) => `stakeholders.${i}.claim`)
        : path === 'timeline.{i}.text'
          ? Array.from({ length: lengthOf(topic.timeline) }, (_, i) => `timeline.${i}.text`)
          : [path]
    for (const s of keys) {
      const key = parseEmphasisKey(s)
      const text = key && emphasisFieldText(topic, key)
      if (key && text !== null) out.push({ key, text })
    }
  }
  return out
}

/** 語句がその欄で最初に出る所（JS の文字列の位置。start 以上 end 未満。無ければ null） */
export function firstOccurrence(text: string, phrase: string): { start: number; end: number } | null {
  if (!phrase) return null
  const start = text.indexOf(phrase)
  return start < 0 ? null : { start, end: start + phrase.length }
}

/** 2つの所が1字でも重なるか */
export function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end
}

const hasEdgeSpace = (p: string): boolean => p !== p.trim()

// ---------- コネクタの確かめ（docs/SPEC.md の 7.1 の「コネクタが断る」「コネクタが知らせる」） ----------

export type EmphasisErrorCode =
  | 'not-object'
  | 'unknown-key'
  | 'no-field'
  | 'not-array'
  | 'empty'
  | 'not-string'
  | 'spaces'
  | 'length'
  | 'not-found'
  | 'overlap'
  | 'too-many-in-field'
  | 'too-many'
  | 'view-count'

export type EmphasisWarningCode = 'over-ratio' | 'stakeholder-count' | 'summary-missing'

/** 断る訳・知らせる訳（鍵と語句と訳。どこを直せばよいかが Claude に分かるように） */
export interface EmphasisProblem<C extends string = string> {
  code: C
  /** 欄の道の鍵（全体の数・形の時は ''） */
  key: string
  phrase?: string
  message: string
}

export interface EmphasisCheck {
  /** 断る物（1つでもあれば、その話題を断る） */
  errors: EmphasisProblem<EmphasisErrorCode>[]
  /** 知らせる物（断らない。定期実行の報告に書く） */
  warnings: EmphasisProblem<EmphasisWarningCode>[]
}

const L = RECORD_LIMITS.emphasis
const N = RECORD_NORMS.emphasis
/** 2割を整数で比べる（小数の誤差で境目が揺れないように） */
const RATIO_PERCENT = Math.round(N.ratio * 100)

/**
 * 1つの欄の語句の字数の合計が、その欄の字数の2割と12字の大きい方を超えるか（超えたら知らせる。短い欄でも1か所は知らせずに付けられる）
 */
export function overEmphasisRatio(phraseChars: number, fieldChars: number): boolean {
  return phraseChars > N.minChars && phraseChars * 100 > fieldChars * RATIO_PERCENT
}

/**
 * 話題の強調を確かめる（コネクタが、話題の文を整えた後の、記録に入る文で確かめる。docs/SPEC.md の 7.1 の「強調」）。
 * topic.emphasis を省いた時は {} とみなす（要約に強調が無い、を知らせる）
 */
export function checkEmphasis(topic: unknown): EmphasisCheck {
  const errors: EmphasisProblem<EmphasisErrorCode>[] = []
  const warnings: EmphasisProblem<EmphasisWarningCode>[] = []
  const raw = isObj(topic) ? topic.emphasis : undefined
  const err = (code: EmphasisErrorCode, key: string, message: string, phrase?: string) =>
    errors.push(phrase === undefined ? { code, key, message } : { code, key, phrase, message })
  if (raw !== undefined && !isObj(raw)) {
    err('not-object', '', '強調（emphasis）は、欄の道を鍵にしたオブジェクトにしてください')
    warnings.push({ code: 'summary-missing', key: 'summary', message: '要約に強調がありません' })
    return { errors, warnings }
  }
  const emphasis: Obj = raw ?? {}
  let total = 0
  for (const key of Object.keys(emphasis)) {
    const value = emphasis[key]
    if (Array.isArray(value)) total += value.length
    const k = parseEmphasisKey(key)
    if (!k) {
      err('unknown-key', key, `「${key}」は強調を付けられる欄の道ではありません`)
      continue
    }
    const text = emphasisFieldText(topic, k)
    if (text === null) {
      err(
        'no-field',
        key,
        `「${key}」の欄がありません（null の欄・並びの外の番号・対立見解なし・続報でない話題などには付けられません）`,
      )
      continue
    }
    if (!Array.isArray(value)) {
      err('not-array', key, `「${key}」の値は語句の並びにしてください`)
      continue
    }
    if (value.length === 0) {
      err('empty', key, `「${key}」が空の並びです（強調の無い欄は鍵を書かないでください）`)
      continue
    }
    if (value.length > L.perField)
      err('too-many-in-field', key, `「${key}」の語句が${value.length}個です（1つの欄に${L.perField}つまで）`)
    const found: { phrase: string; at: { start: number; end: number } }[] = []
    let phraseChars = 0
    for (const p of value) {
      if (typeof p !== 'string') {
        err('not-string', key, `「${key}」に文字でない値があります`)
        continue
      }
      phraseChars += countChars(p)
      if (hasEdgeSpace(p)) {
        err('spaces', key, `「${key}」の語句「${p}」の前後に空白・改行があります`, p)
        continue
      }
      const n = countChars(p)
      if (n < L.phraseMin || n > L.phraseMax)
        err('length', key, `「${key}」の語句「${p}」は${n}字です（${L.phraseMin}〜${L.phraseMax}字）`, p)
      const at = firstOccurrence(text, p)
      if (!at) {
        err('not-found', key, `「${key}」の語句「${p}」が欄の文にありません（1字も変えずに抜き出してください）`, p)
        continue
      }
      const before = found.find((f) => overlaps(f.at, at))
      if (before) err('overlap', key, `「${key}」の語句「${p}」が、前の語句「${before.phrase}」と重なっています`, p)
      found.push({ phrase: p, at })
    }
    const fieldChars = countChars(text)
    if (overEmphasisRatio(phraseChars, fieldChars))
      warnings.push({
        code: 'over-ratio',
        key,
        message: `「${key}」の強調の字数の合計（${phraseChars}字）が、欄の字数（${fieldChars}字）の2割と${N.minChars}字の大きい方を超えています`,
      })
  }
  if (total > L.total) err('too-many', '', `強調が全体で${total}か所です（${L.total}まで）`)
  // AI の見解と対立見解で数が違う（片方だけに付けた時も。どちらにも付けないのはよい）
  if (isObj(topic) && isObj(topic.view) && topic.view.kind === 'opposed') {
    const a = countOf(emphasis['view.aiView'])
    const b = countOf(emphasis['view.counterView'])
    if (a !== b)
      err(
        'view-count',
        a > b ? 'view.aiView' : 'view.counterView',
        `AI の見解（${a}か所）と対立見解（${b}か所）で強調の数が違います`,
      )
  }
  // 主張のある（claim が null でない）当事者で、語句の数がそろわない
  if (isObj(topic) && Array.isArray(topic.stakeholders)) {
    const counts: number[] = []
    topic.stakeholders.forEach((s, i) => {
      if (isObj(s) && typeof s.claim === 'string') counts.push(countOf(emphasis[`stakeholders.${i}.claim`]))
    })
    if (counts.some((c) => c !== counts[0]))
      warnings.push({
        code: 'stakeholder-count',
        key: 'stakeholders',
        message: `主張のある当事者で強調の数がそろっていません（${counts.join('・')}）`,
      })
  }
  if (countOf(emphasis.summary) === 0)
    warnings.push({ code: 'summary-missing', key: 'summary', message: '要約に強調がありません' })
  return { errors, warnings }
}

const countOf = (v: unknown): number => (Array.isArray(v) ? v.length : 0)

// ---------- アプリの直し（docs/SPEC.md の 7.1 の「アプリ」） ----------

/**
 * 表示に使う強調（捨てて出す。受け取った記録は変えない）。捨てる物: 知らない鍵・無い欄や null の欄の鍵・見つからない語句・前の語句と
 * 重なる語句（並びの先の物を残す）・前後に空白・改行のある語句・2〜40字に入らない語句・文字の並びでない値・数の上限を超えた分
 * （ほかの訳で捨てた後に数える。1つの欄は4つ目から。全体は EMPHASIS_PATHS の順、同じ道の中は番号の順、欄の中は並びの順に数えて
 * 61か所目から）。emphasis が無い・形が違う時は {}。番号は受け取った記録の並びの番号で解く（詰めない・並べ替えない）。
 * raw を省いた時は topic.emphasis を使う
 */
export function repairEmphasis(topic: unknown, raw: unknown = isObj(topic) ? topic.emphasis : undefined): Emphasis {
  if (!isObj(raw)) return {}
  const fields: { key: EmphasisKey; phrases: string[] }[] = []
  for (const s of Object.keys(raw)) {
    const value = raw[s]
    const key = parseEmphasisKey(s)
    const text = key && emphasisFieldText(topic, key)
    if (!key || text === null || !Array.isArray(value)) continue
    const kept: string[] = []
    const at: { start: number; end: number }[] = []
    for (const p of value) {
      if (typeof p !== 'string' || hasEdgeSpace(p)) continue
      const n = countChars(p)
      if (n < L.phraseMin || n > L.phraseMax) continue
      const occ = firstOccurrence(text, p)
      if (!occ || at.some((a) => overlaps(a, occ))) continue
      if (kept.length >= L.perField) continue
      kept.push(p)
      at.push(occ)
    }
    if (kept.length) fields.push({ key, phrases: kept })
  }
  fields.sort((a, b) => compareEmphasisKeys(a.key, b.key))
  const out: Emphasis = {}
  let total = 0
  for (const f of fields) {
    const room = L.total - total
    if (room <= 0) break
    const phrases = f.phrases.slice(0, room)
    out[f.key.key] = phrases
    total += phrases.length
  }
  return out
}

// ---------- 画面用（段階2の本文の強調。見た目は A のオレンジの文字＋太字で、色の値は src/styles.css の --emphasis。docs/SPEC.md の 17.） ----------

/** 欄の文の区切り（strong = 強調の所） */
export interface EmphasisSegment {
  text: string
  strong: boolean
}

/**
 * 欄の文を、語句の最初に出る所で「ふつう」と「強調」に分ける（つなぐと元の文になる）。見つからない語句・前の語句と重なる語句は付けない
 * （repairEmphasis の後の語句を渡すので、ふつうは全部付く）。用語の印とは別に付ける（重なってよい。docs/SPEC.md の 7.1）
 */
export function splitEmphasis(text: string, phrases: readonly string[] = []): EmphasisSegment[] {
  const ranges: { start: number; end: number }[] = []
  for (const p of phrases) {
    const occ = typeof p === 'string' ? firstOccurrence(text, p) : null
    if (occ && !ranges.some((r) => overlaps(r, occ))) ranges.push(occ)
  }
  ranges.sort((a, b) => a.start - b.start)
  const out: EmphasisSegment[] = []
  let pos = 0
  for (const r of ranges) {
    if (r.start > pos) out.push({ text: text.slice(pos, r.start), strong: false })
    out.push({ text: text.slice(r.start, r.end), strong: true })
    pos = r.end
  }
  if (pos < text.length) out.push({ text: text.slice(pos), strong: false })
  return out
}
