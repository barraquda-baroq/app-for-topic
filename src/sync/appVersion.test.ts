// アプリの版（DS の src/sync/syncParts.test.ts の「package.json の version の x.y と揃っている」から）とデータの形の版（段階3で 2）
import { describe, expect, it } from 'vitest'
import pkg from '../../package.json?raw'
import { APP_VERSION, DATA_MODEL } from './appVersion'

describe('アプリの版', () => {
  it('package.json の version の x.y と揃っている', () => {
    const version = (JSON.parse(pkg) as { version: string }).version
    expect(version.split('.').slice(0, 2).join('.')).toBe(APP_VERSION)
  })

  it('データの形の版は 2（段階3で出典に著者の欄を足し、出典の表示が規約の条件になったため。コネクタも同じ値を持つ）', () => {
    expect(DATA_MODEL).toBe(2)
  })
})
