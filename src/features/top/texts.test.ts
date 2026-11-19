// 段階2の画面だけの言葉（src/features/top/texts.ts。設計: 段階2の 1.5・1.8・1.20）: 出典にした所（頭から2つ・3つ以上は「ほか」・
// nか所。段階3で「報道: …（n社）」から替えた。Q19 のあわせての A）・追いつきの帯の文・既読 n件・この版の選び方・版の一覧の作れなかった枠・
// 空の時の文（段階3で替えた。Q8 の A）と待つ間の文・L の空の列の1行（段階3。Q18 の A）
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
  SECTION_TEXTS,
  waitingEditionText,
  WAITING_TEXT,
} from './texts'

describe('画面の言葉', () => {
  it('出典にした所（頭から2つ、3つ以上は「ほか」、括弧に nか所）', () => {
    expect(outletsText(['〇〇省'])).toBe('出典: 〇〇省（1か所）')
    expect(outletsText(['〇〇省', '△△庁'])).toBe('出典: 〇〇省・△△庁（2か所）')
    expect(outletsText(['〇〇省', '△△庁', '▽▽府', '□□ボイス'])).toBe('出典: 〇〇省・△△庁 ほか（4か所）')
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

  it('空の時は届く時刻の案内（段階3で替えた）、待つ間は段階0・1の文のまま', () => {
    expect(EMPTY_TITLE).toBe('まだ版はありません')
    expect(EMPTY_NOTE).toBe('12:00版と20:00版が、ここに届きます。')
    expect(WAITING_TEXT).toBe('版を受け取っています…')
  })

  it('L の空の列の1行（国内・世界）', () => {
    expect(SECTION_TEXTS.columnEmpty).toEqual({
      jp: 'この版には国内の話題がありません',
      world: 'この版には世界の話題がありません',
    })
  })
})
