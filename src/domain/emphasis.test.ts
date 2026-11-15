// 強調（D24。docs/SPEC.md の 7.1 の「強調」・5.12・16.3）: コネクタの確かめ（断る物と知らせる物を分けて返す）、アプリの直し（捨てて出す・
// 受け取った記録は変えない・全体の60を超えた分は EMPHASIS_PATHS の順で後ろを捨てる・番号を詰めない）、画面用の区切り
import { describe, expect, it } from 'vitest'
import { makeSampleTopic, SAMPLE_SUMMARY } from '../test/fixtures/sampleTopic'
import {
  checkEmphasis,
  EMPHASIS_PATHS,
  emphasisFields,
  emphasisFieldText,
  firstOccurrence,
  overEmphasisRatio,
  parseEmphasisKey,
  repairEmphasis,
  splitEmphasis,
  type EmphasisErrorCode,
  type EmphasisWarningCode,
} from './emphasis'
import type { Emphasis, Topic } from './types'

/** 強調だけを替えた話題（強調の確かめは id を見ないので、id は作り直さない） */
const withEmphasis = (emphasis: unknown, edit?: (t: Topic) => void): Topic => {
  const t = makeSampleTopic(edit)
  return { ...t, emphasis: emphasis as Emphasis }
}
const errorCodes = (t: unknown): EmphasisErrorCode[] => checkEmphasis(t).errors.map((e) => e.code)
const warningCodes = (t: unknown): EmphasisWarningCode[] => checkEmphasis(t).warnings.map((w) => w.code)
const base = makeSampleTopic()

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x)
    Object.freeze(v)
  }
  return v
}

/** 経緯 rows 行・当事者 people 人の話題（どの欄にも重ならない語句が3つずつある） */
function bigTopic(rows: number, people: number): Topic {
  return makeSampleTopic((t) => {
    t.timeline = Array.from({ length: rows }, (_, i) => ({ when: null, text: `一つ目${i}、二つ目${i}、三つ目${i}` }))
    t.stakeholders = Array.from({ length: people }, (_, i) => ({
      name: `当事者${i}`,
      stance: 'for' as const,
      stanceNote: null,
      claim: `甲の${i}番、乙の${i}番、丙の${i}番`,
      reason: null,
    }))
    t.view = { kind: 'none', noneReason: null }
  })
}
const three = (prefix: string[], i: number) => prefix.map((p) => `${p}${i}`)

describe('欄の道（EMPHASIS_PATHS）', () => {
  it('7.1 の表の順', () => {
    expect(EMPHASIS_PATHS).toEqual([
      'summary',
      'conclusion.note',
      'soWhat.life',
      'soWhat.system',
      'soWhat.world',
      'soWhat.whyNews',
      'stakeholders.{i}.claim',
      'view.aiView',
      'view.counterView',
      'timeline.{i}.text',
      'followUp.whatsNew',
    ])
  })

  it('鍵を読む（番号は 0 か、0 で始まらない数だけ）', () => {
    expect(parseEmphasisKey('summary')).toMatchObject({ path: 'summary', index: null, rank: 0 })
    expect(parseEmphasisKey('stakeholders.0.claim')).toMatchObject({ path: 'stakeholders.{i}.claim', index: 0 })
    expect(parseEmphasisKey('timeline.11.text')).toMatchObject({ path: 'timeline.{i}.text', index: 11 })
    for (const ng of [
      'stakeholders.01.claim',
      'timeline.-1.text',
      'stakeholders.0.text',
      'timeline.0.claim',
      'headline',
      'view',
      'soWhat',
    ])
      expect(parseEmphasisKey(ng)).toBeNull()
  })

  it('欄の文を引く（無い欄・null の欄・並びの外・対立見解なし・続報でない話題は null）', () => {
    expect(emphasisFieldText(base, 'summary')).toBe(SAMPLE_SUMMARY)
    expect(emphasisFieldText(base, 'soWhat.world')).toBeNull()
    expect(emphasisFieldText(base, 'stakeholders.1.claim')).toBe('維持費のために少額の通行料を取るべきだと主張している。')
    expect(emphasisFieldText(base, 'stakeholders.2.claim')).toBeNull()
    expect(emphasisFieldText(base, 'stakeholders.3.claim')).toBeNull()
    expect(emphasisFieldText(base, 'timeline.2.text')).toBe('その後、市が通行料の案を示す予定')
    expect(emphasisFieldText(base, 'followUp.whatsNew')).toBeNull()
    expect(emphasisFieldText({ ...base, view: { kind: 'none', noneReason: null } }, 'view.aiView')).toBeNull()
    expect(emphasisFieldText(null, 'summary')).toBeNull()
    expect(emphasisFields(base).map((f) => f.key.key)).toEqual([
      'summary',
      'conclusion.note',
      'soWhat.life',
      'soWhat.system',
      'soWhat.whyNews',
      'stakeholders.0.claim',
      'stakeholders.1.claim',
      'view.aiView',
      'view.counterView',
      'timeline.0.text',
      'timeline.1.text',
      'timeline.2.text',
    ])
  })

  it('最初に出る所と重なり', () => {
    expect(firstOccurrence('橋が開通、また橋が開通', '橋が開通')).toEqual({ start: 0, end: 4 })
    expect(firstOccurrence('橋が開通', '道')).toBeNull()
  })
})

describe('コネクタの確かめ: 断る物（errors）', () => {
  it('作り物の話題は断る物も知らせる物も無い', () => {
    expect(checkEmphasis(base)).toEqual({ errors: [], warnings: [] })
  })

  it('知らない鍵・01 の番号', () => {
    for (const key of [
      'headline',
      'soWhat.foo',
      'stakeholders.0.name',
      'rankReason',
      'stakeholders.01.claim',
      'timeline.01.text',
    ])
      expect(errorCodes(withEmphasis({ ...base.emphasis, [key]: ['15日に開通'] }))).toEqual(['unknown-key'])
  })

  it('無い欄・null の欄の鍵（null の観点・並びの外の番号・主張が null の当事者・対立見解なし・続報でない）', () => {
    for (const key of ['soWhat.world', 'stakeholders.3.claim', 'stakeholders.2.claim', 'timeline.3.text', 'followUp.whatsNew'])
      expect(errorCodes(withEmphasis({ ...base.emphasis, [key]: ['開通'] }))).toEqual(['no-field'])
    const none = withEmphasis(
      { summary: ['15日に開通'], 'view.aiView': ['人が戻る効果'], 'view.counterView': ['住宅地へ移る'] },
      (t) => {
        t.view = { kind: 'none', noneReason: null }
      },
    )
    expect(errorCodes(none)).toEqual(['no-field', 'no-field'])
  })

  it('欄に無い語句・1字違いの語句（文字をそろえずに比べる）', () => {
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: ['存在しない語句'] }))).toEqual(['not-found'])
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: ['15日の開通'] }))).toEqual(['not-found'])
    // 全角の数字は半角と別の文字
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: ['１５日に開通'] }))).toEqual(['not-found'])
    const e = checkEmphasis(withEmphasis({ ...base.emphasis, summary: ['15日の開通'] })).errors[0]
    expect(e).toMatchObject({ key: 'summary', phrase: '15日の開通' })
    expect(e.message).toContain('summary')
    expect(e.message).toContain('15日の開通')
  })

  it('1字と41字は断る（2字・40字は通る）', () => {
    const s40 = SAMPLE_SUMMARY.slice(0, 40)
    const s41 = SAMPLE_SUMMARY.slice(0, 41)
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: ['橋'] }))).toEqual(['length'])
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: [s41] }))).toEqual(['length'])
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: ['開通'] }))).toEqual([])
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: [s40] }))).toEqual([])
  })

  it('1つの欄に4つは断る（3つは通る）', () => {
    const p = ['15日に開通', '320メートル', '通行料はまだ決まっていない', '来年3月まで']
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: p }))).toEqual(['too-many-in-field'])
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: p.slice(0, 3) }))).toEqual([])
  })

  it('全体で61は断る（60は通る）', () => {
    const t = bigTopic(12, 8)
    const emphasis: Emphasis = {}
    for (let i = 0; i < 12; i++) emphasis[`timeline.${i}.text`] = three(['一つ目', '二つ目', '三つ目'], i)
    for (let i = 0; i < 8; i++) emphasis[`stakeholders.${i}.claim`] = three(['甲の', '乙の', '丙の'], i).map((s) => `${s}番`)
    expect(errorCodes({ ...t, emphasis })).toEqual([])
    expect(errorCodes({ ...t, emphasis: { ...emphasis, summary: ['15日に開通'] } })).toEqual(['too-many'])
  })

  it('空の並び・並びでない値・文字でない値', () => {
    expect(errorCodes(withEmphasis({ ...base.emphasis, 'soWhat.system': [] }))).toEqual(['empty'])
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: '15日に開通' }))).toEqual(['not-array'])
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: ['15日に開通', 3] }))).toEqual(['not-string'])
    expect(errorCodes(withEmphasis(['summary']))).toEqual(['not-object'])
  })

  it('重なる語句・同じ語句2つ', () => {
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: ['15日に開通', '日に開通し'] }))).toEqual(['overlap'])
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: ['15日に開通', '15日に開通'] }))).toEqual(['overlap'])
    // 隣り合うだけなら重ならない
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: ['15日に', '開通し'] }))).toEqual([])
  })

  it('AI の見解と対立見解で数が違う（片方だけに付けた時も。どちらにも付けないのはよい）', () => {
    const { 'view.aiView': _a, 'view.counterView': _c, ...rest } = base.emphasis
    expect(
      errorCodes(withEmphasis({ ...rest, 'view.aiView': ['人が戻る効果'], 'view.counterView': ['住宅地へ移る', 'おそれも'] })),
    ).toEqual(['view-count'])
    expect(errorCodes(withEmphasis({ ...rest, 'view.aiView': ['人が戻る効果'] }))).toEqual(['view-count'])
    expect(errorCodes(withEmphasis({ ...rest, 'view.counterView': ['住宅地へ移る'] }))).toEqual(['view-count'])
    expect(errorCodes(withEmphasis(rest))).toEqual([])
  })

  it('前後に空白・改行のある語句', () => {
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: [' 15日に開通'] }))).toEqual(['spaces'])
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: ['15日に開通\n'] }))).toEqual(['spaces'])
    expect(errorCodes(withEmphasis({ ...base.emphasis, summary: ['15日に開通　'] }))).toEqual(['spaces'])
  })
})

describe('コネクタの確かめ: 知らせる物（warnings。断らない）', () => {
  it('欄の字数の2割を超える（5.12 の例: 要約 126字に 31字）', () => {
    const t = withEmphasis({ ...base.emphasis, summary: ['15日に開通', '通行料はまだ決まっていない', '渋滞が2割ほど減る見通し'] })
    expect(checkEmphasis(t).errors).toEqual([])
    expect(warningCodes(t)).toEqual(['over-ratio'])
    // 5.12 の例の 2か所・19字は知らせない
    expect(warningCodes(base)).toEqual([])
    expect(overEmphasisRatio(25, 126)).toBe(false)
    expect(overEmphasisRatio(26, 126)).toBe(true)
    expect(overEmphasisRatio(25, 125)).toBe(false)
  })

  it('短い欄は12字を超えたら（16字の続報の「何が新しいか」に9字・12字なら知らせない、13字なら知らせる）', () => {
    const follow = (phrase: string) =>
      withEmphasis({ ...base.emphasis, 'followUp.whatsNew': [phrase] }, (t) => {
        t.followUp = { prevTopicId: '2026-11-14-12-aaaaaaaa', whatsNew: '市が開通後1日の交通量を発表した' }
      })
    expect(emphasisFieldText(follow('x'), 'followUp.whatsNew')).toHaveLength(16)
    expect(warningCodes(follow('1日の交通量を発表'))).toEqual([])
    expect(warningCodes(follow('後1日の交通量を発表した'))).toEqual([])
    expect(warningCodes(follow('通後1日の交通量を発表した'))).toEqual(['over-ratio'])
    expect(checkEmphasis(follow('通後1日の交通量を発表した')).errors).toEqual([])
  })

  it('主張のある当事者で数がそろわない（主張が null の当事者は数えない）', () => {
    const { 'stakeholders.1.claim': _s, ...rest } = base.emphasis
    expect(warningCodes(withEmphasis(rest))).toEqual(['stakeholder-count'])
    expect(checkEmphasis(withEmphasis(rest)).errors).toEqual([])
    const { 'stakeholders.0.claim': _t, ...none } = rest
    expect(warningCodes(withEmphasis(none))).toEqual([])
  })

  it('要約に強調が無い（入力の emphasis を省いた時も）', () => {
    const { summary: _s, ...rest } = base.emphasis
    expect(warningCodes(withEmphasis(rest))).toEqual(['summary-missing'])
    expect(checkEmphasis(withEmphasis(undefined))).toEqual({
      errors: [],
      warnings: [{ code: 'summary-missing', key: 'summary', message: '要約に強調がありません' }],
    })
    expect(warningCodes(withEmphasis({}))).toEqual(['summary-missing'])
  })
})

describe('アプリの直し（repairEmphasis。捨てて出す）', () => {
  it('合う物はそのまま', () => {
    expect(repairEmphasis(base)).toEqual(base.emphasis)
  })

  it('合わない語句と鍵を捨てても、受け取った記録は変えない', () => {
    const raw = deepFreeze(
      withEmphasis({
        summary: [
          '15日に開通',
          '15日に開通',
          '日に開通し',
          '存在しない',
          ' 通行料',
          '橋',
          SAMPLE_SUMMARY.slice(0, 41),
          5,
          '通行料はまだ決まっていない',
        ],
        headline: ['新しい橋'],
        'soWhat.world': ['世界'],
        'stakeholders.01.claim': ['通行料は無料'],
        'stakeholders.2.claim': ['確かめられなかった'],
        'soWhat.system': [],
        'conclusion.note': '開通は確定',
        'timeline.0.text': ['建設', '橋の建設', '新しい橋', '始まった', 'が始ま'],
      }),
    )
    const before = structuredClone(raw)
    expect(repairEmphasis(raw)).toEqual({
      summary: ['15日に開通', '通行料はまだ決まっていない'],
      'timeline.0.text': ['建設', '新しい橋', '始まった'],
    })
    expect(raw).toEqual(before)
  })

  it('1つの欄は、ほかの訳で捨てた後に数えて4つ目から捨てる', () => {
    const t = withEmphasis({ summary: ['存在しない', '15日に開通', '320メートル', '通行料はまだ決まっていない', '来年3月まで'] })
    expect(repairEmphasis(t).summary).toEqual(['15日に開通', '320メートル', '通行料はまだ決まっていない'])
  })

  it('全体の60を超えた分は EMPHASIS_PATHS の順（同じ道の中は番号の順）で後ろを捨てる', () => {
    const t = bigTopic(12, 10)
    const emphasis: Emphasis = {}
    // 鍵の書き順は問わない（経緯を先に、当事者を後ろから書く）
    for (let i = 0; i < 12; i++) emphasis[`timeline.${i}.text`] = three(['一つ目', '二つ目', '三つ目'], i)
    for (let i = 9; i >= 0; i--) emphasis[`stakeholders.${i}.claim`] = three(['甲の', '乙の', '丙の'], i).map((s) => `${s}番`)
    emphasis.summary = ['存在しない', '15日に開通', '320メートル', '通行料はまだ決まっていない']
    const out = repairEmphasis({ ...t, emphasis })
    expect(Object.values(out).flat()).toHaveLength(60)
    // 要約 3 ＋ 当事者 30 ＋ 経緯 27（9行）
    expect(out.summary).toHaveLength(3)
    expect(Object.keys(out).filter((k) => k.startsWith('stakeholders.'))).toHaveLength(10)
    expect(out['timeline.8.text']).toHaveLength(3)
    expect(out['timeline.9.text']).toBeUndefined()
    expect(out['timeline.11.text']).toBeUndefined()
    expect(Object.keys(out)[0]).toBe('summary')
    // 60 の境が欄の途中に来る時は、欄の中の並びの順で残す
    const cut = repairEmphasis({ ...t, emphasis: { ...emphasis, 'conclusion.note': ['開通は確定'] } })
    expect(cut['timeline.8.text']).toEqual(['一つ目8', '二つ目8'])
  })

  it('壊れた当事者・経緯の行があっても、鍵の番号は受け取った記録の並びの番号で解く（詰めない）', () => {
    const t = withEmphasis(
      { summary: ['15日に開通'], 'stakeholders.1.claim': ['少額の通行料を取るべき'], 'timeline.2.text': ['通行料の案を示す'] },
      (x) => {
        ;(x.stakeholders as unknown[])[0] = 'こわれた当事者'
        ;(x.timeline as unknown[])[1] = null
      },
    )
    expect(repairEmphasis(t)).toEqual({
      summary: ['15日に開通'],
      'stakeholders.1.claim': ['少額の通行料を取るべき'],
      'timeline.2.text': ['通行料の案を示す'],
    })
  })

  it('用語の印と重なってよい（用語「通行料」を含む語句も残す）', () => {
    expect(base.terms.some((t) => t.term === '通行料')).toBe(true)
    expect(repairEmphasis(base).summary).toContain('通行料はまだ決まっていない')
  })

  it('emphasis が無い・形が違う時は {}', () => {
    expect(repairEmphasis(withEmphasis(undefined))).toEqual({})
    expect(repairEmphasis(withEmphasis(null))).toEqual({})
    expect(repairEmphasis(withEmphasis(['summary']))).toEqual({})
    expect(repairEmphasis(null, { summary: ['15日に開通'] })).toEqual({})
  })
})

describe('画面用の区切り（splitEmphasis）', () => {
  it('最初に出る所に付け（同じ語句が2回なら最初の方）、つなぐと元の文になる', () => {
    const text = '橋が開通、また橋が開通した'
    expect(splitEmphasis(text, ['橋が開通'])).toEqual([
      { text: '橋が開通', strong: true },
      { text: '、また橋が開通した', strong: false },
    ])
    const segs = splitEmphasis(SAMPLE_SUMMARY, base.emphasis.summary)
    expect(segs.map((s) => s.text).join('')).toBe(SAMPLE_SUMMARY)
    expect(segs.filter((s) => s.strong).map((s) => s.text)).toEqual(['15日に開通', '通行料はまだ決まっていない'])
  })

  it('並びの順でなく文の順に並べ、見つからない・重なる語句は付けない', () => {
    expect(splitEmphasis('甲と乙と丙', ['丙', '甲', '無い', '甲と'])).toEqual([
      { text: '甲', strong: true },
      { text: 'と乙と', strong: false },
      { text: '丙', strong: true },
    ])
    expect(splitEmphasis('甲と乙')).toEqual([{ text: '甲と乙', strong: false }])
    expect(splitEmphasis('')).toEqual([])
  })
})
