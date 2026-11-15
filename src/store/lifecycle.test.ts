// 画面を離れる前の保存（docs/SPEC.md の 7.8 の「部品」の saveBeforeLeave）: 入力欄の下書きを反映し、既読・知ってるを端末に書き、
// 送信待ちをすぐ送り始める。端末に書けなかった時は false（アプリの更新の帯は切り替えない。src/ui/Layout.tsx）
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ order: [] as string[], saved: true }))

vi.mock('../sync/controller', () => ({
  uploadNow: () => {
    h.order.push('送る')
  },
}))
vi.mock('./appStore', () => ({
  flushNow: async () => {
    h.order.push('端末に書く')
    return h.saved
  },
}))

import { markDraftClean, markDraftDirty } from './draftRegistry'
import { saveBeforeLeave } from './lifecycle'

const key = Symbol('下書き')

afterEach(() => {
  markDraftClean(key)
  h.order = []
  h.saved = true
})

describe('画面を離れる前の保存', () => {
  it('下書きを反映 → 端末に書く → 送信待ちを送り始める の順。書けたら true', async () => {
    markDraftDirty(key, () => h.order.push('下書き'))
    expect(await saveBeforeLeave()).toBe(true)
    expect(h.order).toEqual(['下書き', '端末に書く', '送る'])
  })

  it('端末に書けなかった時は false（送信待ちにある物は送り始める）', async () => {
    h.saved = false
    expect(await saveBeforeLeave()).toBe(false)
    expect(h.order).toEqual(['端末に書く', '送る'])
  })
})
