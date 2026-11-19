// 持ち主の記録の写し（Vault の SQLite の mirror と辞書の今の形）。NS の connector/src/vault/mirror.ts を元に、TS の形に書き直した（設計の 1.9）。
// - 問い合わせは読ませる6つの表（CLAUDE_READ_TABLES）に table in で絞る（ルールが表で読みを絞るため。設計の 2.1）。順は updated・__name__ で、
//   前に読んだ最後の文書の [updated, 名前] の後ろ（startAt・before: false）から N 件ずつ（同じ時刻の文書も名前の順で必ず次に来る）。
//   形は src/test/connectorQueries.ts の CONNECTOR_QUERIES の1つ目（test/unit/mirror.test.ts で確かめる）
// - 全文は持たない。表ごとの軽い行（lite）だけを持つ: 版（order・枠・窓）・話題（版・threadId・地域・ジャンル・見出し・要約の頭・順位・
//   出典の URL）・訂正（話題・文）・作れなかった印（版・種類）・知ってる（表記・時点・on）・辞書の束（版と語の数。語は辞書の今の形に当てる）
// - 1ページを1つのトランザクションで保存し、位置も同じトランザクションで進める。もっと新しい updated の行がある記録は書き換えない
//   （遅れて届いた古いページ）。取り込みの途中で写しを消した（reset）時は、その取り込みの続きを捨てる
// - 記録はアプリと同じ decodeDoc（src/sync/codec.ts）で取り出す（指紋が合わない・TS が書く形でない文書は使わない）
// - 30日: 版・話題・訂正・作れなかった印は、id の日付が30日を過ぎたら（isExpiredDocId。アプリと同じ日本時間の 0時の境）写しから消す
//   （取り込む時も入れない）。クラウドに残っていても写しは先に消える（前の版の一覧・訂正する話題に出さない）
// - 消えないはずの表（辞書の束・知ってる）: 数（count。table ==）を写しと比べ（recount）、違えば、その表を名前の順に読み直して
//   無くなった物を写しから外す（recheck。束が減った時は辞書を作り直す）。作業の字数（workBudget）で区切り、残りは alarm で続ける
// - 1日の行の予算（RowBudget）を超える時は止める（位置を進めない。UTC の 0時の後に続ける）
import { isExpiredDocId } from '../../../src/domain/ids'
import { checkTermEntry } from '../../../src/domain/validate'
import { CLAUDE_READ_TABLES, type ClaudeReadTableName, type TermEntry } from '../../../src/domain/types'
import { decodeDoc } from '../../../src/sync/codec'
import { log } from '../log'
import type { Dictionary } from './dictionary'
import type { CommitResult, FirestoreRest, FsDoc } from './firestore'
import type { MirrorRow, MirrorStore } from './store'
import { fromFields, timestampMicros, type Timestamp } from './values'
import { rowsOfCommit, type PreparedWrite } from './writer'

export interface Cursor {
  /** 最後に読んだ文書の updated（RFC 3339） */
  ts: string
  /** 最後に読んだ文書の名前（projects/…/documents/users/{uid}/records/{表名}:{id}） */
  name: string
}

export interface WarmState {
  done: boolean
  /** 取り込み始めた時の文書の数（進み具合の表示用） */
  total: number
  /** 取り込んだ文書の数 */
  seen: number
}

export interface SyncOptions {
  /** 読むページの数の上限 */
  maxPages: number
  /** 1回に取り込む JSON の文字数の目安（超えたら次のページを読まない） */
  workBudget: number
  /** 読み取りの数を数える（足りなければ false を返して止める） */
  takeReads: (n: number) => boolean
}

export interface SyncOutcome {
  pages: number
  docs: number
  /** 最後まで読んだ（今の時点の変更をすべて受け取った） */
  done: boolean
  /** 読み取りの枠が足りずに止まった */
  outOfReads: boolean
  /** 1日の行の予算が足りずに止まった（UTC の 0時の後に続ける） */
  outOfRows?: boolean
}

/** 表ごとの軽い形（mirror の lite） */
export interface EditionLite {
  date: string
  slot: string
  order: string[]
  window: { since: string; until: string } | null
}
export interface TopicLite {
  editionId: string
  threadId: string
  region: string
  genre: string
  headline: string
  /** 要約の頭 40字 */
  summaryHead: string
  rank: number
  /** 出典の URL（前の版で出典にした発表を候補から除く） */
  urls: string[]
}
export interface CorrectionLite {
  topicId: string
  editionId: string
  text: string
}
export interface EditionFailLite {
  editionId: string
  reasonKind: string
}
export interface KnownLite {
  term: string
  asOf: string | null
  on: boolean
}
export interface PackLite {
  editionId: string
  /** 語の数 */
  n: number
}

export interface LiteOf {
  editions: EditionLite
  topics: TopicLite
  corrections: CorrectionLite
  editionFails: EditionFailLite
  knownTerms: KnownLite
  termPacks: PackLite
}

/** 写しの記録（id と軽い形） */
export type Lite<T extends ClaudeReadTableName> = LiteOf[T] & { id: string }

/** 30日で消す表（写しの中。既読は読まない） */
export const MIRROR_EXPIRING_TABLES = ['editions', 'topics', 'corrections', 'editionFails'] as const

/** 消えないはずの表（数を比べて読み直す） */
export const MIRROR_KEPT_TABLES = ['termPacks', 'knownTerms'] as const
export type KeptTable = (typeof MIRROR_KEPT_TABLES)[number]

const READ_TABLES: ReadonlySet<string> = new Set(CLAUDE_READ_TABLES)

const PAGE_MAX = 50
const PAGE_MIN = 2
/** 辞書の束を名前で読む時（読み直し・作り直し）の初めのページの大きさ（束は1つ最大20万字。読んだ束の大きさで合わせ直す） */
const PACK_PAGE_START = 10

/** 次のページの大きさ（文書の平均の字数が大きい時は、作業の字数の半分に収まる数にする） */
const pageSizeFor = (size: number, count: number, workBudget: number): number => {
  const avg = count ? size / count : 0
  return avg > 5_000 ? Math.max(PAGE_MIN, Math.min(PAGE_MAX, Math.floor(workBudget / 2 / avg))) : PAGE_MAX
}
/** 要約の頭の字数（前の版の話題・訂正する話題の短い形） */
export const SUMMARY_HEAD_CHARS = 40

/** 読み直しの様子（meta 'recheck'。表ごとに、最後に読んだ文書の名前） */
export interface RecheckState {
  tables: KeptTable[]
  /** いま読み直している表の、最後に読んだ文書の名前（無ければ初めから） */
  after: string | null
  /** 読み直しで束が減った・変わった（終わったら辞書を作り直す） */
  packsChanged: boolean
}

/** 問い合わせを組む（形は src/test/connectorQueries.ts の CONNECTOR_QUERIES。test/unit/mirror.test.ts で確かめる） */
export const mirrorQueries = {
  /** 写しの差分: table in [読ませる6つ]・orderBy updated, __name__・位置から続ける */
  delta(cursor: Cursor | null, limit: number): Record<string, unknown> {
    const q: Record<string, unknown> = {
      from: [{ collectionId: 'records' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'table' },
          op: 'IN',
          value: { arrayValue: { values: CLAUDE_READ_TABLES.map((t) => ({ stringValue: t })) } },
        },
      },
      orderBy: [
        { field: { fieldPath: 'updated' }, direction: 'ASCENDING' },
        { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
      ],
      limit,
    }
    if (cursor) q.startAt = { values: [{ timestampValue: cursor.ts }, { referenceValue: cursor.name }], before: false }
    return q
  },
  /** 表の数（count）: table == だけ */
  count(table: string): Record<string, unknown> {
    return {
      from: [{ collectionId: 'records' }],
      where: { fieldFilter: { field: { fieldPath: 'table' }, op: 'EQUAL', value: { stringValue: table } } },
    }
  },
  /** 名前で読み直す: table ==・orderBy __name__・位置（最後に読んだ文書の名前）の後ろから */
  byName(table: string, after: string | null, limit: number): Record<string, unknown> {
    const q: Record<string, unknown> = {
      from: [{ collectionId: 'records' }],
      where: { fieldFilter: { field: { fieldPath: 'table' }, op: 'EQUAL', value: { stringValue: table } } },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit,
    }
    if (after) q.startAt = { values: [{ referenceValue: after }], before: false }
    return q
  },
}

/** 届いた文書を読んだ物 */
type Parsed =
  | { kind: 'row'; row: MirrorRow; entries: TermEntry[] | null; expired: boolean }
  | { kind: 'skip'; reason: string; name: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const head = (text: string, n: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(one)
  return chars.length > n ? chars.slice(0, n).join('') : one
}

/** 記録から軽い形を作る（形の崩れた記録も、読める所だけで作る。表示はしないので、読めない欄は空） */
export function liteOf(table: ClaudeReadTableName, rec: Record<string, unknown>): LiteOf[ClaudeReadTableName] {
  switch (table) {
    case 'editions': {
      const w =
        isObj(rec.window) && typeof rec.window.since === 'string' && typeof rec.window.until === 'string' ? rec.window : null
      return {
        date: s(rec.date),
        slot: s(rec.slot),
        order: Array.isArray(rec.order) ? rec.order.filter((x): x is string => typeof x === 'string') : [],
        window: w ? { since: String(w.since), until: String(w.until) } : null,
      } satisfies EditionLite
    }
    case 'topics':
      return {
        editionId: s(rec.editionId),
        threadId: s(rec.threadId) || s(rec.id),
        region: s(rec.region),
        genre: s(rec.genre),
        headline: s(rec.headline),
        summaryHead: head(s(rec.summary), SUMMARY_HEAD_CHARS),
        rank: typeof rec.rank === 'number' ? rec.rank : 0,
        urls: Array.isArray(rec.sources) ? rec.sources.map((x) => (isObj(x) ? s(x.url) : '')).filter((u) => u !== '') : [],
      } satisfies TopicLite
    case 'corrections':
      return { topicId: s(rec.topicId), editionId: s(rec.editionId), text: s(rec.text) } satisfies CorrectionLite
    case 'editionFails':
      return { editionId: s(rec.editionId), reasonKind: s(rec.reasonKind) } satisfies EditionFailLite
    case 'knownTerms':
      return {
        term: s(rec.term),
        asOf: typeof rec.asOf === 'string' ? rec.asOf : null,
        on: rec.on !== false,
      } satisfies KnownLite
    case 'termPacks':
      return {
        editionId: s(rec.editionId),
        n: Array.isArray(rec.entries) ? rec.entries.length : 0,
      } satisfies PackLite
  }
}

/** 束の語（形の正しい語だけ。崩れた語は飛ばす） */
export function packEntriesOf(rec: Record<string, unknown>): TermEntry[] {
  if (!Array.isArray(rec.entries)) return []
  return rec.entries.filter((e): e is TermEntry => checkTermEntry(e).errors.length === 0)
}

/** a が b より後の位置か（updated → 文書の名前の順。問い合わせの並びと同じ。b が無ければ後） */
function isAfter(a: Cursor, b: Cursor | null): boolean {
  if (!b) return true
  const d = timestampMicros(a.ts) - timestampMicros(b.ts)
  if (Number.isNaN(d)) return true
  return d > 0 || (d === 0 && a.name > b.name)
}

export class Mirror {
  readonly #store: MirrorStore
  readonly #dict: Dictionary
  readonly #fs: FirestoreRest
  readonly #ownerUid: () => string
  readonly #now: () => number
  #pageSize = PAGE_MAX
  /** 辞書の束を名前で読む時のページの大きさ（差分の読み取りと分ける。差分が小さな文書の続きで PAGE_MAX に戻っても、束は大きいまま読まない） */
  #packPageSize = PACK_PAGE_START
  /** 写しを消した（reset）回数（取り込みの途中で消したら、その取り込みの続きを捨てる） */
  #epoch = 0
  /** 内容が変わるたびに増える（読むツールの覚えに使う） */
  #version = 0

  constructor(store: MirrorStore, dict: Dictionary, fs: FirestoreRest, ownerUid: () => string, now: () => number) {
    this.#store = store
    this.#dict = dict
    this.#fs = fs
    this.#ownerUid = ownerUid
    this.#now = now
  }

  version(): number {
    return this.#version
  }

  cursor(): Cursor | null {
    return this.#store.getMeta<Cursor>('cursor')
  }

  warm(): WarmState {
    return this.#store.getMeta<WarmState>('warm') ?? { done: false, total: 0, seen: 0 }
  }

  /** 写しを消す（持ち主が変わった時。次の読み取りで最初から取り込み直す。辞書の今の形も） */
  reset(): void {
    this.#store.transaction(() => {
      this.#store.clearMirror()
      for (const k of ['cursor', 'warm', 'recheck', 'expiredDay']) this.#store.deleteMeta(k)
      this.#dict.cancelRebuild()
    })
    this.#version += 1
    this.#epoch += 1
  }

  /** 届いた文書を写しの行にする（使えない文書は skip。理由はログの印） */
  #parse(doc: FsDoc, now: number): Parsed {
    const f = fromFields(doc.fields)
    const docId = doc.name.slice(doc.name.lastIndexOf('/') + 1)
    const updated = (f.updated as Timestamp | null)?.timestamp ?? ''
    const updUs = timestampMicros(updated)
    if (!updated || !Number.isFinite(updUs)) return { kind: 'skip', reason: 'updated', name: docId }
    const d = decodeDoc(f, { docId, place: 'records' })
    if (!d.ok) return { kind: 'skip', reason: d.reason, name: docId }
    if (!READ_TABLES.has(d.table)) return { kind: 'skip', reason: 'table', name: docId }
    const table = d.table as ClaudeReadTableName
    const rec = d.record as unknown as Record<string, unknown>
    const row: MirrorRow = {
      name: docId,
      tbl: table,
      id: d.id,
      updUs,
      updated,
      hash: d.hash,
      device: d.device,
      lite: JSON.stringify(liteOf(table, rec)),
    }
    return {
      kind: 'row',
      row,
      entries: table === 'termPacks' ? packEntriesOf(rec) : null,
      expired: isExpiredDocId(docId, now),
    }
  }

  /**
   * 1つの行を写しに入れる（トランザクションの中）。30日を過ぎた行は入れずに消す。辞書の束は、初めて見た束の語を辞書に当てる
   * （行の予算が足りなければ false。呼ぶ側がページごと戻す）
   */
  #apply(p: Extract<Parsed, { kind: 'row' }>): boolean {
    if (p.expired) {
      if (this.#store.getMirror(p.row.name)) this.#store.deleteMirror(p.row.name)
      return true
    }
    const had = this.#store.getMirror(p.row.name)
    if (had && had.updUs > p.row.updUs) return true
    if (p.entries && !(had && had.hash === p.row.hash)) {
      if (this.#dict.applyInTransaction(p.entries) === null) return false
    }
    this.#store.putMirror(p.row)
    return true
  }

  /** 差分を読む（1回の呼び出しで maxPages ページまで） */
  async sync(opts: SyncOptions): Promise<SyncOutcome> {
    const owner = this.#ownerUid()
    let pages = 0
    let docs = 0
    let work = 0
    const epoch = this.#epoch
    const dropped = () => epoch !== this.#epoch
    const stopped = (): SyncOutcome => ({ pages, docs, done: false, outOfReads: false })
    let warm = this.warm()
    if (!warm.done && !this.cursor() && warm.total === 0) {
      // 最初の取り込み: 全体の数を数える（進み具合の表示用。1,000件ごとに1回の読み取り）
      try {
        if (opts.takeReads(3 * CLAUDE_READ_TABLES.length)) {
          // 数は表ごとの table == の count（CONNECTOR_QUERIES の形。table in の count は一覧に無い）
          let total = 0
          for (const t of CLAUDE_READ_TABLES) total += await this.#fs.count(`users/${owner}`, mirrorQueries.count(t))
          if (dropped()) return stopped()
          warm = { done: false, total, seen: 0 }
          this.#store.setMeta('warm', warm)
        }
      } catch (e) {
        log('mirror_count_failed', { code: e instanceof Error ? e.name : 'error' })
      }
    }
    for (;;) {
      if (pages >= opts.maxPages || (pages > 0 && work >= opts.workBudget)) return { pages, docs, done: false, outOfReads: false }
      const n = this.#pageSize
      // 読み取り: 返った文書の数（0件でも1回）と、アクセスルールが読む2つの文書（config/owner・config/connector）
      if (!opts.takeReads(n + 2)) return { pages, docs, done: false, outOfReads: true }
      const page = await this.#fs.runQuery(`users/${owner}`, mirrorQueries.delta(this.cursor(), n))
      if (dropped()) return stopped()
      opts.takeReads(Math.max(1, page.length) + 2 - (n + 2))
      const now = this.#now()
      let size = 0
      const parsed = page.map((d) => {
        size += (d.fields.json as { stringValue?: string } | undefined)?.stringValue?.length ?? 0
        return this.#parse(d, now)
      })
      let spent = false
      let changed = false
      rollbackOnSpent(this.#store, () => {
        for (const p of parsed) {
          if (p.kind === 'skip') {
            log('mirror_skipped', { reason: p.reason })
            continue
          }
          if (!this.#apply(p)) {
            spent = true
            throw new PageRollback()
          }
          changed = true
        }
        const last = page[page.length - 1]
        if (last) {
          const ts = (last.fields.updated as { timestampValue?: string } | undefined)?.timestampValue
          // 前へだけ進める（遅れて届いた古いページで戻さない）
          if (ts && isAfter({ ts, name: last.name }, this.cursor()))
            this.#store.setMeta('cursor', { ts, name: last.name } satisfies Cursor)
        }
        if (!warm.done) {
          warm = { ...warm, seen: warm.seen + page.length, done: page.length < n }
          this.#store.setMeta('warm', warm)
        }
      })
      if (spent) {
        // ページの全部が今日の行の予算に入らない（大きな辞書の束が続く）: 小さなページで読み直す。1件も入らなければ、位置を進めずに
        // 次の日（UTC）に続ける（同じ大きさのページを毎日読み直して、いつまでも進まない形にしない）
        if (n > 1) {
          this.#pageSize = Math.max(1, Math.floor(n / 2))
          continue
        }
        log('mirror_row_budget', { docs })
        return { pages, docs, done: false, outOfReads: false, outOfRows: true }
      }
      pages += 1
      docs += page.length
      work += size
      if (changed) this.#version += 1
      // ページの大きさを、文書の大きさに合わせる（辞書の束が続く時は少なく）
      this.#pageSize = pageSizeFor(size, page.length, opts.workBudget)
      if (page.length < n) return { pages, docs, done: true, outOfReads: false }
    }
  }

  /** 30日を過ぎた行を写しから消す（日本時間の日が変わった時だけ。読むツールの前と、毎日の cron で）。消した数 */
  expire(now: number, force = false): number {
    const today = new Date(now + 9 * 3_600_000).toISOString().slice(0, 10)
    if (!force && this.#store.getMeta<string>('expiredDay') === today) return 0
    let n = 0
    this.#store.transaction(() => {
      for (const t of MIRROR_EXPIRING_TABLES)
        for (const name of this.#store.mirrorNames(t))
          if (isExpiredDocId(name, now)) {
            this.#store.deleteMirror(name)
            n += 1
          }
      this.#store.setMeta('expiredDay', today)
    })
    if (n) {
      this.#version += 1
      log('mirror_expired', { count: n })
    }
    return n
  }

  /**
   * 書いた記録を、読み直さずに写しへ入れる（次の差分の読み取りでも同じ内容が届く）。辞書の束の語は辞書の今の形に当てる
   * （書いた束は、行の予算を超えても当てる。書いたのに引けない語を作らない）
   */
  putOwn(prepared: readonly PreparedWrite[], result: CommitResult): void {
    const recs = new Map(prepared.map((p) => [`${p.table}:${p.id}`, JSON.parse(p.json) as Record<string, unknown>]))
    const rows = rowsOfCommit(prepared, result, (p) =>
      JSON.stringify(liteOf(p.table as ClaudeReadTableName, recs.get(`${p.table}:${p.id}`) ?? {})),
    )
    this.#store.transaction(() => {
      for (const r of rows) {
        const rec = recs.get(r.name)
        if (r.tbl === 'termPacks' && rec && !this.#store.getMirror(r.name))
          this.#dict.applyInTransaction(packEntriesOf(rec), false)
        this.#store.putMirror(r)
      }
    })
    this.#version += 1
  }

  /**
   * 名前で読んで写しに入れる（書き込みが「もうある」で断られた後、差分の読み取りで見えない文書を確かめる。NS の fetchNames）。
   * 読ませる6つの表の文書だけ（ルールもほかの表は読ませない）。行の予算が足りなければ入れない（呼ぶ側は「もうある」を確かめられない）
   */
  async fetchNames(docIds: readonly string[]): Promise<void> {
    const names = docIds.filter((id) => READ_TABLES.has(id.slice(0, id.indexOf(':'))))
    if (!names.length) return
    const owner = this.#ownerUid()
    const epoch = this.#epoch
    const found = await this.#fs.batchGet(names.map((id) => `users/${owner}/records/${id}`))
    if (epoch !== this.#epoch) return
    const now = this.#now()
    let changed = false
    rollbackOnSpent(this.#store, () => {
      for (const d of found.values()) {
        if (!d) continue
        const p = this.#parse(d, now)
        if (p.kind !== 'row') continue
        if (!this.#apply(p)) throw new PageRollback()
        changed = true
      }
    })
    if (changed) this.#version += 1
  }

  /** 表の写しの行（id と軽い形。名前の順） */
  rows<T extends ClaudeReadTableName>(table: T): Lite<T>[] {
    const out: Lite<T>[] = []
    for (const r of this.#store.mirrorRows(table)) {
      try {
        out.push({ ...(JSON.parse(r.lite) as LiteOf[T]), id: r.id })
      } catch {
        // 読めない行は無いのと同じ
      }
    }
    return out
  }

  /** 1つの記録の軽い形（無ければ null） */
  get<T extends ClaudeReadTableName>(table: T, id: string): Lite<T> | null {
    const r = this.#store.getMirror(`${table}:${id}`)
    if (!r) return null
    try {
      return { ...(JSON.parse(r.lite) as LiteOf[T]), id: r.id }
    } catch {
      return null
    }
  }

  /** 写しにある記録か（表と id） */
  has(table: ClaudeReadTableName, id: string): boolean {
    return this.#store.getMirror(`${table}:${id}`) !== null
  }

  /** 知ってる（termId → on・時点。組み立てで「いまの説明で知ってる」語を外す） */
  known(): Map<string, { on: boolean; asOf: string | null }> {
    const out = new Map<string, { on: boolean; asOf: string | null }>()
    for (const k of this.rows('knownTerms')) out.set(k.id, { on: k.on, asOf: k.asOf })
    return out
  }

  /** 表ごとの写しの行の数 */
  counts(): Record<string, number> {
    return this.#store.mirrorCounts()
  }

  // ---------- 消えないはずの表 ----------

  /**
   * クラウドの数（count。table ==）を写しの数と比べる（回を始める時・毎日の cron）。違う表を返す（読み直しは recheck で）。
   * 読み取り: 表ごとに1回（1,000件ごとに1回）と、ルールが読む2つの文書
   */
  async recount(takeReads: (n: number) => boolean): Promise<KeptTable[]> {
    const owner = this.#ownerUid()
    const mine = this.counts()
    const out: KeptTable[] = []
    for (const t of MIRROR_KEPT_TABLES) {
      if (!takeReads(3)) break
      const cloud = await this.#fs.count(`users/${owner}`, mirrorQueries.count(t))
      if (cloud !== (mine[t] ?? 0)) {
        log('mirror_count_mismatch', { table: t, cloud, mine: mine[t] ?? 0 })
        out.push(t)
      }
    }
    return out
  }

  /** 読み直しを始める（meta 'recheck'。もう始めていれば表を足すだけ） */
  startRecheck(tables: readonly KeptTable[]): void {
    if (!tables.length) return
    const cur = this.#store.getMeta<RecheckState>('recheck')
    const all = [...new Set([...(cur?.tables ?? []), ...tables])] as KeptTable[]
    this.#store.setMeta('recheck', {
      tables: all,
      after: cur?.after ?? null,
      packsChanged: cur?.packsChanged ?? false,
    } satisfies RecheckState)
  }

  recheckState(): RecheckState | null {
    return this.#store.getMeta<RecheckState>('recheck')
  }

  /**
   * 読み直しを1歩進める: いまの表を名前の順に読み、そのページの範囲の写しの行のうち、クラウドに無い物を外す（無い記録が写しにあれば入れる）。
   * 表を読み終えたら次の表へ。束が減った・変わった時は、全部を読み終えた後に辞書を作り直す（startRebuild）。終わったら true
   */
  async recheckStep(opts: SyncOptions): Promise<{ done: boolean; outOfReads?: boolean; outOfRows?: boolean }> {
    const owner = this.#ownerUid()
    const epoch = this.#epoch
    let work = 0
    for (let pages = 0; pages < opts.maxPages; pages++) {
      const st = this.recheckState()
      if (!st || !st.tables.length) {
        this.#store.deleteMeta('recheck')
        return { done: true }
      }
      if (pages > 0 && work >= opts.workBudget) return { done: false }
      const table = st.tables[0]
      // 辞書の束は大きいので、読んだ束の大きさに合わせたページで読む（知ってるは小さい）
      const n = table === 'termPacks' ? this.#packPageSize : PAGE_MAX
      if (!opts.takeReads(n + 2)) return { done: false, outOfReads: true }
      const page = await this.#fs.runQuery(`users/${owner}`, mirrorQueries.byName(table, st.after, n))
      if (epoch !== this.#epoch) return { done: false }
      opts.takeReads(Math.max(1, page.length) + 2 - (n + 2))
      const now = this.#now()
      const prefix = `${this.#fs.name(`users/${owner}/records`)}/`
      const afterId = st.after ? st.after.slice(prefix.length) : null
      const last = page[page.length - 1]
      const lastId = last ? last.name.slice(last.name.lastIndexOf('/') + 1) : null
      const seen = new Set<string>()
      let packsChanged = st.packsChanged
      let spent = false
      let size = 0
      for (const d of page) size += (d.fields.json as { stringValue?: string } | undefined)?.stringValue?.length ?? 0
      work += size
      if (table === 'termPacks') this.#packPageSize = pageSizeFor(size, page.length, opts.workBudget)
      rollbackOnSpent(this.#store, () => {
        for (const d of page) {
          const p = this.#parse(d, now)
          if (p.kind === 'skip') continue
          seen.add(p.row.name)
          const had = this.#store.getMirror(p.row.name)
          if (!had || had.hash !== p.row.hash) {
            // 無かった束は今の辞書に当てれば足りる（語は rev の大きい方が残るだけ）。中身の違う束は作り直す
            if (table === 'termPacks' && had) packsChanged = true
            if (!this.#apply(p)) {
              spent = true
              throw new PageRollback()
            }
          }
        }
        // このページの範囲（前の位置の後ろから、このページの最後まで。最後のページは表の終わりまで）の、クラウドに無い写しの行を外す
        const upTo = page.length < n ? null : lastId
        for (const name of this.#store.mirrorNames(table, afterId, upTo))
          if (!seen.has(name)) {
            this.#store.deleteMirror(name)
            if (table === 'termPacks') packsChanged = true
          }
        const rest = page.length < n ? st.tables.slice(1) : st.tables
        const after = page.length < n ? null : (last?.name ?? null)
        this.#store.setMeta('recheck', { tables: rest, after, packsChanged } satisfies RecheckState)
      })
      if (spent) {
        // 大きな辞書の束が続いてページが今日の行の予算に入らない: 小さなページで読み直す（1件も入らなければ次の日に）
        if (table === 'termPacks' && n > 1) {
          this.#packPageSize = Math.max(1, Math.floor(n / 2))
          continue
        }
        return { done: false, outOfRows: true }
      }
      this.#version += 1
      const next = this.recheckState()
      if (next && !next.tables.length) {
        this.#store.deleteMeta('recheck')
        if (next.packsChanged) this.#dict.startRebuild(now)
        return { done: true }
      }
    }
    return { done: false }
  }

  /**
   * 辞書の作り直しを1歩進める（辞書の束を名前の順に読み、作り直しの表に当てる。1日の行の予算の中で）。終わったら入れ替えて true
   */
  async rebuildStep(opts: SyncOptions): Promise<{ done: boolean; outOfReads?: boolean; outOfRows?: boolean }> {
    const owner = this.#ownerUid()
    const epoch = this.#epoch
    let work = 0
    for (let pages = 0; pages < opts.maxPages; pages++) {
      const st = this.#dict.rebuildState()
      if (!st) return { done: true }
      if (pages > 0 && work >= opts.workBudget) return { done: false }
      const n = this.#packPageSize
      if (!opts.takeReads(n + 2)) return { done: false, outOfReads: true }
      const page = await this.#fs.runQuery(`users/${owner}`, mirrorQueries.byName('termPacks', st.after, n))
      if (epoch !== this.#epoch || !this.#dict.rebuilding()) return { done: false }
      opts.takeReads(Math.max(1, page.length) + 2 - (n + 2))
      const now = this.#now()
      // ページの文書ごとの束（読めない文書は null。位置は進める）
      const items: { docName: string; pack: { name: string; entries: TermEntry[] } | null }[] = []
      let size = 0
      for (const d of page) {
        size += (d.fields.json as { stringValue?: string } | undefined)?.stringValue?.length ?? 0
        const p = this.#parse(d, now)
        items.push({ docName: d.name, pack: p.kind === 'row' && p.entries ? { name: p.row.name, entries: p.entries } : null })
      }
      work += size
      this.#packPageSize = pageSizeFor(size, page.length, opts.workBudget)
      if (!items.length) {
        this.#dict.finishRebuild()
        this.#version += 1
        log('dictionary_rebuilt', { count: this.#dict.size() })
        return { done: true }
      }
      // ページの全部が今日の行の予算に入らない時は、頭の半分ずつに減らして当てる（大きな束が続くページでも、日ごとに少しずつ進める。
      // 1つの束も入らなければ次の日に続ける）
      let take = items.length
      for (;;) {
        const part = items.slice(0, take)
        const packs = part.flatMap((i) => (i.pack ? [i.pack] : []))
        if (this.#dict.rebuildApply(packs, part[part.length - 1].docName)) break
        if (take === 1) return { done: false, outOfRows: true }
        take = Math.ceil(take / 2)
      }
      if (take < items.length) {
        this.#packPageSize = Math.max(1, Math.min(this.#packPageSize, take))
        return { done: false, outOfRows: true }
      }
      if (page.length < n) {
        this.#dict.finishRebuild()
        this.#version += 1
        log('dictionary_rebuilt', { count: this.#dict.size() })
        return { done: true }
      }
    }
    return { done: false }
  }
}

/** ページの書き込みを戻す印（行の予算が足りない時） */
class PageRollback extends Error {
  constructor() {
    super('page rollback')
    this.name = 'PageRollback'
  }
}

/** トランザクションの中で PageRollback を投げたら、書き込みを戻して何もしない（戻した行は行の予算からも外す） */
function rollbackOnSpent(store: MirrorStore, fn: () => void): void {
  const mark = store.markRows()
  try {
    store.transaction(fn)
  } catch (e) {
    store.restoreRows(mark)
    if (!(e instanceof PageRollback)) throw e
  }
}
