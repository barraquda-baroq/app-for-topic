// @vitest-environment node
// 段階2の見本の案（scripts/sample-variants.mjs → e2e/samples/variants.json）: 色の案が src/styles.test.ts と同じ決まりを満たし（■1 の全部の値が
// 5つの地で 4.5:1。ホワイトに明るめが無い）、形の案が今の画面の testid・クラスを指し、variants.json を作り直し忘れていないこと（設計: 段階2の
// 5.6。DS の scripts/sample-variants.test.mjs から、TS の問いの分だけ）
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrast, hexToOklch, lightness } from './lib/color.mjs'
import {
  ANSWERS,
  ASKED_SHAPE_CSS,
  EMPHASIS_OPTIONS,
  GROUNDS,
  QUESTIONS,
  SHAPE_CSS,
  THEMES,
  WHITE_BRIGHTER_TRIED,
  buildVariants,
  checkPick,
  checkTheme,
  emitCss,
  emitSpec,
  hexOf,
  pickTokens,
  readThemes,
  sameVariants,
  variantsJson,
  withTokens,
} from './sample-variants.mjs'

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const themes = readThemes(css)
const variants = buildVariants(css)
const variantsFile = readFileSync(new URL('../e2e/samples/variants.json', import.meta.url), 'utf8')
const looks = readFileSync(new URL('../docs/STAGE2-LOOKS.md', import.meta.url), 'utf8')

/** src/ の下の CSS（画面ごとの CSS も。形の案が使うクラスを探す） */
const SRC = new URL('../src/', import.meta.url)
const srcCss = readdirSync(SRC, { recursive: true })
  .filter((f) => String(f).endsWith('.css'))
  .map((f) => readFileSync(new URL(String(f), SRC), 'utf8'))
  .join('\n')
const testIdValues = [
  ...readFileSync(new URL('../src/features/top/testIds.ts', import.meta.url), 'utf8').matchAll(/:\s*'([a-z-]+)'/g),
].map((m) => m[1])

/** その外観の、今の --emphasis（A） */
const nowEmphasis = (t) => hexOf(themes[t], '--emphasis')

describe('src/styles.css を読む', () => {
  it('3つの外観の変数を読み、var() をたどって色にする（別名の --read-text は --text-muted の色）', () => {
    expect(THEMES.map(nowEmphasis)).toEqual(['#9a5200', '#f0a25e', '#c08050'])
    for (const t of THEMES) expect(hexOf(themes[t], '--read-text')).toBe(hexOf(themes[t], '--text-muted'))
    expect(hexOf(themes.dark, '--bg')).toBe('#101113')
  })

  it('今の値は、どの外観も決まりを満たす', () => {
    for (const t of THEMES) expect(checkTheme(t, themes[t]), t).toEqual([])
  })

  it('決まりを割る値を見つける（字の 4.5:1・強調の色相・ディープダークの強調の明るさ・差し色のグレー・線の 3:1）', () => {
    // 10. の例の #ad5d00 はホワイトの --bg の上で 4.47:1
    expect(checkTheme('white', withTokens(themes.white, { '--emphasis': '#ad5d00' })).join('\n')).toMatch(
      /--emphasis \/ --bg が 4\.47:1/,
    )
    expect(checkTheme('white', withTokens(themes.white, { '--emphasis': '#7a5a00' })).join('\n')).toMatch(/--emphasis の色相/)
    expect(checkTheme('deep-dark', withTokens(themes['deep-dark'], { '--emphasis': '#f0a25e' })).join('\n')).toMatch(
      /--emphasis が --text より明るい/,
    )
    expect(checkTheme('dark', withTokens(themes.dark, { '--accent': '#9fb4e6' })).join('\n')).toMatch(/--accent の彩度/)
    expect(checkTheme('white', withTokens(themes.white, { '--term-line': '#c8c8c2' })).join('\n')).toMatch(/--term-line \/ --bg/)
  })
})

describe('■1 強調の色の案', () => {
  /** その外観の5つの地の上での比（いちばん低い物） */
  const lowest = (t, color) => Math.min(...GROUNDS.map((g) => contrast(color, hexOf(themes[t], g))))

  it('A（今）・B（明るめ）・C（暗め）の全部の値が、5つの地の上で 4.5:1 以上（条件で地を減らさない）', () => {
    for (const t of THEMES) {
      const values = [nowEmphasis(t), EMPHASIS_OPTIONS['emphasis-brighter'][t], EMPHASIS_OPTIONS['emphasis-darker'][t]].filter(
        Boolean,
      )
      for (const v of values) expect(lowest(t, v), `${t} ${v}`).toBeGreaterThanOrEqual(4.5)
      expect(GROUNDS).toEqual(['--bg', '--surface', '--surface-2', '--surface-3', '--accent-soft'])
    }
  })

  it('ホワイトに明るめ（B）は無い（今の色が 4.5:1 を守るいちばん明るい所。一段明るい色は --accent-soft の上で落ちる）', () => {
    expect(EMPHASIS_OPTIONS['emphasis-brighter'].white).toBeUndefined()
    expect(variants.options['emphasis-brighter'].appearances).toEqual(['dark', 'deep-dark'])
    expect(variants.options['emphasis-darker'].appearances).toEqual(['white', 'dark', 'deep-dark'])
    expect(lightness(WHITE_BRIGHTER_TRIED)).toBeGreaterThan(lightness(nowEmphasis('white')))
    expect(contrast(WHITE_BRIGHTER_TRIED, hexOf(themes.white, '--accent-soft'))).toBeLessThan(4.5)
    expect(checkTheme('white', withTokens(themes.white, { '--emphasis': WHITE_BRIGHTER_TRIED }))).not.toEqual([])
  })

  it('明るめは今より明るく、暗めは今より暗い。どれもオレンジの色相（55〜65°）で、ディープダークは本文の字より暗い', () => {
    for (const t of THEMES) {
      const now = lightness(nowEmphasis(t))
      const b = EMPHASIS_OPTIONS['emphasis-brighter'][t]
      if (b) expect(lightness(b), t).toBeGreaterThan(now)
      expect(lightness(EMPHASIS_OPTIONS['emphasis-darker'][t]), t).toBeLessThan(now)
      for (const v of [b, EMPHASIS_OPTIONS['emphasis-darker'][t]].filter(Boolean)) {
        const [, c, h] = hexToOklch(v)
        expect(h, `${t} ${v}`).toBeGreaterThanOrEqual(55)
        expect(h, `${t} ${v}`).toBeLessThanOrEqual(65)
        expect(c, `${t} ${v}`).toBeGreaterThan(0.08)
      }
    }
    for (const v of [EMPHASIS_OPTIONS['emphasis-brighter']['deep-dark'], EMPHASIS_OPTIONS['emphasis-darker']['deep-dark']])
      expect(lightness(v)).toBeLessThan(lightness(hexOf(themes['deep-dark'], '--text')))
  })

  it('案の CSS は、その外観の :root[data-theme] で --emphasis だけを書き換える（ホワイトも data-theme で今の値に勝つ）', () => {
    expect(variants.options['emphasis-darker'].css).toBe(
      ":root[data-theme='white'] {\n  --emphasis: #8f4c00;\n}\n" +
        ":root[data-theme='dark'] {\n  --emphasis: #e0975a;\n}\n" +
        ":root[data-theme='deep-dark'] {\n  --emphasis: #b8773f;\n}\n",
    )
    expect(variants.options['emphasis-brighter'].css).not.toContain("data-theme='white'")
  })

  it('docs/STAGE2-LOOKS.md の ■1 の今の決め方の値は、聞いた時の値（答える前の値。まだ答えが無いので今の src/styles.css の値）', () => {
    const q1 = looks.slice(looks.indexOf('### ■1 '), looks.indexOf('### ■2 '))
    const asked = (t) => variants.asked.tokens[t]?.['--emphasis'] ?? nowEmphasis(t)
    expect(q1).toContain(`ホワイト ${asked('white')}・ダーク ${asked('dark')}・ディープダーク ${asked('deep-dark')}`)
  })
})

describe('形の案（■2・■3・■4・■12）', () => {
  it('どの問いの案も、variants.json に作り方がある（今 = now は差し込まない）。字は問いの中で重ならない', () => {
    for (const [n, q] of Object.entries(QUESTIONS)) {
      expect(new Set(q.options.map((o) => o.letter)).size, `■${n}`).toBe(q.options.length)
      expect(
        q.options.filter((o) => o.id === 'now'),
        `■${n}`,
      ).toHaveLength(1)
      for (const o of q.options.filter((x) => x.id !== 'now')) {
        expect(variants.options[o.id], o.id).toMatchObject({ question: Number(n), letter: o.letter })
      }
    }
    // 絵の無い案（■4 の D・■12 の C）は作らない。■12 はホワイトだけ
    expect(QUESTIONS[4].options.map((o) => o.letter)).toEqual(['A', 'B', 'C'])
    expect(QUESTIONS[12].options.map((o) => o.letter)).toEqual(['A', 'B'])
    expect(QUESTIONS[12].appearances).toEqual(['white'])
    expect(Object.keys(QUESTIONS).map(Number)).toEqual([1, 2, 3, 4, 12])
  })

  it('案の字と名前は docs/STAGE2-LOOKS.md の選ぶ物と同じ字（見本のページは文の名前を出す）', () => {
    for (const [n, q] of Object.entries(QUESTIONS)) {
      const section = looks.slice(looks.indexOf(`### ■${n} `), looks.indexOf('\n### ', looks.indexOf(`### ■${n} `) + 5))
      const choice = /- 選ぶ物: (.+)/.exec(section)?.[1] ?? ''
      for (const o of q.options) expect(choice, `■${n} ${o.letter}`).toMatch(new RegExp(`(^|／)\\s*${o.letter} `))
    }
  })

  it('形の案が指す testid は src/features/top/testIds.ts の物、クラスは今の画面の CSS にある物（名前が替わったら、ここで分かる）', () => {
    for (const [id, source] of Object.entries(SHAPE_CSS)) {
      const ids = [...source.matchAll(/data-testid='([a-z-]+)'/g)].map((m) => m[1])
      for (const t of ids) expect(testIdValues, `${id} の ${t}`).toContain(t)
      const selectors = source.replace(/\{[^}]*\}/g, '')
      for (const [, cls] of selectors.matchAll(/\.([a-z][\w-]*)/g))
        expect(srcCss, `${id} の .${cls}`).toMatch(new RegExp(`\\.${cls}\\b`))
      // 色は変数だけ（16進の色・rgb() を書かない）
      expect(source, id).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/)
      expect(variants.options[id].css).toBe(source)
      expect(variants.options[id].tokens).toEqual({})
    }
  })
})

describe('e2e/samples/variants.json', () => {
  it('作り直し忘れが無い（node scripts/sample-variants.mjs の出力と同じ中身）', () => {
    expect(sameVariants(variantsFile, variantsJson(css))).toBe(true)
    expect(sameVariants(null, variantsJson(css))).toBe(false)
    expect(sameVariants('{', variantsJson(css))).toBe(false)
  })

  it('答えはまだ無いので、答えた問いの下に敷く値（asked）は空', () => {
    expect(ANSWERS).toEqual({})
    expect(ASKED_SHAPE_CSS).toBe('')
    expect(variants.asked).toEqual({ questions: [], tokens: { white: {}, dark: {}, 'deep-dark': {} }, css: '' })
  })

  it('今の src/styles.css が決まりを割ると、書き出さずに止める', () => {
    const broken = css.replace('--accent-soft: #e8e8e5;', '--accent-soft: #c9c9c5;')
    expect(broken).not.toBe(css)
    expect(() => buildVariants(broken)).toThrow(/今の src\/styles\.css が決まりを満たしていません/)
  })

  it('決まりを割る案は、書き出さずに止める（ホワイトの暗めを、10. の例の #ad5d00 にした時）', () => {
    const before = EMPHASIS_OPTIONS['emphasis-darker'].white
    EMPHASIS_OPTIONS['emphasis-darker'].white = '#ad5d00'
    try {
      expect(() => buildVariants(css)).toThrow(
        /案 emphasis-darker が決まりを満たしていません:\nホワイト: --emphasis \/ --bg が 4\.47:1/,
      )
    } finally {
      EMPHASIS_OPTIONS['emphasis-darker'].white = before
    }
    expect(buildVariants(css)).toEqual(variants)
  })

  it('node scripts/sample-variants.mjs --check が通る', () => {
    const out = execFileSync(process.execPath, [new URL('./sample-variants.mjs', import.meta.url).pathname, '--check'], {
      encoding: 'utf8',
    })
    expect(out).toContain('e2e/samples/variants.json は src/styles.css と合っています')
  })
})

describe('--emit（選んだ案を書く形にする）', () => {
  const v = JSON.parse(variantsJson(css))

  it('色の案は、外観ごとに src/styles.css の行の形にする（外観を名指しできる）', () => {
    expect(emitCss(v, 'emphasis-darker@white')).toBe('/* ホワイト（:root） */\n  --emphasis: #8f4c00;\n')
    expect(emitCss(v, 'emphasis-brighter@dark,emphasis-darker@deep-dark')).toBe(
      "/* ダーク（:root[data-theme='dark']） */\n  --emphasis: #f4ad6e;\n/* ディープダーク（:root[data-theme='deep-dark']） */\n  --emphasis: #b8773f;\n",
    )
  })

  it('形の案は、部品の CSS を直す手がかりとして、差し込んだ CSS を出す', () => {
    const out = emitCss(v, 'major-badge')
    expect(out).toContain('/* ■3 B（major-badge）: 形の案')
    expect(out).toContain("[data-testid='top-card'][data-major='true']")
  })

  it('仕様書の表の行は、選んでいない外観を今の値で埋める', () => {
    expect(emitSpec(v, 'emphasis-darker@white', css)).toBe(
      '| トークン | ホワイト | ダーク | ディープダーク |\n|---|---|---|---|\n| `--emphasis` | `#8f4c00` | `#f0a25e` | `#c08050` |\n',
    )
    expect(emitSpec(v, 'term-question', css)).toBe('- ■2 B: 語の後ろに小さな「？」（形の案。term-question）\n')
  })

  it('変えない外観の名指し・知らない案・同じ値を2つの案が書き換える・同じ問いの形を2つ選ぶ、は止める', () => {
    expect(() => pickTokens(v, 'emphasis-brighter@white')).toThrow(/ホワイトを変えません/)
    expect(() => pickTokens(v, 'nothing')).toThrow(/知らない案/)
    expect(() => pickTokens(v, 'emphasis-darker@mono')).toThrow(/知らない外観/)
    expect(() => pickTokens(v, 'emphasis-brighter,emphasis-darker')).toThrow(/両方が書き換えます/)
    expect(() => pickTokens(v, 'major-badge,major-bigger')).toThrow(/■3 の形の案を2つ/)
    expect(pickTokens(v, 'emphasis-brighter@dark,emphasis-darker@white')).toEqual({
      white: { '--emphasis': '#8f4c00' },
      dark: { '--emphasis': '#f4ad6e' },
      'deep-dark': {},
    })
  })

  it('選んだ案を合わせても決まりを満たす（組み合わせの確かめ）', () => {
    expect(checkPick(v, 'emphasis-brighter@dark+deep-dark,emphasis-darker@white,major-bigger,sync-text', css)).toEqual([])
  })
})
