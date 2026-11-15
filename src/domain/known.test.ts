// 「知ってる」の判定と合わせ方（docs/SPEC.md の 7.4・7.8・16.3）: 古い話題で押しても新しい話題で出る・asOf が戻らない、asOf が null の
// 記録に asOf の付いた話題はもう一度出る、2台の合わせ方（on・term は1組、asOf は新しい方）
import { describe, expect, it } from 'vitest'
import { termIdOf } from './ids'
import { isKnownTerm, KNOWN_TERM_FIELD_GROUP, mergeKnownTermFields, newerAsOf, pressKnownTerm, unpressKnownTerm } from './known'
import type { KnownTerm } from './types'

const termId = termIdOf('与党（日本）')
const press = (asOf: string | null, term = '与党') => ({ termId, term, asOf })

describe('「知ってる」の判定', () => {
  it('話題の asOf が null なら、on の記録で知ってる', () => {
    const k = pressKnownTerm(null, press(null), 1)
    expect(isKnownTerm(k, null)).toBe(true)
    expect(isKnownTerm(unpressKnownTerm(k, 2), null)).toBe(false)
    expect(isKnownTerm(undefined, null)).toBe(false)
  })

  it('話題の asOf ≦ 記録の asOf なら知ってる。新しい説明の話題でだけ、もう一度出る', () => {
    const k = pressKnownTerm(null, press('2026-11'), 1)
    expect(isKnownTerm(k, '2026-11')).toBe(true)
    expect(isKnownTerm(k, '2026-10')).toBe(true)
    expect(isKnownTerm(k, '2026-12')).toBe(false)
  })

  it('記録の asOf が null で、asOf の付いた話題はもう一度出る', () => {
    const k = pressKnownTerm(null, press(null), 1)
    expect(isKnownTerm(k, '2026-11')).toBe(false)
  })

  it('7.4 の例: 2026-12 の説明で押した後に 11/20 の版（2026-11）で押しても asOf は 2026-12 のまま。どちらの版でも出ない', () => {
    let k = pressKnownTerm(null, press('2026-12'), 1)
    k = pressKnownTerm(k, press('2026-11'), 2)
    expect(k.asOf).toBe('2026-12')
    expect(k.updatedAt).toBe(2)
    expect(isKnownTerm(k, '2026-11')).toBe(true)
    expect(isKnownTerm(k, '2026-12')).toBe(true)
    // 外した後にもう一度押しても戻らない
    k = pressKnownTerm(unpressKnownTerm(k, 3), press(null), 4)
    expect(k).toMatchObject({ on: true, asOf: '2026-12', createdAt: 1, updatedAt: 4 })
  })

  it('押した記録の形と、知らない欄を残すこと', () => {
    expect(pressKnownTerm(null, press('2026-11'), 10)).toEqual({
      id: termId,
      v: 1,
      createdAt: 10,
      updatedAt: 10,
      by: 'user',
      ai: null,
      term: '与党',
      asOf: '2026-11',
      on: true,
    })
    const prev = { ...pressKnownTerm(null, press(null), 1), future: 'x' } as KnownTerm
    expect(pressKnownTerm(prev, press(null, '与党（日本）'), 2)).toMatchObject({ future: 'x', term: '与党（日本）' })
    expect(unpressKnownTerm(prev, 3)).toMatchObject({ future: 'x', on: false, updatedAt: 3 })
  })

  it('新しい方の時点（null がいちばん古い）', () => {
    expect(newerAsOf(null, null)).toBeNull()
    expect(newerAsOf(null, '2026-11')).toBe('2026-11')
    expect(newerAsOf('2026-12', '2026-11')).toBe('2026-12')
    expect(newerAsOf('2026-11', '2027-01')).toBe('2027-01')
  })
})

describe('2台の合わせ方（on・term は1組、asOf は新しい方）', () => {
  const fields = (on: boolean, term: string, asOf: string | null) => ({ on, term, asOf })

  it('スマホで「知ってる」、電波の無い PC で外す → PC が後で同期すれば「外した」', () => {
    const base = fields(true, '与党', '2026-11')
    const pc = fields(false, '与党', '2026-11')
    const cloud = fields(true, '与党', '2026-11')
    expect(mergeKnownTermFields(base, pc, cloud)).toEqual(fields(false, '与党', '2026-11'))
  })

  it('この端末が変えていなければ相手の組。両方が変えたらこの端末の組。asOf はどちらでも新しい方', () => {
    const base = fields(true, '与党', '2026-11')
    expect(mergeKnownTermFields(base, base, fields(false, '与党（日本）', '2026-12'))).toEqual(
      fields(false, '与党（日本）', '2026-12'),
    )
    expect(mergeKnownTermFields(base, fields(true, '与党（日本）', '2026-11'), fields(false, '与党', '2027-01'))).toEqual(
      fields(true, '与党（日本）', '2027-01'),
    )
    expect(mergeKnownTermFields(base, fields(false, '与党', '2027-02'), base)).toEqual(fields(false, '与党', '2027-02'))
  })

  it('共通の履歴が無い時（両方が新しく作った）は、この端末の組と新しい方の asOf', () => {
    expect(mergeKnownTermFields(null, fields(true, '与党', null), fields(false, '与党', '2026-11'))).toEqual(
      fields(true, '与党', '2026-11'),
    )
  })

  it('1組の欄', () => {
    expect(KNOWN_TERM_FIELD_GROUP).toEqual(['on', 'term'])
  })
})
