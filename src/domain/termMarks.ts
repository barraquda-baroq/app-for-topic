// 本文の中の用語の印（docs/SPEC.md の 9.・7.1 の「用語」・5.12。■2 の A）。記録には位置を持たず、話題の用語（term・aliases）を欄の文に
// そのままの文字で照らして付ける（文字をそろえない。強調と同じ）。重なる時は長い方（7.1）。強調と重なってよい（強調はオレンジの太字、
// 用語の印は点線。どちらも付ける）。記録の文は文のまま区切るだけで、HTML として読まない（4.6）。
// 付け方（開発。設計: 段階2の 1.12）:
// - 付ける欄は、詳細に出す順（detailTextFields）。見出し・用語の説明・出典・確かめられなかった点・決まった文には付けない
// - 1つの話題の中で、語ごとに最初に出る1か所だけ（全部に付けると本文が印だらけになる）
// - 「知ってる」の語には付けない（下の用語の一覧と同じく、次から出さない。7.4）。知ってる語・もう付けた語も、重なりの決めには加わる
//   （「国際連合」の中の「国際」に、別の語の印を付けない）
// - richSegments で、強調（src/domain/emphasis.ts の splitEmphasis と同じ決まり）と用語の印の境で文を区切る（src/features/topic/RichText.tsx）
// カードの要約には付けない（カードは押すと詳細を開く所で、中に小さな押す所があると押し間違えるため）
import { firstOccurrence, overlaps } from './emphasis'

/** 印を付ける欄（key は強調の鍵と同じ形。理由は 'stakeholders.{i}.reason'） */
export interface TermField {
  key: string
  text: string
}

/** 照らす話題の用語（ShownTopic.terms の一部） */
export interface TermSurface {
  termId: string
  term: string
  aliases: readonly string[]
  asOf?: string | null
}

/** 用語の印1つ（その欄の文の、JS の文字列の位置。start 以上 end 未満） */
export interface TermHit {
  key: string
  start: number
  end: number
  termId: string
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const strOf = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/**
 * 用語の印を付ける欄を、詳細に出す順に並べる（docs/SPEC.md の 9. の並びに足りない所を足した順。設計: 段階2の 1.10）:
 * 結論の補足 → 要約 → 続報の何が新しいか（と、続報の時は経緯の各行）→ だから何？4つ → 当事者の主張と理由（並びの順）→ AI の見解 →
 * 対立見解 → 経緯の各行（続報でない時）。null・空の欄は入れない（決まった文には付けない）。見出し・用語の説明・出典・確かめられなかった点は
 * 入れない。topic は表示用の写し（ShownTopic）
 */
export function detailTextFields(topic: unknown): TermField[] {
  const out: TermField[] = []
  if (!isObj(topic)) return out
  const push = (key: string, v: unknown) => {
    const text = strOf(v)
    if (text !== null) out.push({ key, text })
  }
  const timeline = () => {
    if (!Array.isArray(topic.timeline)) return
    topic.timeline.forEach((e, i) => push(`timeline.${i}.text`, isObj(e) ? e.text : null))
  }
  const followUp = isObj(topic.followUp) ? topic.followUp : null
  push('conclusion.note', isObj(topic.conclusion) ? topic.conclusion.note : null)
  push('summary', topic.summary)
  if (followUp) {
    push('followUp.whatsNew', followUp.whatsNew)
    timeline()
  }
  const soWhat = isObj(topic.soWhat) ? topic.soWhat : {}
  for (const k of ['life', 'system', 'world', 'whyNews']) push(`soWhat.${k}`, soWhat[k])
  if (Array.isArray(topic.stakeholders))
    topic.stakeholders.forEach((s, i) => {
      if (!isObj(s)) return
      push(`stakeholders.${i}.claim`, s.claim)
      push(`stakeholders.${i}.reason`, s.reason)
    })
  if (isObj(topic.view) && topic.view.kind === 'opposed') {
    push('view.aiView', topic.view.aiView)
    push('view.counterView', topic.view.counterView)
  }
  if (!followUp) timeline()
  return out
}

/** 語の表記と別名（空・重なりを除く） */
function surfacesOf(t: TermSurface): string[] {
  return [...new Set([t.term, ...t.aliases].filter((s): s is string => typeof s === 'string' && s !== ''))]
}

/** 文の中の、語の表記のすべての所（重なってもよい） */
function occurrencesOf(text: string, surface: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (let i = text.indexOf(surface); i >= 0; i = text.indexOf(surface, i + 1)) out.push({ start: i, end: i + surface.length })
  return out
}

/**
 * 欄の文の中の用語の印（fields の順・欄の中は前から）。語ごとに、最初に印の付く1か所だけ。isKnown が true の語（「知ってる」）には付けない。
 * 欄の中の重なりは、長い方を採る（同じ長さなら前の方、それも同じなら terms の並びの前の語）。知ってる語・前の欄でもう付けた語も重なりの
 * 決めには加わり、その所には印を付けない
 */
export function findTermHits(
  fields: readonly TermField[],
  terms: readonly TermSurface[],
  isKnown: (term: TermSurface) => boolean = () => false,
): TermHit[] {
  const known = new Set(terms.filter((t) => isKnown(t)).map((t) => t.termId))
  const done = new Set<string>()
  const out: TermHit[] = []
  for (const field of fields) {
    const candidates: { start: number; end: number; termId: string; order: number }[] = []
    terms.forEach((t, order) => {
      for (const s of surfacesOf(t))
        for (const at of occurrencesOf(field.text, s)) candidates.push({ ...at, termId: t.termId, order })
    })
    candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start || a.order - b.order)
    const won: typeof candidates = []
    for (const c of candidates) if (!won.some((w) => overlaps(w, c))) won.push(c)
    won.sort((a, b) => a.start - b.start)
    const inField = new Set<string>()
    for (const w of won) {
      if (known.has(w.termId) || done.has(w.termId) || inField.has(w.termId)) continue
      inField.add(w.termId)
      out.push({ key: field.key, start: w.start, end: w.end, termId: w.termId })
    }
    for (const id of inField) done.add(id)
  }
  return out
}

/** その欄の用語の印だけ（findTermHits の結果から） */
export function hitsOf(hits: readonly TermHit[], key: string): TermHit[] {
  return hits.filter((h) => h.key === key)
}

/** 欄の文の区切り（strong = 強調の所、termId = 用語の印の語（無ければ null）、termStart = その印の頭の区切り） */
export interface RichSegment {
  text: string
  strong: boolean
  termId: string | null
  termStart: boolean
}

/**
 * 欄の文を、強調と用語の印の境で区切る（つなぐと元の文になる）。強調は語句の最初に出る所（見つからない語句・前の語句と重なる語句は
 * 付けない。splitEmphasis と同じ決まり）。用語の印は hits（その欄の物。重なる印・文の外の印は捨てる）。強調と用語は重なってよく、
 * 強調の中の語・語をまたぐ強調は、境で区切る（1つの印が2つ以上の区切りになる時は、頭の区切りだけ termStart）
 */
export function richSegments(
  text: string,
  phrases: readonly string[] = [],
  hits: readonly { start: number; end: number; termId: string }[] = [],
): RichSegment[] {
  const strong: { start: number; end: number }[] = []
  for (const p of phrases) {
    const occ = typeof p === 'string' ? firstOccurrence(text, p) : null
    if (occ && !strong.some((r) => overlaps(r, occ))) strong.push(occ)
  }
  const terms: { start: number; end: number; termId: string }[] = []
  for (const h of [...hits].sort((a, b) => a.start - b.start)) {
    if (!(h.start >= 0 && h.end <= text.length && h.start < h.end)) continue
    if (!terms.some((t) => overlaps(t, h))) terms.push({ start: h.start, end: h.end, termId: h.termId })
  }
  const cuts = new Set<number>([0, text.length])
  for (const r of [...strong, ...terms]) {
    cuts.add(r.start)
    cuts.add(r.end)
  }
  const points = [...cuts].sort((a, b) => a - b)
  const out: RichSegment[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i]
    const end = points[i + 1]
    if (start === end) continue
    const term = terms.find((t) => t.start <= start && end <= t.end) ?? null
    out.push({
      text: text.slice(start, end),
      strong: strong.some((r) => r.start <= start && end <= r.end),
      termId: term?.termId ?? null,
      termStart: term !== null && term.start === start,
    })
  }
  return out
}
