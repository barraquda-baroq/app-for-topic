// Vault（Durable Object）の SQLite。Workers では ctx.storage.sql、テストでは node:sqlite を同じ SQL で使う（NS の connector/src/vault/store.ts の形）。
// DO の表は全部ここで決める（設計の 1.1・1.3・1.5・1.7・1.9。B4・B5 はこの表に書く・読むだけ）:
// - meta: 身元（identity。更新用トークンは TOKEN_ENC_KEY で暗号化）・連携の状態（pairing）・使った連携の確かめの指紋（usedPairings）・
//   数の記録（quota）・接続の要求の回数（rate:…）・同意の承認（consentClaims）・写しの位置（cursor・warm）・1日の行の予算（rows）など（JSON）
// - mirror: 写し。読ませる6つの表（CLAUDE_READ_TABLES）の、表ごとの軽い行（lite。話題は出典の URL も）。全文は持たない
//   （TS の記録は書き換えないので、全文を持たなくても答えられる。NS の rec・chunk・readmemo は持たない）
// - terms・term_forms: 辞書の今の形（語ごとに1行と、そろえた表記 → termId の引く索引）。terms_next・term_forms_next は作り直しの表
//   （日をまたいで alarm で進め、終わったら入れ替える。その間は今の表で引ける。設計の 1.9）
// - runs: 回の覚え書き（種類・枠・窓・締め切り・期限・最後の呼び出し・候補集めの様子）。run_terms: 回に溜めた新しい語（下書きの中で書いた語）
// - candidates: 候補（回ごと。c0001 から）。materials: 資料の控え（回ごと。本文は 12,000字まで。読んだ時刻）
// - drafts: 下書き（回ごと。d:01 から。読んだ時刻・照合済みになった時刻）。run_counts: 回の数え（照合の訳の種類ごとの数・取りに行った数など）
// - host_rules: ホストごとの robots.txt と AI の意思表示の読み（1日1回）。terms_watch: 規約のページの指紋の見張り（週1回）。
//   source_counts: 出どころごとの数（直近14回。数だけ）。source_state: 出どころの印（一覧の作りが変わったかもしれない など）
// - first_seen: 日付だけの項目を初めて見た時刻（URL の指紋だけ。3日）。jma_watch: 気象庁の見張りの控え（版に入れてよい種類の項目だけ。24時間）
// - host_pace: ホストごとの「次に取ってよい時刻」（取る時刻の予約。同じ時に呼ばれた道具と alarm が同じ表を使う）
// - probe: 試しの回の probe の表（数と番号だけ。'terms' だけ規約のページの文字）
// - tasks: alarm のやる事の表（写しの続き・候補集めの続き・毎日の決まりの読み・気象庁の見張り・回の期限。いちばん早い物の時刻に置き直す）
// 回の物（候補・控え・下書き・数え・新しい語・probe）は、版か作れなかった印を足した時に消し、残った物も回の期限に全部消す（回の覚え書きも）。
// 取り込んだ記録の写しは暗号化しない（Durable Object の保存領域はもともと暗号化されている。NS と同じ）。
// DO の SQLite の行の書き込みは、無料プランのアカウントで1日 10万（NS と分け合う）。この Vault は1日 40,000 行の予算（RowBudget）を持ち、
// 書いた行を数える（写し・辞書・回の物。設計の 1.9 の (3)）。
import type { TermEntry } from '../../../src/domain/types'

export type SqlValue = string | number | null

export interface SqlRunner {
  all<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): T[]
  run(sql: string, ...params: SqlValue[]): void
  /** 同期のトランザクション（途中で例外なら何も書かない） */
  transaction<T>(fn: () => T): T
}

const termsTable = (name: string) =>
  `CREATE TABLE IF NOT EXISTS ${name} (term_id TEXT PRIMARY KEY, key TEXT NOT NULL, term TEXT NOT NULL, aliases TEXT NOT NULL,
    explanation TEXT NOT NULL, as_of TEXT, rev INTEGER NOT NULL, retired INTEGER NOT NULL) WITHOUT ROWID`
const formsTable = (name: string) =>
  `CREATE TABLE IF NOT EXISTS ${name} (form TEXT NOT NULL, term_id TEXT NOT NULL, PRIMARY KEY (form, term_id)) WITHOUT ROWID`

/** 表を作る SQL（どれも主の鍵の表で、別の索引を作らない。索引も行の書き込みに数えられるため） */
export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mirror (name TEXT PRIMARY KEY, tbl TEXT NOT NULL, id TEXT NOT NULL, upd_us INTEGER NOT NULL,
    updated TEXT NOT NULL, hash TEXT NOT NULL, device TEXT NOT NULL, lite TEXT NOT NULL) WITHOUT ROWID`,
  termsTable('terms'),
  formsTable('term_forms'),
  termsTable('terms_next'),
  formsTable('term_forms_next'),
  `CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, kind TEXT NOT NULL, model TEXT NOT NULL, started INTEGER NOT NULL,
    expires INTEGER NOT NULL, last_call INTEGER NOT NULL, edition_id TEXT, writer_ms INTEGER, checker_ms INTEGER, since_ms INTEGER,
    until_ms INTEGER, done INTEGER NOT NULL DEFAULT 0, probe TEXT, skip TEXT NOT NULL DEFAULT '[]', collect TEXT NOT NULL DEFAULT '{}',
    notes TEXT NOT NULL DEFAULT '{}') WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS run_terms (run_id TEXT NOT NULL, term_id TEXT NOT NULL, entry TEXT NOT NULL, draft TEXT NOT NULL,
    PRIMARY KEY (run_id, term_id)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS candidates (run_id TEXT NOT NULL, cid TEXT NOT NULL, source TEXT NOT NULL, url TEXT NOT NULL,
    title TEXT NOT NULL, published TEXT, at_ms INTEGER, tags TEXT NOT NULL DEFAULT '[]', readable INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (run_id, cid)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS materials (run_id TEXT NOT NULL, url TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL,
    published TEXT, published_note TEXT, author TEXT, via TEXT, body TEXT NOT NULL, body_chars INTEGER NOT NULL,
    cut INTEGER NOT NULL DEFAULT 0, fetched INTEGER NOT NULL, read_at INTEGER, PRIMARY KEY (run_id, url)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS drafts (run_id TEXT NOT NULL, draft_id TEXT NOT NULL, seq INTEGER NOT NULL, rank INTEGER NOT NULL,
    model TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, reject_reason TEXT, created INTEGER NOT NULL,
    updated INTEGER NOT NULL, read_at INTEGER, verified_at INTEGER, checks INTEGER NOT NULL DEFAULT 0, claims INTEGER,
    fixed INTEGER, check_model TEXT, topic_id TEXT, PRIMARY KEY (run_id, draft_id)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS run_counts (run_id TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL,
    PRIMARY KEY (run_id, key)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS host_rules (host TEXT PRIMARY KEY, day TEXT NOT NULL, state TEXT NOT NULL, crawl_delay REAL,
    data TEXT NOT NULL DEFAULT '{}', checked INTEGER NOT NULL, changed INTEGER) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS terms_watch (url TEXT PRIMARY KEY, source TEXT NOT NULL, fingerprint TEXT, state TEXT NOT NULL,
    checked INTEGER NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS source_counts (source TEXT NOT NULL, at INTEGER NOT NULL, counts TEXT NOT NULL,
    PRIMARY KEY (source, at)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS source_state (source TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS first_seen (fp TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS jma_watch (link TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
    kept INTEGER NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS host_pace (host TEXT PRIMARY KEY, next INTEGER NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS probe (run_id TEXT NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL, text TEXT,
    PRIMARY KEY (run_id, source)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS tasks (key TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}') WITHOUT ROWID`,
]

/** 回の物を入れる表（版か作れなかった印を足した時・回の期限に消す。runs は期限まで残す） */
export const RUN_ITEM_TABLES = ['candidates', 'materials', 'drafts', 'run_counts', 'run_terms', 'probe'] as const

// ---------- 行の形 ----------

/** 写しの1行（mirror） */
export interface MirrorRow {
  /** 文書の名前の最後（{表名}:{id}） */
  name: string
  tbl: string
  id: string
  /** updated（サーバー時刻）のマイクロ秒 */
  updUs: number
  /** updated の文字列（RFC 3339） */
  updated: string
  hash: string
  device: string
  /** 表ごとの軽い形（JSON。mirror.ts の LiteOf） */
  lite: string
}

/** 回の覚え書き（runs） */
export interface RunRow {
  runId: string
  kind: string
  /** 回のモデル（版・作れなかった印・辞書の束の model） */
  model: string
  started: number
  /** 回の期限（始めて12時間） */
  expires: number
  lastCall: number
  /** 枠の版の id（訂正だけの回は null） */
  editionId: string | null
  /** 書く係の締め切り・照合の打ち切り（訂正だけの回は null） */
  writerMs: number | null
  checkerMs: number | null
  /** 候補を集める窓（ms。訂正だけの回は null）。since より後で until まで */
  sinceMs: number | null
  untilMs: number | null
  /** 版か作れなかった印を足した（回の物は消した。覚え書きだけ期限まで残す） */
  done: boolean
  /** 試しの回の probe（'sources'・'hosts'・'terms'） */
  probe: string | null
  /** 試しの回で probe から外す出どころの id */
  skip: string[]
  /** 候補集めの様子（B4 が書く） */
  collect: CollectState
  /** 回の覚え書き（足した訂正・束を足したか など。B5 が書く。中身の文・題は持たない） */
  notes: Record<string, unknown>
}

/** 候補集めの様子 */
export interface CollectState {
  /**
   * none = 集めない回（訂正だけの回）。collecting = 集めている。done = 集め終わった。試しの回の probe の 'hosts'・'terms' は候補を
   * 集めず、collectStep がその probe だけをして done にする（topic_status(runId) はその終わりを待って probe の表を返す）
   */
  state?: 'none' | 'collecting' | 'done'
  /** 進み具合（取った一覧・本文の数と、取る数） */
  progress?: { done: number; total: number }
  /** 窓を広げた（候補が少ないため。広げた時刻 ms） */
  widenedSinceMs?: number
  /** 集め直した回数（1つの回に2回まで） */
  recollected?: number
}

/** 候補の1行（candidates。B4 が書く） */
export interface CandidateRow {
  runId: string
  /** 'c0001' から */
  cid: string
  /** 出どころの id（sources.ts の決まった ASCII の印） */
  source: string
  url: string
  title: string
  /** 一覧の日時（そのままの文字。無ければ null） */
  published: string | null
  /** 窓で絞る時刻（ms。日付だけの項目は初めて見た回の始めの時刻） */
  atMs: number | null
  /** 一覧の行の印（[英語]・[最大震度5強]・[似た題 c0031] など） */
  tags: string[]
  /** 読める候補か（本文が短い・PDF だけなどは false。一覧には出さず、数だけ数える） */
  readable: boolean
}

/** 資料の控えの1行（materials。B4 が書く） */
export interface MaterialRow {
  runId: string
  /** 本文を取った URL（https:。転送の後の物） */
  url: string
  source: string
  title: string
  /** 資料の頭の時刻かページ・一覧の日付（そのままの文字。publishedAtOf で直す） */
  published: string | null
  publishedNote: string | null
  author: string | null
  via: string | null
  /** 本文（文字だけ。12,000字まで） */
  body: string
  /** 本文の字数（切る前。SOURCE_BODY_MIN_CHARS 未満は出典にできない） */
  bodyChars: number
  /** 12,000字で切った */
  cut: boolean
  fetched: number
  /** topic_read_article が読んだ時刻（読んでいなければ null。読んでいない資料は出典にできない） */
  readAt: number | null
}

/** 下書きの状態 */
export type DraftStatus = 'pending' | 'verified' | 'rejected'

/** 下書きの1行（drafts。B5 が書く） */
export interface DraftRow {
  runId: string
  /** 'd:01' から */
  draftId: string
  /** 置いた順（1〜。置き換えは数えない） */
  seq: number
  rank: number
  /** 書いた係のモデル */
  model: string
  /** 入力（TopicDraftInput の JSON。照合で直した後の物） */
  input: string
  status: DraftStatus
  rejectReason: string | null
  /** 初めに置いた時刻（putDraft の upsert は、置き換えでも created を替えない） */
  created: number
  /**
   * 今の中身を置いた・置き換えた時刻。照合済み・外した・足した時にも進み、読む・断られた照合では進まない（vault/drafts.ts の
   * 「確かめが早すぎる」（2分）は updated から数える。upsert で created も替える形にするなら、drafts.ts の数えもそろえる）
   */
  updated: number
  /** topic_get_draft で初めて読んだ時刻（読む前の照合は断る） */
  readAt: number | null
  /** 照合済みになった時刻（今の中身を置いて（updated）から2分未満は「確かめが早すぎる」） */
  verifiedAt: number | null
  /** 照合を当てた回数（1つの下書きに5回まで） */
  checks: number
  claims: number | null
  fixed: number | null
  checkModel: string | null
  /** 足した話題の id（足した後） */
  topicId: string | null
}

/** ホストの決まりの読み（host_rules。B4 が書く） */
export interface HostRuleRow {
  host: string
  /** 読んだ日（日本時間の YYYY-MM-DD） */
  day: string
  /** ok = 取ってよい道がある・refused = robots.txt が断る・stopped = AI への意思表示（作者に伺う）・unreadable = 読めない・403・429・確認画面 */
  state: 'ok' | 'refused' | 'stopped' | 'unreadable'
  /** robots.txt の Crawl-delay（秒） */
  crawlDelay: number | null
  /** 決まりの中身（許す・断る道の組・名前の組・指紋。題・本文は持たない。形は B4 が決める） */
  data: Record<string, unknown>
  checked: number
  /** robots.txt が前と変わった時刻（次の回の候補の一覧と報告に出す） */
  changed: number | null
}

/** 規約のページの見張り（terms_watch。B4 が書く） */
export interface TermsWatchRow {
  url: string
  source: string
  fingerprint: string | null
  /** same = data の指紋と同じ・changed = 違う（取りを止める）・unreadable = 読めなかった */
  state: 'same' | 'changed' | 'unreadable'
  checked: number
}

/** 出どころの印（source_state。B4 が書く） */
export interface SourceFlags {
  /** 一覧の作りが変わったかもしれない（itemPath に合う項目が0件。取りは続ける） */
  structure?: boolean
  /** 日付が読めた項目が半分未満 */
  undated?: boolean
  /** 規約・RSS の利用条件で断っている（取らない） */
  refusedTerms?: boolean
  /** 気象庁: 7日見えない種類の行（種類の名前） */
  jmaUnseen?: string[]
}

/** probe の1行（試しの回。B4 が書く。数と番号と決まった印だけ。'terms' だけ text に規約のページの文字） */
export interface ProbeRow {
  runId: string
  source: string
  data: Record<string, number | string | boolean | null>
  text: string | null
}

/** やる事（tasks）。鍵: 'mirror'・'rules'・'jma'・'expire'・'collect:{runId}' */
export interface TaskRow {
  key: string
  at: number
  data: Record<string, unknown>
}

type Db = Record<string, SqlValue>

const json = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string') return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}
const num = (v: SqlValue | undefined): number | null => (v === null || v === undefined ? null : Number(v))
const str = (v: SqlValue | undefined): string | null => (v === null || v === undefined ? null : String(v))

const toRun = (r: Db): RunRow => ({
  runId: String(r.run_id),
  kind: String(r.kind),
  model: String(r.model),
  started: Number(r.started),
  expires: Number(r.expires),
  lastCall: Number(r.last_call),
  editionId: str(r.edition_id),
  writerMs: num(r.writer_ms),
  checkerMs: num(r.checker_ms),
  sinceMs: num(r.since_ms),
  untilMs: num(r.until_ms),
  done: Boolean(Number(r.done)),
  probe: str(r.probe),
  skip: json<string[]>(r.skip, []),
  collect: json<CollectState>(r.collect, {}),
  notes: json<Record<string, unknown>>(r.notes, {}),
})

const toCandidate = (r: Db): CandidateRow => ({
  runId: String(r.run_id),
  cid: String(r.cid),
  source: String(r.source),
  url: String(r.url),
  title: String(r.title),
  published: str(r.published),
  atMs: num(r.at_ms),
  tags: json<string[]>(r.tags, []),
  readable: Boolean(Number(r.readable)),
})

const toMaterial = (r: Db): MaterialRow => ({
  runId: String(r.run_id),
  url: String(r.url),
  source: String(r.source),
  title: String(r.title),
  published: str(r.published),
  publishedNote: str(r.published_note),
  author: str(r.author),
  via: str(r.via),
  body: String(r.body),
  bodyChars: Number(r.body_chars),
  cut: Boolean(Number(r.cut)),
  fetched: Number(r.fetched),
  readAt: num(r.read_at),
})

const toDraft = (r: Db): DraftRow => ({
  runId: String(r.run_id),
  draftId: String(r.draft_id),
  seq: Number(r.seq),
  rank: Number(r.rank),
  model: String(r.model),
  input: String(r.input),
  status: String(r.status) as DraftStatus,
  rejectReason: str(r.reject_reason),
  created: Number(r.created),
  updated: Number(r.updated),
  readAt: num(r.read_at),
  verifiedAt: num(r.verified_at),
  checks: Number(r.checks),
  claims: num(r.claims),
  fixed: num(r.fixed),
  checkModel: str(r.check_model),
  topicId: str(r.topic_id),
})

const toEntry = (r: Db): TermEntry => {
  const e: TermEntry = {
    termId: String(r.term_id),
    key: String(r.key),
    term: String(r.term),
    aliases: json<string[]>(r.aliases, []),
    explanation: String(r.explanation),
    asOf: str(r.as_of),
    rev: Number(r.rev),
  }
  if (Number(r.retired)) e.retired = true
  return e
}

// ---------- 1日の行の予算 ----------

/** 1日（UTC）の行の書き込みの予算（アカウントの 10万を NS と分け合う。設計の 1.6・1.9・1.11） */
export const DAILY_ROW_BUDGET = 40_000

/** 予算を meta に書き戻す間（行の数。書き戻すのも1行の書き込みなので、毎回は書かない） */
const ROW_FLUSH_EVERY = 200

/** 行の予算の記録（UTC の日ごと） */
export interface RowCounts {
  day: string
  rows: number
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** UTC の次の 0時（ms。DO の行の数が戻る時刻） */
export function nextUtcMidnight(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

export class MirrorStore {
  readonly sql: SqlRunner
  /** 行の予算（UTC の日）。書いた数はメモリに足し、ROW_FLUSH_EVERY ごとと flushRows で meta に書き戻す */
  #rows: RowCounts | null = null
  #unflushed = 0
  #now: () => number

  constructor(sql: SqlRunner, now: () => number = () => Date.now()) {
    this.sql = sql
    this.#now = now
    for (const s of SCHEMA) sql.run(s)
  }

  transaction<T>(fn: () => T): T {
    return this.sql.transaction(fn)
  }

  // ---------- meta ----------

  getMeta<T>(k: string): T | null {
    const rows = this.sql.all<{ v: string }>('SELECT v FROM meta WHERE k = ?', k)
    if (!rows.length) return null
    try {
      return JSON.parse(rows[0].v) as T
    } catch {
      return null
    }
  }

  setMeta(k: string, v: unknown): void {
    this.sql.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v))
  }

  deleteMeta(k: string): void {
    this.sql.run('DELETE FROM meta WHERE k = ?', k)
  }

  // ---------- 行の予算 ----------

  #rowCounts(): RowCounts {
    const day = utcDay(this.#now())
    if (!this.#rows || this.#rows.day !== day) {
      const saved = this.getMeta<RowCounts>('rows')
      this.#rows = saved && saved.day === day && typeof saved.rows === 'number' ? saved : { day, rows: 0 }
      this.#unflushed = 0
    }
    return this.#rows
  }

  /** 書いた行を数える（止めない。回の物・連携の記録など、無いと何もできない書き込み） */
  countRows(n: number): void {
    if (n <= 0) return
    const c = this.#rowCounts()
    c.rows += n
    this.#unflushed += n
    if (this.#unflushed >= ROW_FLUSH_EVERY) this.flushRows()
  }

  /** 予算の中なら数えて true。超えるなら数えずに false（写しの取り込み・辞書の作り直しは日をまたいで続ける） */
  takeRows(n: number): boolean {
    if (n > 0 && this.#rowCounts().rows + n > DAILY_ROW_BUDGET) return false
    this.countRows(n)
    return true
  }

  /**
   * 行の数の印（トランザクションを戻す前に取る）。戻した時は restoreRows で印の数に戻す（書かなかった行を予算に残さない。
   * 戻した分を数えたままにすると、同じページを次の日に読み直す前に予算を使い切ったように見える）
   */
  markRows(): RowCounts {
    return { ...this.#rowCounts() }
  }

  /** markRows の印の数に戻す（同じ日の印だけ。日が変わっていれば何もしない） */
  restoreRows(mark: RowCounts): void {
    const c = this.#rowCounts()
    if (c.day !== mark.day || c.rows <= mark.rows) return
    c.rows = mark.rows
    // 戻したトランザクションの中で書き戻した meta も戻っているので、次の flushRows で書き直す
    this.#unflushed = Math.max(1, Math.min(this.#unflushed, ROW_FLUSH_EVERY - 1))
  }

  /** 今日（UTC）の行の予算の残り */
  rowsLeft(): number {
    return DAILY_ROW_BUDGET - this.#rowCounts().rows
  }

  /** 今日（UTC）書いた行の数 */
  rowsUsed(): number {
    return this.#rowCounts().rows
  }

  /** 数えた行を meta に書き戻す（ツールの答えの後・alarm の後） */
  flushRows(): void {
    if (!this.#rows || this.#unflushed === 0) return
    this.#unflushed = 0
    this.setMeta('rows', this.#rows)
  }

  #count(sql: string, ...params: SqlValue[]): number {
    return Number(this.sql.all<{ n: number }>(sql, ...params)[0]?.n ?? 0)
  }

  /** 消す前に数え、消した行を予算に数える */
  #delete(table: string, where: string, ...params: SqlValue[]): number {
    const n = this.#count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params)
    if (n) {
      this.sql.run(`DELETE FROM ${table} WHERE ${where}`, ...params)
      this.countRows(n)
    }
    return n
  }

  // ---------- 写し ----------

  getMirror(name: string): MirrorRow | null {
    const r = this.sql.all<Db>('SELECT * FROM mirror WHERE name = ?', name)[0]
    return r ? toMirror(r) : null
  }

  /** 写しの行を入れる（もっと新しい updated の行があれば入れない）。入れたら true */
  putMirror(row: MirrorRow): boolean {
    const cur = this.sql.all<{ upd_us: number; hash: string }>('SELECT upd_us, hash FROM mirror WHERE name = ?', row.name)[0]
    if (cur && Number(cur.upd_us) > row.updUs) return false
    if (cur && Number(cur.upd_us) === row.updUs && cur.hash === row.hash) return true
    this.sql.run(
      `INSERT INTO mirror (name, tbl, id, upd_us, updated, hash, device, lite) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET tbl = excluded.tbl, id = excluded.id, upd_us = excluded.upd_us, updated = excluded.updated,
         hash = excluded.hash, device = excluded.device, lite = excluded.lite`,
      row.name,
      row.tbl,
      row.id,
      row.updUs,
      row.updated,
      row.hash,
      row.device,
      row.lite,
    )
    this.countRows(1)
    return true
  }

  deleteMirror(name: string): void {
    this.#delete('mirror', 'name = ?', name)
  }

  /** 表の写しの行（名前の順） */
  mirrorRows(tbl: string): MirrorRow[] {
    return this.sql.all<Db>('SELECT * FROM mirror WHERE tbl = ? ORDER BY name', tbl).map(toMirror)
  }

  /** 表の写しの行の名前（名前の順。after より後・upTo まで（含む）。どちらも無ければ全部） */
  mirrorNames(tbl: string, after: string | null = null, upTo: string | null = null): string[] {
    const where = ['tbl = ?']
    const params: SqlValue[] = [tbl]
    if (after !== null) {
      where.push('name > ?')
      params.push(after)
    }
    if (upTo !== null) {
      where.push('name <= ?')
      params.push(upTo)
    }
    return this.sql
      .all<{ name: string }>(`SELECT name FROM mirror WHERE ${where.join(' AND ')} ORDER BY name`, ...params)
      .map((r) => r.name)
  }

  /** 表ごとの写しの行の数 */
  mirrorCounts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.sql.all<{ tbl: string; n: number }>('SELECT tbl, COUNT(*) AS n FROM mirror GROUP BY tbl'))
      out[r.tbl] = Number(r.n)
    return out
  }

  /** 写しを消す（持ち主が変わった時。辞書の今の形・作り直しの表も） */
  clearMirror(): void {
    for (const t of ['mirror', 'terms', 'term_forms', 'terms_next', 'term_forms_next']) this.#delete(t, '1 = 1')
  }

  // ---------- 辞書の今の形（dictionary.ts が使う） ----------

  /** 語（next = 作り直しの表） */
  getTerm(termId: string, next = false): TermEntry | null {
    const r = this.sql.all<Db>(`SELECT * FROM ${next ? 'terms_next' : 'terms'} WHERE term_id = ?`, termId)[0]
    return r ? toEntry(r) : null
  }

  /** 語を書く（表記の索引も書き直す。old は今の行）。書いた行の数を返す（数えるのは呼ぶ側） */
  putTerm(entry: TermEntry, oldForms: readonly string[], newForms: readonly string[], next = false): number {
    const terms = next ? 'terms_next' : 'terms'
    const forms = next ? 'term_forms_next' : 'term_forms'
    this.sql.run(
      `INSERT INTO ${terms} (term_id, key, term, aliases, explanation, as_of, rev, retired) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(term_id) DO UPDATE SET key = excluded.key, term = excluded.term, aliases = excluded.aliases,
         explanation = excluded.explanation, as_of = excluded.as_of, rev = excluded.rev, retired = excluded.retired`,
      entry.termId,
      entry.key,
      entry.term,
      JSON.stringify(entry.aliases),
      entry.explanation,
      entry.asOf,
      entry.rev,
      entry.retired === true ? 1 : 0,
    )
    let n = 1
    const keep = new Set(newForms)
    const had = new Set(oldForms)
    for (const f of had)
      if (!keep.has(f)) {
        this.sql.run(`DELETE FROM ${forms} WHERE form = ? AND term_id = ?`, f, entry.termId)
        n += 1
      }
    for (const f of keep)
      if (!had.has(f)) {
        this.sql.run(`INSERT OR IGNORE INTO ${forms} (form, term_id) VALUES (?, ?)`, f, entry.termId)
        n += 1
      }
    return n
  }

  /** その表記を持つ語の id（外していない語だけ。索引は外していない語だけを持つ） */
  termIdsOfForm(form: string, next = false): string[] {
    return this.sql
      .all<{ term_id: string }>(`SELECT term_id FROM ${next ? 'term_forms_next' : 'term_forms'} WHERE form = ?`, form)
      .map((r) => r.term_id)
  }

  /** 辞書の語の数（外した語も） */
  termCount(next = false): number {
    return this.#count(`SELECT COUNT(*) AS n FROM ${next ? 'terms_next' : 'terms'}`)
  }

  /** 辞書の語を全部（テスト・作り直しの確かめ用。ツールは使わない） */
  allTerms(next = false): TermEntry[] {
    return this.sql.all<Db>(`SELECT * FROM ${next ? 'terms_next' : 'terms'} ORDER BY term_id`).map(toEntry)
  }

  /** 作り直しの表を空にする */
  clearNextTerms(): void {
    this.#delete('terms_next', '1 = 1')
    this.#delete('term_forms_next', '1 = 1')
  }

  /** 作り直しの表を今の表と入れ替える（今の表を捨て、作り直しの表の名前を替える。行は書き直さない） */
  swapNextTerms(): void {
    this.transaction(() => {
      this.sql.run('DROP TABLE terms')
      this.sql.run('DROP TABLE term_forms')
      this.sql.run('ALTER TABLE terms_next RENAME TO terms')
      this.sql.run('ALTER TABLE term_forms_next RENAME TO term_forms')
      this.sql.run(termsTable('terms_next'))
      this.sql.run(formsTable('term_forms_next'))
    })
  }

  // ---------- 回 ----------

  putRun(r: RunRow): void {
    this.sql.run(
      `INSERT INTO runs (run_id, kind, model, started, expires, last_call, edition_id, writer_ms, checker_ms, since_ms, until_ms, done,
         probe, skip, collect, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.runId,
      r.kind,
      r.model,
      r.started,
      r.expires,
      r.lastCall,
      r.editionId,
      r.writerMs,
      r.checkerMs,
      r.sinceMs,
      r.untilMs,
      r.done ? 1 : 0,
      r.probe,
      JSON.stringify(r.skip),
      JSON.stringify(r.collect),
      JSON.stringify(r.notes),
    )
    this.countRows(1)
  }

  getRun(runId: string): RunRow | null {
    const r = this.sql.all<Db>('SELECT * FROM runs WHERE run_id = ?', runId)[0]
    return r ? toRun(r) : null
  }

  /** 回の覚え書き（期限の内も外も。始めた順） */
  runs(): RunRow[] {
    return this.sql.all<Db>('SELECT * FROM runs ORDER BY started').map(toRun)
  }

  touchRun(runId: string, at: number): void {
    this.sql.run('UPDATE runs SET last_call = ? WHERE run_id = ?', at, runId)
    this.countRows(1)
  }

  setRunCollect(runId: string, c: CollectState): void {
    this.sql.run('UPDATE runs SET collect = ? WHERE run_id = ?', JSON.stringify(c), runId)
    this.countRows(1)
  }

  setRunNotes(runId: string, notes: Record<string, unknown>): void {
    this.sql.run('UPDATE runs SET notes = ? WHERE run_id = ?', JSON.stringify(notes), runId)
    this.countRows(1)
  }

  /** 窓を広げた時（B4） */
  setRunWindow(runId: string, sinceMs: number, untilMs: number): void {
    this.sql.run('UPDATE runs SET since_ms = ?, until_ms = ? WHERE run_id = ?', sinceMs, untilMs, runId)
    this.countRows(1)
  }

  markRunDone(runId: string): void {
    this.sql.run('UPDATE runs SET done = 1 WHERE run_id = ?', runId)
    this.countRows(1)
  }

  /** 回の物（候補・控え・下書き・数え・新しい語・probe）を消す。回の覚え書きは残す */
  deleteRunItems(runId: string): number {
    let n = 0
    for (const t of RUN_ITEM_TABLES) n += this.#delete(t, 'run_id = ?', runId)
    this.#delete('tasks', 'key = ?', `collect:${runId}`)
    return n
  }

  /** 回の覚え書きごと消す（期限） */
  deleteRun(runId: string): void {
    this.deleteRunItems(runId)
    this.#delete('runs', 'run_id = ?', runId)
  }

  // ---------- 回に溜めた新しい語 ----------

  putRunTerm(runId: string, entry: TermEntry, draftId: string): void {
    this.sql.run(
      `INSERT INTO run_terms (run_id, term_id, entry, draft) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id, term_id) DO UPDATE SET entry = excluded.entry, draft = excluded.draft`,
      runId,
      entry.termId,
      JSON.stringify(entry),
      draftId,
    )
    this.countRows(1)
  }

  runTerms(runId: string): { entry: TermEntry; draft: string }[] {
    return this.sql
      .all<{ entry: string; draft: string }>('SELECT entry, draft FROM run_terms WHERE run_id = ? ORDER BY term_id', runId)
      .map((r) => ({ entry: JSON.parse(r.entry) as TermEntry, draft: r.draft }))
  }

  deleteRunTerm(runId: string, termId: string): void {
    this.#delete('run_terms', 'run_id = ? AND term_id = ?', runId, termId)
  }

  // ---------- 候補 ----------

  putCandidates(rows: readonly CandidateRow[]): void {
    this.transaction(() => {
      for (const r of rows)
        this.sql.run(
          `INSERT INTO candidates (run_id, cid, source, url, title, published, at_ms, tags, readable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id, cid) DO UPDATE SET source = excluded.source, url = excluded.url, title = excluded.title,
             published = excluded.published, at_ms = excluded.at_ms, tags = excluded.tags, readable = excluded.readable`,
          r.runId,
          r.cid,
          r.source,
          r.url,
          r.title,
          r.published,
          r.atMs,
          JSON.stringify(r.tags),
          r.readable ? 1 : 0,
        )
    })
    this.countRows(rows.length)
  }

  candidates(runId: string): CandidateRow[] {
    return this.sql.all<Db>('SELECT * FROM candidates WHERE run_id = ? ORDER BY cid', runId).map(toCandidate)
  }

  candidate(runId: string, cid: string): CandidateRow | null {
    const r = this.sql.all<Db>('SELECT * FROM candidates WHERE run_id = ? AND cid = ?', runId, cid)[0]
    return r ? toCandidate(r) : null
  }

  candidateCount(runId: string, readableOnly = true): number {
    return this.#count(`SELECT COUNT(*) AS n FROM candidates WHERE run_id = ?${readableOnly ? ' AND readable = 1' : ''}`, runId)
  }

  // ---------- 資料の控え ----------

  putMaterial(r: MaterialRow): void {
    this.sql.run(
      `INSERT INTO materials (run_id, url, source, title, published, published_note, author, via, body, body_chars, cut, fetched, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, url) DO UPDATE SET source = excluded.source, title = excluded.title, published = excluded.published,
         published_note = excluded.published_note, author = excluded.author, via = excluded.via, body = excluded.body,
         body_chars = excluded.body_chars, cut = excluded.cut, fetched = excluded.fetched,
         read_at = COALESCE(materials.read_at, excluded.read_at)`,
      r.runId,
      r.url,
      r.source,
      r.title,
      r.published,
      r.publishedNote,
      r.author,
      r.via,
      r.body,
      r.bodyChars,
      r.cut ? 1 : 0,
      r.fetched,
      r.readAt,
    )
    this.countRows(1)
  }

  material(runId: string, url: string): MaterialRow | null {
    const r = this.sql.all<Db>('SELECT * FROM materials WHERE run_id = ? AND url = ?', runId, url)[0]
    return r ? toMaterial(r) : null
  }

  materials(runId: string): MaterialRow[] {
    return this.sql.all<Db>('SELECT * FROM materials WHERE run_id = ? ORDER BY url', runId).map(toMaterial)
  }

  /** topic_read_article が読んだ（時刻を新しくする。訂正だけの回の控えは、最後に読んでから1時間で消す） */
  markMaterialRead(runId: string, url: string, at: number): void {
    this.sql.run('UPDATE materials SET read_at = ? WHERE run_id = ? AND url = ?', at, runId, url)
    this.countRows(1)
  }

  /** 控えを消す（訂正だけの回の、最後に読んでから1時間を過ぎた物など） */
  deleteMaterial(runId: string, url: string): void {
    this.#delete('materials', 'run_id = ? AND url = ?', runId, url)
  }

  // ---------- 下書き ----------

  putDraft(d: DraftRow): void {
    this.sql.run(
      `INSERT INTO drafts (run_id, draft_id, seq, rank, model, input, status, reject_reason, created, updated, read_at, verified_at,
         checks, claims, fixed, check_model, topic_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, draft_id) DO UPDATE SET seq = excluded.seq, rank = excluded.rank, model = excluded.model,
         input = excluded.input, status = excluded.status, reject_reason = excluded.reject_reason, updated = excluded.updated,
         read_at = excluded.read_at, verified_at = excluded.verified_at, checks = excluded.checks, claims = excluded.claims,
         fixed = excluded.fixed, check_model = excluded.check_model, topic_id = excluded.topic_id`,
      d.runId,
      d.draftId,
      d.seq,
      d.rank,
      d.model,
      d.input,
      d.status,
      d.rejectReason,
      d.created,
      d.updated,
      d.readAt,
      d.verifiedAt,
      d.checks,
      d.claims,
      d.fixed,
      d.checkModel,
      d.topicId,
    )
    this.countRows(1)
  }

  draft(runId: string, draftId: string): DraftRow | null {
    const r = this.sql.all<Db>('SELECT * FROM drafts WHERE run_id = ? AND draft_id = ?', runId, draftId)[0]
    return r ? toDraft(r) : null
  }

  /** 回の下書き（置いた順） */
  drafts(runId: string): DraftRow[] {
    return this.sql.all<Db>('SELECT * FROM drafts WHERE run_id = ? ORDER BY seq', runId).map(toDraft)
  }

  // ---------- 回の数え ----------

  /** 数えを足す（負の数で戻す） */
  addRunCount(runId: string, key: string, n = 1): void {
    this.sql.run(
      `INSERT INTO run_counts (run_id, key, n) VALUES (?, ?, ?) ON CONFLICT(run_id, key) DO UPDATE SET n = run_counts.n + excluded.n`,
      runId,
      key,
      n,
    )
    this.countRows(1)
  }

  runCount(runId: string, key: string): number {
    return this.#count('SELECT COALESCE(SUM(n), 0) AS n FROM run_counts WHERE run_id = ? AND key = ?', runId, key)
  }

  /** 回の数え（鍵の頭で絞る。'why:' など） */
  runCounts(runId: string, prefix = ''): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.sql.all<{ key: string; n: number }>(
      'SELECT key, n FROM run_counts WHERE run_id = ? AND substr(key, 1, ?) = ? ORDER BY key',
      runId,
      prefix.length,
      prefix,
    ))
      out[r.key] = Number(r.n)
    return out
  }

  // ---------- 出どころの見張り ----------

  putHostRule(r: HostRuleRow): void {
    this.sql.run(
      `INSERT INTO host_rules (host, day, state, crawl_delay, data, checked, changed) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET day = excluded.day, state = excluded.state, crawl_delay = excluded.crawl_delay,
         data = excluded.data, checked = excluded.checked, changed = excluded.changed`,
      r.host,
      r.day,
      r.state,
      r.crawlDelay,
      JSON.stringify(r.data),
      r.checked,
      r.changed,
    )
    this.countRows(1)
  }

  hostRule(host: string): HostRuleRow | null {
    const r = this.sql.all<Db>('SELECT * FROM host_rules WHERE host = ?', host)[0]
    if (!r) return null
    return {
      host: String(r.host),
      day: String(r.day),
      state: String(r.state) as HostRuleRow['state'],
      crawlDelay: num(r.crawl_delay),
      data: json<Record<string, unknown>>(r.data, {}),
      checked: Number(r.checked),
      changed: num(r.changed),
    }
  }

  putTermsWatch(r: TermsWatchRow): void {
    this.sql.run(
      `INSERT INTO terms_watch (url, source, fingerprint, state, checked) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET source = excluded.source, fingerprint = excluded.fingerprint, state = excluded.state,
         checked = excluded.checked`,
      r.url,
      r.source,
      r.fingerprint,
      r.state,
      r.checked,
    )
    this.countRows(1)
  }

  termsWatch(url: string): TermsWatchRow | null {
    const r = this.sql.all<Db>('SELECT * FROM terms_watch WHERE url = ?', url)[0]
    if (!r) return null
    return {
      url: String(r.url),
      source: String(r.source),
      fingerprint: str(r.fingerprint),
      state: String(r.state) as TermsWatchRow['state'],
      checked: Number(r.checked),
    }
  }

  /** 出どころごとの数を足す（直近14回だけ残す。数だけ。題は持たない） */
  putSourceCounts(source: string, at: number, counts: Record<string, number>, keep = 14): void {
    this.sql.run(
      `INSERT INTO source_counts (source, at, counts) VALUES (?, ?, ?) ON CONFLICT(source, at) DO UPDATE SET counts = excluded.counts`,
      source,
      at,
      JSON.stringify(counts),
    )
    this.countRows(1)
    this.#delete(
      'source_counts',
      'source = ? AND at NOT IN (SELECT at FROM source_counts WHERE source = ? ORDER BY at DESC LIMIT ?)',
      source,
      source,
      keep,
    )
  }

  /** 出どころごとの数（新しい順） */
  sourceCounts(source: string): { at: number; counts: Record<string, number> }[] {
    return this.sql
      .all<{ at: number; counts: string }>('SELECT at, counts FROM source_counts WHERE source = ? ORDER BY at DESC', source)
      .map((r) => ({ at: Number(r.at), counts: json<Record<string, number>>(r.counts, {}) }))
  }

  setSourceFlags(source: string, flags: SourceFlags, at: number): void {
    this.sql.run(
      `INSERT INTO source_state (source, data, updated) VALUES (?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET data = excluded.data, updated = excluded.updated`,
      source,
      JSON.stringify(flags),
      at,
    )
    this.countRows(1)
  }

  sourceFlags(source: string): SourceFlags {
    const r = this.sql.all<{ data: string }>('SELECT data FROM source_state WHERE source = ?', source)[0]
    return r ? json<SourceFlags>(r.data, {}) : {}
  }

  // ---------- 日付だけの項目を初めて見た時刻（URL の指紋だけ。3日） ----------

  /** 初めて見た時刻（無ければ at を覚えて at を返す。remember = false（試しの回）は覚えずに null） */
  firstSeen(fp: string, at: number, remember = true): number | null {
    const r = this.sql.all<{ at: number }>('SELECT at FROM first_seen WHERE fp = ?', fp)[0]
    if (r) return Number(r.at)
    if (!remember) return null
    this.sql.run('INSERT INTO first_seen (fp, at) VALUES (?, ?)', fp, at)
    this.countRows(1)
    return at
  }

  pruneFirstSeen(before: number): number {
    return this.#delete('first_seen', 'at < ?', before)
  }

  // ---------- 気象庁の見張りの控え（24時間） ----------

  putJmaWatch(rows: readonly { link: string; title: string; kind: string; at: number }[], kept: number): void {
    this.transaction(() => {
      for (const r of rows)
        this.sql.run(
          `INSERT INTO jma_watch (link, title, kind, at, kept) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(link) DO UPDATE SET title = excluded.title, kind = excluded.kind, at = excluded.at`,
          r.link,
          r.title,
          r.kind,
          r.at,
          kept,
        )
    })
    this.countRows(rows.length)
  }

  jmaWatch(): { link: string; title: string; kind: string; at: number }[] {
    return this.sql
      .all<{ link: string; title: string; kind: string; at: number }>('SELECT link, title, kind, at FROM jma_watch ORDER BY at')
      .map((r) => ({ ...r, at: Number(r.at) }))
  }

  pruneJmaWatch(before: number): number {
    return this.#delete('jma_watch', 'kept < ?', before)
  }

  // ---------- ホストごとの次に取ってよい時刻（予約） ----------

  /**
   * そのホストへ取りに行く時刻を予約する: 次に取ってよい時刻（無ければ今）を自分の取る時刻にし、表の時刻をそれ＋gapMs に進めてから返す。
   * 返すのは待つ ms（0 ならすぐ）。読みと書きの間に await を挟まない（同期の SQL だけ）ので、同時に呼ばれた道具・alarm の予約が
   * 重なっても間は縮まない
   */
  reserveHost(host: string, now: number, gapMs: number): number {
    const r = this.sql.all<{ next: number }>('SELECT next FROM host_pace WHERE host = ?', host)[0]
    const at = Math.max(now, r ? Number(r.next) : now)
    this.sql.run(
      'INSERT INTO host_pace (host, next) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET next = excluded.next',
      host,
      at + gapMs,
    )
    this.countRows(1)
    return at - now
  }

  hostNext(host: string): number | null {
    const r = this.sql.all<{ next: number }>('SELECT next FROM host_pace WHERE host = ?', host)[0]
    return r ? Number(r.next) : null
  }

  // ---------- probe（試しの回） ----------

  putProbe(r: ProbeRow): void {
    this.sql.run(
      `INSERT INTO probe (run_id, source, data, text) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id, source) DO UPDATE SET data = excluded.data, text = excluded.text`,
      r.runId,
      r.source,
      JSON.stringify(r.data),
      r.text,
    )
    this.countRows(1)
  }

  probes(runId: string): ProbeRow[] {
    return this.sql
      .all<{
        run_id: string
        source: string
        data: string
        text: string | null
      }>('SELECT run_id, source, data, text FROM probe WHERE run_id = ? ORDER BY source', runId)
      .map((r) => ({ runId: r.run_id, source: r.source, data: json(r.data, {}), text: r.text }))
  }

  // ---------- やる事（alarm） ----------

  /** やる事を置く（同じ鍵があれば、早い方の時刻にする。later = true なら遅い方でも置き直す） */
  putTask(key: string, at: number, data: Record<string, unknown> = {}, later = false): void {
    const cur = this.sql.all<{ at: number }>('SELECT at FROM tasks WHERE key = ?', key)[0]
    if (cur && !later && Number(cur.at) <= at) return
    this.sql.run(
      'INSERT INTO tasks (key, at, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at, data = excluded.data',
      key,
      at,
      JSON.stringify(data),
    )
    this.countRows(1)
  }

  deleteTask(key: string): void {
    this.#delete('tasks', 'key = ?', key)
  }

  task(key: string): TaskRow | null {
    const r = this.sql.all<{ key: string; at: number; data: string }>('SELECT key, at, data FROM tasks WHERE key = ?', key)[0]
    return r ? { key: r.key, at: Number(r.at), data: json(r.data, {}) } : null
  }

  tasks(): TaskRow[] {
    return this.sql
      .all<{ key: string; at: number; data: string }>('SELECT key, at, data FROM tasks ORDER BY at, key')
      .map((r) => ({ key: r.key, at: Number(r.at), data: json(r.data, {}) }))
  }

  /** いちばん早いやる事の時刻（無ければ null） */
  nextTaskAt(): number | null {
    const r = this.sql.all<{ at: number | null }>('SELECT MIN(at) AS at FROM tasks')[0]
    return r && r.at !== null ? Number(r.at) : null
  }
}

function toMirror(r: Db): MirrorRow {
  return {
    name: String(r.name),
    tbl: String(r.tbl),
    id: String(r.id),
    updUs: Number(r.upd_us),
    updated: String(r.updated),
    hash: String(r.hash),
    device: String(r.device),
    lite: String(r.lite),
  }
}
