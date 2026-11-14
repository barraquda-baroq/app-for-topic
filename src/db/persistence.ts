// 端末の中の保存（Dexie・IndexedDB。DB の名前は topic-studio。docs/SPEC.md の 3.・14.4）。DS の src/db/persistence.ts から、
// 端末だけの表 _meta の部分だけを写した物。段階0で覚えるのは、この端末で持ち主だと確かめたアカウント（_meta の ownerSeen）だけ。
// 段階1でデータの表と送信待ち（_outbox など）を version(2) で足す（v1 はもう端末にあるので変えない）

import Dexie, { type Table } from 'dexie'

export const DEFAULT_DB_NAME = 'topic-studio'

/**
 * Dexie v1 の表の一覧（固定する。段階0で端末に入るので、後から表を足す時は v2 を作る）。
 * _meta は端末だけの覚え書き（同期しない。key と value）
 */
export const V1_SCHEMA: Record<string, string> = {
  _meta: 'key',
}

interface MetaRow {
  key: string
  value: unknown
}

class TopicDB extends Dexie {
  constructor(name: string) {
    super(name)
    this.version(1).stores(V1_SCHEMA)
  }

  get meta(): Table<MetaRow, string> {
    return this.table('_meta')
  }
}

export interface Persistence {
  /** 端末だけの覚え書き（_meta）を読む（無ければ undefined） */
  getMeta<T>(key: string): Promise<T | undefined>
  /** 端末だけの覚え書き（_meta）を書く */
  setMeta(key: string, value: unknown): Promise<void>
  close(): void
}

export function createPersistence(dbName = DEFAULT_DB_NAME): Persistence {
  const db = new TopicDB(dbName)
  return {
    async getMeta<T>(key: string) {
      return (await db.meta.get(key))?.value as T | undefined
    },

    async setMeta(key, value) {
      await db.meta.put({ key, value })
    },

    close() {
      db.close()
    },
  }
}
