// ログインと持ち主の関所の司令塔（docs/SPEC.md の 14.4）: トップ・設定の画面を出してよいか（持ち主だと確かめたアカウントだけ）。
// DS の src/sync/controller.test.ts の「データの画面を出してよいか」から（別のアカウントの確かめは段階1で足す）
import { afterEach, describe, expect, it } from 'vitest'
import { canShowData, resetSyncForTests } from './controller'

afterEach(() => resetSyncForTests())

const signedIn = { auth: 'signedIn' as const }

describe('トップ・設定の画面を出してよいか', () => {
  it('この端末で持ち主だと確かめたアカウントの時だけ', () => {
    expect(canShowData({ ...signedIn, owner: 'ok', ownerSeen: true })).toBe(true)
    // まだ確かめていない・記録が無い（確かめていない）・ほかのアカウント
    expect(canShowData({ ...signedIn, owner: 'checking', ownerSeen: false })).toBe(false)
    expect(canShowData({ ...signedIn, owner: 'missing', ownerSeen: false })).toBe(false)
    expect(canShowData({ ...signedIn, owner: 'mismatch', ownerSeen: true })).toBe(false)
    // 前に確かめたアカウントで、記録が消えた時は出す（DS は同期だけを止める。段階0には同期が無い）
    expect(canShowData({ ...signedIn, owner: 'missing', ownerSeen: true })).toBe(true)
    expect(canShowData({ auth: 'signedOut', owner: 'ok', ownerSeen: true })).toBe(false)
    expect(canShowData({ auth: 'checking', owner: 'ok', ownerSeen: true })).toBe(false)
  })
})
