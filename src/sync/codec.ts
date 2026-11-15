// Firestore の文書の形（docs/SPEC.md の 7.7 の「1件の文書の形」）。1記録 = 1文書（users/{uid}/{置き場}/{表名}:{id}）。
// 記録はキーを並べ替えた JSON 文字列（stableStringify）にして json に入れる（端末の中の中身とそのまま比べられ、Firestore が扱えない値
// （undefined など）にも困らない）。外側の欄は DS・NS の RecordDoc と同じ8つ（{ table, id, json, chunks: 0, deleted: false, hash, updated,
// device }）にして、段階3のコネクタの書き込みの部品と同じ形にする（docs/SPEC.md の 7.7）。
// DS の src/sync/codec.ts を写し、TS の形に直した（docs/SPEC.md の 7.8 の「部品」）:
// - 分けた文書（_chunk・splitJson）を外した。どの記録も上限で 20万字以下で、DS の分ける境（25万字）に届かないため（7.7・7.9）
// - 削除の印（json: null・deleted: true）を外した。TS は削除の印を書かずに日付で本当に消す（7.8 の「30日で消す」）。届いた文書の
//   deleted が true・chunks が 0 でない物は、TS が書く形ではないので使わない（decodeDoc が断る）
// - 復元の印（reset）・月の束（itemPack）を外した（TS に復元と束の手入れが無い。16.5）
// - 置き場の割り当て placeOf を足した。既読（reads）は必ず Claude が読めない private、ほか（訂正 corrections も）は records（7.7・D21）
import { stableStringify } from '../domain/equal'
import { hashJson, recordHash } from '../domain/hash'
import { docIdOf, isOneOf, TABLE_NAMES, TABLE_PLACE, type Place, type RecordDoc, type TableName } from '../domain/types'

export { docIdOf, hashJson }
export type { Place, RecordDoc }

/** 記録の最小の形（id と、あればアプリの記録の最後に直した日時。docs/SPEC.md の 7.7 の「記録に共通の欄」） */
export type Rec = { id: string; updatedAt?: number }

/** 置き場の一覧（購読と、どこまで受け取ったかの印 _meta.cursor は置き場ごと。docs/SPEC.md の 7.8） */
export const PLACES: readonly Place[] = ['records', 'private']

/**
 * 表の置き場（docs/SPEC.md の 7.7 の「表の一覧」）。reads は必ず private、ほか（corrections も）は records。
 * 書く道（docPathOf）は必ずここを通すので、既読を Claude が読める置き場に書く誤りが起きない（D21）
 */
export function placeOf(table: TableName): Place {
  const place = TABLE_PLACE[table]
  // 表の名前の一覧に無い表は置き場が決まらない。records に落とすと、後で足す読み手の記録を Claude が読める所に書きうるので、書かずに止める
  if (!place) throw new Error(`置き場の決まっていない表です: ${String(table)}`)
  return place
}

/** 置き場の道（collection の道の区切り。users/{uid}/{置き場}） */
export function placePath(uid: string, place: Place): readonly [string, string, Place] {
  return ['users', uid, place]
}

/** 記録の文書の道（users/{uid}/{置き場}/{表名}:{id}。置き場は placeOf で決める） */
export function docPathOf(uid: string, table: TableName, id: string): readonly [string, string, Place, string] {
  return ['users', uid, placeOf(table), docIdOf(table, id)]
}

/** 文書の id（{表名}:{id}）から表と id に分ける（TS の id はコロンを含まないが、最初のコロンで分ける。表は知らない名前もそのまま返す） */
export function splitDocId(docId: string): { table: string; id: string } {
  const i = docId.indexOf(':')
  return i < 0 ? { table: docId, id: '' } : { table: docId.slice(0, i), id: docId.slice(i + 1) }
}

/** 記録の指紋（null = 無い時は ''。src/domain/hash.ts の recordHash。送る前に、クラウドが前にそろえた時のままかを比べる） */
export function hashRecord(rec: Rec | null | undefined): string {
  return rec ? recordHash(rec) : ''
}

/** 文書に入れる JSON とその指紋 */
export interface Encoded {
  json: string
  hash: string
  /** 書く量の目安（json の文字数。JS の文字列の長さ。RECORD_LIMITS.json と同じ数え方） */
  size: number
}

export function encodeJson(json: string): Encoded {
  return { json, hash: hashJson(json), size: json.length }
}

/** 記録をキーの順にそろえた JSON にする（コネクタも同じ stableStringify・hashJson なので同じ値になる。7.7） */
export function encodeRecord(rec: Rec): Encoded {
  return encodeJson(stableStringify(rec))
}

/** 外側の文書のうち、書く時に呼ぶ側が決める欄 */
export interface DocMeta<TUpdated> {
  /** 書いた端末の ID（コネクタは 'claude-connector'。アプリの書き込みはルールがコネクタの名前を断る） */
  device: string
  /** サーバー時刻（アプリは serverTimestamp()。ルールで == request.time。codec は Firebase に頼らないので型は呼ぶ側が決める） */
  updated: TUpdated
}

/** 符号にした記録から外側の文書を作る（8つの欄だけ。chunks は 0、deleted は false に決め打ち。ルールの appDoc と同じ。7.7） */
export function recordDocOf<TUpdated>(table: TableName, id: string, enc: Encoded, meta: DocMeta<TUpdated>): RecordDoc<TUpdated> {
  return { table, id, json: enc.json, chunks: 0, deleted: false, hash: enc.hash, updated: meta.updated, device: meta.device }
}

/** 記録から外側の文書を作る（id は記録の id） */
export function encodeDoc<TUpdated>(table: TableName, rec: Rec, meta: DocMeta<TUpdated>): RecordDoc<TUpdated> {
  return recordDocOf(table, rec.id, encodeRecord(rec), meta)
}

/**
 * 届いた文書を使わない理由。どれも TS が書く形ではないので、受け取りでは捨てて（記録にしない）、位置は進める
 * - shape: 外側の欄の型が違う（表・id・json・hash・device が文字でない など）
 * - table: 知らない表（private は表を絞らずに購読するので、後の版が足した表も届く。7.8）
 * - docId: 文書の id が '{表名}:{id}' でない
 * - place: 表の置き場と違う置き場にある（reads が records にある など。7.7）
 * - chunks: 分けた文書（TS は使わない）
 * - deleted: 削除の印（TS は書かない）
 * - hash: json の指紋が合わない
 * - json: json が記録の形（オブジェクト）でない・読めない
 * - id: json の中の id が外側の id と違う
 */
export type DecodeFailure = 'shape' | 'table' | 'docId' | 'place' | 'chunks' | 'deleted' | 'hash' | 'json' | 'id'

export type Decoded =
  | { ok: true; table: TableName; id: string; record: Rec; hash: string; device: string; updated: unknown }
  | { ok: false; reason: DecodeFailure }

export interface DecodeExpect {
  /** 文書の id（スナップショットの id。'{表名}:{id}' と合うかを確かめる） */
  docId?: string
  /** 読んだ置き場（表の置き場と合うかを確かめる） */
  place?: Place
}

const fail = (reason: DecodeFailure): Decoded => ({ ok: false, reason })

/**
 * 届いた文書（スナップショットの data()）から記録を取り出す。記録の中身は受け取ったまま（知らない値・知らない欄を消さない。
 * 表示用に直すのは src/domain/repair.ts。docs/SPEC.md の 7.8 の「版を出す条件」）
 */
export function decodeDoc(data: unknown, expect: DecodeExpect = {}): Decoded {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('shape')
  const d = data as Record<string, unknown>
  if (typeof d.table !== 'string' || typeof d.id !== 'string' || d.id === '') return fail('shape')
  if (typeof d.json !== 'string' || typeof d.hash !== 'string' || typeof d.device !== 'string') return fail('shape')
  if (!isOneOf(TABLE_NAMES, d.table)) return fail('table')
  const table = d.table
  if (expect.docId !== undefined && expect.docId !== docIdOf(table, d.id)) return fail('docId')
  if (expect.place !== undefined && TABLE_PLACE[table] !== expect.place) return fail('place')
  if (d.chunks !== 0) return fail('chunks')
  if (d.deleted !== false) return fail('deleted')
  if (hashJson(d.json) !== d.hash) return fail('hash')
  let rec: unknown
  try {
    rec = JSON.parse(d.json)
  } catch {
    return fail('json')
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return fail('json')
  if ((rec as { id?: unknown }).id !== d.id) return fail('id')
  return { ok: true, table, id: d.id, record: rec as Rec, hash: d.hash, device: d.device, updated: d.updated }
}
