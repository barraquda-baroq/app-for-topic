// 端末の中の保存（Dexie・IndexedDB。DB の名前は topic-studio。docs/SPEC.md の 3.・14.4・7.8）。段階0は端末だけの表 _meta（持ち主だと
// 確かめたアカウント ownerSeen）だけで、段階1でデータの表と送信待ち（_outbox）を version(2) で足した（v1 はもう端末にあるので変えない。
// docs/SPEC.md の 7.8 の「端末の表（Dexie v2）」）。
//
// DS の src/db/persistence.ts を手本にし、TS の形（docs/SPEC.md の 7.7・7.8）に直した:
// - アプリが書くのは「知ってる」（knownTerms）と既読（reads）だけ。端末への書き込みと送信待ちへの積み込みは同じトランザクションでする。
//   コネクタが作る記録（版・話題・訂正・作れなかった印）は、受け取ったまま（知らない欄も）入れるだけで、送信待ちに積まない
// - アプリの記録は消さない（削除の印を書かない）。30日を過ぎた行は期限の専用の関数 expireBefore で、データの行と同じ鍵の送信待ちの行を
//   一緒に消す（送信待ちに積まない。DS の delLocal は使わない）
// - 受け取った位置（_meta の cursor）は置き場（records・private）ごとに、反映と同じトランザクションで書く
// - 話題と訂正は開く分だけ読む（版ごと・話題ごと）。アプリの記録と版の一覧は全部を読める（docs/SPEC.md の 7.8 の「画面の状態の持ち方」）
// - DS の受け取り箱のまとまり（g）・復元（force・replaceAll）・ゴミ箱の控え・_gone・_pack・親子の片付け・dropMissing は写さない
//   （TS には削除の印も受け取り箱も無い。docs/SPEC.md の 16.5）
//
// 守ること（DS と同じ）: 送信待ちに無い記録は「端末の中 = 最後に知ったクラウドの内容」、送信待ちにあれば「base = 最後に知ったクラウドの内容」。

import Dexie, { type Table } from 'dexie'
import { contentEqual, deepEqual } from '../domain/equal'
import { isYmd } from '../domain/jst'
import { EXPIRING_TABLES, isOneOf, USER_TABLES, type Place, type TableName, type UserTableName } from '../domain/types'
import { mergeRemote } from '../sync/merge'

export const DEFAULT_DB_NAME = 'topic-studio'

/**
 * Dexie v1 の表の一覧（段階0で端末に入った。変えない）。
 * _meta は端末だけの覚え書き（同期しない。key と value）
 */
export const V1_SCHEMA: Record<string, string> = {
  _meta: 'key',
}

/**
 * Dexie v2 で足す表（docs/SPEC.md の 7.8 の「端末の表（Dexie v2）」）。表の名前の一覧（TABLE_NAMES）から作らずに固定の一覧で書く
 * （表を足した時に v2 の形が変わってしまわないように。段階1を公開した後に表や索引を足すなら v3 を作る）。
 * 索引は記録の上の段の欄: 訂正の topicId は話題に付けて出すため、editionId は開いている版の訂正をまとめて読むため。
 * termPacks は入れない（辞書は Claude 用で、アプリは受け取らない。7. の要点の 7）。新しい表は空なので upgrade() は要らない
 */
export const V2_ADDED: Record<string, string> = {
  editions: 'id, date',
  topics: 'id, editionId, threadId',
  corrections: 'id, topicId, editionId',
  editionFails: 'id, editionId',
  knownTerms: 'id',
  reads: 'id',
  _outbox: 'k',
}

/** 端末に入れる表（V2_ADDED のデータの表と同じ並び。termPacks は入れない） */
export const LOCAL_TABLES = ['editions', 'topics', 'corrections', 'editionFails', 'knownTerms', 'reads'] as const
export type LocalTableName = (typeof LOCAL_TABLES)[number]

/** コネクタが作る記録の表のうち、端末に入れる物（アプリは書かない・送信待ちに積まない。docs/SPEC.md の 7.8） */
export const CONNECTOR_LOCAL_TABLES = ['editions', 'topics', 'corrections', 'editionFails'] as const
export type ConnectorLocalTableName = (typeof CONNECTOR_LOCAL_TABLES)[number]

const LOCAL_SET: ReadonlySet<string> = new Set(LOCAL_TABLES)
const USER_SET: ReadonlySet<string> = new Set(USER_TABLES)

/** 端末に入れる表か（termPacks・知らない表は入れない） */
export const isLocalTable = (t: string): t is LocalTableName => LOCAL_SET.has(t)

/** アプリが作る・直す表か（knownTerms・reads。送信待ちに積むのはこの表だけ） */
export const isUserTable = (t: string): t is UserTableName => USER_SET.has(t)

/** 端末に入れた記録（受け取ったまま。知らない欄も残す。表示用に直すのは src/domain/repair.ts） */
export type AnyRecord = { id: string; updatedAt?: number }

/** 送信待ちの1件の鍵（`${表名}/${id}`） */
export const outboxKey = (table: string, id: string): string => `${table}/${id}`

// ---------- _meta（端末だけ。docs/SPEC.md の 7.8 の「_meta（端末だけ）」） ----------

/** 受け取った位置（文書の updated のサーバー時刻。秒とナノ秒。DS と同じ） */
export interface SyncCursor {
  s: number
  n: number
}

/** 置き場ごとの、どこまで受け取ったかの印（_meta の cursor） */
export type StoredCursors = Partial<Record<Place, SyncCursor>>

/** 初めての受け取りの 1.（「知ってる」を読む）を終えた印（2. を終えたら消す。docs/SPEC.md の 7.8 の「版と話題を受け取る」） */
export interface FirstSync {
  /** 1. を終えた時刻（端末の時計・ミリ秒） */
  knownAt: number
}

/** _meta の鍵と中身（null は「無い」の印。段階0の setMeta('ownerSeen', null) と同じ） */
export interface MetaValues {
  /** この端末で持ち主だと確かめた uid（段階0のまま） */
  ownerSeen: string | null
  /** 端末の ID（UUID） */
  deviceId: string | null
  /** 最後に同期したアカウントと、そのメールのアドレス（別のアカウントの確かめに出す） */
  uid: string | null
  uidEmail: string | null
  cursor: StoredCursors | null
  /** 最後にクラウドとそろった時刻（端末の時計・ミリ秒。1時間に1回まで書く） */
  caughtUpAt: number | null
  firstSync: FirstSync | null
  /** 同期の形の版（違えば位置を消して初めから受け取る） */
  syncSchema: number | null
  /** 30日の手入れを最後にした日（日本時間の 'YYYY-MM-DD'） */
  lastMaintainDay: string | null
}
export type MetaKey = keyof MetaValues

/** _meta の鍵の一覧（docs/SPEC.md の 7.8 の表と同じ並び） */
export const META_KEYS: readonly MetaKey[] = [
  'ownerSeen',
  'deviceId',
  'uid',
  'uidEmail',
  'cursor',
  'caughtUpAt',
  'firstSync',
  'syncSchema',
  'lastMaintainDay',
]

/** 反映と同じトランザクションで書く _meta（位置は cursor で置き場ごとに渡すので、ここには入れない） */
export type MetaPatch = { [K in Exclude<MetaKey, 'cursor'>]?: MetaValues[K] }

interface MetaRow {
  key: string
  value: unknown
}

// ---------- 送信待ち（_outbox。docs/SPEC.md の 7.8） ----------

/**
 * 送信待ちの1行。DS の OutboxRow から、受け取り箱のまとまり g と復元の force を外した物（docs/SPEC.md の 7.8 の「端末の表」）。
 * k = `${表名}/${id}`。積むのはアプリの表（knownTerms・reads）だけ
 */
export interface OutboxRow {
  k: string
  t: UserTableName
  id: string
  /** 最後にクラウドとそろえた時の内容（null = その時クラウドに無かった） */
  base: AnyRecord | null
  /** クラウドとの共通の履歴が無い（初めてのログイン・アカウントの切り替え・クラウドで消えていた記録の作り直し） */
  noHistory?: boolean
  /**
   * この行を送るトランザクションを始めたが、返事を受け取っていない（書き込みがクラウドに届いたかもしれない）。端末の中が base と同じに
   * なっても、クラウドを確かめるまで送り終わりにしない。クラウドの内容から base を書き直す時は、この印の無い行に置き換わる（DS と同じ）
   */
  unconfirmed?: boolean
  /**
   * 返事を受け取れなかった送るトランザクションの id と、そのトランザクションで送った内容（unconfirmed の時だけ）。クラウドの送る書き込みの
   * 印（users/{uid}/sync/{端末の ID}）がこの id なら、その書き込みは届いていて、送った内容が新しい base になる（confirmLanded）
   */
  tx?: string
  sent?: AnyRecord | null
  /** 積んだ時刻（端末の時計） */
  at: number
}

/** 送るための1件（送信待ちの行と、いまの端末の中の内容） */
export interface OutboxItem {
  k: string
  table: UserTableName
  id: string
  base: AnyRecord | null
  noHistory: boolean
  unconfirmed?: boolean
  tx?: string
  sent?: AnyRecord | null
  /** いまの端末の中の内容（null = 端末に無い。TS はアプリの記録をクラウドで消さないので、書かずに送り終わりにする） */
  local: AnyRecord | null
}

/** 送るトランザクションで書く送信待ち（markUnconfirmed）。key = `${表名}/${id}`、record = 送る内容 */
export interface SentRow {
  key: string
  record: AnyRecord | null
}

/** 1件の変化（record = null はクラウドに無い） */
export interface Change {
  table: TableName
  id: string
  record: AnyRecord | null
  /** クラウドから: この端末が書いた物（返事を受け取れなかった書き込みなど）。端末の中はそれより新しいので、base だけ進める */
  own?: boolean
}

// ---------- 3者マージ（docs/SPEC.md の 7.8 の「既読・知ってるを送る・受け取る」） ----------

/**
 * アプリの記録1件の3者マージ（base = 最後にそろえた中身、mine = この端末、theirs = クラウド）。mine・theirs は両方ある時だけ呼ぶ
 * （無い時の扱いは persistence が決める）。テストでは別の合わせ方を渡して、端末の保存だけを確かめられる
 */
export type MergeRecord = (
  table: UserTableName,
  base: AnyRecord | null,
  mine: AnyRecord,
  theirs: AnyRecord,
  opts: { noHistory?: boolean },
) => AnyRecord

/**
 * 既定の3者マージ: 同期と同じ src/sync/merge.ts の mergeRemote（DS の persistence も同期の merge をそのまま使う）。表ごとの合わせ方
 * （既読の seen はどちらかが true なら true・topicIds は並びのマージ、知ってるの on・term は1組・asOf は新しい方、共通の履歴が無い時は
 * クラウドを正とし並びは足し合わせる）を、端末の別のタブの保存とクラウドの反映の両方に当てる（docs/SPEC.md の 7.8 の
 * 「既読・知ってるを送る・受け取る」）。決まりを持たない合わせ方を既定にすると、2台で既読を付けた時に片方の seen が消えるため。
 * mine・theirs が両方ある時の mergeRemote は null を返さないが、型のために theirs で受ける
 */
export const syncMerge: MergeRecord = (table, base, mine, theirs, opts) =>
  mergeRemote(table, base, mine, theirs, opts).record ?? theirs

// ---------- 保存の口 ----------

/** アプリの記録（メモリに持つ分。docs/SPEC.md の 7.8 の「画面の状態の持ち方」） */
export interface UserRecords {
  knownTerms: Record<string, AnyRecord>
  reads: Record<string, AnyRecord>
}

export const emptyUserRecords = (): UserRecords => ({ knownTerms: {}, reads: {} })

/** 保存した時に、別のタブ（または同期を受け持つ画面が反映したほかの端末の変更）が先に書き換えていた記録をどう扱ったか */
export interface SaveOutcome {
  /** 別のタブの変更とこのタブの変更を合わせて書いた記録 */
  merged: Partial<Record<UserTableName, AnyRecord[]>>
  /** 端末から消えていた（30日を過ぎて expireBefore で消した既読）ので、戻さずに書かなかった記録 */
  dropped: Partial<Record<UserTableName, string[]>>
  /** 実際に書いた内容 */
  written: Change[]
}

export interface RemoteApplyOptions {
  /** 受け取った位置。同じトランザクションで、_meta の cursor のその置き場だけを書き直す（ほかの置き場の位置は変えない） */
  cursor?: { place: Place; at: SyncCursor }
  /** 同じトランザクションで書く _meta（初めての受け取りで caughtUpAt を書き firstSync を消す など。null を書くと「無い」） */
  meta?: MetaPatch
}

/** 期限で消した物（docs/SPEC.md の 7.8 の「端末の中で消す」） */
export interface ExpireOutcome {
  /** 消したデータの行（record はいつも null） */
  removed: Change[]
  /** 一緒に消した送信待ちの鍵 */
  outbox: string[]
}

export interface PersistenceOptions {
  /** アプリの記録の3者マージ（渡さなければ syncMerge = src/sync/merge.ts の mergeRemote。テストで差し替える時だけ渡す） */
  merge?: MergeRecord
}

export interface Persistence {
  /** 端末だけの覚え書き（_meta）を読む（無ければ undefined） */
  getMeta<T>(key: string): Promise<T | undefined>
  /** 端末だけの覚え書き（_meta）を書く */
  setMeta(key: string, value: unknown): Promise<void>
  /** その置き場の受け取った位置だけを書き直す（null で消す。ほかの置き場の位置は変えない） */
  setCursor(place: Place, at: SyncCursor | null): Promise<void>

  /** アプリの記録（知ってる・既読）を全部読む */
  loadUserRecords(): Promise<UserRecords>
  /** 版を全部読む（30日で 60件ほど。id の順 = 古い順） */
  listEditions(): Promise<AnyRecord[]>
  /** 作れなかった印を全部読む（0〜数件） */
  listEditionFails(): Promise<AnyRecord[]>
  /** 訂正を全部読む（30日で多くて百件ほど。「前に見た後に足された訂正」を createdAt で選ぶ時に使う） */
  listCorrections(): Promise<AnyRecord[]>
  /** その版の話題（話題は 1本 約1万バイト × 1,200 なので、開く分だけ読む） */
  topicsOfEdition(editionId: string): Promise<AnyRecord[]>
  /** その続報のつながりの話題（同じ threadId） */
  topicsOfThread(threadId: string): Promise<AnyRecord[]>
  /** 話題を id で読む（ids と同じ並びで、端末に無ければ null。版の order の話題がそろったかを見る） */
  getTopics(ids: readonly string[]): Promise<(AnyRecord | null)[]>
  /** その話題の訂正 */
  correctionsOfTopic(topicId: string): Promise<AnyRecord[]>
  /** その版の話題の訂正（開いている版の訂正をまとめて読む） */
  correctionsOfEdition(editionId: string): Promise<AnyRecord[]>

  /**
   * prev（このタブが最後に保存した内容）から next への差分（参照が変わった記録）を書き、同じトランザクションで送信待ちに積む。
   * 保存先の記録が prev と違っていたら（別のタブ・ほかの端末の反映が先に書いた）、3者マージで合わせる。next に無い記録は消さない
   * （アプリの記録は消さない。30日を過ぎた既読は expireBefore が消す）
   */
  save(prev: UserRecords, next: UserRecords): Promise<SaveOutcome>
  /**
   * クラウドの変化を反映する（送信待ちのあるアプリの記録は3者マージ）。opts の位置と _meta は同じトランザクションで書く。
   * 実際に書いた内容を返す
   */
  applyRemote(changes: readonly Change[], opts?: RemoteApplyOptions): Promise<Change[]>
  /** 送信待ち（最大 limit 件。鍵の順）と、いまの端末の中の内容 */
  readOutbox(limit: number): Promise<OutboxItem[]>
  /** 送った内容を記録する。送った後に端末の中で変わっていなければ送信待ちから外す（local が null の行も、ここで送り終わりにする） */
  completeUpload(sent: readonly Change[]): Promise<void>
  /** 送るトランザクションで書く送信待ちに、送る前に「返事を受け取るまでクラウドが base のままか分からない」と印を付ける */
  markUnconfirmed(rows: readonly SentRow[], tx: string): Promise<void>
  /** 印の付いた送信待ちのうち、keys の物のトランザクションの id */
  unconfirmedTx(keys: readonly string[]): Promise<Set<string>>
  /** トランザクション tx の書き込みは届いていた: その印の付いた送信待ちを、送った返事を受け取った時（completeUpload）と同じにする */
  confirmLanded(tx: string): Promise<void>
  outboxCount(): Promise<number>
  /** 送信待ちのある記録の鍵（`${表名}/${id}`） */
  outboxKeys(): Promise<Set<string>>
  /**
   * 前に別のアカウントで使っていた端末・初めて同期する端末: アプリの記録（知ってる・既読）を全部「共通の履歴が無い」送信待ちにし、
   * Claude の記録の写し（版・話題・訂正・作れなかった印）は端末から消して受け取り直す（ルールでアプリから作れないので、送らない）。
   * 受け取った位置・caughtUpAt・firstSync も同じトランザクションで消す（写しを消したのに位置が残って、古い記録が届かない事が無いように）
   */
  markAllDirty(): Promise<void>
  /**
   * 30日の外の行を端末から消す: 版の日付が firstKeptDate より前の版・話題・訂正・作れなかった印・既読の行と、同じ鍵の送信待ちの行を
   * 同じトランザクションで消す。送信待ちには積まない（削除の印を書かない）。firstKeptDate は端末の時計の
   * retentionBoundary(今).firstKeptDate（src/domain/jst.ts）
   */
  expireBefore(firstKeptDate: string): Promise<ExpireOutcome>
  close(): void
}

class TopicDB extends Dexie {
  constructor(name: string) {
    super(name)
    this.version(1).stores(V1_SCHEMA)
    this.version(2).stores(V2_ADDED)
  }

  tableOf(name: LocalTableName): Table<AnyRecord, string> {
    return this.table(name)
  }

  get outbox(): Table<OutboxRow, string> {
    return this.table('_outbox')
  }

  get meta(): Table<MetaRow, string> {
    return this.table('_meta')
  }
}

/** 送信待ちの行を書き直す（base を書き直す時は返事待ちの印と、その書き込みの id・送った内容を外す。DS の rewriteRow と同じ） */
function rewriteRow(row: OutboxRow, patch: Partial<OutboxRow>): OutboxRow {
  const next: OutboxRow = { ...row, ...patch }
  if ('base' in patch && !('unconfirmed' in patch)) {
    delete next.unconfirmed
    delete next.tx
    delete next.sent
  }
  for (const f of ['noHistory', 'unconfirmed', 'tx'] as const) if (!next[f]) delete next[f]
  if (!next.tx) delete next.sent
  return next
}

/** 受け取った記録を端末に入れてよいか（主キーの id が文書の id と同じ物だけ。壊れた1件で反映のトランザクション全体を止めないように） */
const storable = (ch: Change): boolean =>
  ch.record === null ||
  (typeof ch.record === 'object' && !Array.isArray(ch.record) && (ch.record as { id?: unknown }).id === ch.id)

export function createPersistence(dbName = DEFAULT_DB_NAME, options: PersistenceOptions = {}): Persistence {
  const db = new TopicDB(dbName)
  const merge = options.merge ?? syncMerge
  const localTables = () => LOCAL_TABLES.map((t) => db.tableOf(t))
  const userTables = () => USER_TABLES.map((t) => db.tableOf(t))

  /** 送信待ちの行と、いまの端末の中の内容（keys の順。アプリの表でない行は飛ばす） */
  async function itemsOf(keys: readonly string[]): Promise<OutboxItem[]> {
    if (!keys.length) return []
    const rows = (await db.outbox.bulkGet([...keys])).filter((r): r is OutboxRow => Boolean(r) && isUserTable(r!.t))
    const items = new Map<string, OutboxItem>()
    for (const t of USER_TABLES) {
      const list = rows.filter((r) => r.t === t)
      if (!list.length) continue
      const locals = await db.tableOf(t).bulkGet(list.map((r) => r.id))
      list.forEach((r, i) =>
        items.set(r.k, {
          k: r.k,
          table: t,
          id: r.id,
          base: r.base,
          noHistory: Boolean(r.noHistory),
          ...(r.unconfirmed ? { unconfirmed: true } : {}),
          ...(r.tx ? { tx: r.tx, sent: r.sent ?? null } : {}),
          local: locals[i] ?? null,
        }),
      )
    }
    return keys.map((k) => items.get(k)).filter((x): x is OutboxItem => Boolean(x))
  }

  /** 置き場の位置を書き直す（トランザクションの中で呼ぶ。ほかの置き場の位置は残す） */
  async function writeCursor(place: Place, at: SyncCursor | null): Promise<void> {
    const cur = ((await db.meta.get('cursor'))?.value ?? null) as StoredCursors | null
    const next: StoredCursors = { ...(cur ?? {}) }
    if (at) next[place] = at
    else delete next[place]
    await db.meta.put({ key: 'cursor', value: Object.keys(next).length ? next : null })
  }

  /** クラウドの変化を反映する（applyRemote のトランザクションの中） */
  async function applyRemoteTx(changes: readonly Change[], written: Change[]): Promise<void> {
    const put = async (table: LocalTableName, record: AnyRecord) => {
      await db.tableOf(table).put(record)
      written.push({ table, id: record.id, record })
    }
    const del = async (table: LocalTableName, id: string) => {
      await db.tableOf(table).delete(id)
      written.push({ table, id, record: null })
    }
    for (const ch of changes) {
      // 辞書の束（termPacks）と知らない表は端末に入れない（7. の要点の 7）
      if (!isLocalTable(ch.table)) continue
      if (!storable(ch)) {
        console.warn('受け取った記録の id が文書と違うので、端末に入れません', ch.table, ch.id)
        continue
      }
      const disk = (await db.tableOf(ch.table).get(ch.id)) ?? null
      if (!isUserTable(ch.table)) {
        // コネクタの記録: アプリは書かないので、端末の中はいつもクラウドと同じ。受け取ったまま（知らない欄も）入れる
        if (ch.record) {
          if (!deepEqual(disk, ch.record)) await put(ch.table, ch.record)
        } else if (disk) await del(ch.table, ch.id)
        continue
      }
      const k = outboxKey(ch.table, ch.id)
      const queued = await db.outbox.get(k)
      if (!ch.record) {
        // クラウドに無い（ほかの端末が30日で消した・誰かが Firebase の画面で消した）。アプリの記録は端末から消さない（30日を過ぎた既読は
        // expireBefore が消す）。消さない表（知ってる）の送信待ちは、共通の履歴が無い物として作り直す（base が古いまま書けずに残り続けない
        // ように）。既読は作り直さない: 送る前の守り（30日の外の既読を送らない）と expireBefore で捨てる（docs/SPEC.md の 7.8 の
        // 「既読・知ってるを送る・受け取る」。src/sync/batch.ts の decideBatch が作り直すのも知ってるだけ）
        if (queued) {
          if (!disk) await db.outbox.delete(k)
          else if (!isOneOf(EXPIRING_TABLES, ch.table)) await db.outbox.put(rewriteRow(queued, { base: null, noHistory: true }))
        }
        continue
      }
      if (!queued) {
        if (!deepEqual(disk, ch.record)) await put(ch.table, ch.record)
        continue
      }
      // この端末が書いた物（返事を受け取れなかった書き込み）: 端末の中はそれより新しいので、base だけ進める
      if (ch.own) {
        if (deepEqual(disk, ch.record)) await db.outbox.delete(k)
        else await db.outbox.put(rewriteRow(queued, { base: ch.record, noHistory: undefined }))
        continue
      }
      // 送信待ちのある記録は3者マージする（送信待ちはあるが端末に無い時は、ふつうは起きないが、クラウドの内容を入れて送り終わりにする）
      let result = disk ? merge(ch.table, queued.base, disk, ch.record, { noHistory: Boolean(queued.noHistory) }) : ch.record
      // クラウドと同じ中身になったら、クラウドの記録そのものを使う（直した日時まで端末とクラウドをそろえる）
      if (contentEqual(result, ch.record)) result = ch.record
      if (!deepEqual(result, disk)) await put(ch.table, result)
      // クラウドの内容が新しい base。合わせた結果がクラウドと同じなら送る物は無い
      if (deepEqual(result, ch.record)) await db.outbox.delete(k)
      else await db.outbox.put(rewriteRow(queued, { base: ch.record, noHistory: undefined }))
    }
  }

  /**
   * 送った内容を記録する（completeUpload・confirmLanded）。送った後にこの端末で変わっていなければ送り終わり。変わっていれば、送った内容を
   * 新しい base にして残す。onlyTx = その id のトランザクションの印の付いた行だけ（トランザクションの中で読み直して確かめる）
   */
  async function completeSent(sent: readonly Change[], onlyTx?: string): Promise<void> {
    const mine = sent.filter((s) => isUserTable(s.table))
    if (!mine.length) return
    await db.transaction('rw', [...userTables(), db.outbox], async () => {
      for (const s of mine) {
        const table = s.table as UserTableName
        const k = outboxKey(table, s.id)
        const row = await db.outbox.get(k)
        if (!row || (onlyTx !== undefined && row.tx !== onlyTx)) continue
        const disk = (await db.tableOf(table).get(s.id)) ?? null
        if (deepEqual(disk, s.record)) await db.outbox.delete(k)
        else await db.outbox.put(rewriteRow(row, { base: s.record, noHistory: undefined }))
      }
    })
  }

  const readAll = (table: LocalTableName) => db.tableOf(table).toArray()
  const readBy = (table: LocalTableName, index: string, value: string) => db.tableOf(table).where(index).equals(value).toArray()

  return {
    async getMeta<T>(key: string) {
      return (await db.meta.get(key))?.value as T | undefined
    },

    async setMeta(key, value) {
      await db.meta.put({ key, value })
    },

    setCursor(place, at) {
      return db.transaction('rw', db.meta, () => writeCursor(place, at))
    },

    loadUserRecords() {
      return db.transaction('r', userTables(), async () => {
        const out = emptyUserRecords()
        for (const t of USER_TABLES) for (const r of await db.tableOf(t).toArray()) out[t][r.id] = r
        return out
      })
    },

    listEditions: () => readAll('editions'),
    listEditionFails: () => readAll('editionFails'),
    listCorrections: () => readAll('corrections'),
    topicsOfEdition: (editionId) => readBy('topics', 'editionId', editionId),
    topicsOfThread: (threadId) => readBy('topics', 'threadId', threadId),
    correctionsOfTopic: (topicId) => readBy('corrections', 'topicId', topicId),
    correctionsOfEdition: (editionId) => readBy('corrections', 'editionId', editionId),

    async getTopics(ids) {
      if (!ids.length) return []
      return (await db.tableOf('topics').bulkGet([...ids])).map((r) => r ?? null)
    },

    async save(prev, next) {
      const work: { table: UserTableName; puts: AnyRecord[] }[] = []
      for (const t of USER_TABLES) {
        const a = prev[t]
        const b = next[t]
        if (a === b) continue
        const puts: AnyRecord[] = []
        for (const id in b) if (a[id] !== b[id]) puts.push(b[id])
        if (puts.length) work.push({ table: t, puts })
      }
      const outcome: SaveOutcome = { merged: {}, dropped: {}, written: [] }
      if (!work.length) return outcome
      const at = Date.now()
      // 端末への書き込みと送信待ちへの積み込みを1つのトランザクションでする（記録だけが書けて送信待ちが無い、という形を作らない。
      // docs/SPEC.md の 7.8 の「既読・知ってるを送る・受け取る」）
      await db.transaction('rw', [...work.map((x) => db.tableOf(x.table)), db.outbox], async () => {
        for (const job of work) {
          const table = db.tableOf(job.table)
          const base = prev[job.table]
          const ids = job.puts.map((r) => r.id)
          const onDisk = await table.bulkGet(ids)
          const queued = await db.outbox.bulkGet(ids.map((id) => outboxKey(job.table, id)))
          const toWrite: AnyRecord[] = []
          const enqueue: OutboxRow[] = []
          job.puts.forEach((mine, i) => {
            const before = base[mine.id] ?? null
            const disk = onDisk[i] ?? null
            if (before && !disk) {
              // 別のタブが期限で消していた（30日を過ぎた既読）: 戻さない
              ;(outcome.dropped[job.table] ??= []).push(mine.id)
              return
            }
            let record = mine
            if (disk && !deepEqual(disk, before)) {
              // 保存先が prev と違う（別のタブ・ほかの端末の反映が先に書いた。新しく作ったつもりの記録が保存先にもうあった時も）:
              // 同期と同じ決まりで、このタブが変えた所を重ねる
              record = merge(job.table, before, mine, disk, {})
              ;(outcome.merged[job.table] ??= []).push(record)
            }
            if (deepEqual(record, disk)) return
            toWrite.push(record)
            outcome.written.push({ table: job.table, id: record.id, record })
            if (!queued[i]) enqueue.push({ k: outboxKey(job.table, record.id), t: job.table, id: record.id, base: disk, at })
          })
          if (enqueue.length) await db.outbox.bulkPut(enqueue)
          if (toWrite.length) await table.bulkPut(toWrite)
        }
      })
      return outcome
    },

    async applyRemote(changes, opts = {}) {
      const written: Change[] = []
      await db.transaction('rw', [...localTables(), db.outbox, db.meta], async () => {
        await applyRemoteTx(changes, written)
        if (opts.cursor) await writeCursor(opts.cursor.place, opts.cursor.at)
        for (const [key, value] of Object.entries(opts.meta ?? {})) {
          if (value !== undefined) await db.meta.put({ key, value })
        }
      })
      return written
    },

    readOutbox(limit) {
      // 送信待ちの鍵・行・端末の中の内容を1つの読み取りのトランザクションで読む（読んでいる途中に保存が入って混ざらないように）
      return db.transaction('r', [db.outbox, ...userTables()], async () => {
        const keys = (await db.outbox.toCollection().primaryKeys()).map(String)
        return itemsOf(keys.slice(0, Math.max(0, limit)))
      })
    },

    completeUpload(sent) {
      return completeSent(sent)
    },

    async markUnconfirmed(sent, tx) {
      if (!sent.length) return
      await db.transaction('rw', db.outbox, async () => {
        const rows = await db.outbox.bulkGet(sent.map((s) => s.key))
        const marked: OutboxRow[] = []
        rows.forEach((r, i) => {
          if (r) marked.push(rewriteRow(r, { unconfirmed: true, tx, sent: sent[i].record }))
        })
        if (marked.length) await db.outbox.bulkPut(marked)
      })
    },

    async unconfirmedTx(keys) {
      const out = new Set<string>()
      if (!keys.length) return out
      for (const r of await db.outbox.bulkGet([...keys])) if (r?.unconfirmed && r.tx) out.add(r.tx)
      return out
    },

    async confirmLanded(tx) {
      const rows = await db.outbox.filter((r) => r.tx === tx).toArray()
      const sent = rows.filter((r) => isUserTable(r.t)).map((r): Change => ({ table: r.t, id: r.id, record: r.sent ?? null }))
      if (sent.length) await completeSent(sent, tx)
    },

    outboxCount() {
      return db.outbox.count()
    },

    async outboxKeys() {
      return new Set((await db.outbox.toCollection().primaryKeys()).map(String))
    },

    async markAllDirty() {
      const at = Date.now()
      await db.transaction('rw', [...localTables(), db.outbox, db.meta], async () => {
        // 前のアカウントのクラウドに送った、返事の無い書き込みの印も外す（共通の履歴が無いので base も無い）
        const old = await db.outbox.toArray()
        const rows = new Map<string, OutboxRow>()
        for (const r of old) {
          if (!isUserTable(r.t)) continue
          rows.set(r.k, { k: r.k, t: r.t, id: r.id, base: null, noHistory: true, at: r.at })
        }
        for (const t of USER_TABLES) {
          for (const key of await db.tableOf(t).toCollection().primaryKeys()) {
            const id = String(key)
            const k = outboxKey(t, id)
            rows.set(k, { k, t, id, base: null, noHistory: true, at: rows.get(k)?.at ?? at })
          }
        }
        await db.outbox.clear()
        if (rows.size) await db.outbox.bulkPut([...rows.values()])
        // Claude の記録の写しは消して、このアカウントのクラウドから受け取り直す（位置も消して、初めての受け取りから）
        for (const t of CONNECTOR_LOCAL_TABLES) await db.tableOf(t).clear()
        await db.meta.bulkPut([
          { key: 'cursor', value: null },
          { key: 'caughtUpAt', value: null },
          { key: 'firstSync', value: null },
        ])
      })
    },

    async expireBefore(firstKeptDate) {
      // 境の形が違うと、範囲が広がって30日の内の行まで消えるので断る
      if (!isYmd(firstKeptDate)) throw new Error(`30日の境の日付の形が違います（${firstKeptDate}）`)
      const out: ExpireOutcome = { removed: [], outbox: [] }
      await db.transaction('rw', [...EXPIRING_TABLES.map((t) => db.tableOf(t)), db.outbox], async () => {
        for (const t of EXPIRING_TABLES) {
          // どの id も版の id（'YYYY-MM-DD-12|20'）で始まるので、id の範囲で切れる（訂正は話題の id で始まるので、話題と同じ日に消える。
          // '2026-11-15-20' < '2026-11-16' < '2026-11-16-12'。docs/SPEC.md の 7.7 の「名札」・7.8 の「30日で消す」）
          const ids = (await db.tableOf(t).where('id').below(firstKeptDate).primaryKeys()).map(String)
          if (ids.length) {
            await db.tableOf(t).bulkDelete(ids)
            for (const id of ids) out.removed.push({ table: t, id, record: null })
          }
          // 同じ鍵の送信待ちも消す（電波の無い間に読んだ既読が、送信待ちのまま30日を過ぎた時。削除の印は書かない）
          const keys = (await db.outbox.where('k').between(outboxKey(t, ''), outboxKey(t, firstKeptDate)).primaryKeys()).map(
            String,
          )
          if (keys.length) {
            await db.outbox.bulkDelete(keys)
            out.outbox.push(...keys)
          }
        }
      })
      return out
    },

    close() {
      db.close()
    },
  }
}
