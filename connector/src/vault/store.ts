// Vault（Durable Object）の SQLite。Workers では ctx.storage.sql、テストでは node:sqlite を同じ SQL で使う（NS の connector/src/vault/store.ts の形）。
// B0（コネクタの土台）では、NS から写す所だけを置く:
// - meta: 身元（identity。更新用トークンは TOKEN_ENC_KEY で暗号化）・連携の状態（pairing）・使った連携の確かめの指紋（usedPairings）・
//   数の記録（quota）・接続の要求の回数（rate:…）・同意の承認（consentClaims）など（JSON）
// 写し（表ごとの軽い行・辞書の今の形）・回の覚え書き・候補・資料の控え・下書き・やる事の表は、B3 以降で SCHEMA に表を足す（設計の 1.1・1.3・1.9）。
// NS の rec（全文の写し）・chunk（分割文書）・readmemo は TS では持たない（TS の記録は書き換えないので、全文を持たなくても答えられる）。
// 取り込んだ記録の写しは暗号化しない（Durable Object の保存領域はもともと暗号化されている。NS と同じ）。

export type SqlValue = string | number | null

export interface SqlRunner {
  all<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): T[]
  run(sql: string, ...params: SqlValue[]): void
  /** 同期のトランザクション（途中で例外なら何も書かない） */
  transaction<T>(fn: () => T): T
}

/** 表を作る SQL（B3 以降で写し・回・下書きなどの表を足す） */
export const SCHEMA: readonly string[] = [`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`]

export class MirrorStore {
  readonly sql: SqlRunner

  constructor(sql: SqlRunner) {
    this.sql = sql
    for (const s of SCHEMA) sql.run(s)
  }

  transaction<T>(fn: () => T): T {
    return this.sql.transaction(fn)
  }

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
}
