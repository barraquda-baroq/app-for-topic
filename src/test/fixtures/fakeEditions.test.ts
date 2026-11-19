// 作り物の版（docs/SPEC.md の 16.3 の「作り物の版」）を確かめる: 場面が全部ある・id がコネクタと同じ作り方・同じ種からは同じ物・
// 中身が作り物だけ（URL は https://example.com/…、社は作り物の一覧、読んだ所は「××ニュース」）・上限の内（コネクタの確かめで断る物が、
// 断る物を入れた1本と後の版の記録の見本のほかに無い）。作り物の版は、テスト・エミュレーターに入れる道具・段階2の画面の見本で使う。
// 段階2で足した extras（設計: 段階2の 5.3・4.1）: 既定の出力（id・数）は今と同じ・correctsEmphasis の訂正の対象が強調した語句・どれも送る
// 直前の確かめを通る（newerTopic・newerEdition で v: 2 にした記録は、v の誤りだけで断られる）
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkEmphasis, emphasisFieldText, firstOccurrence, splitEmphasis } from '../../domain/emphasis'
import { deepEqual, stableStringify } from '../../domain/equal'
import { correctionIdOf, editionFailIdOf, editionIdOf, isRecordIdFor, termIdOf, termPackIdOf, topicIdOf } from '../../domain/ids'
import { firstSyncSinceMs, isJstDateTime, isPublishedAt, isWithinRetention, isYm, isYmd, jstStartOfDayMs } from '../../domain/jst'
import { isKnownTerm } from '../../domain/known'
import { countChars, RECORD_LIMITS } from '../../domain/limits'
import { DEFAULT_OUTLET_LIST } from '../../domain/outlets'
import { repairTopic, type RepairOutcome, type ShownTopic } from '../../domain/repair'
import { GENRE_VALUES, type TermEntry, type Topic } from '../../domain/types'
import {
  checkCorrection,
  checkEdition,
  checkEditionFail,
  checkEditionNorms,
  checkMajorsPerDay,
  checkRecord,
  checkTermPack,
  checkTopic,
} from '../../domain/validate'
import {
  CHAIN_CORRECTION_TEXT,
  CLOSURE_CORRECTION_TEXT,
  CLOSURE_EMPHASIS,
  FAKE_MONTH_EXTRAS,
  FAKE_TOPIC_SCENES,
  FAKE_URL_PREFIX,
  FAKE_VIA,
  fakeRecordsOf,
  makeFakeEdition,
  makeFakeMonth,
  RULING_JP_KEY,
  RULING_US_KEY,
  type FakeEdition,
  type FakeMonth,
  type FakeTopicScene,
} from './fakeEditions'
import { FAKE_OUTLET_NAMES, FAKE_OUTLETS, FAKE_UNLISTED_OUTLET } from './fakeOutlets'

const opts = { outlets: FAKE_OUTLETS }
const ED_OPTS = { date: '2026-11-15', slot: '12', seed: 'test' } as const
const ed = makeFakeEdition(ED_OPTS)
const MONTH_OPTS = { until: '2026-11-15', days: 35 } as const
const month = makeFakeMonth(MONTH_OPTS)

const scene = (e: FakeEdition, s: FakeTopicScene): Topic => {
  const t = e.topics.find((x) => x.id === e.scenes[s])
  if (!t) throw new Error(`場面 ${s} の話題がありません`)
  return t
}

function ok<T>(r: RepairOutcome<T>): T {
  if (r.kind !== 'ok') throw new Error(`ok ではない: ${r.kind}`)
  return r.value
}

/** 受け取った記録（JSON から読んだ形） */
const received = (v: unknown) => JSON.parse(JSON.stringify(v)) as Record<string, unknown>

/** 断る物を入れた1本と、後の版のコネクタが作った記録の見本（今の確かめでは断られる） */
const rejectedIds = (e: FakeEdition) => new Set([e.scenes.connectorRejects, e.scenes.newerValues])
/** 決まりの範囲の外になる場面（強調の無い話題・上限いっぱいの話題） */
const outOfNormIds = (e: FakeEdition) => new Set([e.scenes.noEmphasis, e.scenes.maxLength, ...rejectedIds(e)])

const allTopics = (m: FakeMonth) => m.editions.flatMap((e) => e.topics)

/** 作り物の版（段階2の形の20本）の、版の決まりの範囲の知らせる物（段階3で目安を10本にしたので、本数だけ） */
const STAGE2_COUNT_NOTE = ['話題が 20本です（目安は 10本）']

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('makeFakeEdition: 版の形', () => {
  it('20本（国内10・世界10、7つのジャンルすべて、重大印1をいちばん上）', () => {
    expect(ed.topics).toHaveLength(20)
    expect(ed.topics.map((t) => t.rank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(ed.topics.filter((t) => t.region === 'jp')).toHaveLength(10)
    expect(ed.topics.filter((t) => t.region === 'world')).toHaveLength(10)
    for (const g of GENRE_VALUES) expect(ed.topics.some((t) => t.genre === g)).toBe(true)
    expect(ed.topics.filter((t) => t.major).map((t) => t.rank)).toEqual([1])
    // 段階3で版の目安を10本にした（段階3の設計の 4.13）。作り物の版は段階2の形（20本）のままなので、本数だけを知らせる
    expect(checkEditionNorms(ed.edition, ed.topics).map((p) => p.message)).toEqual(STAGE2_COUNT_NOTE)
    const other = makeFakeEdition({ ...ED_OPTS, slot: '20' })
    expect(checkMajorsPerDay([...ed.topics, ...other.topics])).toEqual([])
  })

  it('id はコネクタと同じ作り方（版は枠・話題は中身の指紋・束は entries の指紋・語は key の指紋）', () => {
    expect(ed.edition.id).toBe(editionIdOf('2026-11-15', '12'))
    expect(ed.edition.order).toEqual(ed.topics.map((t) => t.id))
    for (const t of ed.topics) {
      expect(t.id).toBe(topicIdOf(t))
      expect(t.id.startsWith(`${ed.edition.id}-`)).toBe(true)
      expect(isRecordIdFor('topics', t.id)).toBe(true)
      expect(t.threadId).toBe(t.id)
      expect(t.editionId).toBe(ed.edition.id)
    }
    expect(new Set(ed.edition.order).size).toBe(20)
    expect(ed.termPack.id).toBe(termPackIdOf(ed.edition.id, ed.termPack.entries))
    for (const e of ed.termPack.entries) expect(e.termId).toBe(termIdOf(e.key))
  })

  it('場面の名前は、決めた順位の話題を指す', () => {
    for (const [s, rank] of Object.entries(FAKE_TOPIC_SCENES)) expect(ed.scenes[s as FakeTopicScene]).toBe(ed.topics[rank - 1].id)
  })

  it('作った時刻の順: 辞書の束 → 話題 → 版（版は枠の時刻より前。候補を集めた窓は日本時間）', () => {
    const slotAt = jstStartOfDayMs('2026-11-15') + 12 * 60 * 60 * 1000
    for (const t of ed.topics) expect(t.createdAt).toBeGreaterThan(ed.termPack.createdAt)
    expect(ed.edition.createdAt).toBeGreaterThan(Math.max(...ed.topics.map((t) => t.createdAt)))
    expect(ed.edition.createdAt).toBeLessThan(slotAt)
    expect(ed.edition.window?.since).toBe('2026-11-14T20:00+09:00')
    expect(isJstDateTime(ed.edition.window?.until)).toBe(true)
    for (const t of ed.topics) for (const s of t.sources) if (s.publishedAt) expect(isPublishedAt(s.publishedAt)).toBe(true)
  })
})

describe('makeFakeEdition: 同じ種からは同じ物', () => {
  it('同じ種・日付・枠からは同じ物、種が違えば違う物', () => {
    expect(deepEqual(makeFakeEdition(ED_OPTS), ed)).toBe(true)
    const other = makeFakeEdition({ ...ED_OPTS, seed: 'other' })
    expect(other.edition.order).not.toEqual(ed.edition.order)
    // 種が変わっても、場面のある順位は変わらない
    expect(other.topics[FAKE_TOPIC_SCENES.maxLength - 1].id).toBe(other.scenes.maxLength)
  })

  it('Math.random・Date.now・今の時刻を使わない', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random を使った')
    })
    vi.useFakeTimers({ now: Date.UTC(2030, 0, 1) })
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now を使った')
    })
    expect(deepEqual(makeFakeEdition(ED_OPTS), ed)).toBe(true)
    expect(deepEqual(makeFakeMonth(MONTH_OPTS), month)).toBe(true)
  })

  it('日付の形が違えば投げる', () => {
    expect(() => makeFakeEdition({ ...ED_OPTS, date: '2026-02-30' })).toThrow(RangeError)
  })
})

describe('中身はすべて作り物（docs/SPEC.md の 3.・16.3）', () => {
  const everything = [ed, makeFakeEdition({ ...ED_OPTS, slot: '20', seed: 'x' })]
  const json = stableStringify({ everything, month })

  it('URL は https://example.com/ で始まる物だけ（出典の url も、文の中も）', () => {
    const urls = json.match(/[a-z]+:\/\/[^"\s\\]*/gi) ?? []
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(u.startsWith(FAKE_URL_PREFIX)).toBe(true)
    for (const t of [...ed.topics, ...allTopics(month)])
      for (const s of t.sources) expect(s.url.startsWith(FAKE_URL_PREFIX)).toBe(true)
  })

  it('社の名前は作り物の一覧だけ、読んだ所は「××ニュース」だけ', () => {
    for (const t of [...ed.topics, ...allTopics(month)]) {
      for (const s of t.sources) {
        expect(FAKE_OUTLET_NAMES).toContain(s.outlet)
        if (s.via !== null) expect(s.via).toBe(FAKE_VIA)
      }
      for (const n of t.outletNames) expect(FAKE_OUTLET_NAMES).toContain(n)
    }
  })

  it('本物の社・読んだ所の名前とホストを含まない', () => {
    for (const e of [...DEFAULT_OUTLET_LIST.outlets, ...DEFAULT_OUTLET_LIST.vias]) {
      expect(json).not.toContain(e.name)
      for (const h of e.hosts) expect(json).not.toContain(h)
    }
    expect(json).not.toMatch(/yahoo|google/i)
  })

  it('作り物の社の一覧で、リンクになる出典と、一覧に無いホストで文として出る出典の両方がある', () => {
    const shown = ed.topics.map((t) => ok(repairTopic(received(t), opts)))
    const sources = shown.flatMap((t) => t.sources)
    expect(sources.some((s) => s.link !== null && s.via === null)).toBe(true)
    expect(sources.some((s) => s.link !== null && s.via === FAKE_VIA)).toBe(true)
    const newer = shown.find((t) => t.id === ed.scenes.newerValues) as ShownTopic
    expect(newer.sources.find((s) => s.outlet === FAKE_UNLISTED_OUTLET)?.link).toBeNull()
  })
})

describe('上限の内（docs/SPEC.md の 7.1 の「上限の一覧と決まりの範囲」）', () => {
  it('断る物を入れた1本のほかは、コネクタの強調の確かめで errors が 0', () => {
    for (const t of ed.topics) {
      const r = checkEmphasis(t)
      if (t.id === ed.scenes.connectorRejects) expect(r.errors.length).toBeGreaterThan(0)
      else expect(r.errors).toEqual([])
    }
  })

  it('断る物を入れた1本と後の版の記録の見本のほかは、コネクタが送る直前の確かめで断る物が無い', () => {
    for (const t of ed.topics) if (!rejectedIds(ed).has(t.id)) expect(checkTopic(t, opts).errors).toEqual([])
    expect(checkEdition(ed.edition)).toEqual({ errors: [], warnings: [] })
    expect(checkTermPack(ed.termPack)).toEqual({ errors: [], warnings: [] })
  })

  it('決まりの範囲の真ん中の話題は、知らせる物も無い（強調の無い話題・上限いっぱいの話題のほか）', () => {
    for (const t of ed.topics) if (!outOfNormIds(ed).has(t.id)) expect(checkTopic(t, opts)).toEqual({ errors: [], warnings: [] })
  })

  it('記録の json は表ごとの上限の内（辞書の束も 200語まで）', () => {
    for (const t of ed.topics) expect(stableStringify(t).length).toBeLessThanOrEqual(RECORD_LIMITS.json.topics)
    expect(stableStringify(ed.edition).length).toBeLessThanOrEqual(RECORD_LIMITS.json.editions)
    expect(stableStringify(ed.termPack).length).toBeLessThanOrEqual(RECORD_LIMITS.json.termPacks)
    expect(ed.termPack.entries.length).toBeLessThanOrEqual(RECORD_LIMITS.termPack.entries)
  })

  it('上限いっぱいの話題: 境目の字数ちょうどで通り、1字多いと断る。強調も全体で60か所・各40字で、json は 100,000字に入る', () => {
    const t = scene(ed, 'maxLength')
    const T = RECORD_LIMITS.topic
    const n = countChars
    expect(n(t.headline)).toBe(T.headline)
    expect(n(t.summary)).toBe(T.summary)
    expect(n(t.rankReason)).toBe(T.rankReason)
    expect(n(t.conclusion.note)).toBe(T.conclusionNote)
    for (const v of Object.values(t.soWhat)) expect(n(v ?? '')).toBe(T.soWhat)
    expect(t.stakeholders).toHaveLength(T.stakeholders)
    for (const s of t.stakeholders) {
      expect([n(s.name), n(s.stanceNote ?? ''), n(s.claim ?? ''), n(s.reason ?? '')]).toEqual([
        T.stakeholderName,
        T.stanceNote,
        T.claim,
        T.claimReason,
      ])
    }
    if (t.view.kind !== 'opposed') throw new Error('対立見解がある話題のはず')
    expect([n(t.view.axis), n(t.view.issue ?? ''), n(t.view.aiView), n(t.view.counterView)]).toEqual([
      T.axis,
      T.issue,
      T.aiView,
      T.counterView,
    ])
    expect(t.timeline).toHaveLength(T.timeline)
    for (const e of t.timeline) expect(n(e.text)).toBe(T.timelineText)
    expect(t.terms).toHaveLength(T.terms)
    for (const e of t.terms) {
      expect(n(e.term)).toBe(T.term)
      expect(e.aliases).toHaveLength(T.termAliases)
      for (const a of e.aliases) expect(n(a)).toBe(T.termAlias)
      expect(n(e.explanation)).toBe(T.termExplanation)
    }
    expect(t.sources).toHaveLength(T.sources)
    for (const s of t.sources) {
      expect([n(s.title), s.url.length, n(s.publishedNote ?? '')]).toEqual([T.sourceTitle, T.url, T.publishedNote])
    }
    expect(t.unverified).toHaveLength(T.unverified)
    for (const u of t.unverified) expect(n(u)).toBe(T.unverifiedText)
    expect(t.check?.claims).toBe(T.checkClaims)
    const phrases = Object.values(t.emphasis)
    expect(phrases.flat()).toHaveLength(RECORD_LIMITS.emphasis.total)
    for (const p of phrases) expect(p.length).toBeLessThanOrEqual(RECORD_LIMITS.emphasis.perField)
    for (const p of phrases.flat()) expect(n(p)).toBe(RECORD_LIMITS.emphasis.phraseMax)
    expect(stableStringify(t).length).toBeLessThanOrEqual(RECORD_LIMITS.json.topics)
    const r = checkTopic(t, opts)
    expect(r.errors).toEqual([])
    // 決まりの範囲の外（見出し・要約・用語の数・強調の2割）は知らせるだけ
    expect(r.warnings.length).toBeGreaterThan(0)
    // 1字多いと断る
    const longer = { ...t, summary: `${t.summary}あ` }
    expect(checkTopic({ ...longer, id: topicIdOf(longer), threadId: topicIdOf(longer) }, opts).errors.map((e) => e.path)).toEqual(
      ['summary'],
    )
  })

  it('話題の用語は辞書の束の写し（束には使った語が全部ある）', () => {
    const byId = new Map(ed.termPack.entries.map((e) => [e.termId, e]))
    expect(byId.size).toBe(ed.termPack.entries.length)
    for (const t of ed.topics)
      for (const term of t.terms) {
        const e = byId.get(term.termId) as TermEntry
        expect(term).toEqual({ termId: e.termId, term: e.term, aliases: e.aliases, explanation: e.explanation, asOf: e.asOf })
      }
  })
})

describe('話題の場面（docs/SPEC.md の 16.3 の「作り物の版」）', () => {
  it('重大印・速報', () => {
    const t = scene(ed, 'major')
    expect([t.major, t.rank, t.conclusion.breaking]).toEqual([true, 1, true])
  })

  it('soWhat の null（暮らし・世界）', () => {
    expect(scene(ed, 'soWhatLifeNull').soWhat.life).toBeNull()
    expect(scene(ed, 'soWhatWorldNull').soWhat.world).toBeNull()
    const sports = scene(ed, 'sportsNone').soWhat
    expect([sports.life, sports.world]).toEqual([null, null])
  })

  it('確かめられなかった当事者（claim: null）と立場の補足', () => {
    const t = scene(ed, 'unverifiedStakeholder')
    expect(t.stakeholders).toContainEqual(
      expect.objectContaining({ stance: 'unknown', stanceNote: null, claim: null, reason: null }),
    )
    expect(scene(ed, 'stanceNote').stakeholders.some((s) => typeof s.stanceNote === 'string' && s.claim !== null)).toBe(true)
  })

  it('対立見解なし: スポーツ（理由は null）と理由つき、AI のジャンル、論点', () => {
    const sports = scene(ed, 'sportsNone')
    expect([sports.genre, sports.view]).toEqual(['sports', { kind: 'none', noneReason: null }])
    const withReason = scene(ed, 'noneWithReason').view
    expect(withReason.kind === 'none' && typeof withReason.noneReason === 'string').toBe(true)
    expect(scene(ed, 'aiGenre').genre).toBe('ai')
    const issue = scene(ed, 'viewIssue').view
    expect(issue.kind === 'opposed' && typeof issue.issue === 'string').toBe(true)
    expect(scene(ed, 'emptyConclusionNote').conclusion.note).toBe('')
  })

  it('経緯の when: null の行・年月だけの行', () => {
    expect(scene(ed, 'timelineWhenNull').timeline.some((e) => e.when === null)).toBe(true)
    expect(scene(ed, 'timelineYearMonth').timeline.some((e) => isYm(e.when))).toBe(true)
  })

  it('国の添え字の語（「与党（日本）」「与党（米国）」は表記が同じで別の語）', () => {
    const jp = scene(ed, 'jpRulingParty').terms.find((x) => x.termId === termIdOf(RULING_JP_KEY))
    const us = scene(ed, 'usRulingParty').terms.find((x) => x.termId === termIdOf(RULING_US_KEY))
    expect([jp?.term, us?.term]).toEqual(['与党', '与党'])
    expect(jp?.termId).not.toBe(us?.termId)
    expect(ed.termPack.entries.filter((e) => e.term === '与党').map((e) => e.key)).toEqual([RULING_US_KEY, RULING_JP_KEY])
  })

  it('出典の via（××ニュース）・日付だけ・publishedAt: null と補足', () => {
    expect(scene(ed, 'viaSource').sources.some((s) => s.via === FAKE_VIA && s.outlet === FAKE_UNLISTED_OUTLET)).toBe(true)
    expect(scene(ed, 'publishedDateOnly').sources.some((s) => isYmd(s.publishedAt))).toBe(true)
    expect(scene(ed, 'publishedAtNull').sources.some((s) => s.publishedAt === null && typeof s.publishedNote === 'string')).toBe(
      true,
    )
  })

  it('check: null', () => {
    expect(scene(ed, 'noCheck').check).toBeNull()
    expect(ed.topics.filter((t) => t.check === null)).toHaveLength(1)
  })

  it('知らない決まった値・知らない欄（後の版のコネクタの記録）: repair が消さずに残す', () => {
    const t = scene(ed, 'newerValues')
    expect(GENRE_VALUES as readonly string[]).not.toContain(t.genre)
    expect(checkTopic(t, opts).errors.map((e) => e.code)).toEqual(['value', 'value', 'url'])
    const shown = ok(repairTopic(received(t), opts)) as ShownTopic & Record<string, unknown>
    expect(shown.genre).toBe('novel')
    expect(shown.stakeholders[0].stance).toBe('neutral')
    expect(shown.storySeed).toEqual((t as unknown as Record<string, unknown>).storySeed)
    expect(shown.sources[0]).toMatchObject({ paywall: false })
    expect(shown.emphasis).toEqual(t.emphasis)
  })
})

describe('強調の場面（docs/SPEC.md の 7.1 の「強調」・5.12）', () => {
  it('正しい物: 要約・だから何？・経緯の大事な行だけ・AI の見解と対立見解で同じ数（断る物も知らせる物も無い）', () => {
    const t = scene(ed, 'major')
    expect(checkEmphasis(t)).toEqual({ errors: [], warnings: [] })
    expect(t.emphasis.summary.length).toBeGreaterThanOrEqual(1)
    expect(Object.keys(t.emphasis).some((k) => k.startsWith('soWhat.'))).toBe(true)
    const timelineKeys = Object.keys(t.emphasis).filter((k) => k.startsWith('timeline.'))
    expect(timelineKeys.length).toBeGreaterThan(0)
    expect(timelineKeys.length).toBeLessThan(t.timeline.length)
    expect(t.emphasis['view.aiView'].length).toBe(t.emphasis['view.counterView'].length)
  })

  it('主張のある当事者すべてに同じ数（主張を確かめられなかった当事者には付けない）', () => {
    const t = scene(ed, 'jpRulingParty')
    const counts = t.stakeholders.map((s, i) => (s.claim === null ? null : (t.emphasis[`stakeholders.${i}.claim`]?.length ?? 0)))
    expect(counts).toEqual([1, 1, null])
    expect(checkEmphasis(t)).toEqual({ errors: [], warnings: [] })
  })

  it('見通しを「見通し」の言葉ごと強調する', () => {
    const t = scene(ed, 'outlookEmphasis')
    expect(t.conclusion.label).toBe('outlook')
    expect(t.emphasis.summary.some((p) => p.endsWith('見通し'))).toBe(true)
  })

  it('強調の無い話題（{}）: コネクタは要約に強調が無い事だけを知らせる', () => {
    const t = scene(ed, 'noEmphasis')
    expect(t.emphasis).toEqual({})
    expect(checkEmphasis(t)).toEqual({ errors: [], warnings: [expect.objectContaining({ code: 'summary-missing' })] })
  })

  it('同じ語句が欄に2回出る文: 強調はその欄で最初に出る所に付く', () => {
    const t = scene(ed, 'repeatedPhrase')
    const twice = Object.entries(t.emphasis).flatMap(([key, phrases]) => {
      const text = emphasisFieldText(t, key) ?? ''
      return phrases.filter((p) => text.indexOf(p) !== text.lastIndexOf(p)).map((p) => ({ text, p }))
    })
    expect(twice.length).toBeGreaterThan(0)
    const { text, p } = twice[0]
    const segs = splitEmphasis(text, [p])
    const at = segs.findIndex((s) => s.strong)
    expect(
      segs
        .slice(0, at)
        .map((s) => s.text)
        .join('').length,
    ).toBe(firstOccurrence(text, p)?.start)
    expect(segs.filter((s) => s.strong)).toHaveLength(1)
  })

  it('コネクタなら断る物（欄に無い語句・重なる語句・知らない鍵・null の欄の鍵）: repair が捨てて出し、受け取った記録は変えない', () => {
    const t = scene(ed, 'connectorRejects')
    const codes = checkEmphasis(t).errors.map((e) => e.code)
    expect(codes).toEqual(expect.arrayContaining(['not-found', 'overlap', 'unknown-key', 'no-field']))
    // 強調のほかは断る物が無い
    for (const e of checkTopic(t, opts).errors) expect(e.code.startsWith('emphasis:')).toBe(true)
    const raw = received(t)
    const before = JSON.stringify(raw)
    const shown = ok(repairTopic(raw, opts))
    expect(JSON.stringify(raw)).toBe(before)
    expect(shown.emphasis).toEqual({
      summary: [t.emphasis.summary[0]],
      'soWhat.life': [t.emphasis['soWhat.life'][0]],
      'view.aiView': t.emphasis['view.aiView'],
      'view.counterView': t.emphasis['view.counterView'],
    })
    expect(checkEmphasis({ ...t, emphasis: shown.emphasis }).errors).toEqual([])
  })

  it('断る物を入れた1本のほかは、repair が強調を何も捨てない', () => {
    for (const t of ed.topics)
      if (t.id !== ed.scenes.connectorRejects) expect(ok(repairTopic(received(t), opts)).emphasis).toEqual(t.emphasis)
  })
})

describe('makeFakeMonth（何日分かの版）', () => {
  const editionIds = month.editions.map((e) => e.edition.id)
  const topics = allTopics(month)
  const topicById = new Map(topics.map((t) => [t.id, t]))
  const editionById = new Map(month.editions.map((e) => [e.edition.id, e]))

  it('35日分の枠（作れなかった枠を除く）を古い順に', () => {
    expect(month.editions).toHaveLength(35 * 2 - 1)
    expect(editionIds).toEqual([...editionIds].sort())
    expect(editionIds[0]).toBe('2026-10-12-12')
    expect(editionIds.at(-1)).toBe('2026-11-15-20')
    for (const e of month.editions) {
      expect(checkEdition(e.edition).errors).toEqual([])
      expect(checkTermPack(e.termPack).errors).toEqual([])
      expect(checkEditionNorms(e.edition, e.topics).map((p) => p.message)).toEqual(STAGE2_COUNT_NOTE)
      for (const t of e.topics) if (!rejectedIds(e).has(t.id)) expect(checkTopic(t, opts).errors).toEqual([])
    }
    const days = new Map<string, Topic[]>()
    for (const t of topics) days.set(t.editionId.slice(0, 10), [...(days.get(t.editionId.slice(0, 10)) ?? []), t])
    for (const ts of days.values()) expect(checkMajorsPerDay(ts)).toEqual([])
  })

  it('作れなかった枠を1つ（reasonKind: quota。版の記録は無く、印だけ）', () => {
    expect(month.editionFails).toHaveLength(1)
    const f = month.editionFails[0]
    expect(f.editionId).toBe(month.scenes.failedEditionId)
    expect(f.reasonKind).toBe('quota')
    expect(f.id).toBe(editionFailIdOf(f))
    expect(checkEditionFail(f)).toEqual({ errors: [], warnings: [] })
    expect(editionIds).not.toContain(f.editionId)
  })

  it('続報の鎖: 橋の開通 → 渋滞が2割減 → 点検で1日通行止め（threadId は1本目、前の話題を指す）', () => {
    const chain = month.scenes.chain.map((id) => topicById.get(id) as Topic)
    const heads = ['〇〇市で新しい橋が開通', '〇〇市の新しい橋、開通後の渋滞が2割減', '〇〇市の新しい橋、点検で1日通行止め']
    chain.forEach((t, i) => expect(t.headline.startsWith(heads[i])).toBe(true))
    expect(chain.map((t) => t.threadId)).toEqual([chain[0].id, chain[0].id, chain[0].id])
    expect(chain[0].followUp).toBeNull()
    expect(chain[1].followUp?.prevTopicId).toBe(chain[0].id)
    expect(chain[2].followUp?.prevTopicId).toBe(chain[1].id)
    for (const t of chain.slice(1)) {
      expect(t.timeline.length).toBeGreaterThan(0)
      expect(t.emphasis['followUp.whatsNew']?.length).toBe(1)
    }
    expect(chain.map((t) => t.editionId)).toEqual([...new Set(chain.map((t) => t.editionId))].sort())
    for (const t of chain) expect(checkTopic(t, opts)).toEqual({ errors: [], warnings: [] })
  })

  it('時期で変わる語: 「与党（日本）」の asOf が途中で上がり、その版の束に新しい rev の説明を足す', () => {
    const { termId, asOfBefore, asOfAfter, changedIn } = month.scenes.changingTerm
    expect(asOfBefore < asOfAfter).toBe(true)
    const uses = topics.flatMap((t) => t.terms.filter((x) => x.termId === termId).map((x) => ({ editionId: t.editionId, x })))
    expect(uses.length).toBe(month.editions.length)
    for (const { editionId, x } of uses) expect(x.asOf).toBe(editionId < changedIn ? asOfBefore : asOfAfter)
    expect(editionById.get(changedIn)?.termPack.entries.find((e) => e.termId === termId)?.rev).toBe(2)
    // 古い説明で「知ってる」を押していても、新しい説明の話題ではもう一度出る（docs/SPEC.md の 7.4）
    expect(isKnownTerm({ on: true, asOf: asOfBefore }, asOfBefore)).toBe(true)
    expect(isKnownTerm({ on: true, asOf: asOfBefore }, asOfAfter)).toBe(false)
  })

  it('辞書の束は、その版で新しく足した語と説明を新しくした語だけ。話題の用語はその時の辞書の写し', () => {
    const dict = new Map<string, TermEntry>()
    for (const e of month.editions) {
      expect(e.termPack.entries.length).toBeGreaterThan(0)
      expect(e.termPack.entries.length).toBeLessThanOrEqual(RECORD_LIMITS.termPack.entries)
      for (const entry of e.termPack.entries) {
        const had = dict.get(entry.termId)
        if (had) expect(entry.rev).toBeGreaterThan(had.rev)
        dict.set(entry.termId, entry)
      }
      for (const t of e.topics)
        for (const term of t.terms) {
          const d = dict.get(term.termId) as TermEntry
          expect(term).toEqual({ termId: d.termId, term: d.term, aliases: d.aliases, explanation: d.explanation, asOf: d.asOf })
        }
    }
  })

  it('訂正: 鎖の1本目に1つ・1つの話題に2つ・いちばん古い（30日の境の外の）話題に1つ', () => {
    const cs = month.corrections
    expect(cs).toHaveLength(4)
    expect(cs.map((c) => c.createdAt)).toEqual([...cs.map((c) => c.createdAt)].sort((a, b) => a - b))
    const perTopic = new Map<string, number>()
    for (const c of cs) {
      expect(c.id).toBe(correctionIdOf(c))
      expect(c.editionId).toBe(c.topicId.slice(0, 13))
      const topic = topicById.get(c.topicId) as Topic
      expect(topic).toBeDefined()
      // 足せるのは版の記録がある版の話題だけ（版の記録の後に足す）
      expect(c.createdAt).toBeGreaterThan(editionById.get(topic.editionId)?.edition.createdAt ?? Infinity)
      expect(checkCorrection(c, { existingForTopic: perTopic.get(c.topicId) ?? 0 })).toEqual({ errors: [], warnings: [] })
      perTopic.set(c.topicId, (perTopic.get(c.topicId) ?? 0) + 1)
    }
    const { chainFirst, twice, oldest } = month.scenes.corrections
    expect(chainFirst).toBe(month.scenes.chain[0])
    expect(cs.filter((c) => c.topicId === chainFirst).map((c) => c.text)).toEqual([CHAIN_CORRECTION_TEXT])
    expect(perTopic.get(twice)).toBe(2)
    expect(perTopic.get(oldest)).toBe(1)
    const now = jstStartOfDayMs(MONTH_OPTS.until) + 21 * 60 * 60 * 1000
    expect(isWithinRetention(oldest.slice(0, 10), now)).toBe(false)
    expect(isWithinRetention(twice.slice(0, 10), now)).toBe(true)
  })

  it('30日の境の外の版と、32日より前の版を含む（新しい端末が受け取らない物）', () => {
    const now = jstStartOfDayMs(MONTH_OPTS.until) + 21 * 60 * 60 * 1000
    expect(month.editions.filter((e) => !isWithinRetention(e.edition.date, now)).length).toBe(10)
    // 初めての受け取りで購読を始める位置（端末の時計 − 32日。src/domain/jst.ts の firstSyncSinceMs）より前に書かれた版
    expect(month.editions.some((e) => e.edition.createdAt < firstSyncSinceMs(now))).toBe(true)
  })

  it('同じ引数からは同じ物、種が違えば違う物', () => {
    expect(deepEqual(makeFakeMonth(MONTH_OPTS), month)).toBe(true)
    expect(makeFakeMonth({ ...MONTH_OPTS, seed: 'other' }).scenes.chain).not.toEqual(month.scenes.chain)
  })

  it('until の日を 12:00版で終える・3日の短い月・引数が違えば投げる', () => {
    const short = makeFakeMonth({ until: '2026-11-15', days: 3, untilSlot: '12' })
    expect(short.editions.map((e) => e.edition.id)).toEqual(['2026-11-13-12', '2026-11-13-20', '2026-11-14-20', '2026-11-15-12'])
    expect(short.scenes.changingTerm.changedIn).toBe('2026-11-14-20')
    expect(short.corrections).toHaveLength(4)
    for (const e of short.editions) expect(checkTermPack(e.termPack).errors).toEqual([])
    expect(() => makeFakeMonth({ until: '2026-11-15', days: 2 })).toThrow(RangeError)
    expect(() => makeFakeMonth({ until: '2026/11/15', days: 5 })).toThrow(RangeError)
  })
})

describe('fakeRecordsOf（コネクタが足す順）', () => {
  it('辞書の束 → 話題 → 版の順に、作った時刻の順で並ぶ。どの記録も表の確かめで形が合う', () => {
    const recs = fakeRecordsOf(month)
    const counts = { termPacks: 0, topics: 0, editions: 0, editionFails: 0, corrections: 0 }
    for (const r of recs) counts[r.table] += 1
    expect(counts).toEqual({
      termPacks: month.editions.length,
      topics: month.editions.length * 20,
      editions: month.editions.length,
      editionFails: 1,
      corrections: 4,
    })
    expect(recs.map((r) => r.record.createdAt)).toEqual([...recs.map((r) => r.record.createdAt)].sort((a, b) => a - b))
    const seenAt = new Map(recs.map((r, i) => [r.record.id, i]))
    for (const e of month.editions) {
      const at = (id: string) => seenAt.get(id) ?? -1
      for (const t of e.topics) {
        expect(at(e.termPack.id)).toBeLessThan(at(t.id))
        expect(at(t.id)).toBeLessThan(at(e.edition.id))
      }
    }
    for (const r of fakeRecordsOf(ed))
      if (!rejectedIds(ed).has(r.record.id)) expect(checkRecord(r.table, r.record, opts).errors).toEqual([])
  })
})

describe('makeFakeMonth の extras（段階2の見本と E2E の場面。設計: 段階2の 5.3）', () => {
  const BASE = { until: '2026-11-15', untilSlot: '12', days: 7, seed: 'samples' } as const
  const plain = makeFakeMonth(BASE)
  const all = makeFakeMonth({ ...BASE, extras: [...FAKE_MONTH_EXTRAS] })
  const recordsById = (m: FakeMonth) => new Map(fakeRecordsOf(m).map((r) => [r.record.id, r]))

  it('既定は何も足さない（extras を省いた時・空の時は今と同じ物。場面にも extras が無い）', () => {
    expect(deepEqual(makeFakeMonth({ ...BASE, extras: [] }), plain)).toBe(true)
    expect(plain.scenes.extras).toBeUndefined()
    expect(deepEqual(makeFakeMonth(MONTH_OPTS), month)).toBe(true)
    expect(() => makeFakeMonth({ ...BASE, extras: ['nope' as never] })).toThrow(RangeError)
  })

  it('足しても、既定の記録の id・数・中身は同じ（v を替えた2つの記録のほか）', () => {
    const a = recordsById(plain)
    const b = recordsById(all)
    const changed = new Set([all.scenes.extras?.newerTopic, all.scenes.extras?.newerEdition])
    for (const [id, r] of a) {
      expect(b.has(id)).toBe(true)
      if (!changed.has(id)) expect([id, deepEqual(b.get(id), r)]).toEqual([id, true])
    }
    const added = [...b.keys()].filter((id) => !a.has(id))
    expect(added.sort()).toEqual([all.scenes.extras?.correctsEmphasis?.correctionId, all.editionFails.at(-1)?.id].sort())
    expect(all.scenes.chain).toEqual(plain.scenes.chain)
    expect(all.scenes.corrections).toEqual(plain.scenes.corrections)
  })

  it('correctsEmphasis: 続報の鎖の3本目の要約の強調した語句そのものを正す訂正（版の 60分後）', () => {
    const m = makeFakeMonth({ ...BASE, extras: ['correctsEmphasis'] })
    const x = m.scenes.extras?.correctsEmphasis
    expect(x?.topicId).toBe(m.scenes.chain[2])
    const c = m.corrections.find((r) => r.id === x?.correctionId)!
    expect(c.text).toBe(CLOSURE_CORRECTION_TEXT)
    const third = m.editions.find((e) => e.edition.id === c.editionId)!
    const topic = third.topics.find((t) => t.id === c.topicId)!
    expect(topic.emphasis.summary).toContain(CLOSURE_EMPHASIS)
    expect(firstOccurrence(topic.summary, CLOSURE_EMPHASIS)).not.toBeNull()
    // 訂正の文は、強調した語句（来週の土曜に1日通行止め）の中身を正す
    for (const w of ['通行止め', '来週の土曜', '1日']) expect(c.text).toContain(w)
    expect(c.createdAt).toBe(third.edition.createdAt + 60 * 60 * 1000)
    expect(c.id).toBe(correctionIdOf(c))
    expect(checkCorrection(c, { existingForTopic: 0 })).toEqual({ errors: [], warnings: [] })
    expect(m.corrections.map((r) => r.createdAt)).toEqual([...m.corrections.map((r) => r.createdAt)].sort((a, b) => a - b))
    expect(m.corrections).toHaveLength(plain.corrections.length + 1)
  })

  it('failsNext: untilSlot の次の枠に作れなかった印だけ（版は作らない）', () => {
    const m = makeFakeMonth({ ...BASE, extras: ['failsNext'] })
    expect(m.scenes.extras?.failsNext).toBe('2026-11-15-20')
    const f = m.editionFails.find((x) => x.editionId === '2026-11-15-20')!
    expect(f).toMatchObject({
      reasonKind: 'quota',
      createdAt: jstStartOfDayMs('2026-11-15') + 20 * 60 * 60 * 1000 - 2 * 60 * 1000,
    })
    expect(f.id).toBe(editionFailIdOf(f))
    expect(checkEditionFail(f)).toEqual({ errors: [], warnings: [] })
    expect(m.editions.map((e) => e.edition.id)).not.toContain('2026-11-15-20')
    expect(m.editionFails).toHaveLength(2)
    // until の日を 20:00版で終える時は、次の日の 12:00
    const late = makeFakeMonth({ until: '2026-11-15', days: 3, extras: ['failsNext'] })
    expect(late.scenes.extras?.failsNext).toBe('2026-11-16-12')
  })

  it('newerTopic・newerEdition: いちばん新しい版の20位の話題・版の記録を v: 2 に（id は同じ。v の誤りだけで断られる）', () => {
    const m = makeFakeMonth({ ...BASE, extras: ['newerTopic', 'newerEdition'] })
    const newest = m.editions.at(-1)!
    const before = plain.editions.at(-1)!
    expect(m.scenes.extras?.newerTopic).toBe(before.topics[19].id)
    expect(newest.topics[19]).toEqual({ ...before.topics[19], v: 2 })
    expect(m.scenes.extras?.newerEdition).toBe(before.edition.id)
    expect(newest.edition).toEqual({ ...before.edition, v: 2 })
    const vErrors = (now: { path: string; code: string }[], was: { path: string; code: string }[]) =>
      now.filter((e) => !was.some((w) => w.path === e.path && w.code === e.code))
    expect(vErrors(checkTopic(newest.topics[19], opts).errors, checkTopic(before.topics[19], opts).errors)).toEqual([
      expect.objectContaining({ path: 'v', code: 'value' }),
    ])
    expect(checkEdition(newest.edition).errors).toEqual([expect.objectContaining({ path: 'v', code: 'value' })])
  })

  it('全部を足しても、v を替えた記録と断る物の見本のほかは、送る直前の確かめを通る', () => {
    const changed = new Set([all.scenes.extras?.newerTopic, all.scenes.extras?.newerEdition])
    for (const e of all.editions)
      for (const r of fakeRecordsOf(e))
        if (!changed.has(r.record.id) && !rejectedIds(e).has(r.record.id))
          expect([r.record.id, checkRecord(r.table, r.record, opts).errors]).toEqual([r.record.id, []])
    for (const f of all.editionFails) expect(checkEditionFail(f).errors).toEqual([])
    const perTopic = new Map<string, number>()
    for (const c of all.corrections) {
      expect(checkCorrection(c, { existingForTopic: perTopic.get(c.topicId) ?? 0 }).errors).toEqual([])
      perTopic.set(c.topicId, (perTopic.get(c.topicId) ?? 0) + 1)
    }
  })
})
