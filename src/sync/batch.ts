// 1回のトランザクションで送る物を選び（selectBatch）、クラウドの中身と突き合わせて書く物を決める（decideBatch）。
// 純粋な関数（エンジンと、テスト用の偽のクラウドの両方で使う）。DS の src/sync/batch.ts を写し、TS の形に直した（docs/SPEC.md の 7.8 の「部品」）:
// - 送信待ちは1件ずつ、クラウドが前にそろえた時（base）から変わっていない時だけ書く（DS のまま）
// - 受け取り箱のまとまり（g）・復元の「必ず上書き」（force）・内容から作った id の削除の印を外した（TS に受け取り箱・復元・削除の印が無い。16.5）
// - 分けた文書を外したので、1件 = 1文書で数える（7.7）
// - 送る側の守りを足した（7.8 の「既読・知ってるを送る・受け取る」）: アプリの表で local が null の行と、アプリが書かない表（Claude の記録）の行は、
//   書かずに送り終わりにする（削除の印を決して書かない。ルールで断られて、同じトランザクションのほかの記録まで止めない）。30日の外の既読の行は、
//   送らずに捨てる（電波の無い間に読んだ既読が、送信待ちのまま30日を過ぎた時）
// - クラウドに無くて base がある「知ってる」（誰かが Firebase の画面で消した）は、共通の履歴が無い物として作り直す（7.8。DS のままだと、
//   受け取りで removed を無視するので base が新しくならず、送信待ちが残り続ける）
import { deepEqual } from '../domain/equal'
import { isExpiredDocId } from '../domain/ids'
import { docIdOf, EXPIRING_TABLES, isOneOf, USER_TABLES, type TableName } from '../domain/types'
import { encodeRecord, hashRecord, type Encoded, type Rec } from './codec'

/**
 * 送信待ちの1行のうち、送る物を選ぶのに使う欄（src/db/persistence.ts の readOutbox が返す行。docs/SPEC.md の 7.8 の _outbox）。
 * 呼ぶ側の行の型（tx・sent などを持つ）をそのまま渡せるよう、関数は T extends SendItem で受け取って同じ型で返す
 */
export interface SendItem {
  /** 送信待ちの鍵（'{表名}/{id}'） */
  k: string
  table: TableName
  id: string
  /** 最後にクラウドとそろえた時の中身（null = その時クラウドに無かった） */
  base: Rec | null
  /** クラウドとの共通の履歴が無い（初めてのログイン・前に別のアカウントで使っていた端末）。クラウドに何も無い時だけ書く */
  noHistory?: boolean
  /** 送ったトランザクションの返事を受け取っていない（書き込みが届いたかもしれないので、base がまだクラウドの中身か分からない） */
  unconfirmed?: boolean
  /** いまの端末の中身（null = 端末に無い。TS はアプリの記録をクラウドで消さないので、送らない） */
  local: Rec | null
}

export interface BatchEntry<T extends SendItem = SendItem> {
  it: T
  /** local を符号にした物（書く json と指紋） */
  enc: Encoded
  baseHash: string
}

export interface BatchLimits {
  /** 1回に書く量の上限（json の文字数の合計） */
  maxChars: number
  /** 1回に書く文書の数の上限 */
  maxDocs: number
}

/** Firestore の1回のトランザクション・まとめての書き込みで書ける文書の数（docs/SPEC.md の 7.9 の「1つの文書・まとめ書き」） */
export const FIRESTORE_MAX_WRITES = 500

/**
 * アプリの送る1回の上限（DS と同じ 400文書・150万字。7.9）。500 の手前にして、送る書き込みの印（sync/{端末の ID}）の分を残す。
 * TS のアプリの記録は小さい（既読は30本読んでも約900字、知ってるは約200字。上限は RECORD_LIMITS.json の 5,000字・2,000字）ので、
 * ふだんは文書の数で決まる
 */
export const SEND_LIMITS: Readonly<BatchLimits> = { maxChars: 1_500_000, maxDocs: 400 }

/** 30日の削除の1回の問い合わせ・まとめての削除の数（1回の書き込みの上限 500 の手前。7.8 の「30日で消す」） */
export const EXPIRE_BATCH_DOCS = 450

/** 30日の削除で1台が1日に消す数の上限（長くどの端末も開かなかった時は、次の日に続ける。7.8 の「30日で消す」） */
export const EXPIRE_DAILY_DOCS = 2_000

/** アプリが書く表（知ってる・既読）か。ほかの表（Claude の記録）はアプリから作れない・直せない（ルール。7.7） */
export const isAppTable = (table: TableName): boolean => isOneOf(USER_TABLES, table)

/** 端末の中身が、最後に知ったクラウドの中身と同じ（この端末にもクラウドにも無い物・クラウドと全く同じ物） */
export const sameAsBase = (it: SendItem): boolean => (it.noHistory ? it.local === null : deepEqual(it.local, it.base))

/**
 * 送る前に捨てる、30日の外の行（30日で消す表の行で、版の日付から30日を過ぎた物。今は既読だけがアプリの書く表）。
 * serverNow はクラウドから消す境と同じサーバーの時刻の見積もり（src/domain/jst.ts の estimateServerNow。7.8 の「30日で消す」）
 */
export function expiredBeforeSend(it: SendItem, serverNow: number): boolean {
  return isOneOf(EXPIRING_TABLES, it.table) && isExpiredDocId(docIdOf(it.table, it.id), serverNow)
}

/**
 * 送る必要が無い送信待ち（エンジンは書かずに送り終わりにする。DS の nothingToSend に TS の守りを足した）。
 * - アプリが書かない表の行・local が null の行: 書かない（削除の印を書かない。7.8）
 * - 30日の外の既読の行（serverNow を渡した時だけ。見積もりがまだ無い時は呼ぶ側が決める）: 送らずに捨てる（7.8）
 * - 送ったトランザクションの返事を受け取っていない行（unconfirmed）は、書き込みがクラウドに届いているかもしれないので、端末の中身が base と
 *   同じでも外さない（送る時にクラウドを読んで確かめ、同じなら書かずに終える。DS のまま）
 */
export function nothingToSend(it: SendItem, serverNow?: number | null): boolean {
  if (!isAppTable(it.table) || it.local === null) return true
  if (serverNow != null && expiredBeforeSend(it, serverNow)) return true
  return !it.unconfirmed && sameAsBase(it)
}

/** 送る物を選ぶ時の決まり */
export interface SelectOptions extends BatchLimits {
  /** サーバーの時刻の見積もり（30日の外の既読を送らない。無ければ守りをしない） */
  serverNow?: number | null
}

/**
 * 送る物を選ぶ。readOutbox が返した順に、上限に収まるだけ取る（送る必要が無い行は飛ばす）。
 * 1件だけで上限を超える時は、それだけを送る（DS のまま。TS のアプリの記録は小さいので、ふだんは起きない）
 */
export function selectBatch<T extends SendItem>(items: readonly T[], opts: SelectOptions): BatchEntry<T>[] {
  const out: BatchEntry<T>[] = []
  let chars = 0
  for (const it of items) {
    if (nothingToSend(it, opts.serverNow) || !it.local) continue
    const entry: BatchEntry<T> = { it, enc: encodeRecord(it.local), baseHash: hashRecord(it.base) }
    if (out.length && (chars + entry.enc.size > opts.maxChars || out.length + 1 > opts.maxDocs)) break
    out.push(entry)
    chars += entry.enc.size
    if (chars >= opts.maxChars || out.length >= opts.maxDocs) break
  }
  return out
}

/** クラウドの文書の状態（無い = exists: false） */
export interface CloudState {
  exists: boolean
  hash: string
}

export interface BatchDecision<T extends SendItem = SendItem> {
  /** batch と同じ順に、書くかどうか */
  write: boolean[]
  /** クラウドが先に変わっていて書けなかった物（受け取りで base が新しくなってから送り直す） */
  conflicts: T[]
}

/**
 * クラウドに無くて base がある時に、共通の履歴が無い物として作り直す表（消さない表。docs/SPEC.md の 7.8）。
 * 既読は入れない: 既読がクラウドに無いのはほかの端末が30日で消した時なので、作り直さずに、送る前の守り（expiredBeforeSend）と
 * 端末の中で消す expireBefore で捨てる
 */
const RECREATE_TABLES: ReadonlySet<TableName> = new Set<TableName>(['knownTerms'])

/**
 * 書く物を決める。1件ずつ、共通の履歴が無い物はクラウドに何も無い時、ほかは base の指紋がクラウドと同じ時に書く（DS のまま）。
 * 消さない表（知ってる）がクラウドに無く base がある時は、共通の履歴が無い物として書く（作り直す。7.8）
 */
export function decideBatch<T extends SendItem>(batch: readonly BatchEntry<T>[], cloud: readonly CloudState[]): BatchDecision<T> {
  const write = batch.map((b, i) => {
    const c = cloud[i]
    if (b.it.noHistory) return !c.exists
    if (!c.exists && b.baseHash !== '' && RECREATE_TABLES.has(b.it.table)) return true
    return (c.exists ? c.hash : '') === b.baseHash
  })
  const conflicts = batch.filter((_, i) => !write[i]).map((b) => b.it)
  return { write, conflicts }
}
