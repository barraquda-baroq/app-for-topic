// 段階2の画面だけの言葉（src/features/top/texts.ts。設計: 段階2の 1.5・1.8・1.20）: 報じた社（頭から2社・3社以上は「ほか」・n社）・
// 追いつきの帯の文・既読 n件・この版の選び方・版の一覧の作れなかった枠・段階0・1の空と待つ間の文のまま
import { describe, expect, it } from 'vitest'
import {
  catchUpBandText,
  choiceCountText,
  editionNameOfId,
  editionRowFailedText,
  EMPTY_NOTE,
  EMPTY_TITLE,
  outletsText,
  readFoldText,
  waitingEditionText,
  WAITING_TEXT,
} from './texts'

describe('画面の言葉', () => {
  it('報じた社（頭から2社、3社以上は「ほか」、括弧に n社）', () => {
    expect(outletsText(['〇〇通信'])).toBe('報道: 〇〇通信（1社）')
    expect(outletsText(['〇〇通信', '△△新聞'])).toBe('報道: 〇〇通信・△△新聞（2社）')
    expect(outletsText(['〇〇通信', '△△新聞', '□□放送', '◇◇日報'])).toBe('報道: 〇〇通信・△△新聞 ほか（4社）')
    expect(outletsText([])).toBeNull()
  })

  it('追いつきの帯（版の数は字で・いちばん古い版から）', () => {
    expect(catchUpBandText(2, '2026-11-13-20')).toBe('見ていない版が 2つあります（11/13（金）20:00版から）')
    expect(catchUpBandText(3, null)).toBe('見ていない版が 3つあります')
    expect(catchUpBandText(2, 'broken')).toBe('見ていない版が 2つあります')
  })

  it('既読 n件・この版の選び方・版の一覧の作れなかった枠・版の名前', () => {
    expect(readFoldText(5)).toBe('既読 5件')
    expect(choiceCountText(312, 20)).toBe('候補 312 件から20本を選びました')
    expect(editionRowFailedText('quota')).toBe('作れませんでした（使用量の上限）')
    expect(editionRowFailedText('bug')).toBe('作れませんでした（そのほか）')
    expect(editionNameOfId('2026-11-15-12')).toBe('11/15（日）12:00版')
    expect(editionNameOfId('2026-11-15')).toBeNull()
    expect(waitingEditionText('2026-11-15-20')).toBe('11/15（日）20:00版を受け取っています…')
  })

  it('空と待つ間は段階0・1の文のまま', () => {
    expect(EMPTY_TITLE).toBe('まだ版はありません')
    expect(EMPTY_NOTE).toBe('12:00版と20:00版は、段階3から届くようになります。')
    expect(WAITING_TEXT).toBe('版を受け取っています…')
  })
})
