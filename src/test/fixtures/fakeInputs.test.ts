// 作り物の版の話題 → 入力 → 組み立て（段階3の設計の 1.5・6.1 の B1・7. の「単体（ルート）」）: 作り物の版の話題（19・20位を除く）を
// 入力に戻して組み立てると、作り物と同じ id・同じ記録になる（コネクタの組み立て・作り物の版・アプリの3つの形が1つの所で合う）。
// 何日分かの版では、続報の鎖（前の版の話題の短い id → threadId）・時期で変わる語（辞書の rev 2）も同じになる。
// 段階2までの作り物の話題のうち、出典でない社を outletNames に並べた物（moreOutlets）は、段階3の組み立てが outletNames を出典の社だけから
// 作るので、outletNames と id だけが違う（その2つを出典の社だけにした記録と同じになる）
import { describe, expect, it } from 'vitest'
import { assembleTopic } from '../../domain/assemble'
import { deepEqual } from '../../domain/equal'
import { topicIdOf, topicShortId } from '../../domain/ids'
import { checkTopic } from '../../domain/validate'
import type { Topic } from '../../domain/types'
import { FAKE_TOPIC_SCENES, makeFakeEdition, makeFakeMonth } from './fakeEditions'
import {
  FAKE_BODY_CHARS,
  fakeDictOfTopic,
  fakeInputCasesOf,
  fakeInputOf,
  fakeSourceRefOf,
  type FakeInputCase,
} from './fakeInputs'
import { FAKE_OUTLETS } from './fakeOutlets'
import { makeSampleTopic } from './sampleTopic'

const ed = makeFakeEdition({ date: '2026-11-15', slot: '12', seed: 'test' })
const month = makeFakeMonth({ until: '2026-11-15', days: 6 })

/** 段階3の組み立てで期待する記録（outletNames を出典の社だけにし、続報でない話題は id と threadId を作り直す） */
function expectedOf(t: Topic): Topic {
  const sourceOutlets = [...new Set(t.sources.map((s) => s.outlet))]
  if (deepEqual(sourceOutlets, t.outletNames)) return t
  const e: Topic = { ...t, outletNames: sourceOutlets }
  e.id = topicIdOf(e)
  if (t.threadId === t.id) e.threadId = e.id
  return e
}

const roundTrip = (c: FakeInputCase) => assembleTopic(c.input, c.ctx)

describe('作り物の版の話題 → 入力 → 組み立て', () => {
  const cases = fakeInputCasesOf(ed)

  it('19位（コネクタなら断る物）・20位（後の版の記録の見本）を除く18本', () => {
    expect(cases.map((c) => c.topic.rank)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
    expect(cases.some((c) => c.topic.id === ed.scenes.connectorRejects || c.topic.id === ed.scenes.newerValues)).toBe(false)
  })

  it('どれも断る物が無く、作り物と同じ記録になる（共通の欄・照合の件数も作り物から渡すので、記録の全部が同じ）', () => {
    for (const c of cases) {
      const r = roundTrip(c)
      expect([c.topic.rank, r.errors]).toEqual([c.topic.rank, []])
      expect([c.topic.rank, r.topic]).toEqual([c.topic.rank, expectedOf(c.topic)])
      expect(r.droppedKnown).toEqual([])
    }
  })

  it('outletNames に出典でない社を並べていない話題は、同じ id（指紋）になる', () => {
    const same = cases.filter((c) => expectedOf(c.topic) === c.topic)
    // 段階2までの作り物で、出典でない社を並べたのは 2位・10位だけ
    expect(cases.filter((c) => expectedOf(c.topic) !== c.topic).map((c) => c.topic.rank)).toEqual([2, 10])
    for (const c of same) expect(roundTrip(c).topic?.id).toBe(c.topic.id)
  })

  it('知らせる物は、作り物の記録をそのまま確かめた時と同じ', () => {
    for (const c of cases) {
      const want = checkTopic(expectedOf(c.topic), { outlets: FAKE_OUTLETS }).warnings.map((w) => w.code)
      expect([c.topic.rank, roundTrip(c).warnings.map((w) => w.code)]).toEqual([c.topic.rank, want])
    }
  })

  it('入力に、記録にしか無い物（id・threadId・outletNames・URL・題・掲載日時）が入っていない', () => {
    for (const c of cases) {
      const json = JSON.stringify(c.input)
      expect(json).not.toContain('https://')
      for (const k of ['"id"', '"threadId"', '"outletNames"', '"publishedAt"', '"editionId"', '"runId"', '"model"'])
        expect([c.topic.rank, k, json.includes(k)]).toEqual([c.topic.rank, k, false])
    }
  })

  it('作り物の版は author の欄を持たないので、組み立てた出典にも欄が無い（指紋は変わらない）', () => {
    for (const c of cases) for (const s of roundTrip(c).topic?.sources ?? []) expect('author' in s).toBe(false)
  })
})

describe('何日分かの作り物の版 → 入力 → 組み立て（続報・時期で変わる語）', () => {
  const cases = fakeInputCasesOf(month)

  it('どの版の話題も、作り物と同じ記録になる', () => {
    expect(cases.length).toBe(month.editions.length * 18)
    for (const c of cases) {
      const r = roundTrip(c)
      expect([c.topic.id, r.errors]).toEqual([c.topic.id, []])
      expect(deepEqual(r.topic, expectedOf(c.topic))).toBe(true)
    }
  })

  it('続報の鎖: 前の話題の短い id から followUp.prevTopicId と threadId を写す', () => {
    const [first, second, third] = month.scenes.chain
    for (const id of [second, third]) {
      const c = cases.find((x) => x.topic.id === id) as FakeInputCase
      expect(c.input.followUp?.prev).toBe(topicShortId(c.topic.followUp?.prevTopicId ?? ''))
      const r = roundTrip(c)
      expect(r.topic?.followUp?.prevTopicId).toBe(c.topic.followUp?.prevTopicId)
      expect(r.topic?.threadId).toBe(first)
    }
  })

  it('時期で変わる語は、その版の辞書の rev の説明になる', () => {
    const { termId, changedIn } = month.scenes.changingTerm
    const c = cases.find(
      (x) => x.topic.editionId === changedIn && x.topic.terms.some((t) => t.termId === termId),
    ) as FakeInputCase
    expect(c.ctx.dict.get(termId)?.rev).toBe(2)
    expect(roundTrip(c).topic?.terms.find((t) => t.termId === termId)).toEqual(c.topic.terms.find((t) => t.termId === termId))
  })

  it('前の版の話題に無い prev は断る（直近6版の外・知らない id）', () => {
    const c = cases.find((x) => x.topic.id === month.scenes.chain[1]) as FakeInputCase
    const r = assembleTopic(c.input, { ...c.ctx, recentTopics: [] })
    expect(r.topic).toBeNull()
    expect(r.errors.map((e) => [e.path, e.code])).toEqual([['followUp.prev', 'followUp-not-found']])
  })
})

describe('入力の作り方', () => {
  it('強調は要素ごとの入力に戻る（当事者の主張は claimEmphasis、経緯の行は emphasis、ほかは欄ごと）', () => {
    const t = makeSampleTopic()
    const { input } = fakeInputOf(t, fakeDictOfTopic(t))
    expect(input.emphasis).toEqual({
      summary: t.emphasis.summary,
      'soWhat.life': t.emphasis['soWhat.life'],
      'view.aiView': t.emphasis['view.aiView'],
      'view.counterView': t.emphasis['view.counterView'],
    })
    expect(input.stakeholders.map((s) => s.claimEmphasis)).toEqual(
      t.stakeholders.map((_, i) => t.emphasis[`stakeholders.${i}.claim`]),
    )
    expect(input.stakeholders[0].claimEmphasis).toEqual(t.emphasis['stakeholders.0.claim'])
    expect(input.timeline.map((e) => e.emphasis)).toEqual(t.timeline.map((_, i) => t.emphasis[`timeline.${i}.text`]))
    expect(input.timeline[1].emphasis).toEqual(t.emphasis['timeline.1.text'])
  })

  it('出典は控えの ref と社。控えは記録の出典から（読んだ所は控えに）', () => {
    const t = makeSampleTopic()
    const { input, materials } = fakeInputOf(t)
    expect(input.sources).toEqual([
      { ref: fakeSourceRefOf(1, 0), outlet: '〇〇通信' },
      { ref: fakeSourceRefOf(1, 1), outlet: '◇◇日報' },
    ])
    expect(materials.get('c0102')).toEqual({
      url: t.sources[1].url,
      title: t.sources[1].title,
      published: t.sources[1].publishedAt,
      publishedNote: null,
      bodyChars: FAKE_BODY_CHARS,
      read: true,
      via: '××ニュース',
    })
  })

  it('知らない強調の鍵がある記録（19位の、コネクタなら断る物）は入力にしない', () => {
    expect(() => fakeInputOf(ed.topics[FAKE_TOPIC_SCENES.connectorRejects - 1])).toThrow()
  })
})
