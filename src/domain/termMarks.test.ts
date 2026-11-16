// 本文の中の用語の印（src/domain/termMarks.ts。docs/SPEC.md の 9.・7.1・5.12。設計: 段階2の 1.12）: 長い方を採る・別名・1つの話題で
// 語ごとに最初の1か所・知ってる語に付けない・欄の順（詳細の順）・強調と重なる時の区切り（強調の中の語・語をまたぐ強調）・
// 文に <b> などがあっても文のまま
import { describe, expect, it } from 'vitest'
import { FAKE_TOPIC_SCENES, makeFakeEdition } from '../test/fixtures/fakeEditions'
import { FAKE_OUTLETS } from '../test/fixtures/fakeOutlets'
import { repairTopic, type ShownTopic } from './repair'
import { detailTextFields, findTermHits, hitsOf, richSegments, type TermSurface } from './termMarks'

const term = (termId: string, t: string, aliases: string[] = []): TermSurface => ({ termId, term: t, aliases })

describe('detailTextFields（印を付ける欄。詳細に出す順）', () => {
  const topic = {
    headline: '見出しには付けない',
    summary: '要約',
    conclusion: { label: 'settled', note: '結論の補足', breaking: false },
    soWhat: { life: '暮らし', system: null, world: '世界', whyNews: 'なぜ' },
    stakeholders: [
      { name: 'A 党', claim: '主張1', reason: '理由1' },
      { name: 'B 党', claim: null, reason: null },
      { name: 'C 党', claim: '主張3', reason: null },
    ],
    view: { kind: 'opposed', axis: '軸', issue: '論点', aiView: '見解', counterView: '対立' },
    timeline: [{ when: null, text: '経緯1' }, { text: '経緯2' }],
    followUp: null,
    terms: [{ explanation: '用語の説明には付けない' }],
    unverified: ['確かめられなかった点には付けない'],
  }

  it('結論の補足 → 要約 → だから何？ → 当事者の主張と理由 → 見解 → 対立見解 → 経緯。null の欄・見出し・説明は入れない', () => {
    expect(detailTextFields(topic).map((f) => f.key)).toEqual([
      'conclusion.note',
      'summary',
      'soWhat.life',
      'soWhat.world',
      'soWhat.whyNews',
      'stakeholders.0.claim',
      'stakeholders.0.reason',
      'stakeholders.2.claim',
      'view.aiView',
      'view.counterView',
      'timeline.0.text',
      'timeline.1.text',
    ])
  })

  it('続報の時は、経緯を「何が新しいか」のすぐ後に（詳細の 6 の欄）。対立見解なし・空の補足は入れない', () => {
    const f = {
      ...topic,
      conclusion: { label: 'settled', note: '', breaking: false },
      view: { kind: 'none', noneReason: '理由の文には付けない' },
      followUp: { prevTopicId: 'x', whatsNew: '新しい事' },
    }
    expect(detailTextFields(f).map((x) => x.key)).toEqual([
      'summary',
      'followUp.whatsNew',
      'timeline.0.text',
      'timeline.1.text',
      'soWhat.life',
      'soWhat.world',
      'soWhat.whyNews',
      'stakeholders.0.claim',
      'stakeholders.0.reason',
      'stakeholders.2.claim',
    ])
  })

  it('形の分からない値は空', () => {
    expect(detailTextFields(null)).toEqual([])
    expect(detailTextFields({ summary: 3 })).toEqual([])
  })
})

describe('findTermHits（用語の印）', () => {
  it('重なる時は長い方を採り、短い方はその所に付けない', () => {
    const hits = findTermHits(
      [{ key: 'summary', text: '国際連合の会議で、国際的な話し合い' }],
      [term('t1', '国際'), term('t2', '国際連合')],
    )
    expect(hits).toEqual([
      { key: 'summary', start: 0, end: 4, termId: 't2' },
      { key: 'summary', start: 9, end: 11, termId: 't1' },
    ])
  })

  it('別名でも付ける（そのままの文字で照らす。大きさ・幅をそろえない）', () => {
    const hits = findTermHits(
      [{ key: 'summary', text: '中銀が金利を上げた。ＡＩも' }],
      [term('t1', '中央銀行', ['中銀']), term('t2', 'AI')],
    )
    expect(hits).toEqual([{ key: 'summary', start: 0, end: 2, termId: 't1' }])
  })

  it('1つの話題で、語ごとに最初に出る1か所だけ（ほかの欄・同じ欄の2回目には付けない）', () => {
    const fields = [
      { key: 'conclusion.note', text: '開通は確定' },
      { key: 'summary', text: '橋が開通し、開通の式も' },
      { key: 'soWhat.life', text: '開通で通勤が楽に' },
    ]
    expect(findTermHits(fields, [term('t1', '開通'), term('t2', '通勤')])).toEqual([
      { key: 'conclusion.note', start: 0, end: 2, termId: 't1' },
      { key: 'soWhat.life', start: 3, end: 5, termId: 't2' },
    ])
  })

  it('別名と表記のどちらが先でも、最初に出る所に付ける', () => {
    const hits = findTermHits([{ key: 'summary', text: 'AB を使う。ABCD も' }], [term('t1', 'ABCD', ['AB'])])
    expect(hits).toEqual([{ key: 'summary', start: 0, end: 2, termId: 't1' }])
  })

  it('「知ってる」の語には付けない（重なりの決めには加わる）', () => {
    const terms = [term('t1', '国際'), term('t2', '国際連合')]
    const hits = findTermHits([{ key: 'summary', text: '国際連合と国際' }], terms, (x) => x.termId === 't2')
    expect(hits).toEqual([{ key: 'summary', start: 5, end: 7, termId: 't1' }])
  })

  it('前の欄でもう付けた語も、後の欄の重なりの決めに加わる', () => {
    const hits = findTermHits(
      [
        { key: 'summary', text: '国際連合' },
        { key: 'soWhat.life', text: '国際連合の国際' },
      ],
      [term('t1', '国際'), term('t2', '国際連合')],
    )
    expect(hits).toEqual([
      { key: 'summary', start: 0, end: 4, termId: 't2' },
      { key: 'soWhat.life', start: 5, end: 7, termId: 't1' },
    ])
    expect(hitsOf(hits, 'soWhat.life')).toEqual([{ key: 'soWhat.life', start: 5, end: 7, termId: 't1' }])
  })

  it('作り物の版の話題: どの語も1か所まで・印は欄の文の中の表記か別名', () => {
    const fake = makeFakeEdition({ date: '2026-11-15', slot: '12', seed: 'term-marks' })
    for (const raw of fake.topics) {
      const r = repairTopic(raw, { outlets: FAKE_OUTLETS })
      if (r.kind !== 'ok') throw new Error('写しにできない')
      const topic: ShownTopic = r.value
      const fields = detailTextFields(topic)
      const hits = findTermHits(fields, topic.terms)
      expect(new Set(hits.map((h) => h.termId)).size).toBe(hits.length)
      for (const h of hits) {
        const text = fields.find((f) => f.key === h.key)!.text.slice(h.start, h.end)
        const t = topic.terms.find((x) => x.termId === h.termId)!
        expect([t.term, ...t.aliases]).toContain(text)
      }
    }
    // 重大印の話題（1位）には、本文に出る語がある
    const major = repairTopic(fake.topics[FAKE_TOPIC_SCENES.major - 1], { outlets: FAKE_OUTLETS })
    if (major.kind !== 'ok') throw new Error('写しにできない')
    expect(findTermHits(detailTextFields(major.value), major.value.terms).length).toBeGreaterThan(0)
  })
})

describe('richSegments（強調と用語の印の区切り）', () => {
  it('つなぐと元の文になり、強調だけ・用語だけの所を分ける', () => {
    const text = '市は来週の土曜に1日通行止めにする'
    const segs = richSegments(text, ['来週の土曜に1日通行止め'], [{ start: 10, end: 14, termId: 't1' }])
    expect(segs.map((s) => s.text).join('')).toBe(text)
    expect(segs).toEqual([
      { text: '市は', strong: false, termId: null, termStart: false },
      { text: '来週の土曜に1日', strong: true, termId: null, termStart: false },
      { text: '通行止め', strong: true, termId: 't1', termStart: true },
      { text: 'にする', strong: false, termId: null, termStart: false },
    ])
  })

  it('語をまたぐ強調: 1つの印が2つの区切りになり、頭だけ termStart', () => {
    const segs = richSegments('利上げを決めた日', ['げを決め'], [{ start: 0, end: 3, termId: 't1' }])
    expect(segs).toEqual([
      { text: '利上', strong: false, termId: 't1', termStart: true },
      { text: 'げ', strong: true, termId: 't1', termStart: false },
      { text: 'を決め', strong: true, termId: null, termStart: false },
      { text: 'た日', strong: false, termId: null, termStart: false },
    ])
  })

  it('強調は最初に出る所だけ・見つからない語句と重なる語句は付けない（splitEmphasis と同じ）', () => {
    const segs = richSegments('橋と橋と川', ['橋', '橋と', '海'])
    expect(segs).toEqual([
      { text: '橋', strong: true, termId: null, termStart: false },
      { text: 'と橋と川', strong: false, termId: null, termStart: false },
    ])
  })

  it('文の外・重なる用語の印は捨てる', () => {
    const segs = richSegments(
      'あいうえお',
      [],
      [
        { start: 1, end: 3, termId: 'a' },
        { start: 2, end: 4, termId: 'b' },
        { start: 4, end: 9, termId: 'c' },
      ],
    )
    expect(segs.filter((s) => s.termId).map((s) => [s.text, s.termId])).toEqual([['いう', 'a']])
  })

  it('記録の文に <b> などがあっても文のまま（HTML として読まない）', () => {
    const text = '<b>太字</b>と<script>x</script>'
    const segs = richSegments(text, ['<b>太字</b>'])
    expect(segs.map((s) => s.text)).toEqual(['<b>太字</b>', 'と<script>x</script>'])
    expect(richSegments('')).toEqual([])
  })
})
