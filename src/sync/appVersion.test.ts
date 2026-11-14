// アプリの版（DS の src/sync/syncParts.test.ts の「package.json の version の x.y と揃っている」から）
import { describe, expect, it } from 'vitest'
import pkg from '../../package.json?raw'
import { APP_VERSION } from './appVersion'

describe('アプリの版', () => {
  it('package.json の version の x.y と揃っている', () => {
    const version = (JSON.parse(pkg) as { version: string }).version
    expect(version.split('.').slice(0, 2).join('.')).toBe(APP_VERSION)
  })
})
