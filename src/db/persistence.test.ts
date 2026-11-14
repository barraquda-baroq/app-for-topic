// 端末の中の保存（_meta）。DB の名前と v1 の表は、端末に入った後は変えない（段階1は v2 で足す。docs/SPEC.md の 14.4）
import { describe, expect, it } from 'vitest'
import { createPersistence, DEFAULT_DB_NAME, V1_SCHEMA } from './persistence'

const uniqueName = () => `persistence-${Math.random().toString(36).slice(2)}`

describe('端末の中の保存', () => {
  it('DB の名前は topic-studio、v1 の表は _meta だけ', () => {
    expect(DEFAULT_DB_NAME).toBe('topic-studio')
    expect(V1_SCHEMA).toEqual({ _meta: 'key' })
  })

  it('覚え書きを書いて読める。開き直しても残る', async () => {
    const name = uniqueName()
    const p = createPersistence(name)
    expect(await p.getMeta('ownerSeen')).toBeUndefined()
    await p.setMeta('ownerSeen', 'uid-a')
    expect(await p.getMeta<string>('ownerSeen')).toBe('uid-a')
    p.close()
    const again = createPersistence(name)
    expect(await again.getMeta<string>('ownerSeen')).toBe('uid-a')
    // 消す時は null を書く
    await again.setMeta('ownerSeen', null)
    expect(await again.getMeta('ownerSeen')).toBeNull()
    again.close()
  })
})
