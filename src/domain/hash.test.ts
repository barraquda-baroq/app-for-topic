// 比べる（equal）と指紋（hash）の確かめ（docs/SPEC.md の 7.7）。hashJson は DS・NS と同じ値になること（段階3のコネクタと同じ計算）、
// 名札の短い指紋（fingerprint）が [0-9a-z] だけの決まった字数で、同じ材料なら同じ・違えば違う値になること。
// 段階3: 指紋と名札の決め打ちの値（fingerprint・termIdOf・topicIdOf ほか）。アプリとコネクタが同じ id を作る事を、計算の中身が変わったら
// 落ちる形で止める（段階3の設計の 6.1 の B1）。出典に著者の欄を書いた話題だけ指紋が変わる
import { describe, expect, it } from 'vitest'
import { contentEqual, deepEqual, stableStringify } from './equal'
import { cyrb53, fingerprint, hashJson, recordHash } from './hash'
import { correctionIdOf, editionFailIdOf, termIdOf, topicIdOf } from './ids'
import type { Topic } from './types'

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

describe('指紋と名札の決め打ちの値（段階3。アプリとコネクタで同じ値）', () => {
  /** 決め打ちの値を作る、作り物の話題（中身は作り物。社は作り物の一覧の名前、URL は https://example.com/…） */
  const topic: Topic = {
    id: '',
    v: 1,
    createdAt: 0,
    by: 'connector',
    ai: 'claude',
    model: 'fake-writer-model',
    runId: 'r202611151016-abcd',
    editionId: '2026-11-15-12',
    threadId: '',
    rank: 1,
    rankReason: '作り物の順位の理由',
    region: 'jp',
    genre: 'economy',
    major: false,
    headline: '〇〇市の新しい橋が開通',
    summary: '〇〇市で新しい橋が開通した。',
    conclusion: { label: 'settled', note: '', breaking: false },
    soWhat: { life: null, system: null, world: null, whyNews: null },
    stakeholders: [],
    view: { kind: 'none', noneReason: null },
    timeline: [],
    followUp: null,
    terms: [],
    sources: [
      {
        outlet: '〇〇省',
        title: '作り物の発表',
        url: 'https://example.com/press/1',
        publishedAt: '2026-11-15',
        publishedNote: null,
        via: null,
      },
    ],
    outletNames: ['〇〇省'],
    unverified: [],
    check: null,
    emphasis: {},
  }

  it('fingerprint（8字・12字）', () => {
    expect(fingerprint('〇〇市で新しい橋が開通', 8)).toBe('fca201us')
    expect(fingerprint('〇〇市で新しい橋が開通', 12)).toBe('1hfca29601us')
    expect(fingerprint(stableStringify({ a: 1 }), 8)).toBe('4gl4oiee')
  })

  it('termIdOf（全角と半角・大文字をそろえた key の指紋）', () => {
    expect(termIdOf('与党（日本）')).toBe('tva8w0i6olk75')
    expect(termIdOf('A 党')).toBe('tvvvsr30e4p7r')
    expect(termIdOf('ＡＩ')).toBe('t3z6hb0up5fwd')
    expect(termIdOf('ai')).toBe(termIdOf('ＡＩ'))
  })

  it('topicIdOf（指紋の外の欄を変えても同じ。著者の欄を書くと変わる）', () => {
    expect(topicIdOf(topic)).toBe('2026-11-15-12-kkmivoyz')
    expect(topicIdOf({ ...topic, model: 'fake-checker-model', createdAt: 1, runId: 'r202611151816-zzzz' })).toBe(
      '2026-11-15-12-kkmivoyz',
    )
    expect(topicIdOf({ ...topic, sources: [{ ...topic.sources[0], author: 'FAKE_著者' }] })).toBe('2026-11-15-12-11vc10te')
  })

  it('訂正・作れなかった印の id', () => {
    expect(correctionIdOf({ topicId: '2026-11-15-12-abcdefgh', text: '作り物の訂正の文' })).toBe(
      '2026-11-15-12-abcdefgh-nvdjvbuu',
    )
    expect(
      editionFailIdOf({ editionId: '2026-11-15-12', runId: 'r202611151016-abcd', reasonKind: 'quota', reason: '作り物の理由' }),
    ).toBe('2026-11-15-12-f2cvhdoq')
  })
})
