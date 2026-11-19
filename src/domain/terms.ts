// 用語の辞書の今の形と表記の重なり（docs/SPEC.md の 7.3・段階3の設計の 1.5）。アプリと段階3のコネクタで同じ物を使う（コネクタは DO の
// SQLite の表に今の形を持ち、テストはメモリの Map。どちらもこの関数で決める）。
// - 今の形: 全部の束を重ね、語ごとに rev のいちばん大きい物（束の順に左右されない）。retired の語は外す（Claude に返さず、話題から指せない）
// - 表記: key の括弧の添え字を除いた形・term・別名を normalizeIdText にそろえた物。辞書全体で、同じ表記を2つの語が持つのは、key の括弧の
//   添え字（国など）だけが違う時だけ許す（例「与党（日本）」「与党（米国）」）。それ以外の重なりはコネクタが断る
// - 指し方: termId か表記で語を引く。表記で2つ以上の語に当たる時は断り、termId で指させる
import { stableStringify } from './equal'
import { normalizeIdText } from './ids'
import type { TermEntry } from './types'

/** 辞書の今の形（termId → rev のいちばん大きい物。外した語も rev を比べるために持つ。外した語を除くのは liveTerms・lookup の側） */
export type TermDictionary = ReadonlyMap<string, TermEntry>

/**
 * 同じ語の2つの entry のどちらが新しいか（rev の大きい方。同じ rev なら外した物、それも同じなら中身の文字の順の大きい方）。
 * 束の届く順に左右されないように、どの順で重ねても同じ物を選ぶ
 */
export function newerTermEntry(a: TermEntry, b: TermEntry): TermEntry {
  if (a.rev !== b.rev) return a.rev > b.rev ? a : b
  if ((a.retired === true) !== (b.retired === true)) return a.retired === true ? a : b
  return stableStringify(a) >= stableStringify(b) ? a : b
}

/** 辞書に束を重ねる（新しい Map を返す。辞書は変えない） */
export function applyPack(dict: TermDictionary, entries: readonly TermEntry[]): Map<string, TermEntry> {
  const out = new Map(dict)
  for (const e of entries) {
    const had = out.get(e.termId)
    out.set(e.termId, had ? newerTermEntry(had, e) : e)
  }
  return out
}

/** 束の並びから辞書の今の形を作る（束の順に左右されない） */
export function dictionaryOf(packs: readonly { entries: readonly TermEntry[] }[]): Map<string, TermEntry> {
  let dict = new Map<string, TermEntry>()
  for (const p of packs) dict = applyPack(dict, p.entries)
  return dict
}

/** 外していない語（辞書の順） */
export function liveTerms(dict: TermDictionary): TermEntry[] {
  return [...dict.values()].filter((e) => e.retired !== true)
}

/** key の括弧の添え字を除いた形（そろえた形。「与党（日本）」→「与党」。添え字の無い key はそろえた key のまま） */
export function keyBaseOf(key: string): string {
  const k = normalizeIdText(key)
  return k.replace(/\s*\([^()]*\)$/, '').trim() || k
}

/** 語の表記（key の添え字を除いた形・term・別名を normalizeIdText にそろえた物。重なりを除く） */
export function termFormsOf(entry: Pick<TermEntry, 'key' | 'term' | 'aliases'>): string[] {
  return [...new Set([keyBaseOf(entry.key), normalizeIdText(entry.term), ...entry.aliases.map(normalizeIdText)])].filter(Boolean)
}

/** 表記の重なり（断る物） */
export interface TermOverlap {
  /** 足す語 */
  termId: string
  key: string
  /** 重なった表記（そろえた形） */
  form: string
  /** 同じ表記を持つ、ほかの語（辞書か、同じ束の語） */
  other: { termId: string; key: string }
  message: string
}

/**
 * 足す語（新しい語・説明を新しくした語）の表記が、辞書の今の形と同じ束のほかの語に重ならないか（docs/SPEC.md の 7.3 の「表記の重なり」）。
 * key の括弧の添え字だけが違う語どうし（添え字を除いた形が同じで、key が違う）は許す。外した語・外す語は数えない。
 * 足す語が辞書の語を新しくする物（同じ termId）なら、辞書の古い物と比べない
 */
export function termOverlapProblems(entries: readonly TermEntry[], dict: TermDictionary): TermOverlap[] {
  const merged = applyPack(dict, entries)
  const live = liveTerms(merged)
  const byForm = new Map<string, TermEntry[]>()
  for (const e of live)
    for (const f of termFormsOf(e)) {
      const list = byForm.get(f) ?? []
      list.push(e)
      byForm.set(f, list)
    }
  const adding = new Set(entries.filter((e) => e.retired !== true).map((e) => e.termId))
  const out: TermOverlap[] = []
  const seen = new Set<string>()
  for (const e of live) {
    if (!adding.has(e.termId)) continue
    for (const form of termFormsOf(e))
      for (const o of byForm.get(form) ?? []) {
        if (o.termId === e.termId) continue
        if (keyBaseOf(o.key) === keyBaseOf(e.key) && normalizeIdText(o.key) !== normalizeIdText(e.key)) continue
        const pair = [e.termId, o.termId].sort().join('|') + `|${form}`
        if (seen.has(pair)) continue
        seen.add(pair)
        out.push({
          termId: e.termId,
          key: e.key,
          form,
          other: { termId: o.termId, key: o.key },
          message: `表記「${form}」が、語「${e.key}」と語「${o.key}」の2つに属します（国などで中身が違う語は key の括弧の添え字で分けてください）`,
        })
      }
  }
  return out
}

/** 語の指し方を解いた結果 */
export type TermRefResult =
  | { ok: true; entry: TermEntry }
  | { ok: false; reason: 'not-found' | 'retired' | 'ambiguous' | 'not-a-form'; matches: string[] }

/**
 * 語の指し方（termId か表記）を辞書で解く（外した語は指せない）。表記はそろえた形で比べ、2つ以上の語に当たれば ambiguous（termId で
 * 指させる）。termId と表記の両方を渡すと、その表記がその語の表記（key の添え字を除いた形・term・別名）かも見る（not-a-form）
 */
export function resolveTermRef(ref: { termId?: string; term?: string }, dict: TermDictionary): TermRefResult {
  if (typeof ref.termId === 'string') {
    const e = dict.get(ref.termId.trim())
    if (!e) return { ok: false, reason: 'not-found', matches: [] }
    if (e.retired === true) return { ok: false, reason: 'retired', matches: [e.termId] }
    if (typeof ref.term === 'string' && !termFormsOf(e).includes(normalizeIdText(ref.term)))
      return { ok: false, reason: 'not-a-form', matches: [e.termId] }
    return { ok: true, entry: e }
  }
  if (typeof ref.term !== 'string' || !normalizeIdText(ref.term)) return { ok: false, reason: 'not-found', matches: [] }
  const form = normalizeIdText(ref.term)
  const matches = liveTerms(dict).filter((e) => termFormsOf(e).includes(form))
  if (matches.length === 1) return { ok: true, entry: matches[0] }
  return { ok: false, reason: matches.length ? 'ambiguous' : 'not-found', matches: matches.map((e) => e.termId) }
}
