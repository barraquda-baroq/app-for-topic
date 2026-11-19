// 気象庁の Atom と電文から、版に入れてよい種類を絞る決まり（段階3の設計の 1.7 の (5)・(6)）: 種類の表で絞る・content の要る語で絞る・
// 優先の順・最大震度5弱で入る・4で入らない・特別警報だけ・Ｒ０６ の名前の種類も当たる・（EventID・系統）の組・訓練と取消・
// 区域と値を電文のまま、電文の段の順に文字にする・大きな電文の「ほか n 地点」
import { describe, expect, it } from 'vitest'
import {
  groupKey,
  hasNeedWord,
  isCancel,
  isDrill,
  JMA_KINDS,
  JMA_PLACE_CAP,
  kindOfTitle,
  parseTelegram,
  sortForRead,
  telegramVerdict,
} from '../../src/fetch/jma'
import { fakeQuakeTelegram, fakeTsunamiTelegram, fakeWarningTelegram } from '../fixtures/fakePages'

const kind = (id: string) => JMA_KINDS.find((k) => k.id === id)!

describe('種類の表', () => {
  it('Atom の題で行に当てる（Ｒ０６・Ｈ２７ の名前の物も当たる）。表に無い種類は入れない', () => {
    expect(kindOfTitle('震度速報')?.id).toBe('quake')
    expect(kindOfTitle('気象警報・注意報（Ｒ０６）')?.id).toBe('special')
    expect(kindOfTitle('気象特別警報・警報・注意報（Ｈ２７）')?.id).toBe('special')
    expect(kindOfTitle('津波警報・注意報・予報a')?.id).toBe('tsunami')
    expect(kindOfTitle('府県天気予報')).toBeNull()
    expect(kindOfTitle('竜巻注意情報')).toBeNull()
  })

  it('見出しの文の要る語（全角の数字もそろえる。要る語の無い行はいつも残す）', () => {
    expect(hasNeedWord(kind('quake'), '作り物県で最大震度５弱を観測しました')).toBe(true)
    expect(hasNeedWord(kind('quake'), '作り物県で最大震度４を観測しました')).toBe(false)
    expect(hasNeedWord(kind('special'), '作り物県に大雨警報を発表')).toBe(false)
    expect(hasNeedWord(kind('rain'), '作り物の文')).toBe(true)
  })

  it('読む順: 津波 ＞ 震度 ＞ 噴火警報 ＞ 特別警報 ＞ 南海トラフ ＞ 遠地地震 ＞ 大雨 ＞ 全般気象情報、同じ行は新しい順', () => {
    const e = [
      { kind: kind('general'), at: 3 },
      { kind: kind('quake'), at: 1 },
      { kind: kind('tsunami'), at: 0 },
      { kind: kind('quake'), at: 2 },
      { kind: kind('special'), at: 9 },
    ]
    expect(sortForRead(e).map((x) => `${x.kind.id}${x.at}`)).toEqual(['tsunami0', 'quake2', 'quake1', 'special9', 'general3'])
  })
})

describe('電文', () => {
  it('最大震度5弱で入る・4で入らない（電文の値で最後に決める）', () => {
    const t5 = parseTelegram(fakeQuakeTelegram({ maxInt: '5-' }))!
    expect(telegramVerdict(kind('quake'), t5)).toEqual({ include: true, tag: '最大震度5弱' })
    const t4 = parseTelegram(fakeQuakeTelegram({ maxInt: '4' }))!
    expect(telegramVerdict(kind('quake'), t4).include).toBe(false)
  })

  it('津波注意報以上（予報だけの物は入れない）', () => {
    expect(telegramVerdict(kind('tsunami'), parseTelegram(fakeTsunamiTelegram({ kind: '津波注意報' }))!)).toEqual({
      include: true,
      tag: '津波注意報',
    })
    expect(
      telegramVerdict(kind('tsunami'), parseTelegram(fakeTsunamiTelegram({ kind: '津波予報（若干の海面変動）' }))!).include,
    ).toBe(false)
  })

  it('特別警報が出た・解除した電文だけ（ふつうの警報は入れない）', () => {
    const v = (name: string, status: string) =>
      telegramVerdict(kind('special'), parseTelegram(fakeWarningTelegram({ name, status }))!)
    expect(v('大雨特別警報', '発表')).toEqual({ include: true, tag: '特別警報' })
    expect(v('大雨特別警報', '解除')).toEqual({ include: true, tag: '特別警報の解除' })
    expect(v('大雨警報', '特別警報から警報')).toEqual({ include: true, tag: '特別警報の解除' })
    expect(v('大雨警報', '発表').include).toBe(false)
    expect(v('大雨特別警報', '継続').include).toBe(false)
  })

  it('訓練・試験の電文と取消の電文を見分ける。（EventID・系統）の組（EventID の無い電文はまとめない）', () => {
    const drill = parseTelegram(fakeQuakeTelegram({ maxInt: '6-', status: '訓練' }))!
    expect(isDrill(drill)).toBe(true)
    const cancel = parseTelegram(fakeQuakeTelegram({ maxInt: '6-', infoType: '取消' }))!
    expect(isCancel(cancel)).toBe(true)
    const q = parseTelegram(fakeQuakeTelegram({ maxInt: '5+' }))!
    const t = parseTelegram(fakeTsunamiTelegram({ kind: '津波警報' }))!
    // 同じ地震の津波と震度は、EventID が同じでも系統が違うので別々の組
    expect(groupKey(kind('quake'), q)).toBe('20261119095800|quake')
    expect(groupKey(kind('tsunami'), t)).toBe('20261119095800|tsunami')
    expect(groupKey(kind('quake'), parseTelegram(fakeQuakeTelegram({ maxInt: '5+', eventId: '' }))!)).toBeNull()
  })

  it('文字にする: 題・発表の時刻と官署・見出し・本文の文を先に、次に電文の段の順で地域と値を電文のまま1行ずつ', () => {
    const t = parseTelegram(fakeQuakeTelegram({ maxInt: '5+' }))!
    expect(t.lines.slice(0, 4)).toEqual([
      '題: 震度速報',
      '発表: 2026-11-19 10:00（▲▲台）',
      '見出し: 作り物の地震の見出しの文です。',
      'この地震による作り物の海の変動の心配はありません。',
    ])
    const rest = t.lines.slice(4).join('\n')
    expect(rest).toContain('震源: 作り物の沖')
    expect(rest).toContain('最大震度: 5強')
    expect(rest.indexOf('作り物県: 震度5強')).toBeLessThan(rest.indexOf('作り物地方北部: 震度5強'))
    expect(rest.indexOf('作り物地方北部: 震度5強')).toBeLessThan(rest.indexOf('作り物市1: 震度4'))
    expect(rest).toContain('（電文の段の数: 府県 1・地域 1・市町村 6）')
  })

  it('大きな電文: 段ごとの数を添えて上限まで並べ、超えた分は「ほか n 地点（電文のとおり）」', () => {
    const t = parseTelegram(fakeQuakeTelegram({ maxInt: '6-', cities: JMA_PLACE_CAP + 7 }))!
    const text = t.lines.join('\n')
    expect(text).toContain(`市町村 ${JMA_PLACE_CAP + 7}`)
    expect(text).toContain('ほか 7 地点（電文のとおり。市町村）')
    expect(t.lines.filter((l) => /作り物市\d+/.test(l))).toHaveLength(JMA_PLACE_CAP)
  })

  it('津波の電文は区域ごとに種類と高さ（区域をまとめない）', () => {
    const t = parseTelegram(fakeTsunamiTelegram({ kind: '津波警報' }))!
    const text = t.lines.join('\n')
    expect(text).toContain('作り物の海岸: 津波警報・高さ １ｍ')
    expect(text).toContain('作り物の湾: 津波予報（若干の海面変動）')
  })

  it('Report でなければ読まない', () => {
    expect(parseTelegram('<html><body>作り物</body></html>')).toBeNull()
  })
})
