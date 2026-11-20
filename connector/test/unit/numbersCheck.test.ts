// 機械の照らし（設計の 4.7 の「機械の照らし」。vault/numbersCheck.ts）: 全角・半角・桁の区切り・「万」「億」と数字の組み合わせ・和暦と西暦の
// 日付をそろえて、資料の本文に見当たらない数字と日付を、欄の道つきで並べる（直しはしない）。作り物の文だけ
import { describe, expect, it } from 'vitest'
import { haystackKeys, missingNumbers, numberTokens } from '../../src/vault/numbersCheck'
import { draftInput } from '../support/drafts'

const keysOf = (text: string) => numberTokens(text).map((t) => t.need)

describe('数字と日付をそろえる', () => {
  it('全角・半角と桁の区切り（, ，）は同じ数', () => {
    const hay = haystackKeys(['作り物の数は１２，０００人だった'])
    expect(keysOf('作り物の数は12,000人')).toEqual([['n:12000']])
    expect(hay.has('n:12000')).toBe(true)
  })

  it('「万」「億」「兆」と数字の組み合わせは値でそろえる', () => {
    expect(keysOf('3万2,000円')).toEqual([['n:32000']])
    expect(keysOf('1.5億円')).toEqual([['n:150000000']])
    expect(keysOf('1億2000万円')).toEqual([['n:120000000']])
    expect(haystackKeys(['32000円']).has('n:32000')).toBe(true)
  })

  it('和暦と西暦の日付・元年・年月・年・月日・日・月・時刻', () => {
    expect(numberTokens('令和8年11月19日')[0].keys).toContain('d:2026-11-19')
    expect(numberTokens('令和元年5月1日')[0].keys).toContain('d:2019-5-1')
    expect(numberTokens('平成31年4月30日')[0].keys).toContain('d:2019-4-30')
    expect(keysOf('2026/11/19')).toEqual([['d:2026-11-19', 'md:11-19']])
    expect(keysOf('2026-11')).toEqual([['ym:2026-11']])
    expect(keysOf('令和8年')).toEqual([['y:2026']])
    expect(keysOf('11月19日')).toEqual([['md:11-19']])
    expect(keysOf('15日に')).toEqual([['day:15']])
    expect(keysOf('来年3月までに')).toEqual([['mon:3']])
    expect(keysOf('10時30分に発表')).toEqual([['t:10:30']])
    expect(keysOf('10:30に発表')).toEqual([['t:10:30']])
  })

  it('1桁の数は、すぐ後が割・%・倍の時だけ見る（文の中の数でふくらませない）', () => {
    expect(keysOf('3つの点')).toEqual([[]])
    expect(keysOf('2割ほど')).toEqual([['n:2']])
    expect(keysOf('5%増えた')).toEqual([['n:5']])
    expect(keysOf('2.5倍')).toEqual([['n:2.5']])
  })
})

describe('見当たらない数字と日付（確かめる所）', () => {
  const body = '〇〇市は令和8年11月15日、作り物の橋の長さを320メートルにすると決めた。費用は3万2,000円。渋滞は2割ほど減る見通し。'

  it('資料の本文に見当たらない物だけを、欄の道つき・下書きの文字のままで並べる（同じ欄の同じ文字は1つ）', () => {
    const input = draftInput(1, {
      headline: '作り物の橋の長さは330メートルに',
      summary:
        '〇〇市は2026年11月15日、作り物の橋の長さを320メートルにした。費用は32,000円。渋滞は3割、さらに3割ほど減る見通し。',
      timeline: [
        { when: '2026-11-15', text: '橋の長さを決めた' },
        { when: '2026-11-16', text: '費用を４万５，０００円とした' },
      ],
      soWhat: { life: null, system: null, world: null, whyNews: null },
      conclusion: { label: 'settled', note: '作り物の補足', breaking: false },
      rankReason: '作り物の理由 99本',
      unverified: ['作り物の点 77件'],
    })
    expect(missingNumbers(input, [body])).toEqual([
      { path: 'headline', text: '330' },
      { path: 'summary', text: '3' },
      { path: 'timeline.1.when', text: '2026-11-16' },
      { path: 'timeline.1.text', text: '４万５，０００' },
    ])
  })

  it('下書きが年月日で、資料が月日だけでも、月日が合えば見当たる事にする（年まで確かめるのは照合の係）', () => {
    const input = draftInput(1, { summary: '作り物の会議は2026年11月20日に開く。' })
    expect(missingNumbers(input, ['作り物の会議は11月20日に開く。']).filter((m) => m.path === 'summary')).toEqual([])
    expect(missingNumbers(input, ['作り物の会議は11月21日に開く。']).filter((m) => m.path === 'summary')).toEqual([
      { path: 'summary', text: '2026年11月20日' },
    ])
  })
})
