// 名札（id）の作り方と形（docs/SPEC.md の 7.7 の「名札」・16.3）: 版の id が端末の時差に左右されない、話題の指紋が threadId・createdAt などで
// 変わらず emphasis が変わると変わる、訂正の id が話題の id で始まり同じ text なら同じ、語の id が全角・半角・大文字・空白の違いで同じ、
// 短い id（話題 p:＋8字・版 e:）と解き方、30日で消せる id の形（ルールの expirableRecord と同じ）。
// 段階3: 回の id（'r{YYYYMMDDHHmm}-{4字}'。日本時間・乱数は呼ぶ側。作り物の版の runId と同じ形）
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeFakeEdition, makeFakeMonth } from '../test/fixtures/fakeEditions'
import { makeSampleTopic } from '../test/fixtures/sampleTopic'
import {
  correctionIdOf,
  editionFailIdOf,
  editionIdAt,
  editionIdOf,
  editionIdOfRecordId,
  editionShortId,
  ID_MAX_CHARS,
  isExpirableDocId,
  isExpiredDocId,
  isRecordIdFor,
  normalizeIdText,
  parseEditionId,
  parseShortId,
  readIdOf,
  resolveEditionRef,
  resolveTopicRef,
  RUN_ID_RE,
  runIdAt,
  termIdOf,
  termPackIdOf,
  topicFingerprint,
  topicIdOf,
  topicShortId,
} from './ids'
import type { TermEntry } from './types'

const jst = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 9, min)

afterEach(() => vi.unstubAllEnvs())

describe('版の id（枠から）', () => {
  it("'{YYYY-MM-DD}-{12|20}'（日本時間の日付）", () => {
    expect(editionIdOf('2026-11-15', '12')).toBe('2026-11-15-12')
    expect(editionIdAt(jst(2026, 11, 15, 10, 30), '12')).toBe('2026-11-15-12')
    expect(editionIdAt(jst(2026, 11, 15, 23, 59), '20')).toBe('2026-11-15-20')
    expect(editionIdAt(jst(2026, 11, 16, 0, 10), '20')).toBe('2026-11-16-20')
  })

  it('端末の時差に左右されない（Asia/Tokyo・America/Los_Angeles・Pacific/Kiritimati で同じ版の id）', () => {
    const times = [jst(2026, 11, 15, 0, 0), jst(2026, 11, 15, 10, 30), jst(2026, 11, 15, 18, 30), jst(2026, 11, 15, 23, 59)]
    const ids = (['Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati'] as const).map((tz) => {
      vi.stubEnv('TZ', tz)
      return times.map((t) => editionIdAt(t, '12'))
    })
    expect(ids[0]).toEqual(['2026-11-15-12', '2026-11-15-12', '2026-11-15-12', '2026-11-15-12'])
    expect(ids[1]).toEqual(ids[0])
    expect(ids[2]).toEqual(ids[0])
  })

  it('読む（形が違う・本当に無い日付は null）', () => {
    expect(parseEditionId('2026-11-15-20')).toEqual({ date: '2026-11-15', slot: '20' })
    expect(parseEditionId('2026-11-15-08')).toBeNull()
    expect(parseEditionId('2026-02-30-12')).toBeNull()
    expect(parseEditionId('2026-11-15-12-abcdefgh')).toBeNull()
    expect(parseEditionId(20261115)).toBeNull()
    expect(readIdOf('2026-11-15-12')).toBe('2026-11-15-12')
  })

  it('版の id で始まる記録の id の、頭の版の id', () => {
    expect(editionIdOfRecordId('2026-11-15-12')).toBe('2026-11-15-12')
    expect(editionIdOfRecordId('2026-11-15-12-k3f9a2bq')).toBe('2026-11-15-12')
    expect(editionIdOfRecordId('2026-11-15-12-k3f9a2bq-c1a2b3c4')).toBe('2026-11-15-12')
    expect(editionIdOfRecordId('2026-11-15-123')).toBeNull()
    expect(editionIdOfRecordId('t3f9a2c1b7d0e')).toBeNull()
  })
})

describe('話題の id（版の id ＋ 中身の指紋8字）', () => {
  it("形は '{版の id}-[0-9a-z]{8}'", () => {
    const t = makeSampleTopic()
    expect(t.id).toMatch(/^2026-11-15-12-[0-9a-z]{8}$/)
    expect(t.id).toBe(`${t.editionId}-${topicFingerprint(t)}`)
    expect(isRecordIdFor('topics', t.id)).toBe(true)
  })

  it('id・threadId・createdAt・model・runId・by・ai・v では変わらない', () => {
    const t = makeSampleTopic()
    const noisy = {
      ...t,
      id: 'x',
      threadId: '2026-11-14-20-aaaaaaaa',
      createdAt: t.createdAt + 123_456,
      model: 'other-model',
      runId: 'r-other',
      by: 'connector' as const,
      ai: 'claude' as const,
      v: 1 as const,
    }
    expect(topicIdOf(noisy)).toBe(t.id)
    expect(topicIdOf({ ...t, v: 2 as unknown as 1, ai: 'other' as unknown as 'claude' })).toBe(t.id)
  })

  it('中身（emphasis・要約・用語の写し・版）が変わると変わる', () => {
    const t = makeSampleTopic()
    expect(makeSampleTopic((x) => (x.emphasis = { ...x.emphasis, summary: ['15日に開通'] })).id).not.toBe(t.id)
    expect(makeSampleTopic((x) => (x.emphasis = {})).id).not.toBe(t.id)
    expect(makeSampleTopic((x) => (x.summary = `${x.summary}。`)).id).not.toBe(t.id)
    expect(makeSampleTopic((x) => (x.terms[0].explanation = 'ちがう説明')).id).not.toBe(t.id)
    const other = makeSampleTopic((x) => (x.editionId = '2026-11-15-20'))
    expect(other.id.startsWith('2026-11-15-20-')).toBe(true)
    // 同じ中身なら何度作っても同じ（送り直しても1件）
    expect(makeSampleTopic().id).toBe(t.id)
    // キーの順は問わない
    const reordered = Object.fromEntries(Object.entries(t).reverse()) as typeof t
    expect(topicIdOf(reordered)).toBe(t.id)
  })
})

describe('訂正・作れなかった印・辞書の束の id', () => {
  const topicId = '2026-11-15-12-k3f9a2bq'

  it("訂正: '{話題の id}-{指紋8字}'（指紋は text。同じ text なら同じ）", () => {
    const a = correctionIdOf({ topicId, text: '新しい橋の歩道の幅は 2メートルではなく 3メートルでした' })
    expect(a).toMatch(/^2026-11-15-12-k3f9a2bq-[0-9a-z]{8}$/)
    expect(a.startsWith(`${topicId}-`)).toBe(true)
    expect(a).toHaveLength(31)
    expect(correctionIdOf({ topicId, text: '新しい橋の歩道の幅は 2メートルではなく 3メートルでした' })).toBe(a)
    expect(correctionIdOf({ topicId, text: '新しい橋の長さは 320メートルではなく 330メートルでした' })).not.toBe(a)
    expect(isRecordIdFor('corrections', a)).toBe(true)
    expect(editionIdOfRecordId(a)).toBe('2026-11-15-12')
  })

  it('作れなかった印: 版と別の id。runId・reasonKind・reason が材料', () => {
    const base = { editionId: '2026-11-15-20', runId: 'r1', reasonKind: 'quota' as const, reason: '使用量の上限に届いた' }
    const a = editionFailIdOf(base)
    expect(a).toMatch(/^2026-11-15-20-[0-9a-z]{8}$/)
    expect(a).not.toBe('2026-11-15-20')
    expect(editionFailIdOf({ ...base, runId: 'r2' })).not.toBe(a)
    expect(editionFailIdOf({ ...base, reasonKind: 'timeout' })).not.toBe(a)
    expect(editionFailIdOf({ ...base })).toBe(a)
  })

  it('辞書の束: 指紋は entries の中身', () => {
    const e: TermEntry = {
      termId: termIdOf('与党（日本）'),
      key: '与党（日本）',
      term: '与党',
      aliases: [],
      explanation: '国の政治で、政府をつくっている政党です。',
      asOf: '2026-11',
      rev: 1,
    }
    const a = termPackIdOf('2026-11-15-12', [e])
    expect(a).toMatch(/^2026-11-15-12-[0-9a-z]{8}$/)
    expect(termPackIdOf('2026-11-15-12', [{ ...e }])).toBe(a)
    expect(termPackIdOf('2026-11-15-12', [{ ...e, rev: 2 }])).not.toBe(a)
  })
})

describe('語の id（t ＋ 12字）', () => {
  it('全角・半角・大文字・空白の違いで同じ', () => {
    const id = termIdOf('AI 規制法')
    expect(id).toMatch(/^t[0-9a-z]{12}$/)
    expect(termIdOf('ＡＩ　規制法')).toBe(id)
    expect(termIdOf(' ai  規制法 ')).toBe(id)
    expect(termIdOf('Ai\n規制法')).toBe(id)
    expect(termIdOf('AI規制法')).not.toBe(id)
    expect(normalizeIdText('  Ａｂｃ　 Ｄ\n e ')).toBe('abc d e')
  })

  it('国の添え字で別の語（「与党（日本）」「与党（米国）」）。全角と半角の括弧は同じ', () => {
    expect(termIdOf('与党（日本）')).not.toBe(termIdOf('与党（米国）'))
    expect(termIdOf('与党（日本）')).toBe(termIdOf('与党(日本)'))
    expect(isRecordIdFor('knownTerms', termIdOf('与党（日本）'))).toBe(true)
  })
})

describe('id の文字と長さ', () => {
  it('どの id も [0-9a-z-] だけで 40字以内', () => {
    const t = makeSampleTopic()
    const ids = [
      editionIdOf('2026-11-15', '12'),
      t.id,
      correctionIdOf({ topicId: t.id, text: '訂正の文' }),
      termPackIdOf('2026-11-15-12', []),
      editionFailIdOf({ editionId: '2026-11-15-12', runId: 'r', reasonKind: 'other', reason: 'x' }),
      termIdOf('〇〇市'),
      readIdOf('2026-11-15-12'),
    ]
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-z-]+$/)
      expect(id.length).toBeLessThanOrEqual(ID_MAX_CHARS)
    }
  })

  it('表ごとの形（取り違えた形は通らない）', () => {
    expect(isRecordIdFor('editions', '2026-11-15-12')).toBe(true)
    expect(isRecordIdFor('editions', '2026-11-15-12-abcdefgh')).toBe(false)
    expect(isRecordIdFor('topics', '2026-11-15-12')).toBe(false)
    expect(isRecordIdFor('topics', '2026-11-15-12-ABCDEFGH')).toBe(false)
    expect(isRecordIdFor('reads', '2026-11-15-20')).toBe(true)
    expect(isRecordIdFor('knownTerms', 't3f9a2c1b7d0e')).toBe(true)
    expect(isRecordIdFor('knownTerms', 't3f9a2c1b7d0')).toBe(false)
  })
})

describe('Claude に見せる短い id', () => {
  const a = '2026-11-15-12-k3f9a2bq'
  const b = '2026-11-16-20-m2n8c4d1'

  it('話題は p:＋指紋8字（id の後ろの8字）、版は e:＋版の id', () => {
    expect(topicShortId(a)).toBe('p:k3f9a2bq')
    expect(editionShortId('2026-11-15-12')).toBe('e:2026-11-15-12')
    expect(parseShortId(' P:K3F9A2BQ ')).toEqual({ kind: 'topic', fingerprint: 'k3f9a2bq' })
    expect(parseShortId('e:2026-11-15-12')).toEqual({ kind: 'edition', editionId: '2026-11-15-12' })
    expect(parseShortId('p:k3f9')).toBeNull()
    expect(parseShortId('e:2026-11-15')).toBeNull()
    expect(parseShortId('t:k3f9a2bq')).toBeNull()
  })

  it('候補の話題の中だけで解く（無い・2つ以上は断る）', () => {
    expect(resolveTopicRef('p:k3f9a2bq', [a, b])).toEqual({ ok: true, id: a })
    expect(resolveTopicRef(a, [a, b])).toEqual({ ok: true, id: a })
    expect(resolveTopicRef('p:zzzzzzzz', [a, b])).toEqual({ ok: false, reason: 'not-found', matches: [] })
    expect(resolveTopicRef('p:k3f9a2bq', [b])).toMatchObject({ ok: false, reason: 'not-found' })
    expect(resolveTopicRef('2026-11-14-12-k3f9a2bq', [a, b])).toMatchObject({ ok: false, reason: 'not-found' })
    const twin = '2026-11-14-20-k3f9a2bq'
    expect(resolveTopicRef('p:k3f9a2bq', [a, twin, b])).toEqual({ ok: false, reason: 'ambiguous', matches: [a, twin] })
    expect(resolveTopicRef('p:k3f9a2bq', [a, a])).toEqual({ ok: true, id: a })
  })

  it('版の指し方', () => {
    expect(resolveEditionRef('e:2026-11-15-12')).toBe('2026-11-15-12')
    expect(resolveEditionRef('2026-11-15-20')).toBe('2026-11-15-20')
    expect(resolveEditionRef('e:2026-11-15-13')).toBeNull()
  })
})

describe('30日で消せる文書の id（ルールの expirableRecord と同じ形）', () => {
  it('表ごとの形だけ', () => {
    for (const ok of [
      'editions:2026-10-01-12',
      'topics:2026-10-01-12-abcdefgh',
      'editionFails:2026-10-01-20-abcdefgh',
      'corrections:2026-10-01-12-abcdefgh-12345678',
      'reads:2026-10-01-12',
    ])
      expect(isExpirableDocId(ok)).toBe(true)
    // 7.7 の「ルールのテスト」の、表ごとの id の形に当たらない物
    for (const ng of [
      'editions:2026-10-01-12-abcdefgh',
      'topics:2026-10-01-12',
      'topics:2026-10-01-12-aaaaaaaa-bbbbbbbb',
      'editionFails:2026-10-01-12-aaaaaaaa-bbbbbbbb',
      'corrections:2026-10-01-12-abcdefgh',
      'topics:2026-10-01-12-abc',
      'termPacks:2026-10-01-12-abcdefgh',
      'knownTerms:t3f9a2c1b7d0e',
      'reads:2026-10-01-12-abcdefgh',
      'saves:2026-10-01-12',
    ])
      expect(isExpirableDocId(ng)).toBe(false)
  })

  it('版の日付から30日を過ぎた物だけ（29日目は消せない・30日目は消せる。訂正は話題と同じ日）', () => {
    const now = jst(2026, 10, 31, 0, 0)
    expect(isExpiredDocId('editions:2026-10-01-12', now)).toBe(true)
    expect(isExpiredDocId('editions:2026-10-02-12', now)).toBe(false)
    expect(isExpiredDocId('editions:2026-10-01-12', now - 1)).toBe(false)
    expect(isExpiredDocId('topics:2026-10-01-20-abcdefgh', now)).toBe(true)
    expect(isExpiredDocId('corrections:2026-10-01-20-abcdefgh-12345678', now)).toBe(true)
    expect(isExpiredDocId('corrections:2026-10-02-12-abcdefgh-12345678', now)).toBe(false)
    expect(isExpiredDocId('termPacks:2026-10-01-12-abcdefgh', now)).toBe(false)
    expect(isExpiredDocId('editions:2026-02-30-12', now)).toBe(false)
  })
})

describe('回の id（段階3）', () => {
  const jst = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 9, min)

  it("'r' ＋ 始めた時刻（日本時間の YYYYMMDDHHmm）＋ '-' ＋ 乱数4字", () => {
    expect(runIdAt(jst(2026, 11, 19, 10, 16), 'a1b2')).toBe('r202611191016-a1b2')
    expect(runIdAt(jst(2026, 11, 20, 0, 5), '0000')).toBe('r202611200005-0000')
    expect(RUN_ID_RE.test('r202611191016-a1b2')).toBe(true)
    for (const bad of ['r20261119101-a1b2', 'r202611191016-A1B2', 'r202611191016-a1b', 'x202611191016-a1b2', 'r202611191016a1b2'])
      expect([bad, RUN_ID_RE.test(bad)]).toEqual([bad, false])
  })

  it('端末の時差に左右されない', () => {
    const t = jst(2026, 11, 19, 23, 59)
    const ids = ['Asia/Tokyo', 'America/Los_Angeles'].map((tz) => {
      vi.stubEnv('TZ', tz)
      return runIdAt(t, 'zz99')
    })
    vi.unstubAllEnvs()
    expect(ids).toEqual(['r202611192359-zz99', 'r202611192359-zz99'])
  })

  it('乱数が [0-9a-z] の4字でなければ投げる（domain は乱数を持たない）', () => {
    for (const bad of ['', 'abc', 'abcde', 'AB12', 'ab-1']) expect(() => runIdAt(0, bad)).toThrow(RangeError)
  })

  it('作り物の版の runId も同じ形', () => {
    const ed = makeFakeEdition({ date: '2026-11-15', slot: '12', seed: 'test' })
    const month = makeFakeMonth({ until: '2026-11-15', days: 3 })
    const runIds = [
      ed.edition,
      ...ed.topics,
      ...month.editions.map((e) => e.edition),
      ...month.editionFails,
      ...month.corrections,
    ].map((r) => r.runId)
    for (const r of runIds) expect([r, RUN_ID_RE.test(r)]).toEqual([r, true])
  })
})
