// 出典の表示（段階3の設計の 3.4。docs/SPEC.md の 5.10）: 5つの形ごとの文・題と URL と著者が入る・著者の無い cc-by は著者の括弧ごと書かない・
// credit の無い社と一覧に無い社は null・加工した主体（CREDIT_PROCESSOR）が入る・作者の名前の欄が無い・cc-by の社の話題だけ詳細の頭の1行がある。
// 社は作り物の一覧（src/test/fixtures/fakeOutlets.ts）、URL は https://example.com/… だけ
import { describe, expect, it } from 'vitest'
import { FAKE_CREDIT_OUTLETS, FAKE_OUTLETS, FAKE_UNLISTED_OUTLET } from '../test/fixtures/fakeOutlets'
import {
  CC_BY_3_NAME,
  CC_BY_3_URL,
  CREDIT_PROCESSOR,
  creditHeadText,
  creditText,
  PDL_V1_NAME,
  PDL_V1_URL,
  type CreditSource,
} from './credit'
import { DEFAULT_OUTLET_LIST, DEFAULT_OUTLETS } from './outlets'

const URL_A = 'https://example.com/press/1'
const src = (outlet: string, extra: Partial<CreditSource> = {}): CreditSource => ({
  outlet,
  title: '作り物の発表の題',
  url: URL_A,
  ...extra,
})
const P = CREDIT_PROCESSOR

describe('出典の表示の文（creditText）', () => {
  it('site: 出典：{サイトの名前}（{url}）を加工して作成（加工: {主体}）', () => {
    expect(creditText(src(FAKE_CREDIT_OUTLETS.site), FAKE_OUTLETS)).toBe(
      `出典：〇〇省ホームページ（${URL_A}）を加工して作成（加工: ${P}）`,
    )
    // 別名で書いた社でも同じ
    expect(creditText(src('〇〇省ホームページ'), FAKE_OUTLETS)).toBe(creditText(src(FAKE_CREDIT_OUTLETS.site), FAKE_OUTLETS))
  })

  it('title: 出典：「{題}」（{組織}）（{url}）を加工して作成（加工: {主体}）', () => {
    expect(creditText(src(FAKE_CREDIT_OUTLETS.title), FAKE_OUTLETS)).toBe(
      `出典：「作り物の発表の題」（△△庁）（${URL_A}）を加工して作成（加工: ${P}）`,
    )
  })

  it('pdl: 出典：{サイトの名前}（{url}）、PDL1.0（{PDL1.0 の URL}）を加工して作成（加工: {主体}）', () => {
    expect(creditText(src(FAKE_CREDIT_OUTLETS.pdl), FAKE_OUTLETS)).toBe(
      `出典：▽▽府ホームページ（${URL_A}）、${PDL_V1_NAME}（${PDL_V1_URL}）を加工して作成（加工: ${P}）`,
    )
  })

  it('jma: 出典が気象庁ホームページである事・加工した事・編集の責任が加工した側にある事', () => {
    expect(creditText(src(FAKE_CREDIT_OUTLETS.jma), FAKE_OUTLETS)).toBe(
      `出典：気象庁ホームページ（${URL_A}）を加工して作成（加工: ${P}。編集の責任は ${P}にあります）`,
    )
  })

  it('cc-by: 社・題・著者・元記事・ライセンスとその URL・要約と翻訳をした事', () => {
    expect(creditText(src(FAKE_CREDIT_OUTLETS.ccBy, { author: 'FAKE_作り物の著者' }), FAKE_OUTLETS)).toBe(
      `出典：□□ボイス「作り物の発表の題」（著者: FAKE_作り物の著者）（${URL_A}）、${CC_BY_3_NAME}（${CC_BY_3_URL}）。${P}が要約・翻訳した`,
    )
  })

  it('cc-by で著者が無い時は「著者: 不明」と書かず、著者の括弧ごと書かない（空白だけ・null も同じ）', () => {
    const want = `出典：□□ボイス「作り物の発表の題」（${URL_A}）、${CC_BY_3_NAME}（${CC_BY_3_URL}）。${P}が要約・翻訳した`
    for (const author of [undefined, null, '', '  ']) {
      const text = creditText(src(FAKE_CREDIT_OUTLETS.ccBy, { author }), FAKE_OUTLETS)
      expect(text).toBe(want)
      expect(text).not.toContain('著者')
    }
  })

  it('credit の無い社・一覧に無い社は null（出典の表示なし。画面は今のまま URL の行）', () => {
    expect(creditText(src('〇〇通信'), FAKE_OUTLETS)).toBeNull()
    expect(creditText(src(FAKE_UNLISTED_OUTLET, { via: '××ニュース' }), FAKE_OUTLETS)).toBeNull()
    // ふだんの一覧には作り物の社が無い
    expect(creditText(src(FAKE_CREDIT_OUTLETS.site))).toBeNull()
  })

  it('どの形の文にも加工した主体が入り、作者の名前の欄が無い（主体はアプリの名前と、AI が要約した事だけ）', () => {
    expect(P).toBe('Topic Studio（AI による要約）')
    for (const name of Object.values(FAKE_CREDIT_OUTLETS)) {
      const text = creditText(src(name, { author: 'FAKE_著者' }), FAKE_OUTLETS)
      expect([name, text?.includes(P)]).toEqual([name, true])
      expect(text).not.toMatch(/作者|\{|\}|undefined|null/)
    }
  })
})

describe('ふだんの一覧の出典の表示', () => {
  it('8つとも文が作れ、出典の URL が入る（府省・庁は「加工して作成」、Global Voices は CC BY 3.0）', () => {
    for (const o of DEFAULT_OUTLET_LIST.outlets) {
      const url = `https://${o.hosts[0]}/`
      const text = creditText({ outlet: o.name, title: '題', url, author: 'FAKE_著者' }, DEFAULT_OUTLETS)
      expect([o.name, text?.includes(`（${url}）`)]).toEqual([o.name, true])
      if (o.credit?.form === 'cc-by') expect(text).toContain(`${CC_BY_3_NAME}（${CC_BY_3_URL}）`)
      else expect(text).toContain('を加工して作成（加工: ')
    }
  })

  it('Global Voices の credit のライセンスは CC BY 3.0 の定数と同じ（outlets.ts と credit.ts で値を2つ持つので）', () => {
    const gv = DEFAULT_OUTLET_LIST.outlets.find((o) => o.credit?.form === 'cc-by')
    expect(gv?.credit).toEqual({ form: 'cc-by', license: CC_BY_3_NAME, licenseUrl: CC_BY_3_URL })
  })

  it('内閣府は PDL1.0 の既定の形で、名前は「内閣府ホームページ」', () => {
    const text = creditText({ outlet: '内閣府', title: '題', url: 'https://www.cao.go.jp/' })
    expect(text).toBe(
      `出典：内閣府ホームページ（https://www.cao.go.jp/）、${PDL_V1_NAME}（${PDL_V1_URL}）を加工して作成（加工: ${P}）`,
    )
  })
})

describe('詳細の頭の1行（creditHeadText）', () => {
  it('cc-by の社を出典に持つ話題だけ、元記事と著者の1行とリンクを返す', () => {
    const head = creditHeadText(
      [src(FAKE_CREDIT_OUTLETS.site), src(FAKE_CREDIT_OUTLETS.ccBy, { title: '作り物の記事', author: 'FAKE_著者' })],
      FAKE_OUTLETS,
    )
    expect(head).toEqual({
      text: `この話題は、□□ボイス「作り物の記事」（著者: FAKE_著者）を元に、${P}が要約・翻訳しました`,
      links: [{ outlet: '□□ボイス', title: '作り物の記事', url: URL_A, author: 'FAKE_著者', link: URL_A }],
    })
  })

  it('cc-by の出典が2本なら1行に並べる。著者の無い出典は著者の括弧を書かない', () => {
    const head = creditHeadText(
      [
        src(FAKE_CREDIT_OUTLETS.ccBy, { title: '記事1', author: 'FAKE_甲' }),
        src(FAKE_CREDIT_OUTLETS.ccBy, { title: '記事2', url: 'https://example.com/press/2' }),
      ],
      FAKE_OUTLETS,
    )
    expect(head?.text).toBe(`この話題は、□□ボイス「記事1」（著者: FAKE_甲）・□□ボイス「記事2」を元に、${P}が要約・翻訳しました`)
    expect(head?.links.map((l) => l.link)).toEqual([URL_A, 'https://example.com/press/2'])
  })

  it('府省・庁だけの話題・credit の無い社だけの話題は null', () => {
    expect(creditHeadText([src(FAKE_CREDIT_OUTLETS.site), src(FAKE_CREDIT_OUTLETS.jma)], FAKE_OUTLETS)).toBeNull()
    expect(creditHeadText([src('〇〇通信')], FAKE_OUTLETS)).toBeNull()
    expect(creditHeadText([], FAKE_OUTLETS)).toBeNull()
  })

  it('リンクにできない URL（社のホストでない・https: でない）は link が null', () => {
    const head = creditHeadText(
      [src(FAKE_CREDIT_OUTLETS.ccBy, { url: 'http://example.com/a', author: 'FAKE_著者' })],
      FAKE_OUTLETS,
    )
    expect(head?.links[0].link).toBeNull()
  })
})
