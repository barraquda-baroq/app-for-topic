// 色のトークン（src/styles.css）が DS と同じ値か、字の色が地の上で読めるか、差し色とログインの画面の地がグレーか、DS だけの色を
// 持ち込んでいないか、部品が色を直接書いていないか、幅の区分の値がスクリプトとそろっているかを確かめる（docs/SPEC.md の 10.・14.3。
// DS の src/styles.test.ts から、区分・ラベル・カレンダーの色の確かめを外した物）。
// 段階2で、TS だけの色（本文の強調 --emphasis・用語の印・重大印・既読の別名）と記事の字の大きさの確かめを足した（設計: 段階2の 3.3）。
// 画面の CSS の書き方（--emphasis を使う所・testid の印を選ばない）は src/screensCss.test.ts
import { describe, expect, it } from 'vitest'
import { WIDTH_L, WIDTH_M } from './ui/hooks'

// テストでは CSS を import すると（?raw でも）中身が空になるので、ファイルを読む。node:fs の型はアプリの tsconfig に無いので、
// 名前を変数にして読み込み、使う関数の形だけを書く
const NODE_FS = 'node:fs'
const { readFileSync, readdirSync } = (await import(/* @vite-ignore */ NODE_FS)) as {
  readFileSync: (path: string, encoding: 'utf8') => string
  readdirSync: (path: string, options: { recursive: true }) => string[]
}
// jsdom の URL は node:fs が受け取らないので、ファイルの場所の文字列にして渡す
const read = (relative: string) => readFileSync(decodeURIComponent(new URL(relative, import.meta.url).pathname), 'utf8')
const css = read('./styles.css')
const loginCss = read('./features/login/login.css')
/** src/ の下のすべての CSS（画面ごとの CSS も。[src/ からの場所, 中身]）。段階2以降で画面の CSS が増えても確かめから漏れないように */
// （new URL('.', import.meta.url) は Vite が開発サーバーの URL に書き換えるので、import.meta.url のファイルの場所から作る）
const SRC_DIR = decodeURIComponent(new URL(import.meta.url).pathname).replace(/[^/]*$/, '')
const ALL_CSS: readonly (readonly [string, string])[] = readdirSync(SRC_DIR, { recursive: true })
  .filter((f) => f.endsWith('.css'))
  .sort()
  .map((f) => [f, readFileSync(`${SRC_DIR}${f}`, 'utf8')] as const)

/** DS の docs/SPEC.md の 4.5 の表のうち、TS が使うトークン（トークン: [ホワイト, ダーク, ディープダーク]。値は DS と同じ） */
const SPEC_TOKENS: Record<string, readonly [string, string, string]> = {
  '--bg': ['#f6f6f4', '#101113', '#08090a'],
  '--surface': ['#ffffff', '#17181b', '#0e0f11'],
  '--surface-2': ['#fafaf9', '#1c1d21', '#121315'],
  '--surface-3': ['#efefec', '#25272c', '#191a1d'],
  '--rule': ['#dcdcd7', '#2a2c31', '#1e1f23'],
  '--border': ['#e0e0dc', '#2e3036', '#202125'],
  '--border-strong': ['#c8c8c2', '#43464e', '#2d2f33'],
  '--text': ['#25282e', '#e6e5e1', '#aeaca6'],
  '--text-muted': ['#5c6068', '#a8aab0', '#8a8984'],
  '--text-faint': ['#62666e', '#90939a', '#858480'],
  // 差し色（グレーの濃淡。作者の指摘で青から替えた）
  '--accent': ['#4f5259', '#bcbdc1', '#9b9993'],
  '--accent-strong': ['#373a40', '#dcdcd9', '#b5b3ad'],
  '--accent-soft': ['#e8e8e5', '#222428', '#17181b'],
  '--on-accent': ['#ffffff', '#121316', '#0b0c0d'],
  '--primary': ['#4f5259', '#4b4e55', '#2a2b2e'],
  '--primary-hover': ['#3e4146', '#565960', '#323337'],
  '--primary-border': ['var(--primary)', 'var(--primary)', '#45464a'],
  '--on-primary': ['#ffffff', '#f1f0ec', '#bab8b2'],
  '--switch-on': ['var(--accent)', '#8b8e95', '#616266'],
  // ログインの画面（外観ごとのグレーの地。作者の指摘で表紙の青から替えた）
  '--cover': ['#e0e0dd', '#2a2b2f', '#161719'],
  '--on-cover': ['#25282e', '#e6e5e1', '#aeaca6'],
  '--cover-border': ['#73767d', '#7b7e85', '#68696c'],
  '--danger': ['#b0402d', '#f08a77', '#b98a82'],
  '--danger-soft': ['#f8e6e2', '#331d19', '#1c1412'],
  '--toast-bg': ['#2b2f38', '#2a2c31', '#141518'],
  '--toast-text': ['#ffffff', '#e6e4de', '#aeaca6'],
  '--backdrop': ['rgb(15 17 22 / 45%)', 'rgb(0 0 0 / 62%)', 'rgb(0 0 0 / 70%)'],
  '--selection': ['#d6d7d9', '#43464d', '#2c2d30'],
  '--brand-filter': ['none', 'brightness(0.95)', 'grayscale(0.85) brightness(0.6)'],
}

const THEMES = ['white', 'dark', 'deep-dark'] as const
type Theme = (typeof THEMES)[number]
const SELECTORS: Record<Theme, string> = {
  white: ':root',
  dark: ":root[data-theme='dark']",
  'deep-dark': ":root[data-theme='deep-dark']",
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** いちばん外側の規則（@media の中は含めない）を、セレクタと中身の組にする */
function topLevelRules(source: string): { selector: string; body: string }[] {
  const src = stripComments(source)
  const rules: { selector: string; body: string }[] = []
  let depth = 0
  let selStart = 0
  let bodyStart = 0
  let selector = ''
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') {
      if (depth === 0) {
        selector = src.slice(selStart, i).trim()
        bodyStart = i + 1
      }
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        rules.push({ selector, body: src.slice(bodyStart, i) })
        selStart = i + 1
      }
    }
  }
  return rules
}

function declarations(body: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of body.split(';')) {
    const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(part)
    if (m) map.set(m[1], m[2].replace(/\s+/g, ' '))
  }
  return map
}

const rules = topLevelRules(css)

/** 外観ごとに、その外観で効く変数の値（ホワイトの :root に、ダーク・ディープダークの規則を重ねた物） */
function themeVars(theme: Theme): Map<string, string> {
  const base = new Map<string, string>()
  for (const r of rules.filter((r) => r.selector === ':root')) for (const [k, v] of declarations(r.body)) base.set(k, v)
  if (theme === 'white') return base
  const own = rules.filter((r) => r.selector === SELECTORS[theme])
  expect(own, `${theme} の規則`).toHaveLength(1)
  for (const [k, v] of declarations(own[0].body)) base.set(k, v)
  return base
}

/** その外観の、その規則だけに書いた値（ホワイトは :root、ほかは :root[data-theme=…]） */
function ownVars(theme: Theme): Map<string, string> {
  const map = new Map<string, string>()
  for (const r of rules.filter((r) => r.selector === SELECTORS[theme])) for (const [k, v] of declarations(r.body)) map.set(k, v)
  return map
}

const VARS = Object.fromEntries(THEMES.map((t) => [t, themeVars(t)])) as Record<Theme, Map<string, string>>

/** var(--x) をたどって 16 進の色にする */
function color(theme: Theme, name: string): string {
  let v = VARS[theme].get(name)
  for (let i = 0; i < 10 && v; i++) {
    const m = /^var\((--[\w-]+)\)$/.exec(v)
    if (!m) break
    v = VARS[theme].get(m[1])
  }
  expect(v, `${theme} の ${name}`).toMatch(/^#[0-9a-f]{6}$/)
  return v as string
}

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** WCAG のコントラスト比 */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map(linear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
describe('色のトークン（DS の docs/SPEC.md の 4.5 と同じ値）', () => {
  it.each(THEMES.map((t, i) => [t, i] as const))('%s: 表のトークンを、その外観の規則に表の値どおりに書いている', (theme, i) => {
    const own = ownVars(theme)
    for (const [name, values] of Object.entries(SPEC_TOKENS)) {
      expect(own.get(name), `${theme} の ${name}`).toBe(values[i])
    }
  })

  it('NS の緑の --active* は、差し色のグレーに置き換えている', () => {
    for (const theme of THEMES) {
      expect(VARS[theme].get('--active')).toBe('var(--accent)')
      expect(VARS[theme].get('--active-soft')).toBe('var(--accent-soft)')
      expect(VARS[theme].get('--active-fill')).toBe('var(--primary)')
      expect(VARS[theme].get('--on-active')).toBe('var(--on-primary)')
    }
  })

  it('NS から持ってくる変数（4.5 の表に無い物）が3つの外観にある', () => {
    for (const theme of THEMES) {
      const own = ownVars(theme)
      for (const name of [
        '--segmented-on',
        '--switch-knob',
        '--warn',
        '--warn-soft',
        '--toast-border',
        '--toast-error-bg',
        '--toast-error-text',
        '--shadow',
        '--shadow-sm',
        '--shadow-lg',
      ]) {
        expect(own.has(name), `${theme} の ${name}`).toBe(true)
      }
    }
  })

  it('NS の小説の機能の色・原稿の書体・アプリのキーボードの変数と、DS の区分・ラベル・カレンダーの色を持ち込んでいない', () => {
    for (const [name, source] of ALL_CSS) {
      expect(stripComments(source), name).not.toMatch(/--area-|--memo|--special|--diff-|--editor-font|--kb-native/)
      expect(stripComments(source), name).not.toMatch(
        /--work-|--private-|--label|--kind-|--on-label|--sat\b|--sun\b|--off-|--today-|--numeral|--stripe|--rule-strong|--done-|--overdue|--qr-|--shadow-lift/,
      )
      expect(stripComments(source), name).not.toMatch(/\[data-(kind|label)/)
    }
  })

  it('3つの外観の規則は、同じトークンの組を持つ（足りない外観が無い）', () => {
    // ホワイトの :root には外観で変わらない物（書体・余白など）も入るので、ダーク・ディープダークの組がホワイトに全部あるかを見る
    const dark = [...ownVars('dark').keys()].sort()
    expect([...ownVars('deep-dark').keys()].sort()).toEqual(dark)
    const white = ownVars('white')
    for (const name of dark) expect(white.has(name), name).toBe(true)
  })

  it('等幅の英数字は Roboto Mono（日本語はゴシック）', () => {
    expect(VARS.white.get('--font-mono')).toBe("'Roboto Mono', var(--font-ui)")
  })
})

describe('字の色が地の上で読める（WCAG の比）', () => {
  // 本文の強調（--emphasis）と既読の見出し（--read-text）も、ほかの字と同じく5つの地すべてで確かめる（条件で地を減らさない。
  // 一覧の地 --bg・シートとパネルの --surface・--surface-2・訂正の箱の --surface-3・選んでいる所の --accent-soft。設計: 段階2の 3.2・3.3）
  const TEXTS = ['--text', '--text-muted', '--text-faint', '--accent', '--emphasis', '--read-text']
  const GROUNDS = ['--bg', '--surface', '--surface-2', '--surface-3', '--accent-soft']

  it.each(THEMES)('%s: 字の色は、どの地の上でも 4.5:1 以上', (theme) => {
    for (const text of TEXTS) {
      for (const ground of GROUNDS) {
        const ratio = contrast(color(theme, text), color(theme, ground))
        expect(ratio, `${theme}: ${text} / ${ground}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it.each(THEMES)('%s: 主なボタン・ログインの画面・選んだ文字・お知らせ・注意の字も 4.5:1 以上', (theme) => {
    const pairs: [string, string][] = [
      ['--on-primary', '--primary'],
      ['--on-primary', '--primary-hover'],
      ['--on-accent', '--accent'],
      ['--accent-strong', '--accent-soft'],
      ['--on-cover', '--cover'],
      ['--text', '--selection'],
      ['--toast-text', '--toast-bg'],
      ['--toast-error-text', '--toast-error-bg'],
      ['--danger', '--surface'],
      ['--danger', '--danger-soft'],
    ]
    for (const [fg, bg] of pairs) {
      expect(contrast(color(theme, fg), color(theme, bg)), `${theme}: ${fg} / ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(THEMES)('%s: 用語の印の点線（--term-line）と重大印の線（--major-line）は、一覧とシートの地の上で 3:1 以上', (theme) => {
    for (const line of ['--term-line', '--major-line']) {
      for (const ground of ['--bg', '--surface']) {
        expect(contrast(color(theme, line), color(theme, ground)), `${theme}: ${line} / ${ground}`).toBeGreaterThanOrEqual(3)
      }
    }
  })
})

describe('TS だけの色（docs/SPEC.md の 10.。設計: 段階2の 3.1・3.2）', () => {
  /** OKLCH の色相（度）・彩度・明るさ */
  const lch = (hex: string) => {
    const [l, a, b] = oklab(hex)
    return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 }
  }

  it('本文の強調（--emphasis）は3つの外観の規則それぞれに書き、ほかは今の色の別名（外観で変わらない :root）', () => {
    for (const theme of THEMES) expect(ownVars(theme).get('--emphasis'), theme).toMatch(/^#[0-9a-f]{6}$/)
    // 作者が A を選んだ強調の色（■1 の今の決め方。ホワイト・ダーク・ディープダーク）
    expect(THEMES.map((t) => ownVars(t).get('--emphasis'))).toEqual(['#9a5200', '#f0a25e', '#c08050'])
    expect(VARS.white.get('--term-line')).toBe('var(--text-faint)')
    expect(VARS.white.get('--major-line')).toBe('var(--text)')
    expect(VARS.white.get('--read-text')).toBe('var(--text-muted)')
    expect(VARS.white.get('--correction-ground')).toBe('var(--surface-3)')
    expect(VARS.white.get('--correction-line')).toBe('var(--border-strong)')
    for (const theme of ['dark', 'deep-dark'] as const) {
      for (const name of ['--term-line', '--major-line', '--read-text', '--correction-ground', '--correction-line'])
        expect(ownVars(theme).has(name), `${theme} の ${name}`).toBe(false)
    }
  })

  it.each(THEMES)('%s: 強調はオレンジ（OKLCH の色相 55〜65°・灰色でない）で、起動アニメーションと同じ色相', (theme) => {
    const { c, h } = lch(color(theme, '--emphasis'))
    expect(h, `${theme} の色相`).toBeGreaterThanOrEqual(55)
    expect(h, `${theme} の色相`).toBeLessThanOrEqual(65)
    expect(c, `${theme} の彩度`).toBeGreaterThan(0.08)
  })

  it('ディープダークの強調は、本文の字（--text）より明るくしない（明るい色を抑える外観）', () => {
    expect(lch(color('deep-dark', '--emphasis')).l).toBeLessThan(lch(color('deep-dark', '--text')).l)
  })
})

describe('記事の字の大きさ（<html data-text-size>。docs/SPEC.md の 9.。設計: 段階2の 3.4）', () => {
  /** その規則に書いた変数 */
  const varsOf = (selector: string) => {
    const own = rules.filter((r) => r.selector === selector)
    expect(own, selector).toHaveLength(1)
    return Object.fromEntries([...declarations(own[0].body)].filter(([k]) => k.startsWith('--read-')))
  }

  it('中（既定）は外観で変わらない :root、小・大は :root[data-text-size] に、同じ変数の組を書く', () => {
    const base = Object.fromEntries([...VARS.white].filter(([k]) => k.startsWith('--read-') && k !== '--read-text'))
    expect(base).toEqual({ '--read-size': '16px', '--read-head': '17px', '--read-title': '20px', '--read-line': '1.75' })
    expect(varsOf(":root[data-text-size='s']")).toEqual({
      '--read-size': '15px',
      '--read-head': '16px',
      '--read-title': '19px',
      '--read-line': '1.7',
    })
    expect(varsOf(":root[data-text-size='l']")).toEqual({
      '--read-size': '18px',
      '--read-head': '19px',
      '--read-title': '22px',
      '--read-line': '1.75',
    })
  })
})

describe('差し色とログインの画面はグレー（DS と同じ。docs/SPEC.md の 10.。オレンジは起動アニメーション・アイコン・本文の強調だけ）', () => {
  /** 差し色と、ログインの画面の地・字・ボタンの枠 */
  const GRAY_TOKENS = [
    '--accent',
    '--accent-strong',
    '--accent-soft',
    '--on-accent',
    '--primary',
    '--primary-hover',
    '--primary-border',
    '--on-primary',
    '--switch-on',
    '--selection',
    '--cover',
    '--on-cover',
    '--cover-border',
  ]
  /** OKLab の彩度（灰色の軸からの離れ。前の青は 0.03〜0.07、面・線・字のグレーは 0.014 まで） */
  const chroma = (hex: string) => Math.hypot(oklab(hex)[1], oklab(hex)[2])
  const lightness = (hex: string) => oklab(hex)[0]

  it.each(THEMES)('%s: 差し色とログインの画面の色は、OKLab の彩度 0.015 未満のグレー', (theme) => {
    for (const name of GRAY_TOKENS) {
      expect(chroma(color(theme, name)), `${theme}: ${name}`).toBeLessThan(0.015)
    }
  })

  it('ログインの画面の地: ホワイトは明るいグレー、ダークは黒より少し明るいグレー、ディープダークはそれより暗いグレー', () => {
    // ホワイト: ページの地（--bg）より暗く、白に見えない。それでも明るい（OKLab の明るさ 0.85 以上）
    expect(lightness(color('white', '--cover'))).toBeLessThan(lightness(color('white', '--bg')) - 0.04)
    expect(lightness(color('white', '--cover'))).toBeGreaterThanOrEqual(0.85)
    // ダーク: 面（--surface）より明るく、まだ暗い（0.4 未満）
    expect(lightness(color('dark', '--cover'))).toBeGreaterThan(lightness(color('dark', '--surface')) + 0.04)
    expect(lightness(color('dark', '--cover'))).toBeLessThan(0.4)
    // ディープダーク: ダークより暗く、ページの地（--bg）よりは明るい
    expect(lightness(color('deep-dark', '--cover'))).toBeLessThan(lightness(color('dark', '--cover')) - 0.04)
    expect(lightness(color('deep-dark', '--cover'))).toBeGreaterThan(lightness(color('deep-dark', '--bg')))
  })

  it.each(THEMES)('%s: ログインの画面の字は地と 4.5:1 以上、ボタンの字は 4.5:1 以上、ボタンの枠は地と 3:1 以上', (theme) => {
    const cover = color(theme, '--cover')
    expect(contrast(color(theme, '--on-cover'), cover), `${theme}: --on-cover / --cover`).toBeGreaterThanOrEqual(4.5)
    // ボタン（.btn）は地 --surface・字 --text
    expect(contrast(color(theme, '--text'), color(theme, '--surface')), `${theme}: --text / --surface`).toBeGreaterThanOrEqual(
      4.5,
    )
    expect(contrast(color(theme, '--cover-border'), cover), `${theme}: --cover-border / --cover`).toBeGreaterThanOrEqual(3)
  })

  it('ログインの画面のボタンの枠は --cover-border、フォーカスの輪は --on-cover（src/features/login/login.css）', () => {
    const src = stripComments(loginCss)
    expect(src).toMatch(/\.login \.btn \{\s*border-color: var\(--cover-border\);\s*\}/)
    expect(src).toMatch(/\.login \.btn:focus-visible,\s*\.login-link:focus-visible \{\s*outline-color: var\(--on-cover\);/)
  })

  it.each(THEMES)('%s: フォーカスの輪・選んでいる所の下線と枠（--accent）は、周りの地と 3:1 以上', (theme) => {
    for (const ground of ['--bg', '--surface', '--surface-2', '--surface-3', '--accent-soft']) {
      expect(contrast(color(theme, '--accent'), color(theme, ground)), `${theme}: --accent / ${ground}`).toBeGreaterThanOrEqual(3)
    }
    // ログインの画面のフォーカスの輪
    expect(contrast(color(theme, '--on-cover'), color(theme, '--cover'))).toBeGreaterThanOrEqual(3)
  })

  it.each(THEMES)(
    '%s: 切り替えのオンの地は、明るさでオフの地と見分けられる（オフ --border-strong と 2:1・面と 3:1 以上）',
    (theme) => {
      expect(contrast(color(theme, '--switch-on'), color(theme, '--border-strong'))).toBeGreaterThanOrEqual(2)
      expect(contrast(color(theme, '--switch-on'), color(theme, '--surface'))).toBeGreaterThanOrEqual(3)
    },
  )
})

describe('部品の書き方', () => {
  /** 色のトークンの規則（3つの外観）を除いた残り */
  function componentCss(source: string): string {
    const tokenSelectors = new Set(Object.values(SELECTORS))
    let out = stripComments(source)
    for (const r of topLevelRules(source)) if (tokenSelectors.has(r.selector)) out = out.replace(r.body, '')
    return out
  }

  it('src/ の下の CSS をすべて確かめる（共通・画面ごとの CSS）', () => {
    const names = ALL_CSS.map(([name]) => name)
    expect(names).toEqual([
      'features/editions/editions.css',
      'features/login/login.css',
      'features/top/top.css',
      'features/topic/topic.css',
      'styles.css',
      'ui/layout.css',
      'ui/menu.css',
      'ui/sync.css',
    ])
  })

  it.each(ALL_CSS)('%s: 部品は色を直接書かず、変数だけを使う', (_name, source) => {
    const rest = componentCss(source)
    expect(rest).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(rest).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab)\(/)
    expect(rest).not.toMatch(/:\s*[^;{}]*\b(?:white|black)\b/)
  })

  it('幅の区分の値は src/ui/hooks.ts の WIDTH_M・WIDTH_L とそろっている（docs/SPEC.md の 9.）', () => {
    const widths = new Set([...css.matchAll(/\((?:max|min)-width:\s*(\d+)px\)/g)].map((m) => Number(m[1])))
    expect([...widths].sort((a, b) => a - b)).toEqual([WIDTH_M - 1, WIDTH_M, WIDTH_L - 1, WIDTH_L])
    expect(css).toContain(`@media (max-width: ${WIDTH_M - 1}px)`)
    expect(css).toContain(`@media (max-width: ${WIDTH_L - 1}px)`)
    expect(css).toContain(`@media (max-width: ${WIDTH_L - 1}px), (pointer: coarse)`)
  })

  // ヘッダーの名前を出さない 380px 未満（docs/SPEC.md の 14.5）だけは、幅の区分とは別の値
  const HEADER_NAME_MAX = 379
  it.each(ALL_CSS)('%s: 幅の値は幅の区分（WIDTH_M・WIDTH_L）か、ヘッダーの名前を隠す 380px 未満だけ', (_name, source) => {
    const allowed = new Set([WIDTH_M - 1, WIDTH_M, WIDTH_L - 1, WIDTH_L, HEADER_NAME_MAX])
    const widths = [...stripComments(source).matchAll(/\((?:max|min)-width:\s*(\d+)px\)/g)].map((m) => Number(m[1]))
    for (const w of widths) expect(allowed.has(w), `${w}px`).toBe(true)
  })

  it('視差効果を減らす設定では、CSS の動きを全部止める（DS と同じ）', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{\s*animation: none !important;\s*transition: none !important;/,
    )
  })
})
