// 名札（id）の作り方と形の確かめ（docs/SPEC.md の 7.7 の「名札（id）の作り方」）。アプリと段階3のコネクタで同じ物を使う。
// - 版: 枠から（'{YYYY-MM-DD}-{12|20}'。日本時間）。中身から作ると、やり直しで同じ枠の版が2つできるため
// - 話題・辞書の束・作れなかった印: '{版の id}-{指紋8字}'。訂正: '{話題の id}-{指紋8字}'（指紋は text）
// - 語: 't' ＋ 12字（key を NFKC・空白を詰める・小文字にした形の指紋。DS の normalizeIdText）。既読: 版の id
// - どの id も [0-9a-z-] だけで 40字以内（'/'・'#'・'?'・'.' を使わない。前の版の行き先 '#/e/{版の id}' に入れられる。詳細は行き先にしない。
//   docs/SPEC.md の 7.7・17.6 の 14）
// 指紋は、材料を stableStringify した文字列の短い指紋（src/domain/hash.ts の fingerprint）。
// Claude に見せる短い id（話題 'p:'＋指紋8字・版 'e:'＋版の id）とその解き方も置く（docs/SPEC.md の 7.7・7.8 の「続報のつなぎ」）。
import { stableStringify } from './equal'
import { fingerprint } from './hash'
import { isExpiredDate, isYmd, jstDateOf, jstParts } from './jst'
import type { CorrectionRecord, EditionFail, Slot, TermEntry, Topic } from './types'

/** 話題・辞書の束・作れなかった印・訂正の指紋の字数 */
export const FINGERPRINT_CHARS = 8
/** 語の指紋の字数 */
export const TERM_FINGERPRINT_CHARS = 12
/** id の最長（いちばん長いのは訂正の 31字） */
export const ID_MAX_CHARS = 40

// ---------- 形（ルールの expirableRecord・段階3の connectorCreate と同じ形。docs/SPEC.md の 7.7） ----------

/** 版の id の形（ルールと同じ。日付の数の範囲はルールと同じくゆるい。本当にある日かは parseEditionId で見る） */
export const EDITION_ID_SOURCE = '20[0-9]{2}-[01][0-9]-[0-3][0-9]-(12|20)'
const FP = `[0-9a-z]{${FINGERPRINT_CHARS}}`

export const EDITION_ID_RE = new RegExp(`^${EDITION_ID_SOURCE}$`)
export const TOPIC_ID_RE = new RegExp(`^${EDITION_ID_SOURCE}-${FP}$`)
export const TERM_PACK_ID_RE = TOPIC_ID_RE
export const EDITION_FAIL_ID_RE = TOPIC_ID_RE
export const CORRECTION_ID_RE = new RegExp(`^${EDITION_ID_SOURCE}-${FP}-${FP}$`)
export const TERM_ID_RE = new RegExp(`^t[0-9a-z]{${TERM_FINGERPRINT_CHARS}}$`)
export const READ_ID_RE = EDITION_ID_RE

/** 表ごとの id の形（ルールの appDoc の id の確かめ・expirableRecord・connectorCreate と同じ形） */
export const ID_PATTERNS = {
  editions: EDITION_ID_RE,
  topics: TOPIC_ID_RE,
  corrections: CORRECTION_ID_RE,
  termPacks: TERM_PACK_ID_RE,
  editionFails: EDITION_FAIL_ID_RE,
  knownTerms: TERM_ID_RE,
  reads: READ_ID_RE,
} as const

/** その表の id の形か */
export function isRecordIdFor(table: keyof typeof ID_PATTERNS, id: unknown): id is string {
  return typeof id === 'string' && id.length <= ID_MAX_CHARS && ID_PATTERNS[table].test(id)
}

/**
 * 30日で消せる文書の id か（表ごとの id の形だけ。ルールの expirableRecord と private の reads と同じ形。docs/SPEC.md の 7.7）。
 * 版 = 枠だけ、話題・作れなかった印 = 枠＋8字、訂正 = 枠＋8字＋8字、既読 = 枠だけ。表を取り違えた形
 * （版に8字が付く・話題に指紋が無い など）は消せない。辞書の束・知ってるは消さない
 */
export function isExpirableDocId(docId: string): boolean {
  return EXPIRABLE_DOC_ID_RES.some((re) => re.test(docId))
}

const EXPIRABLE_DOC_ID_RES = [
  new RegExp(`^(editions|reads):${EDITION_ID_SOURCE}$`),
  new RegExp(`^(topics|editionFails):${EDITION_ID_SOURCE}-${FP}$`),
  new RegExp(`^corrections:${EDITION_ID_SOURCE}-${FP}-${FP}$`),
]

/**
 * 30日で消せる文書の id で、その時刻に版の日付から30日を過ぎているか（ルールの expirableRecord と expiredDay を合わせた物）。
 * 時刻は、クラウドから消す時はサーバーの時刻の見積もり、端末の中で消す時は端末の時計（docs/SPEC.md の 7.8 の「30日で消す」）
 */
export function isExpiredDocId(docId: string, nowMs: number): boolean {
  if (!isExpirableDocId(docId)) return false
  const date = docId.slice(docId.indexOf(':') + 1, docId.indexOf(':') + 11)
  return isYmd(date) && isExpiredDate(date, nowMs)
}

// ---------- 版（枠から） ----------

/** 版の id（'{YYYY-MM-DD}-{12|20}'。日付は日本時間の暦の日付） */
export function editionIdOf(date: string, slot: Slot): string {
  return `${date}-${slot}`
}

/** その時刻（ミリ秒・UTC）の日本時間の日付の、その枠の版の id（端末の時差に左右されない） */
export function editionIdAt(ms: number, slot: Slot): string {
  return editionIdOf(jstDateOf(ms), slot)
}

/** 版の id を日付と枠に分ける（形が違う・本当に無い日付は null） */
export function parseEditionId(id: unknown): { date: string; slot: Slot } | null {
  if (typeof id !== 'string' || !EDITION_ID_RE.test(id)) return null
  const date = id.slice(0, 10)
  return isYmd(date) ? { date, slot: id.slice(11) as Slot } : null
}

/**
 * 版の id で始まる記録の id（話題・辞書の束・作れなかった印・訂正・既読）の、頭の版の id（形が違えば null）。
 * 30日の境を id の範囲で引けるのは、どれも版の id で始まるため（docs/SPEC.md の 7.7 の「名札」）
 */
export function editionIdOfRecordId(id: unknown): string | null {
  if (typeof id !== 'string') return null
  const head = id.slice(0, 13)
  return (id.length === 13 || id[13] === '-') && parseEditionId(head) ? head : null
}

// ---------- 回の id（段階3。段階3の設計の 1.3。docs/SPEC.md の 7.7 の runId） ----------

/** 回の id の乱数の字数（[0-9a-z]） */
export const RUN_ID_RAND_CHARS = 4
/** 回の id の形（'r' ＋ 始めた時刻（日本時間の YYYYMMDDHHmm）＋ '-' ＋ 乱数4字。作り物の版の runId と同じ形） */
export const RUN_ID_RE = new RegExp(`^r[0-9]{12}-[0-9a-z]{${RUN_ID_RAND_CHARS}}$`)

/**
 * 回の id（'r{YYYYMMDDHHmm}-{4字}'。時刻は日本時間）。乱数は呼ぶ側が渡す（domain は乱数を持たない。コネクタは crypto.getRandomValues の
 * [0-9a-z]）。乱数が [0-9a-z] の4字でなければ投げる
 */
export function runIdAt(ms: number, rand: string): string {
  if (!new RegExp(`^[0-9a-z]{${RUN_ID_RAND_CHARS}}$`).test(rand))
    throw new RangeError(`回の id の乱数は [0-9a-z] の${RUN_ID_RAND_CHARS}字にしてください`)
  const p = jstParts(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `r${p.date.replaceAll('-', '')}${two(p.hour)}${two(p.minute)}-${rand}`
}

// ---------- 中身の指紋から作る id ----------

/** 材料を stableStringify した物の短い指紋 */
const fp = (material: unknown, length = FINGERPRINT_CHARS): string => fingerprint(stableStringify(material), length)

/**
 * 話題の指紋に入れない欄（docs/SPEC.md の 7.7 の「名札」）。id・続報をつなぐ番号・作った時刻・作ったモデル・回・by・ai・形の版は
 * 中身ではないので、同じ中身を送り直しても1件になるように外す。強調（emphasis）は中身なので入る
 */
export const TOPIC_ID_EXCLUDED_FIELDS = ['id', 'threadId', 'createdAt', 'model', 'runId', 'by', 'ai', 'v'] as const

/** 話題の中身の指紋（8字） */
export function topicFingerprint(topic: Omit<Topic, 'id'> | Topic): string {
  const material: Record<string, unknown> = { ...topic }
  for (const k of TOPIC_ID_EXCLUDED_FIELDS) delete material[k]
  return fp(material)
}

/** 話題の id（'{版の id}-{指紋8字}'。同じ中身なら同じ id、書き直した物は別の id） */
export function topicIdOf(topic: Omit<Topic, 'id'> | Topic): string {
  return `${topic.editionId}-${topicFingerprint(topic)}`
}

/** 辞書の束の id（'{版の id}-{指紋8字}'。指紋は entries の中身。200語を超える時は束を分ける＝別の指紋） */
export function termPackIdOf(editionId: string, entries: readonly TermEntry[]): string {
  return `${editionId}-${fp(entries)}`
}

/** 作れなかった印の id（'{版の id}-{指紋8字}'。指紋は runId・reasonKind・reason。版と別の id にして、印の後に作れた版を足せるように） */
export function editionFailIdOf(fail: Pick<EditionFail, 'editionId' | 'runId' | 'reasonKind' | 'reason'>): string {
  return `${fail.editionId}-${fp({ runId: fail.runId, reasonKind: fail.reasonKind, reason: fail.reason })}`
}

/** 訂正の id（'{話題の id}-{指紋8字}'。指紋は text。同じ訂正を送り直しても1件。話題の id で始まるので、話題と同じ範囲で消える） */
export function correctionIdOf(correction: Pick<CorrectionRecord, 'topicId' | 'text'>): string {
  return `${correction.topicId}-${fp({ text: correction.text })}`
}

/** 文字をそろえる（NFKC で全角と半角を同じに、空白を詰め（前後を除き、続く空白を1つに）、英字を小文字に。DS の normalizeIdText） */
export function normalizeIdText(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 語の id（'t' ＋ 12字。辞書の key をそろえた形の指紋。2台で押しても1件。別名で押しても同じ語の id はコネクタが辞書で解く） */
export function termIdOf(key: string): string {
  return `t${fp(normalizeIdText(key), TERM_FINGERPRINT_CHARS)}`
}

/** 既読の id（版の id。版1つに1記録） */
export function readIdOf(editionId: string): string {
  return editionId
}

// ---------- Claude に見せる短い id（docs/SPEC.md の 7.7 の「名札」） ----------

/** 話題の短い id（'p:'＋指紋8字 = id の後ろの8字）。NS の「頭8字」だと、日付で始まるので月ごとに全部同じになる */
export function topicShortId(topicId: string): string {
  return `p:${topicId.slice(-FINGERPRINT_CHARS)}`
}

/** 版の短い id（'e:'＋版の id） */
export function editionShortId(editionId: string): string {
  return `e:${editionId}`
}

const TOPIC_SHORT_ID_RE = new RegExp(`^p:(${FP})$`)

/** 短い id を読む（大文字・前後の空白は許す。形が違えば null） */
export function parseShortId(
  ref: string,
): { kind: 'topic'; fingerprint: string } | { kind: 'edition'; editionId: string } | null {
  const r = ref.trim().toLowerCase()
  const t = TOPIC_SHORT_ID_RE.exec(r)
  if (t) return { kind: 'topic', fingerprint: t[1] }
  const e = /^e:(.+)$/.exec(r)
  if (e && parseEditionId(e[1])) return { kind: 'edition', editionId: e[1] }
  return null
}

/** 話題の指し方を解いた結果 */
export type TopicRefResult = { ok: true; id: string } | { ok: false; reason: 'not-found' | 'ambiguous'; matches: string[] }

/**
 * 話題の指し方（短い id 'p:'＋8字か、話題の id そのもの）を、候補の話題の id の中だけで解く（docs/SPEC.md の 7.8 の「続報のつなぎ」・
 * 「訂正を足す・出す」）。候補は、続報なら直近の版の order にある話題、訂正なら30日の内の版の order にある話題（呼ぶ側が渡す）。
 * 2つ以上に当たれば ambiguous で断る
 */
export function resolveTopicRef(ref: string, candidates: readonly string[]): TopicRefResult {
  const r = ref.trim()
  const unique = [...new Set(candidates)]
  if (unique.includes(r)) return { ok: true, id: r }
  const short = parseShortId(r)
  if (!short || short.kind !== 'topic') return { ok: false, reason: 'not-found', matches: [] }
  const matches = unique.filter((id) => TOPIC_ID_RE.test(id) && id.slice(-FINGERPRINT_CHARS) === short.fingerprint)
  if (matches.length === 1) return { ok: true, id: matches[0] }
  return { ok: false, reason: matches.length ? 'ambiguous' : 'not-found', matches }
}

/** 版の指し方（'e:'＋版の id か、版の id そのもの）を解く（形が違う・本当に無い日付は null） */
export function resolveEditionRef(ref: string): string | null {
  const r = ref.trim().toLowerCase()
  if (parseEditionId(r)) return r
  const short = parseShortId(r)
  return short?.kind === 'edition' ? short.editionId : null
}
