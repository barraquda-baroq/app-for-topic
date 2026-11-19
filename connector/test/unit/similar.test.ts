// 似た題の印（段階3の設計の 1.7 の (8)）: 「」の中の名前（4字以上）か「〇〇法」「〇〇法案」の語が同じ候補どうしに [似た題 c0031] の印だけ
import { describe, expect, it } from 'vitest'
import { similarKeys, similarTags, similarTagText } from '../../src/fetch/similar'

describe('似た題の印', () => {
  it('「」の中の4字以上の名前と、〇〇法・〇〇法案の語（方法・法人などは当てない）', () => {
    expect(similarKeys('「作り物推進計画」の公表について')).toEqual(['作り物推進計画'])
    expect(similarKeys('架空振興法案の概要')).toEqual(['架空振興法案'])
    expect(similarKeys('「作り」の新しい方法と作り物法人')).toEqual([])
  })

  it('同じ語の候補どうしに印。中身は作らない', () => {
    const m = similarTags([
      { cid: 'c0001', title: '「作り物推進計画」の公表について' },
      { cid: 'c0002', title: '作り物の会見（「作り物推進計画」について）' },
      { cid: 'c0003', title: '架空振興法案を閣議決定' },
      { cid: 'c0004', title: '架空振興法案の説明' },
      { cid: 'c0005', title: '関係の無い作り物の題' },
    ])
    expect(m.get('c0001')).toEqual(['c0002'])
    expect(m.get('c0002')).toEqual(['c0001'])
    expect(m.get('c0003')).toEqual(['c0004'])
    expect(m.has('c0005')).toBe(false)
    expect(similarTagText(['c0031'])).toBe('似た題 c0031')
  })
})
