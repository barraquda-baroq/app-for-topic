// 読み取りの確かめ（表示用の写し。docs/SPEC.md の 7.1・7.8・16.3）: 知らない値・知らない欄・v: 2 を消さない・書き戻さない（受け取った記録は
// 変えない）、強調の合わない物は写しから捨てる（壊れた要素を出さない時も番号を詰めない）、知らないホストの URL はリンクにしない。
// 段階3: 出典の著者（author）は文字か null、リンクにしない社（linkOpen: 'no-link'）の URL はリンクにしない
import { describe, expect, it } from 'vitest'
import { FAKE_CREDIT_OUTLETS, FAKE_OUTLETS } from '../test/fixtures/fakeOutlets'
import { makeSampleTopic } from '../test/fixtures/sampleTopic'
import { genreLabel, regionLabel } from './fixedTexts'
import { correctionIdOf, termIdOf } from './ids'
import {
  repairCorrection,
  repairEdition,
  repairEditionFail,
  repairKnownTerm,
  repairReadMark,
  repairTopic,
  type RepairOutcome,
  type ShownTopic,
} from './repair'

const opts = { outlets: FAKE_OUTLETS }

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x)
    Object.freeze(v)
  }
  return v
}

function ok<T>(r: RepairOutcome<T>): T {
  if (r.kind !== 'ok') throw new Error(`ok ではない: ${r.kind}`)
  return r.value
}

/** 受け取った記録（JSON から読んだ形。凍らせて、変えていない事を確かめる） */
const received = (v: unknown) => deepFreeze(JSON.parse(JSON.stringify(v)) as Record<string, unknown>)

describe('話題の写し', () => {
  it('ふつうの話題は、そのままの中身と、リンクと強調', () => {
    const t = makeSampleTopic()
    const shown = ok(repairTopic(received(t), opts))
    const { sources, ...rest } = shown
    const { sources: rawSources, ...rawRest } = t
    expect(rest).toEqual(rawRest)
    expect(sources).toEqual(rawSources.map((s) => ({ ...s, link: s.url })))
  })

  it('知らない値・知らない欄を消さない。受け取った記録は変えない', () => {
    const raw = received({
      ...makeSampleTopic(),
      genre: 'novel',
      region: 'space',
      futureField: { a: 1 },
      conclusion: { label: 'probable', note: '補足', breaking: false, level: 2 },
      stakeholders: [{ name: 'A 党', stance: 'neutral', stanceNote: null, claim: '主張', reason: null, seats: 10 }],
      sources: [
        {
          outlet: '〇〇通信',
          title: '題',
          url: 'https://example.com/a',
          publishedAt: null,
          publishedNote: null,
          via: null,
          lang: 'ja',
        },
      ],
    })
    const before = structuredClone(raw)
    const shown = ok(repairTopic(raw, opts)) as ShownTopic & Record<string, unknown>
    expect(shown.genre).toBe('novel')
    expect(genreLabel(shown.genre)).toBeNull()
    expect(shown.region).toBe('space')
    expect(regionLabel(shown.region)).toBeNull()
    expect(shown.futureField).toEqual({ a: 1 })
    expect(shown.conclusion).toEqual({ label: 'probable', note: '補足', breaking: false, level: 2 })
    expect(shown.stakeholders[0]).toMatchObject({ stance: 'neutral', seats: 10 })
    expect(shown.sources[0]).toMatchObject({ lang: 'ja', link: 'https://example.com/a' })
    expect(raw).toEqual(before)
  })

  it('v: 2 は中身を読まずに「新しい形の記録」（書き戻さない）', () => {
    const raw = received({ ...makeSampleTopic(), v: 2, summary: { parts: ['新しい形'] } })
    const before = structuredClone(raw)
    expect(repairTopic(raw, opts)).toEqual({ kind: 'newer', id: raw.id, v: 2 })
    expect(raw).toEqual(before)
  })

  it('形の分からない物（オブジェクトでない・id が無い）は出さない', () => {
    expect(repairTopic(null)).toEqual({ kind: 'broken' })
    expect(repairTopic('topic')).toEqual({ kind: 'broken' })
    expect(repairTopic({ summary: '要約' })).toEqual({ kind: 'broken' })
  })

  it('形の分からない欄は決まった空の値にする（壊れた要素は出さない）', () => {
    const t = makeSampleTopic()
    const shown = ok(
      repairTopic(
        received({
          id: t.id,
          editionId: 12,
          summary: 3,
          soWhat: 'なし',
          view: { kind: 'maybe' },
          stakeholders: [null, { name: 'A 党', claim: 5 }],
          timeline: [{ when: '昨日', text: '行' }, { when: '2026' }],
          terms: [{ term: '語', explanation: '説明', aliases: ['別名', 3], asOf: '2026/11' }, { term: '説明なし' }],
          sources: [{ outlet: '〇〇通信', title: '題', url: 'http://example.com/a', publishedAt: '昨日' }, 'x'],
          followUp: { prevTopicId: 'p' },
          check: 'yes',
          emphasis: 'summary',
        }),
        opts,
      ),
    )
    expect(shown).toMatchObject({
      editionId: '2026-11-15-12',
      threadId: t.id,
      summary: '',
      major: false,
      soWhat: { life: null, system: null, world: null, whyNews: null },
      view: null,
      stakeholders: [{ name: 'A 党', stance: '', stanceNote: null, claim: null, reason: null }],
      timeline: [{ when: null, text: '行' }],
      terms: [{ termId: '', term: '語', aliases: ['別名'], explanation: '説明', asOf: null }],
      sources: [
        {
          outlet: '〇〇通信',
          title: '題',
          url: 'http://example.com/a',
          publishedAt: null,
          publishedNote: null,
          via: null,
          link: null,
        },
      ],
      followUp: null,
      check: null,
      emphasis: {},
      outletNames: [],
      unverified: [],
    })
  })

  it('知らないホスト・作り物の一覧に無い社の URL はリンクにしない（文として出す）', () => {
    const t = makeSampleTopic((x) => (x.sources[1].via = null))
    const shown = ok(repairTopic(received(t), opts))
    expect(shown.sources.map((s) => s.link)).toEqual(['https://example.com/news/bridge-1', null])
    expect(shown.sources[1].url).toBe('https://example.com/via/bridge-2')
    // ふだんの一覧（作り物の社が無い）では、どちらもリンクにしない
    expect(ok(repairTopic(received(makeSampleTopic()))).sources.map((s) => s.link)).toEqual([null, null])
  })
})

describe('話題の写しの強調', () => {
  it('合わない語句・鍵は写しから捨て、受け取った記録は変えない', () => {
    const raw = received(
      makeSampleTopic((t) => {
        t.emphasis = {
          ...t.emphasis,
          summary: ['15日に開通', '存在しない語句', '日に開通し'],
          headline: ['新しい橋'],
          'soWhat.world': ['世界'],
          'stakeholders.2.claim': ['確かめられなかった'],
        }
      }),
    )
    const before = structuredClone(raw)
    const shown = ok(repairTopic(raw, opts))
    expect(shown.emphasis.summary).toEqual(['15日に開通'])
    expect(Object.keys(shown.emphasis)).not.toContain('headline')
    expect(Object.keys(shown.emphasis)).not.toContain('soWhat.world')
    expect(Object.keys(shown.emphasis)).not.toContain('stakeholders.2.claim')
    expect(raw).toEqual(before)
  })

  it('壊れた当事者・経緯の行を出さない時も、語句は受け取った記録の同じ要素に付く（番号を詰めて別の要素に付けない）', () => {
    const raw = received(
      makeSampleTopic((t) => {
        ;(t.stakeholders as unknown[]).unshift('こわれた当事者')
        ;(t.timeline as unknown[]).unshift(null)
        // 受け取った記録の番号: 当事者 1 = A 党、2 = B 党。経緯 2 = 「新しい橋が開通した」
        t.emphasis = {
          summary: ['15日に開通'],
          'stakeholders.0.claim': ['こわれた'],
          'stakeholders.1.claim': ['通行料は無料にすべき'],
          'stakeholders.2.claim': ['少額の通行料を取るべき'],
          'timeline.2.text': ['新しい橋が開通した'],
          'view.aiView': ['人が戻る効果'],
          'view.counterView': ['住宅地へ移るだけ'],
        }
      }),
    )
    const shown = ok(repairTopic(raw, opts))
    expect(shown.stakeholders.map((s) => s.name)).toEqual(['A 党', 'B 党', 'C 党'])
    expect(shown.timeline.map((e) => e.text)).toEqual([
      '新しい橋の建設が始まった',
      '新しい橋が開通した',
      'その後、市が通行料の案を示す予定',
    ])
    // 写しの番号に付け替える: A 党（写しの 0）・B 党（写しの 1）・「新しい橋が開通した」（写しの 1）
    expect(shown.emphasis).toEqual({
      summary: ['15日に開通'],
      'stakeholders.0.claim': ['通行料は無料にすべき'],
      'stakeholders.1.claim': ['少額の通行料を取るべき'],
      'view.aiView': ['人が戻る効果'],
      'view.counterView': ['住宅地へ移るだけ'],
      'timeline.1.text': ['新しい橋が開通した'],
    })
    for (const [key, phrases] of Object.entries(shown.emphasis)) {
      const [field, i] = key.split('.')
      const text =
        field === 'stakeholders'
          ? shown.stakeholders[Number(i)].claim
          : field === 'timeline'
            ? shown.timeline[Number(i)].text
            : null
      if (text !== null) for (const p of phrases) expect(text).toContain(p)
    }
  })
})

describe('版・作れなかった印・訂正の写し', () => {
  const base = { v: 1, createdAt: 1, by: 'connector', ai: 'claude', model: 'm', runId: 'r1' }

  it('版: date・slot が壊れていれば id から。知らない枠は残す（画面は版として出さない）。order は重なりを除く', () => {
    const shown = ok(
      repairEdition(
        received({
          ...base,
          id: '2026-11-15-20',
          date: 'きょう',
          order: ['a', 'a', 3, 'b'],
          notChosen: 'x',
          window: { since: '昨日' },
          usage: { tokens: 5, minutes: 'x' },
        }),
      ),
    )
    expect(shown).toMatchObject({
      date: '2026-11-15',
      slot: '20',
      order: ['a', 'b'],
      notChosen: [],
      window: null,
      usage: { tokens: 5 },
    })
    expect(shown.usage).toEqual({ tokens: 5 })
    expect(ok(repairEdition(received({ ...base, id: '2026-11-15-12', date: '2026-11-15', slot: '08' }))).slot).toBe('08')
    expect(repairEdition(received({ ...base, id: '2026-11-15-12', v: 3 }))).toEqual({ kind: 'newer', id: '2026-11-15-12', v: 3 })
  })

  it('作れなかった印: 知らない理由の種類も残す', () => {
    const shown = ok(
      repairEditionFail(received({ ...base, id: '2026-11-15-20-abcdefgh', reasonKind: 'bug', reason: '理由', extra: 1 })),
    )
    expect(shown).toMatchObject({ editionId: '2026-11-15-20', reasonKind: 'bug', reason: '理由', extra: 1 })
  })

  it('訂正: 付ける話題が分からない訂正は出さない', () => {
    const topicId = '2026-11-15-12-k3f9a2bq'
    const id = correctionIdOf({ topicId, text: '訂正の文' })
    expect(ok(repairCorrection(received({ ...base, id, topicId, editionId: '2026-11-15-12', text: '訂正の文' })))).toMatchObject({
      topicId,
      text: '訂正の文',
    })
    expect(ok(repairCorrection(received({ ...base, id, text: '訂正の文' })))).toMatchObject({
      topicId,
      editionId: '2026-11-15-12',
    })
    expect(repairCorrection(received({ ...base, id: 'x', text: '訂正の文' }))).toEqual({ kind: 'broken' })
    expect(repairCorrection(received({ ...base, id, topicId }))).toEqual({ kind: 'broken' })
  })
})

describe('アプリの記録の写し', () => {
  const user = { v: 1, createdAt: 1, updatedAt: 2, by: 'user', ai: null }

  it('知ってる: 知らない欄を残し、形の分からない値は決まった値に。受け取った記録は変えない', () => {
    const raw = received({ ...user, id: termIdOf('与党'), term: '与党', asOf: '2026-11', on: true, device: 'phone' })
    const before = structuredClone(raw)
    expect(ok(repairKnownTerm(raw))).toEqual(raw)
    expect(raw).toEqual(before)
    expect(ok(repairKnownTerm(received({ ...user, id: 't1', asOf: 202611, on: 'yes' })))).toMatchObject({
      term: '',
      asOf: null,
      on: false,
    })
    expect(repairKnownTerm(received({ ...user, id: 't1', v: 2 }))).toMatchObject({ kind: 'newer' })
  })

  it('既読: 読んだ話題は重なりを除き、editionId が壊れていれば id から', () => {
    const shown = ok(repairReadMark(received({ ...user, id: '2026-11-15-12', topicIds: ['a', 'a', 'b', 1], seen: 1 })))
    expect(shown).toMatchObject({ editionId: '2026-11-15-12', topicIds: ['a', 'b'], seen: false })
  })
})

describe('出典の著者とリンクの開き方（段階3）', () => {
  const withSource = (source: Record<string, unknown>) =>
    received(makeSampleTopic((t) => (t.sources = [{ ...t.sources[0], ...source } as never])))

  it('著者は文字ならそのまま、文字でない時は null、欄の無い出典は欄の無いまま（受け取った記録は変えない）', () => {
    const cases: [unknown, string | null][] = [
      ['FAKE_作り物の著者', 'FAKE_作り物の著者'],
      [null, null],
      [42, null],
      [{ name: 'x' }, null],
    ]
    for (const [author, want] of cases) {
      const raw = withSource({ author })
      const before = structuredClone(raw)
      expect(ok(repairTopic(raw, opts)).sources[0].author).toBe(want)
      expect(raw).toEqual(before)
    }
    expect('author' in ok(repairTopic(withSource({}), opts)).sources[0]).toBe(false)
  })

  it("リンクにしない社（linkOpen: 'no-link'）の出典は、使ってよい URL でも link が null", () => {
    const shown = ok(repairTopic(withSource({ outlet: FAKE_CREDIT_OUTLETS.noLink, url: 'https://example.com/n/1' }), opts))
    expect(shown.sources[0]).toMatchObject({ url: 'https://example.com/n/1', link: null })
    const site = ok(repairTopic(withSource({ outlet: FAKE_CREDIT_OUTLETS.site, url: 'https://example.com/n/1' }), opts))
    expect(site.sources[0].link).toBe('https://example.com/n/1')
  })
})
