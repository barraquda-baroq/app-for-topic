// 比べる（equal）と指紋（hash）の確かめ（docs/SPEC.md の 7.7）。hashJson は DS・NS と同じ値になること（段階3のコネクタと同じ計算）、
// 名札の短い指紋（fingerprint）が [0-9a-z] だけの決まった字数で、同じ材料なら同じ・違えば違う値になること
import { describe, expect, it } from 'vitest'
import { contentEqual, deepEqual, stableStringify } from './equal'
import { cyrb53, fingerprint, hashJson, recordHash } from './hash'

describe('比べる（equal。DS から）', () => {
  it('キーの順と undefined の項目は問わない', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
    expect(deepEqual({ a: [] }, { a: {} })).toBe(false)
  })

  it('stableStringify はキーを並べ替え、undefined を書かない', () => {
    expect(stableStringify({ b: 1, a: { d: undefined, c: [undefined, 'x'] } })).toBe('{"a":{"c":[null,"x"]},"b":1}')
    expect(stableStringify(undefined)).toBe('null')
    expect(stableStringify('与党')).toBe('"与党"')
  })

  it('contentEqual は updatedAt を除いて比べる', () => {
    expect(contentEqual({ id: 'a', on: true, updatedAt: 1 }, { id: 'a', on: true, updatedAt: 2 })).toBe(true)
    expect(contentEqual({ id: 'a', on: true }, { id: 'a', on: false })).toBe(false)
    expect(contentEqual(null, undefined)).toBe(true)
  })
})

describe('指紋（hash。DS から）', () => {
  it('DS・NS の hashJson と同じ値（同じ計算を段階3のコネクタでも使う）', () => {
    expect(hashJson('')).toBe('26c8wzs8fs1.kz98hrb9of.0')
    expect(hashJson('{"a":1}')).toBe('17n1rz14gl4.1nu9hiboiee.7')
    expect(hashJson('打ち合わせ')).toBe('xow8mnkvg3.4qwptymhx6.5')
    expect(hashJson(null)).toBe('')
  })

  it('外側の文書の hash はキーの順で変わらない', () => {
    expect(recordHash({ b: 2, a: 1 })).toBe(recordHash({ a: 1, b: 2 }))
    expect(recordHash({ a: 1 })).toBe(hashJson('{"a":1}'))
  })
})

describe('名札の短い指紋（fingerprint）', () => {
  it('[0-9a-z] だけの決まった字数（8字・12字）', () => {
    for (const s of ['', 'a', '{"a":1}', '〇〇市で新しい橋が開通', '𠮷野家'.repeat(50)]) {
      expect(fingerprint(s, 8)).toMatch(/^[0-9a-z]{8}$/)
      expect(fingerprint(s, 12)).toMatch(/^[0-9a-z]{12}$/)
    }
  })

  it('2つの種の cyrb53 の後ろ半分ずつ（hashJson の2つの種と同じ計算）', () => {
    const s = '{"a":1}'
    const a = cyrb53(s, 1).padStart(11, '0')
    const b = cyrb53(s, 2).padStart(11, '0')
    expect(fingerprint(s, 8)).toBe(a.slice(-4) + b.slice(-4))
    expect(fingerprint(s, 12)).toBe(a.slice(-6) + b.slice(-6))
    expect(hashJson(s).startsWith(cyrb53(s, 1))).toBe(true)
  })

  it('同じ材料なら同じ、1字違えば違う。1,000個で重ならない', () => {
    expect(fingerprint('abc', 8)).toBe(fingerprint('abc', 8))
    expect(fingerprint('abc', 8)).not.toBe(fingerprint('abd', 8))
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(fingerprint(`topic-${i}`, 8))
    expect(seen.size).toBe(1000)
  })

  it('字数が 1〜22 でなければ投げる', () => {
    expect(() => fingerprint('a', 0)).toThrow()
    expect(() => fingerprint('a', 23)).toThrow()
    expect(fingerprint('a', 22)).toMatch(/^[0-9a-z]{22}$/)
  })
})
