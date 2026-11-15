// 決まった値の言葉と決まった文の割り当て（docs/SPEC.md の 7.1 の「決まった値と決まった文」・5.5・5.7・16.3）。知らない値の扱いも表のとおり
import { describe, expect, it } from 'vitest'
import {
  aiLabel,
  asOfText,
  conclusionLabelText,
  editionFailedText,
  editionSlotText,
  FIXED_TEXTS,
  genreLabel,
  reasonKindLabel,
  regionLabel,
  slotLabel,
  stanceLabel,
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
      '読める記事が足りない',
      'そのほか',
    ])
    expect(reasonKindLabel('bug')).toBe('そのほか')
    expect(aiLabel('claude')).toBe('Claude')
    expect(aiLabel('other-ai')).toBe('AI')
  })
})

describe('アプリが出す決まった文', () => {
  it('1〜5・8 の文', () => {
    expect(FIXED_TEXTS.soWhatNone).toBe('この話題では特になし')
    expect(FIXED_TEXTS.claimUnverified).toBe('今回集めた報道では、主張を確かめられなかった')
    expect(FIXED_TEXTS.viewNone).toBe('対立する見解は特になし（事実の報道のため）')
    expect(FIXED_TEXTS.stakeholdersNote).toBe('（並べて示すだけで、どれが正しいかは判定しません）')
    expect(FIXED_TEXTS.commonNote).toBe(
      '「AI の見解」と「対立見解」は、どちらも AI が書いたもので、偏っている可能性があります。両方をあわせて読み、必要なら元記事で確かめてください。',
    )
    expect(FIXED_TEXTS.correctionPrefix).toBe('訂正:')
    expect(FIXED_TEXTS.newerRecord).toBe('新しい形の記録（アプリを更新してください）')
    expect(FIXED_TEXTS.aiGenreNote.length).toBeGreaterThan(0)
  })

  it('7. 作れなかった版「{12:00}版は作れませんでした（{理由}）」', () => {
    expect(editionFailedText('12', 'quota')).toBe('12:00版は作れませんでした（使用量の上限）')
    expect(editionFailedText('20', 'no-sources')).toBe('20:00版は作れませんでした（読める記事が足りない）')
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
