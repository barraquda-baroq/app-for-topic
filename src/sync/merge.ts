// 同期の3者マージ（docs/SPEC.md の 7.8 の「既読・知ってるを送る・受け取る」）。
// base   = 最後にクラウドとそろえた時の中身（null = その時クラウドに無かった）
// mine   = この端末の中身
// theirs = クラウドの今の中身
// 欄ごとに、この端末が base から変えた欄だけをクラウドの中身に重ねる。
// DS の src/sync/merge.ts の仕組み（mergeRemote・mergeFields・mergeList・unionList・insertMissing・mergeUnrelated と、1組の欄 FIELD_GROUPS）を
// 写し、表の指定を TS の表で書き直した（7.8 の「部品」）。アプリが書く記録は knownTerms と reads だけ（7.4。保存は作らない。D10）。
// 外した物（16.5）: 長い文章をつなぐ TEXT_FIELDS・競合の控え（ゴミ箱）・受け取り箱の組・MIM の欄・並べ直し NORMALIZE・控えの作り方を
// 渡さない時の mergeRecordLegacy。足した物は2つ:
// - 表の決まりで決める欄（FIELD_RULES）: 既読の seen は「どちらかが true なら true」、知ってるの asOf は新しい方（null がいちばん古い）
// - 同期で記録を消さない: TS はアプリの記録をクラウドで消さず（削除の印を書かない）、受け取りは removed を無視する（7.8）。
//   だから片方に無い記録は「消した」ではなく「まだ無い」で、ある方を採る
import { contentEqual, deepEqual, stableStringify } from '../domain/equal'
import { KNOWN_TERM_FIELD_GROUP, newerAsOf } from '../domain/known'
import { isOneOf, USER_TABLES, type TableName } from '../domain/types'
import type { Rec } from './codec'

export { contentEqual, deepEqual, stableStringify }
export type { Rec }

type KeyOf = (item: unknown) => string

const asString: KeyOf = (x) => String(x)

/**
 * 並び（id の一覧など）として合わせる欄。両方の端末で変わっていたら、この端末の並びを基本に、相手が消した物を除き、
 * 相手が足した物を相手の並びでの直前の要素の後ろに入れる（重なり無し）
 */
export const LIST_FIELDS: Partial<Record<TableName, Record<string, KeyOf>>> = {
  // 読んだ話題の id（値で。PC で1本目、スマホで2本目を読む → 両方とも既読。7.8）
  reads: { topicIds: asString },
}

/** 1組として扱う欄（変えた側の組をまとめて採る。両方で変えたらこの端末＝後から同期した端末。7.8） */
export const FIELD_GROUPS: Partial<Record<TableName, readonly (readonly string[])[]>> = {
  // 知ってるの on・term（src/domain/known.ts の KNOWN_TERM_FIELD_GROUP。押した・外した時の表記と一緒に採る）
  knownTerms: [KNOWN_TERM_FIELD_GROUP],
}

/**
 * 表の決まりで決める欄の合わせ方。mine・theirs はこの端末とクラウドの値、merged は欄ごとのふつうの合わせ方で出た値。
 * 決まりに当たらない値（知らない形の値）の時は merged を返す（知らない値を消さない。DS の形3）
 */
export type FieldRule = (mine: unknown, theirs: unknown, merged: unknown) => unknown

/** 「どちらかが true なら true」（既読の seen） */
const eitherTrue: FieldRule = (mine, theirs, merged) => (mine === true || theirs === true ? true : merged)

const isAsOfValue = (x: unknown): x is string | null | undefined => x === null || x === undefined || typeof x === 'string'

/** 新しい時点（知ってるの asOf。'YYYY-MM' は文字の比べで足りる。null・無い欄がいちばん古い。src/domain/known.ts の newerAsOf） */
const newerTime: FieldRule = (mine, theirs, merged) => {
  if (!isAsOfValue(mine) || !isAsOfValue(theirs) || (mine === undefined && theirs === undefined)) return merged
  return newerAsOf(mine ?? null, theirs ?? null)
}

/**
 * 表の決まりで決める欄（7.8 の表ごとの合わせ方）。欄ごとに合わせる時（mergeFields）と、共通の履歴が無い時（mergeUnrelated）にいつも当てる。
 * - reads.seen: 2台がどちらも新しく作った時は base が null で、ふつうの合わせ方は両方が変えた欄で「この端末」を採るので、seen: false の端末が
 *   後から同期すると相手の true を false に戻してしまう。だから「どちらかが true なら true」にする
 * - knownTerms.asOf: 古い話題で押しても戻らない（7.4）。2台の合わせ方も新しい方
 */
export const FIELD_RULES: Partial<Record<TableName, Record<string, FieldRule>>> = {
  reads: { seen: eitherTrue },
  knownTerms: { asOf: newerTime },
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** primary の並びに、secondary にしか無い要素を、secondary での直前の要素の後ろに入れる */
function insertMissing(out: unknown[], seen: Set<string>, secondary: unknown[], skip: Set<string>, key: KeyOf): void {
  secondary.forEach((y, i) => {
    const k = key(y)
    if (seen.has(k) || skip.has(k)) return
    let pos = 0
    for (let j = i - 1; j >= 0; j--) {
      const pk = key(secondary[j])
      const idx = out.findIndex((z) => key(z) === pk)
      if (idx >= 0) {
        pos = idx + 1
        break
      }
    }
    out.splice(pos, 0, y)
    seen.add(k)
  })
}

/**
 * 並びの3者マージ（DS のまま）。片方だけが変えていたらその並び。両方が変えていたら、この端末の並びに相手が足した物を足し、相手が消した物を除く
 * （この端末が消した物は戻さない）。両方が変えた時の結果は重なり無し
 */
export function mergeList(base: unknown, mine: unknown, theirs: unknown, key: KeyOf): unknown[] {
  if (deepEqual(mine, base)) return asArray(theirs)
  if (deepEqual(theirs, base)) return asArray(mine)
  const b = asArray(base)
  const m = asArray(mine)
  const t = asArray(theirs)
  const baseItems = new Map(b.map((x) => [key(x), x]))
  const theirItems = new Map(t.map((x) => [key(x), x]))
  const out: unknown[] = []
  const seen = new Set<string>()
  for (const x of m) {
    const k = key(x)
    if (seen.has(k)) continue
    // 相手が消した物は除く
    if (baseItems.has(k) && !theirItems.has(k)) continue
    seen.add(k)
    // 中身を持つ要素は、この端末で変えていなければ相手の中身を使う
    const bx = baseItems.get(k)
    const tx = theirItems.get(k)
    out.push(tx !== undefined && bx !== undefined && deepEqual(x, bx) ? tx : x)
  }
  // 相手が足した物（この端末で消した物は足さない）
  insertMissing(out, seen, t, new Set(baseItems.keys()), key)
  return out
}

/** 共通の履歴が無い2つの並びを合わせる: primary の並びに、secondary にしか無い要素を足す（重なり無し） */
export function unionList(primary: unknown, secondary: unknown, key: KeyOf): unknown[] {
  const out: unknown[] = []
  const seen = new Set<string>()
  for (const x of asArray(primary)) {
    const k = key(x)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(x)
  }
  insertMissing(out, seen, asArray(secondary), new Set(), key)
  return out
}

const pick = (r: Record<string, unknown>, fields: readonly string[]) => fields.map((f) => r[f])

const setField = (out: Record<string, unknown>, field: string, value: unknown) => {
  if (value === undefined) delete out[field]
  else out[field] = value
}

/** 表の決まりで決める欄を当てる（FIELD_RULES） */
function applyRules(
  table: TableName,
  out: Record<string, unknown>,
  m: Record<string, unknown>,
  t: Record<string, unknown>,
): void {
  for (const [field, rule] of Object.entries(FIELD_RULES[table] ?? {})) setField(out, field, rule(m[field], t[field], out[field]))
}

/**
 * 両方にある記録を欄ごとに合わせる（DS のまま、表の決まりを足した）。同じ欄を両方が別々に変えていたら、並びは要素ごとに合わせ、
 * 1組の欄は変えた側の組、表の決まりの欄は決まりのとおり、それ以外はこの端末を採る。知らない欄も残る。updatedAt は新しい方
 */
export function mergeFields(table: TableName, base: Rec | null, mine: Rec, theirs: Rec): Rec {
  const out: Record<string, unknown> = { ...theirs }
  const b = (base ?? {}) as Record<string, unknown>
  const m = mine as unknown as Record<string, unknown>
  const t = theirs as unknown as Record<string, unknown>
  const groups = FIELD_GROUPS[table] ?? []
  const grouped = new Set(groups.flat())
  const keys = new Set([...Object.keys(m), ...Object.keys(b)])
  for (const k of keys) {
    if (k === 'id' || k === 'updatedAt' || grouped.has(k)) continue
    const mv = m[k]
    const bv = b[k]
    const tv = t[k]
    if (deepEqual(mv, bv)) continue
    if (deepEqual(tv, bv) || deepEqual(tv, mv)) out[k] = mv
    else {
      const listKey = LIST_FIELDS[table]?.[k]
      out[k] = listKey ? mergeList(bv, mv, tv, listKey) : mv
    }
    if (out[k] === undefined) delete out[k]
  }
  // 1組の欄: 変えた側の組をまとめて採る（両方で変えたらこの端末。base が null なら、この端末が変えたとみなす）
  for (const fields of groups) {
    if (deepEqual(pick(m, fields), pick(b, fields))) continue
    for (const f of fields) setField(out, f, m[f])
  }
  applyRules(table, out, m, t)
  if (mine.updatedAt !== undefined || theirs.updatedAt !== undefined)
    out.updatedAt = Math.max(mine.updatedAt ?? 0, theirs.updatedAt ?? 0)
  return out as Rec
}

/**
 * 共通の履歴が無い時（初めてのログインで両方の端末に同じ id の記録がある・前に別のアカウントで使っていた端末。7.8）の合わせ方（DS のまま）。
 * クラウドを正とし、並びにはこの端末にしか無い要素を足す。表の決まりの欄（seen・asOf）は決まりのとおり（DS が受け取り箱の組を強い方に
 * するのと同じく、どちらの端末の分も失わない決まりなので、履歴が無くても当てる）
 */
function mergeUnrelated(table: TableName, mine: Rec, theirs: Rec): Rec {
  if (contentEqual(mine, theirs)) return theirs
  const out: Record<string, unknown> = { ...theirs }
  const m = mine as unknown as Record<string, unknown>
  for (const [field, key] of Object.entries(LIST_FIELDS[table] ?? {})) {
    if (!(field in out || field in m)) continue
    // 同じ並びなら足し合わせない
    if (deepEqual(out[field], m[field])) continue
    out[field] = unionList(out[field], m[field], key)
  }
  applyRules(table, out, m, theirs as unknown as Record<string, unknown>)
  return contentEqual(out, theirs) ? theirs : (out as Rec)
}

export interface MergeOptions {
  /** クラウドとの共通の履歴が無い（送信待ちの noHistory） */
  noHistory?: boolean
}

export interface MergeResult {
  /** 合わせた結果（null = どちらにも無い） */
  record: Rec | null
}

/**
 * 3者マージ（7.8 の表ごとの合わせ方）。
 * - アプリが書かない表（版・話題・訂正・作れなかった印・辞書の束）は、受け取ったまま（アプリは送信待ちに積まない）
 * - 片方に無い記録は、ある方（同期で記録を消さない。TS は削除の印を書かず、removed を無視する）
 * - 共通の履歴が無い時は mergeUnrelated、ほかは DS と同じく、片方だけが変えていればその中身、両方が変えていれば mergeFields
 */
export function mergeRemote(
  table: TableName,
  base: Rec | null,
  mine: Rec | null,
  theirs: Rec | null,
  opts: MergeOptions = {},
): MergeResult {
  if (!theirs) return { record: mine }
  if (!mine) return { record: theirs }
  if (!isOneOf(USER_TABLES, table)) return { record: theirs }
  if (opts.noHistory) return { record: mergeUnrelated(table, mine, theirs) }
  if (contentEqual(mine, base)) return { record: theirs }
  // 同じ中身になっていれば、クラウドの中身をそのまま使う（端末の中とクラウドをそろえるため）
  if (contentEqual(theirs, mine)) return { record: theirs }
  if (contentEqual(theirs, base)) return { record: mine }
  return { record: mergeFields(table, base, mine, theirs) }
}
