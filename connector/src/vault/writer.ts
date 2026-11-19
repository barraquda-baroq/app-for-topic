// Firestore への書き込み（作るだけ）。NS の connector/src/vault/writer.ts を写し、TS の表と上限にした（設計の 1.1 の「書き込み」）。
// 書き換え・削除・分けた文書・削除の印は書かない（アクセスルールでも書けない）。
// - 書ける表は、コネクタが作る5つ（CONNECTOR_TABLES: 版・話題・訂正・辞書の束・作れなかった印）だけ。知ってる・既読は書かない
//   （既読の置き場 private は作らない。D21）
// - 1件の記録の json は表ごとの上限（RECORD_LIMITS.json。ルールの connectorCreate と同じ値）まで。id は表ごとの形（ID_PATTERNS）
// - 文書の形はアプリと同じ（src/sync/codec.ts の encodeRecord・recordDocOf の8つの欄）。updated はサーバー時刻（REQUEST_TIME）、
//   device は claude-connector
// - 「無い時だけ作る」（currentDocument.exists = false）。内容から作った id なので、同じ結果を2回送っても1つしかできない
// - 送る前に、アプリと同じ decodeDoc で読み戻せることを確かめる（アプリで「読み取れませんでした」にならないように）
// - 1回の commit は 100件まで（groups。TS の1回の呼び出しは話題5本と束で 100 に届かないが、NS の形のまま残す）
import { ID_PATTERNS, isRecordIdFor } from '../../../src/domain/ids'
import { RECORD_LIMITS } from '../../../src/domain/limits'
import {
  CONNECTOR_TABLES,
  type ConnectorTableName,
  type CorrectionRecord,
  type Edition,
  type EditionFail,
  type TermPack,
  type Topic,
} from '../../../src/domain/types'
import { decodeDoc, encodeRecord, placeOf, recordDocOf } from '../../../src/sync/codec'
import { stableStringify } from '../../../src/domain/equal'
import { CONNECTOR_DEVICE } from '../version'
import type { CommitResult, CommitWrite, FirestoreRest } from './firestore'
import type { MirrorRow } from './store'
import { timestampMicros, type Fields } from './values'

/** 1回の commit に入れる書き込みの数の上限（超える時は同じくらいの数の組に分ける） */
export const COMMIT_GROUP = 100

/** 書ける表（アクセスルールの connectorCreate と同じ5つ） */
export const WRITABLE_TABLES: ReadonlySet<string> = new Set<string>(CONNECTOR_TABLES)

/** 書く記録（表と記録） */
export type WritableRecord =
  | { table: 'editions'; record: Edition }
  | { table: 'topics'; record: Topic }
  | { table: 'corrections'; record: CorrectionRecord }
  | { table: 'termPacks'; record: TermPack }
  | { table: 'editionFails'; record: EditionFail }

export interface PreparedWrite {
  table: ConnectorTableName
  id: string
  json: string
  hash: string
  write: CommitWrite
}

export class EncodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncodeError'
  }
}

const LIMIT_LABEL: Record<ConnectorTableName, string> = {
  editions: '版',
  topics: '話題',
  corrections: '訂正',
  termPacks: '辞書の束',
  editionFails: '作れなかった印',
}

/** 記録を作る書き込みにする（表・id の形・json の上限・読み戻せない形は断る。ふつうは組み立てで断るので、ここは最後の守り） */
export function prepareWrite(fs: FirestoreRest, ownerUid: string, rec: WritableRecord): PreparedWrite {
  const table = rec.table
  if (!WRITABLE_TABLES.has(table)) throw new EncodeError(`表 ${String(table)} には書き込めません`)
  const record = rec.record as unknown as { id?: unknown }
  if (!isRecordIdFor(table as keyof typeof ID_PATTERNS, record.id)) throw new EncodeError('記録の id が不正です')
  const id = record.id as string
  // 置き場はいつも records（既読の private は書かない。placeOf が表から決める）
  if (placeOf(table) !== 'records') throw new EncodeError(`表 ${table} には書き込めません`)
  const enc = encodeRecord(rec.record as unknown as { id: string })
  const max = RECORD_LIMITS.json[table]
  if (enc.size > max)
    throw new EncodeError(
      `${LIMIT_LABEL[table]}の記録が大きすぎます（JSON にして ${enc.size.toLocaleString('ja-JP')}字。上限は ${max.toLocaleString('ja-JP')}字）`,
    )
  const doc = recordDocOf(table, id, enc, { device: CONNECTOR_DEVICE, updated: null })
  // アプリと同じ読み方で読み戻せること
  const back = decodeDoc(doc, { docId: `${table}:${id}`, place: 'records' })
  if (!back.ok || stableStringify(back.record) !== enc.json) throw new EncodeError('記録を読み戻せません')
  const docId = `${table}:${id}`
  const fields: Fields = {
    table: { stringValue: table },
    id: { stringValue: id },
    json: { stringValue: enc.json },
    chunks: { integerValue: '0' },
    deleted: { booleanValue: false },
    hash: { stringValue: enc.hash },
    device: { stringValue: CONNECTOR_DEVICE },
  }
  return {
    table,
    id,
    json: enc.json,
    hash: enc.hash,
    write: {
      update: { name: fs.name(`users/${ownerUid}/records/${docId}`), fields },
      updateTransforms: [{ fieldPath: 'updated', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: { exists: false },
    },
  }
}

/** 書けた記録を、写しの行にする（次の差分の読み取りを待たずに見えるように）。lite は呼ぶ側が作る（mirror.ts の liteOf） */
export function rowsOfCommit(
  prepared: readonly PreparedWrite[],
  result: CommitResult,
  liteOf: (p: PreparedWrite) => string,
): MirrorRow[] {
  return prepared.map((p, i) => {
    const wr = result.writeResults[i]
    const t = wr?.transformResults?.[0] as { timestampValue?: string } | undefined
    const updated = t?.timestampValue ?? result.commitTime
    return {
      name: `${p.table}:${p.id}`,
      tbl: p.table,
      id: p.id,
      updUs: timestampMicros(updated),
      updated,
      hash: p.hash,
      device: CONNECTOR_DEVICE,
      lite: liteOf(p),
    }
  })
}

/** size 件までの、いちばん少ない数の組に、同じくらいの数で分ける（101件なら 51件と 50件。最後の組が小さくならない） */
export function groups<T>(list: readonly T[], size = COMMIT_GROUP): T[][] {
  const n = Math.ceil(list.length / size)
  const base = Math.floor(list.length / Math.max(1, n))
  const extra = list.length % Math.max(1, n)
  const out: T[][] = []
  for (let k = 0, i = 0; k < n; k++) {
    const len = base + (k < extra ? 1 : 0)
    out.push(list.slice(i, i + len))
    i += len
  }
  return out
}
