// 単体テスト用の作り物の話題（docs/SPEC.md の 5.12 の例「〇〇市で新しい橋が開通」。16.3）。決まりの範囲の真ん中にあり、コネクタの確かめで
// 断る物も知らせる物も無い1本。中身はすべて作り物で、URL は https://example.com/… だけ、社は作り物の一覧（src/test/fixtures/fakeOutlets.ts）。
// 段階1の作り物の版（src/test/fixtures/fakeEditions.ts。16.3）とは別の、src/domain のテストのための小さな物。
import { termIdOf, topicIdOf } from '../../domain/ids'
import type { Topic, TopicTerm } from '../../domain/types'

/** 5.12 の例の要約（126字） */
export const SAMPLE_SUMMARY =
  '〇〇市が建設を進めてきた新しい橋が15日に開通し、市の中心部と東部の住宅地が1本の道で結ばれた。長さは320メートルで、歩道と自転車の道も付く。市は朝夕の渋滞が2割ほど減る見通しを示した。通行料はまだ決まっていない。市は来年3月までに決めるとしている。'

const term = (key: string, explanation: string, aliases: string[] = [], asOf: string | null = null): TopicTerm => ({
  termId: termIdOf(key),
  term: key,
  aliases,
  explanation,
  asOf,
})

/** 作り物の話題を作る（edit で欄を変えてから、id と threadId を中身から作り直す） */
export function makeSampleTopic(edit?: (t: Topic) => void): Topic {
  const t: Topic = {
    id: '',
    v: 1,
    createdAt: Date.UTC(2026, 10, 15, 2, 0),
    by: 'connector',
    ai: 'claude',
    model: 'test-model',
    runId: 'r-test-1',
    editionId: '2026-11-15-12',
    threadId: '',
    rank: 1,
    rankReason: '市の中心部と東部を結ぶ道の節目で、暮らしへの影響が大きいため',
    region: 'jp',
    genre: 'economy',
    major: false,
    headline: '〇〇市の新しい橋が開通、市は朝夕の渋滞が2割ほど減る見通しを示す',
    summary: SAMPLE_SUMMARY,
    conclusion: { label: 'outlook', note: '開通は確定、渋滞が減るかは市の見通しの段階', breaking: false },
    soWhat: {
      life: '朝夕に車で中心部へ通う人は、通勤の時間が短くなる見込みです。',
      system: '橋の通行料は市が案を作り、市議会の議決で決まります。',
      world: null,
      whyNews: '中心部と東部を結ぶ道は、長く渋滞が課題でした。',
    },
    stakeholders: [
      {
        name: 'A 党',
        stance: 'for',
        stanceNote: null,
        claim: '通行料は無料にすべきだと主張している。',
        reason: '市民の負担を減らすため。',
      },
      {
        name: 'B 党',
        stance: 'conditional',
        stanceNote: '料金の額しだい',
        claim: '維持費のために少額の通行料を取るべきだと主張している。',
        reason: '修繕の費用をまかなうため。',
      },
      { name: 'C 党', stance: 'unknown', stanceNote: null, claim: null, reason: null },
    ],
    view: {
      kind: 'opposed',
      axis: '成長・企業重視 ⇔ 分配・生活者重視',
      issue: null,
      aiView: '開通で中心部の商店に人が戻る効果は、大きいように見えます。',
      counterView: '渋滞が東部の住宅地へ移るだけになるおそれも、あると考えます。',
    },
    timeline: [
      { when: '2023-04', text: '新しい橋の建設が始まった' },
      { when: '2026-11-15', text: '新しい橋が開通した' },
      { when: null, text: 'その後、市が通行料の案を示す予定' },
    ],
    followUp: null,
    terms: [
      term('通行料', '道や橋を通る時に払うお金のことです。'),
      term('市議会', '市のきまりや予算を話し合って決める集まりです。', ['議会']),
      term('渋滞', '車が多くて、道がなかなか進まないことです。'),
      term('歩道', '人が歩くための道の部分です。'),
      term('住宅地', '家がたくさん集まっている所です。'),
      term('中心部', '町のまん中の、店や役所が多い所です。'),
      term('維持費', 'ものを使い続けるためにかかるお金です。'),
      term('修繕', 'こわれた所を直すことです。'),
      term('議決', '話し合いで、多い方の意見に決めることです。'),
      term('予算', '1年でどれだけお金を使うかの計画です。'),
      term('与党（日本）', '国の政治で、政府をつくっている政党です。', ['与党'], '2026-11'),
    ],
    sources: [
      {
        outlet: '〇〇通信',
        title: '〇〇市の新しい橋が開通',
        url: 'https://example.com/news/bridge-1',
        publishedAt: '2026-11-15T10:00+09:00',
        publishedNote: null,
        via: null,
      },
      {
        outlet: '◇◇日報',
        title: '新しい橋が開通 渋滞2割減の見通し',
        url: 'https://example.com/via/bridge-2',
        publishedAt: '2026-11-15',
        publishedNote: null,
        via: '××ニュース',
      },
    ],
    outletNames: ['〇〇通信', '◇◇日報', '△△新聞'],
    unverified: ['通行料の案の中身は確かめられなかった'],
    check: { claims: 24, fixed: 1, model: 'test-model' },
    emphasis: {
      summary: ['15日に開通', '通行料はまだ決まっていない'],
      'soWhat.life': ['時間が短くなる見込み'],
      'stakeholders.0.claim': ['通行料は無料にすべき'],
      'stakeholders.1.claim': ['少額の通行料を取るべき'],
      'view.aiView': ['人が戻る効果は、大きい'],
      'view.counterView': ['住宅地へ移るだけ'],
      'timeline.1.text': ['新しい橋が開通した'],
    },
  }
  edit?.(t)
  t.id = topicIdOf(t)
  if (t.followUp === null) t.threadId = t.id
  return t
}
