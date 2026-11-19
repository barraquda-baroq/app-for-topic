// Claude 用のコネクタ（connector/ の Worker）が Firestore に送る問い合わせの形の一覧（CONNECTOR_QUERIES。設計の 2.3）。
// エミュレーターは索引を確かめないので、本番で落ちないよう、ここに並べた形を2つのテストで同じように読む:
// - src/sync/rules.emu.test.ts: 索引（firestore.indexes.json）と照らし、本番のルールで、記録されたコネクタがどの形でも引ける事
//   （エミュレーター。アプリの問い合わせの一覧 APP_QUERIES の隣）
// - コネクタの単体のテスト（connector/test/unit）: 問い合わせを組む関数が、この一覧に無い形を作らない事（connectorQueryShapeOf で
//   組んだ structuredQuery を形にして、findConnectorQuery で探す）
// 形は欄と演算と並びだけ（値・位置（startAt）・件数（limit）・取り出す欄（select）は入れない。索引の要る・要らないは、この3つで決まる）。
// 形を足した・変えた時は、ここに足し、索引が要れば firestore.indexes.json にも足す（docs/SPEC.md の 7.7 の「索引」）。
// ルールは絞り込みの代わりにならないので、どの形も表の絞り（table == か table in）を必ず持つ（7.7）。
// テストのためのファイル（コネクタのまとめた中身には入らない。connector/scripts/bundle-check.mjs が src/test/ を断る）

/** REST の口: runQuery（文書を読む）か、runAggregationQuery の COUNT（数だけ。1,000件ごとに読み取り1回） */
export type ConnectorQueryMethod = 'runQuery' | 'count'

/** where の1つの絞り（REST の fieldFilter の欄と演算） */
export interface QueryFilterShape {
  field: string
  op: 'EQUAL' | 'IN' | 'LESS_THAN' | 'LESS_THAN_OR_EQUAL' | 'GREATER_THAN' | 'GREATER_THAN_OR_EQUAL'
}

/** 問い合わせの形（値は入れない） */
export interface ConnectorQueryShape {
  method: ConnectorQueryMethod
  /** 置き場（コネクタが読めるのは records だけ。private はルールで読めない） */
  collection: 'records'
  /** where の絞り（AND で結ぶ。並びは問わない） */
  filters: readonly QueryFilterShape[]
  /** 並び（どれも ASCENDING。__name__ は文書の id） */
  orderBy: readonly string[]
}

export interface ListedConnectorQuery extends ConnectorQueryShape {
  /** テストの言葉に出す名前（何のための問い合わせか） */
  label: string
}

/**
 * コネクタの問い合わせの形の一覧（docs/SPEC.md の 7.7 の「写し」・設計の 1.9・2.3）。
 * - 写しの差分: 読ませる6つの表（src/domain/types.ts の CLAUDE_READ_TABLES）を table in で絞り、updated・__name__ の順に、前に読んだ
 *   位置（最後の文書の updated と名前）の後ろから読む（NS の mirror と同じ startAt。同じ時刻の文書を飛ばさない）。初めは位置なし。
 *   索引は table＋updated（アプリの購読と同じ。__name__ は複合の索引の後ろに自動で付く）
 * - 消えないはずの表（辞書の束・知ってる）の数: table == の COUNT（1つの欄の自動の索引）
 * - その表を名前で読み直す（数が写しより少ない時）: table == と __name__ の順（1つの欄の自動の索引。__name__ が後ろに付く）
 */
export const CONNECTOR_QUERIES: readonly ListedConnectorQuery[] = [
  {
    label: '写しの差分（table in [読ませる6つの表]・orderBy updated, __name__・位置から続ける）',
    method: 'runQuery',
    collection: 'records',
    filters: [{ field: 'table', op: 'IN' }],
    orderBy: ['updated', '__name__'],
  },
  {
    label: '消えないはずの表の数（辞書の束・知ってる。table == の COUNT）',
    method: 'count',
    collection: 'records',
    filters: [{ field: 'table', op: 'EQUAL' }],
    orderBy: [],
  },
  {
    label: '消えないはずの表を名前で読み直す（table ==・orderBy __name__・位置から続ける）',
    method: 'runQuery',
    collection: 'records',
    filters: [{ field: 'table', op: 'EQUAL' }],
    orderBy: ['__name__'],
  },
]

const FILTER_OPS = new Set<string>(['EQUAL', 'IN', 'LESS_THAN', 'LESS_THAN_OR_EQUAL', 'GREATER_THAN', 'GREATER_THAN_OR_EQUAL'])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const fieldPathOf = (v: unknown): string | null =>
  isObject(v) && typeof v.fieldPath === 'string' && v.fieldPath !== '' ? v.fieldPath : null

/** where の1つの fieldFilter を形にする（読めない・決まりの外の演算は null） */
function filterShapeOf(f: unknown): QueryFilterShape | null {
  if (!isObject(f) || !isObject(f.fieldFilter)) return null
  const field = fieldPathOf(f.fieldFilter.field)
  const op = f.fieldFilter.op
  if (!field || typeof op !== 'string' || !FILTER_OPS.has(op)) return null
  return { field, op: op as QueryFilterShape['op'] }
}

/**
 * REST の structuredQuery（runQuery の structuredQuery、runAggregationQuery の structuredAggregationQuery.structuredQuery）を形にする。
 * 読めない・この一覧の考えの外の物（from が1つの records でない・collection group（allDescendants）・OR・unaryFilter・
 * 知らない演算・DESCENDING の並び・知らない鍵）は null（一覧に無い形として断られる）。値・startAt・endAt・limit・offset・select は見ない
 */
export function connectorQueryShapeOf(method: ConnectorQueryMethod, structuredQuery: unknown): ConnectorQueryShape | null {
  if (!isObject(structuredQuery)) return null
  const known = new Set(['from', 'where', 'orderBy', 'startAt', 'endAt', 'limit', 'offset', 'select'])
  if (Object.keys(structuredQuery).some((k) => !known.has(k))) return null
  const from = structuredQuery.from
  if (!Array.isArray(from) || from.length !== 1 || !isObject(from[0])) return null
  if (from[0].collectionId !== 'records' || from[0].allDescendants === true) return null
  const filters: QueryFilterShape[] = []
  const where = structuredQuery.where
  if (where !== undefined) {
    if (!isObject(where)) return null
    if (where.fieldFilter !== undefined) {
      const one = filterShapeOf(where)
      if (!one) return null
      filters.push(one)
    } else if (isObject(where.compositeFilter)) {
      const c = where.compositeFilter
      if (c.op !== 'AND' || !Array.isArray(c.filters) || c.filters.length === 0) return null
      for (const f of c.filters) {
        const one = filterShapeOf(f)
        if (!one) return null
        filters.push(one)
      }
    } else return null
  }
  const orderBy: string[] = []
  if (structuredQuery.orderBy !== undefined) {
    if (!Array.isArray(structuredQuery.orderBy)) return null
    for (const o of structuredQuery.orderBy) {
      if (!isObject(o)) return null
      const field = fieldPathOf(o.field)
      if (!field || (o.direction !== undefined && o.direction !== 'ASCENDING')) return null
      orderBy.push(field)
    }
  }
  return { method, collection: 'records', filters, orderBy }
}

const filterKey = (f: QueryFilterShape) => `${f.field} ${f.op}`

/** 2つの形が同じか（絞りは並びを問わず、並びは順も同じ） */
export function sameConnectorQueryShape(a: ConnectorQueryShape, b: ConnectorQueryShape): boolean {
  const fa = a.filters.map(filterKey).sort()
  const fb = b.filters.map(filterKey).sort()
  return (
    a.method === b.method &&
    a.collection === b.collection &&
    fa.length === fb.length &&
    fa.every((k, i) => k === fb[i]) &&
    a.orderBy.length === b.orderBy.length &&
    a.orderBy.every((f, i) => f === b.orderBy[i])
  )
}

/** 組んだ structuredQuery が一覧のどの形か（一覧に無い・読めない形は null） */
export function findConnectorQuery(method: ConnectorQueryMethod, structuredQuery: unknown): ListedConnectorQuery | null {
  const shape = connectorQueryShapeOf(method, structuredQuery)
  if (!shape) return null
  return CONNECTOR_QUERIES.find((q) => sameConnectorQueryShape(q, shape)) ?? null
}
