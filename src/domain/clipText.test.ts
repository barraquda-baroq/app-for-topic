// ［クリップ］の文（src/domain/clipText.ts。D10・docs/SPEC.md の 7.6・9.。作者の答え A。設計: 段階2の 1.14）: 作り物の鎖の1本目
// （訂正1件・◇◇日報を××ニュースで読んだ出典）で 9. の例と同じ形の文を1字も違わずに作る・訂正なし・2件（足した順）・知らない地域と
// ジャンル・読んだ所あり・リンクにならない URL も入る・強調と用語の印が入らない・だから何？が入らない・日付と曜日（月・年の境）。
// 段階3で、段の頭を「出典:」に替え（Q19 のあわせて）、出典の書き方のある社は URL の行の代わりに出典の表示の行（段階3の設計の 3.4 の 4.）
import { describe, expect, it } from 'vitest'
import { CHAIN_CORRECTION_TEXT, FAKE_TOPIC_SCENES, makeFakeMonth } from '../test/fixtures/fakeEditions'
import { FAKE_CREDIT_OUTLETS, FAKE_OUTLETS } from '../test/fixtures/fakeOutlets'
import { CLIP_SOURCES_HEAD, clipEditionLine, clipText } from './clipText'
import { CREDIT_PROCESSOR, CC_BY_3_NAME, CC_BY_3_URL } from './credit'
import { correctionsByTopic } from './editionShow'
import { publishedAtText } from './fixedTexts'
import { repairCorrection, repairTopic, type ShownCorrection, type ShownTopic } from './repair'

const month = makeFakeMonth({ until: '2026-11-15', untilSlot: '12', days: 3, seed: 'clip-text' })
const allTopics = month.editions.flatMap((e) => e.topics)
const shown = (id: string): ShownTopic => {
  const r = repairTopic(
    allTopics.find((t) => t.id === id),
    { outlets: FAKE_OUTLETS },
  )
  if (r.kind !== 'ok') throw new Error(`写しにできない: ${id}`)
  return r.value
}
const correctionsOf = (topicId: string): ShownCorrection[] => {
  const list = month.corrections.map((c) => repairCorrection(c)).flatMap((r) => (r.kind === 'ok' ? [r.value] : []))
  return correctionsByTopic(list, [topicId]).get(topicId) ?? []
}

describe('clipText（クリップの文）', () => {
  it('段の頭は「出典:」（段階3で「元記事:」から替えた）', () => {
    expect(CLIP_SOURCES_HEAD).toBe('出典:')
  })

  it('鎖の1本目: 見出し・版の行・空行・要約・空行・訂正・空行・出典（社「題」（…で読んだ）と URL）', () => {
    const topic = shown(month.scenes.chain[0])
    const corrections = correctionsOf(topic.id)
    expect(corrections.map((c) => c.text)).toEqual([CHAIN_CORRECTION_TEXT])
    expect(clipText(topic, corrections)).toBe(
      [
        '〇〇市で新しい橋が開通、市は朝夕の渋滞が2割ほど減る見通しを示す',
        '2026年11月13日（金）12:00版・国内・経済',
        '',
        '〇〇市が建設を進めてきた新しい橋が13日に開通し、市の中心部と東部の住宅地が1本の道で結ばれた。長さは320メートルで、歩道の幅は2メートル。市は朝夕の渋滞が2割ほど減る見通しを示した。通行料はまだ決まっていない。市は来年3月までに決めるとしている。',
        '',
        '訂正: 新しい橋の歩道の幅は 2メートルではなく 3メートルでした',
        '',
        '出典:',
        '〇〇通信「〇〇市の新しい橋が開通」',
        'https://example.com/news/2026-11-13-12/14-1',
        '◇◇日報「新しい橋が開通 渋滞2割減の見通し」（××ニュースで読んだ）',
        'https://example.com/via/2026-11-13-12/14-2',
      ].join('\n'),
    )
  })

  it('訂正が無い時は訂正の段を書かない', () => {
    const topic = shown(month.scenes.chain[1])
    const text = clipText(topic, correctionsOf(topic.id))
    expect(text).not.toContain('訂正:')
    expect(text.split('\n\n').map((b) => b.split('\n')[0])).toEqual([topic.headline, topic.summary, CLIP_SOURCES_HEAD])
  })

  it('訂正2件は足した順（2件目が1件目を正す時もそのまま並べる）', () => {
    const topic = shown(month.scenes.corrections.twice)
    const corrections = correctionsOf(topic.id)
    expect(corrections).toHaveLength(2)
    const blocks = clipText(topic, corrections).split('\n\n')
    expect(blocks[2]).toBe(corrections.map((c) => `訂正: ${c.text}`).join('\n'))
    expect(blocks[2].split('\n')[1]).toContain('先の訂正は誤りで')
  })

  it('知らない地域・ジャンルはその語を書かない。リンクにならない URL（一覧に無い社のホスト）も入れる', () => {
    const topic = shown(month.editions[month.editions.length - 1].scenes.newerValues)
    expect(topic.genre).toBe('novel')
    expect(clipEditionLine(topic)).toBe('2026年11月15日（日）12:00版・国内')
    expect(clipEditionLine({ ...topic, region: 'asia', genre: 'politics' })).toBe('2026年11月15日（日）12:00版・政治')
    expect(clipEditionLine({ ...topic, region: 'asia' })).toBe('2026年11月15日（日）12:00版')
    const unlinked = topic.sources.filter((s) => s.link === null)
    expect(unlinked.length).toBeGreaterThan(0)
    for (const s of unlinked) expect(clipText(topic)).toContain(`\n${s.url}`)
  })

  it('https: でない URL・読めない URL は書かない。読んだ所の無い出典は括弧を書かない', () => {
    const topic = shown(month.scenes.chain[0])
    const text = clipText({
      ...topic,
      sources: [
        { outlet: '〇〇通信', title: '題1', url: 'http://example.com/a', via: null },
        { outlet: '△△新聞', title: '題2', url: 'javascript:alert(1)', via: null },
        { outlet: '□□放送', title: '題3', url: 'https://example.com/c', via: null },
      ],
    })
    expect(text.split('\n\n').at(-1)).toBe(
      ['出典:', '〇〇通信「題1」', '△△新聞「題2」', '□□放送「題3」', 'https://example.com/c'].join('\n'),
    )
  })

  it('出典の書き方のある社は、URL の行の代わりに出典の表示の行（URL を含む）。credit の無い社は今のまま URL の行', () => {
    const topic = shown(month.scenes.chain[0])
    const P = CREDIT_PROCESSOR
    const sources = [
      { outlet: FAKE_CREDIT_OUTLETS.site, title: '作り物の発表1', url: 'https://example.com/p/1', via: null },
      { outlet: FAKE_CREDIT_OUTLETS.title, title: '作り物の発表2', url: 'https://example.com/p/2', via: null },
      {
        outlet: FAKE_CREDIT_OUTLETS.ccBy,
        title: '作り物の記事',
        url: 'https://example.com/p/3',
        via: null,
        author: 'FAKE_作り物の著者',
      },
      { outlet: '〇〇通信', title: '題4', url: 'https://example.com/p/4', via: null },
    ]
    const text = clipText({ ...topic, sources }, [], FAKE_OUTLETS)
    expect(text.split('\n\n').at(-1)).toBe(
      [
        '出典:',
        '〇〇省「作り物の発表1」',
        `出典：〇〇省ホームページ（https://example.com/p/1）を加工して作成（加工: ${P}）`,
        '△△庁「作り物の発表2」',
        `出典：「作り物の発表2」（△△庁）（https://example.com/p/2）を加工して作成（加工: ${P}）`,
        '□□ボイス「作り物の記事」',
        `出典：□□ボイス「作り物の記事」（著者: FAKE_作り物の著者）（https://example.com/p/3）、${CC_BY_3_NAME}（${CC_BY_3_URL}）。${P}が要約・翻訳した`,
        '〇〇通信「題4」',
        'https://example.com/p/4',
      ].join('\n'),
    )
    // 一覧を渡さなければ、ふだんの一覧で引く（作り物の社には出典の書き方が無いので、URL の行のまま）
    expect(
      clipText({ ...topic, sources })
        .split('\n\n')
        .at(-1)
        ?.split('\n')[2],
    ).toBe('https://example.com/p/1')
  })

  it('強調・用語の印は付けない。だから何？・当事者・見解・経緯・出典の日時は入れない', () => {
    const topic = shown(month.scenes.chain[0])
    const text = clipText(topic, correctionsOf(topic.id))
    expect(Object.keys(topic.emphasis).length).toBeGreaterThan(0)
    expect(text).not.toMatch(/[*_<>]/)
    for (const s of [
      topic.soWhat.life,
      topic.soWhat.whyNews,
      topic.stakeholders[0].claim,
      topic.view?.kind === 'opposed' ? topic.view.aiView : null,
      topic.timeline[0].text,
      topic.terms[0].explanation,
      '+09:00',
      // 出典の日時（時刻のある物。日付だけの物は版の行と同じ字になる）
      ...topic.sources.map((src) => publishedAtText(src.publishedAt)).filter((x) => x?.includes(':')),
    ])
      if (s) expect([s, text.includes(s)]).toEqual([s, false])
  })

  it('版の行の日付と曜日（月・年の境）・20:00版', () => {
    const topic = shown(month.scenes.chain[0])
    const line = (editionId: string) => clipEditionLine({ ...topic, editionId })
    expect(line('2026-11-30-20')).toBe('2026年11月30日（月）20:00版・国内・経済')
    expect(line('2026-12-01-12')).toBe('2026年12月1日（火）12:00版・国内・経済')
    expect(line('2026-12-31-20')).toBe('2026年12月31日（木）20:00版・国内・経済')
    expect(line('2027-01-01-12')).toBe('2027年1月1日（金）12:00版・国内・経済')
    expect(line('broken')).toBe('国内・経済')
  })

  it('作り物のどの話題でも、見出しで始まり、出典の段で終わる（行の終わりは \\n）', () => {
    for (const ed of month.editions)
      for (const raw of ed.topics) {
        const topic = shown(raw.id)
        const text = clipText(topic, correctionsOf(topic.id))
        expect(text.startsWith(`${topic.headline}\n`)).toBe(true)
        expect(text).not.toContain('\r')
        expect(text.endsWith('\n')).toBe(false)
        expect(text.split('\n\n').at(-1)?.split('\n')[0]).toBe(CLIP_SOURCES_HEAD)
      }
    expect(FAKE_TOPIC_SCENES.newerValues).toBe(20)
  })
})
