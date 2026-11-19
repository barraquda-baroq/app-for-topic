// 決まった値の言葉と決まった文の割り当て（docs/SPEC.md の 7.1 の「決まった値と決まった文」・5.5・5.7・16.3）。知らない値の扱いも表のとおり。
// 段階2で足した日付の書き方（版の日付・版の名前・経緯の日付・出典の日時。曜日・月・年の境・知らない形は null。設計: 段階2の 1.20）。
// 段階3で、出どころの言葉（「報道」「元記事」→「出典」「資料」。SOURCE_WORDS。段階3の設計の 3.2）
import { describe, expect, it } from 'vitest'
import {
  aiLabel,
  asOfText,
  conclusionLabelText,
  editionDateText,
  editionFailedText,
  editionLongDateText,
  editionNameText,
  editionSlotText,
  FIXED_TEXTS,
  genreLabel,
  PUBLISHED_UNKNOWN_TEXT,
  publishedAtText,
  reasonKindLabel,
  regionLabel,
  slotLabel,
  sourceDateText,
  SOURCE_WORDS,
  stanceLabel,
  timelineWhenText,
} from './fixedTexts'
import { GENRE_VALUES, REASON_KIND_VALUES } from './types'

describe('決まった値の言葉', () => {
  it('地域・ジャンル（知らない値は null = 総合にだけ出す）', () => {
    expect(regionLabel('jp')).toBe('国内')
    expect(regionLabel('world')).toBe('世界')
    expect(regionLabel('asia')).toBeNull()
    expect(GENRE_VALUES.map((g) => genreLabel(g))).toEqual([
      '政治',
      '経済',
      'テクノロジー',
      'AI',
      '事故・事件',
      'スポーツ',
      'エンタメ',
    ])
    expect(genreLabel('tech', true)).toBe('テック')
    expect(genreLabel('incident', true)).toBe('事件')
    expect(genreLabel('novel')).toBeNull()
    expect(genreLabel(undefined)).toBeNull()
  })

  it('結論ラベル（知らない値は出さない）・立場（知らない値は「不明」）', () => {
    expect(['settled', 'unsettled', 'outlook'].map(conclusionLabelText)).toEqual(['確定', '未確定', '見通し'])
    expect(conclusionLabelText('maybe')).toBeNull()
    expect(['for', 'against', 'conditional', 'unknown'].map(stanceLabel)).toEqual(['賛成', '反対', '条件付き', '不明'])
    expect(stanceLabel('neutral')).toBe('不明')
  })

  it('枠（知らない値は版として出さない）・作れなかった理由（知らない値は「そのほか」）・AI', () => {
    expect(slotLabel('12')).toBe('12:00')
    expect(slotLabel('20')).toBe('20:00')
    expect(slotLabel('08')).toBeNull()
    expect(editionSlotText('20')).toBe('20:00版')
    expect(REASON_KIND_VALUES.map(reasonKindLabel)).toEqual([
      '使用量の上限',
      '障害',
      '時間切れ',
      '読める資料が足りない',
      'そのほか',
    ])
    expect(reasonKindLabel('bug')).toBe('そのほか')
    expect(aiLabel('claude')).toBe('Claude')
    expect(aiLabel('other-ai')).toBe('AI')
  })
})

describe('出どころの言葉（段階3。Q19 のあわせての今の決め方 A。段階3の設計の 3.2）', () => {
  it('「報道」「元記事」を「出典」「資料」に替える（答えで替わるのは SOURCE_WORDS の1か所）', () => {
    expect(SOURCE_WORDS).toEqual({
      card: '出典',
      cardUnit: 'か所',
      sources: '出典',
      material: '今回読んだ資料',
      original: '元の資料',
      readable: '資料',
    })
    // 決まった文はこの言葉から作る（新聞を思わせる言葉を残さない）
    for (const text of [FIXED_TEXTS.claimUnverified, FIXED_TEXTS.commonNote, reasonKindLabel('no-sources')]) {
      expect(text).not.toMatch(/報道|元記事|記事/)
    }
  })
})

describe('アプリが出す決まった文', () => {
  it('1〜5・8 の文', () => {
    expect(FIXED_TEXTS.soWhatNone).toBe('この話題では特になし')
    expect(FIXED_TEXTS.claimUnverified).toBe('今回読んだ資料では、主張を確かめられなかった')
    expect(FIXED_TEXTS.viewNone).toBe('対立する見解は特になし（事実の報道のため）')
    expect(FIXED_TEXTS.stakeholdersNote).toBe('（並べて示すだけで、どれが正しいかは判定しません）')
    expect(FIXED_TEXTS.commonNote).toBe(
      '「AI の見解」と「対立見解」は、どちらも AI が書いたもので、偏っている可能性があります。両方をあわせて読み、必要なら元の資料で確かめてください。',
    )
    expect(FIXED_TEXTS.correctionPrefix).toBe('訂正:')
    expect(FIXED_TEXTS.newerRecord).toBe('新しい形の記録（アプリを更新してください）')
    expect(FIXED_TEXTS.aiGenreNote.length).toBeGreaterThan(0)
  })

  it('7. 作れなかった版「{12:00}版は作れませんでした（{理由}）」', () => {
    expect(editionFailedText('12', 'quota')).toBe('12:00版は作れませんでした（使用量の上限）')
    expect(editionFailedText('20', 'no-sources')).toBe('20:00版は作れませんでした（読める資料が足りない）')
    expect(editionFailedText('20', 'bug')).toBe('20:00版は作れませんでした（そのほか）')
    expect(editionFailedText('08', 'quota')).toBeNull()
  })

  it('9. 用語の説明の時点「{2026年11月}時点」（asOf が null・形が違えば添えない）', () => {
    expect(asOfText('2026-11')).toBe('2026年11月時点')
    expect(asOfText('2027-01')).toBe('2027年1月時点')
    expect(asOfText(null)).toBeNull()
    expect(asOfText('2026-11-15')).toBeNull()
  })
})

describe('日付の書き方（段階2の画面。設計: 段階2の 1.20）', () => {
  it('版の日付の短い形「11/15（日）」・長い形「2026年11月15日（日）」（月と日は0で埋めない）', () => {
    expect(editionDateText('2026-11-15')).toBe('11/15（日）')
    expect(editionDateText('2026-11-05')).toBe('11/5（木）')
    expect(editionLongDateText('2026-11-15')).toBe('2026年11月15日（日）')
    expect(editionLongDateText('2027-01-03')).toBe('2027年1月3日（日）')
  })

  it('月・年の境', () => {
    expect(editionDateText('2026-11-30')).toBe('11/30（月）')
    expect(editionDateText('2026-12-01')).toBe('12/1（火）')
    expect(editionLongDateText('2026-12-31')).toBe('2026年12月31日（木）')
    expect(editionLongDateText('2027-01-01')).toBe('2027年1月1日（金）')
  })

  it('版の名前「11/15（日）12:00版」', () => {
    expect(editionNameText('2026-11-15', '12')).toBe('11/15（日）12:00版')
    expect(editionNameText('2026-11-14', '20')).toBe('11/14（土）20:00版')
    expect(editionNameText('2026-11-14', '08')).toBeNull()
    expect(editionNameText('2026-11-31', '12')).toBeNull()
  })

  it('経緯の when（年・年月・年月日。null・形の違う物は null）', () => {
    expect(timelineWhenText('2026')).toBe('2026年')
    expect(timelineWhenText('2023-04')).toBe('2023年4月')
    expect(timelineWhenText('2026-11-15')).toBe('2026年11月15日')
    expect(timelineWhenText('2026-01-05')).toBe('2026年1月5日')
    for (const v of [null, '', '2026-13', '2026-02-30', '26-11', '2026/11']) expect([v, timelineWhenText(v)]).toEqual([v, null])
  })

  it('出典の日時（時差つきの日時は時刻まで・日付だけは日付・null は補足の文か「掲載日時は不明」）', () => {
    expect(publishedAtText('2026-11-15T11:30+09:00')).toBe('2026年11月15日 11:30')
    expect(publishedAtText('2026-11-15T09:05:42+09:00')).toBe('2026年11月15日 09:05')
    expect(publishedAtText('2026-11-05')).toBe('2026年11月5日')
    for (const v of [null, '2026-11-15T11:30Z', '2026-11-15T25:00+09:00', '2026-11-31', 'きのう'])
      expect([v, publishedAtText(v)]).toEqual([v, null])
    expect(sourceDateText({ publishedAt: '2026-11-15T11:30+09:00', publishedNote: 'ほか' })).toBe('2026年11月15日 11:30')
    expect(sourceDateText({ publishedAt: null, publishedNote: '掲載日時は記事に書かれていない' })).toBe(
      '掲載日時は記事に書かれていない',
    )
    expect(sourceDateText({ publishedAt: null, publishedNote: null })).toBe(PUBLISHED_UNKNOWN_TEXT)
    expect(sourceDateText({ publishedAt: null })).toBe('掲載日時は不明')
  })
})
