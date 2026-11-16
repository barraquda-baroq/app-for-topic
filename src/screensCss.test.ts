// 段階2の画面の CSS と TS・TSX の書き方の確かめ（docs/SPEC.md の 9.・10.。DS の src/calendarCss.test.ts の考え。設計: 段階2の 3.3）:
// 本文の強調の色（--emphasis）を使うのは .emph の規則だけ（オレンジは起動アニメーション・アイコン・本文の強調だけ。D8）で、太字も付ける
// （色だけに頼らない）。部品の CSS は E2E・見本のための testid の印（data-testid・data-kind・data-section など）を選ばず、見た目は
// クラスで分ける（CSS が選ぶ data-* は外観と記事の字の大きさだけ）。部品の TS・TSX は色を直に書かない（DS の FRAME-166）。
// CSS の色の値・字の比・幅の区分・視差効果の決まりは src/styles.test.ts で確かめる
import { describe, expect, it } from 'vitest'

// CSS は import すると（?raw でも）テストでは中身が空になるので、ファイルを読む（src/styles.test.ts と同じ読み方）
const NODE_FS = 'node:fs'
const { readFileSync, readdirSync } = (await import(/* @vite-ignore */ NODE_FS)) as {
  readFileSync: (path: string, encoding: 'utf8') => string
  readdirSync: (path: string, options: { recursive: true }) => string[]
}
const SRC_DIR = decodeURIComponent(new URL(import.meta.url).pathname).replace(/[^/]*$/, '')
/** src/ の下のすべての CSS（[src/ からの場所, 中身]） */
const ALL_CSS: readonly (readonly [string, string])[] = readdirSync(SRC_DIR, { recursive: true })
  .filter((f) => f.endsWith('.css'))
  .sort()
  .map((f) => [f, readFileSync(`${SRC_DIR}${f}`, 'utf8')] as const)

/** 画面と部品の TS・TSX（テストを除く。src/features と src/ui） */
const CODE = import.meta.glob(['./features/**/*.{ts,tsx}', './ui/**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')
/** TS のコメントを除く（文字の中の // は残す。// の前が : の物（https://）はコメントにしない） */
const stripTsComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')

interface CssRule {
  selector: string
  body: string
}

/** すべての規則（@media・@supports の中も。@keyframes の中は除く）を、セレクタと中身の組にする（DS の flatRules） */
function flatRules(source: string): CssRule[] {
  const src = stripComments(source)
  const out: CssRule[] = []
  const stack: { prelude: string; start: number }[] = []
  let last = 0
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') {
      stack.push({ prelude: src.slice(last, i).trim(), start: i + 1 })
      last = i + 1
    } else if (ch === '}') {
      const top = stack.pop()
      const inKeyframes = stack.some((s) => s.prelude.startsWith('@keyframes'))
      if (top && !top.prelude.startsWith('@') && !inKeyframes) out.push({ selector: top.prelude, body: src.slice(top.start, i) })
      last = i + 1
    } else if (ch === ';' && (stack.length === 0 || stack[stack.length - 1].prelude.startsWith('@'))) {
      // いちばん外・@media の中の、規則でない文（@import など）
      last = i + 1
    }
  }
  return out
}

/** 規則の中の宣言（[名前, 値]） */
function declarationsOf(body: string): [string, string][] {
  return body
    .split(';')
    .map((part) => /^\s*([\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(part))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1].toLowerCase(), m[2].replace(/\s+/g, ' ')])
}

/** CSS が選んでよい data-* の印（外観と記事の字の大きさ。<html> に入れる物）。ほかの data-* は E2E・見本が探すための物 */
const CSS_DATA_ATTRS = ['data-theme', 'data-text-size']

describe('確かめる道具', () => {
  it('@media の中の規則も読み、@keyframes の中は読まない', () => {
    const rules = flatRules(`
      .a { color: var(--text); }
      @media (max-width: 599px) { .b { font-weight: 700; } }
      @keyframes k { 0% { opacity: 0; } }
      /* .c { } */
    `)
    expect(rules.map((r) => r.selector)).toEqual(['.a', '.b'])
    expect(declarationsOf(rules[1].body)).toEqual([['font-weight', '700']])
  })

  it('src/ の下の CSS と、src/features・src/ui の TS・TSX を読めている', () => {
    expect(ALL_CSS.map(([name]) => name)).toContain('styles.css')
    expect(ALL_CSS.map(([name]) => name)).toContain('features/topic/topic.css')
    expect(Object.keys(CODE)).toContain('./ui/Modal.tsx')
    expect(Object.keys(CODE)).toContain('./features/top/TopPage.tsx')
    expect(Object.keys(CODE)).toContain('./features/topic/sheets.ts')
  })
})

describe('本文の強調の色（docs/SPEC.md の 9.・10.。作者は A: オレンジの字＋太字）', () => {
  it('var(--emphasis) を使うのは .emph の規則だけ（ほかの部品・バッジ・印にオレンジを使わない）', () => {
    const found: string[] = []
    for (const [name, source] of ALL_CSS) {
      for (const r of flatRules(source)) {
        if (!r.body.includes('var(--emphasis)')) continue
        if (r.selector !== '.emph') found.push(`${name}: ${r.selector}`)
      }
    }
    expect(found).toEqual([])
  })

  it('.emph はオレンジの字と太字（色だけに頼らない）', () => {
    const emph = ALL_CSS.flatMap(([, source]) => flatRules(source)).filter((r) => r.selector === '.emph')
    expect(emph).toHaveLength(1)
    expect(Object.fromEntries(declarationsOf(emph[0].body))).toEqual({ color: 'var(--emphasis)', 'font-weight': '700' })
  })

  it('TS・TSX にも --emphasis を書かない（style で色を付けない。強調は RichText の <strong class="emph"> だけ）', () => {
    const found = Object.entries(CODE)
      .filter(([, source]) => stripTsComments(source).includes('--emphasis'))
      .map(([file]) => file)
    expect(found).toEqual([])
  })
})

describe('部品の CSS は testid の印を選ばない（見た目はクラスで分ける。設計: 段階2の 4.3）', () => {
  it.each(ALL_CSS)('%s: 選ぶ data-* は外観と記事の字の大きさ（data-theme・data-text-size）だけ', (_name, source) => {
    const found: string[] = []
    for (const r of flatRules(source)) {
      for (const m of r.selector.matchAll(/\[\s*(data-[\w-]+)/g)) {
        if (!CSS_DATA_ATTRS.includes(m[1])) found.push(`${r.selector} の ${m[1]}`)
      }
    }
    expect(found).toEqual([])
  })
})

describe('部品は色を直接書かない（DS の FRAME-166）', () => {
  it('TS・TSX の文字の値に色（#fff・rgb() など）を書かない（style でも、属性・変数でも。色は CSS 変数だけ）', () => {
    const found: string[] = []
    for (const [file, source] of Object.entries(CODE)) {
      const code = stripTsComments(source)
      for (const m of code.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
        const text = m[2]
        if (/#[0-9a-fA-F]{3,8}\b/.test(text) || /\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(/.test(text)) {
          found.push(`${file}: ${m[0]}`)
        }
      }
    }
    expect(found).toEqual([])
  })

  it('TSX の style に色の名前（white・black など）を書かない', () => {
    const found: string[] = []
    for (const [file, source] of Object.entries(CODE)) {
      for (const m of stripTsComments(source).matchAll(/style=\{\{([^}]*)\}\}/g)) {
        if (/:\s*['"`](?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy)['"`]/i.test(m[1])) {
          found.push(`${file}: ${m[0]}`)
        }
      }
    }
    expect(found).toEqual([])
  })
})
