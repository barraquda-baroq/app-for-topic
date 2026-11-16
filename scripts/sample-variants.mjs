// 段階2の見本で作者に見比べてもらう案を作る（docs/SPEC.md の 9.・10.・12.。設計: 段階2の 3.2・5.1・5.4。DS の
// scripts/sample-variants.mjs から、TS の問いの分だけを写した）。
//   node scripts/sample-variants.mjs            → e2e/samples/variants.json に書き出す（いつも同じ結果。リポジトリに入れる）
//   node scripts/sample-variants.mjs --check    → 書き出し済みの e2e/samples/variants.json が src/styles.css と合っているかだけ確かめる
//   node scripts/sample-variants.mjs --emit css --pick emphasis-darker@white
//                                               → 作者が選んだ案の値を、src/styles.css に書く形で出す（形の案は、差し込んだ CSS を出す）
//   node scripts/sample-variants.mjs --emit spec --pick …
//                                               → 同じ値を、仕様書の表の行の形で出す（17. の作者の答え・10. の TS の色の表）
// 案（見本のページの A・B・C。「今」= A は今の src/styles.css のまま。何も差し込まない）:
//   emphasis-brighter  ■1 B  本文の強調の色（--emphasis）を明るめに（ダーク・ディープダークだけ。ホワイトは今の色がもう5つの地で 4.5:1 を
//                            守るいちばん明るい色なので、明るめは作れない。設計: 段階2の 3.2）
//   emphasis-darker    ■1 C  同じく暗めに（3つの外観）
//   term-question      ■2 B  本文の中の用語の印を、点線の代わりに語の後ろの小さな「？」にする（形の案）
//   term-none          ■2 C  本文には印を付けない（下の用語の一覧だけ。押す所も箱も出さない形にする）
//   major-badge        ■3 B  重大印を「重大」の札だけにする（カードの左の太い線を消す）
//   major-bigger       ■3 C  札に加えて、重大の話題の見出しを少し大きくする（カードの左の線は消す）
//   correction-plain   ■4 B  「訂正あり」に加えて、訂正のある話題の強調を外す（カードと詳細）
//   correction-detail-only ■4 C  カードの「訂正あり」を出さない（詳細の上の「訂正: …」だけ）
//   sync-text          ■12 B ヘッダーの同期の表示を字だけにする（スマホは段階1の短い字。字は撮る時に e2e/samples/samples.spec.ts が
//                            src/sync/syncView.ts の syncShortLabel で入れる data-sample-short から出す）
// ■4 の D（次の版の上でも知らせる）・■12 の C（［今すぐ同期］と設定の「同期」）は、データの形・部品を足す案なので絵を作らない（文だけ）。
// 色の案は、src/styles.test.ts と同じ決まり（字 4.5:1 を5つの地で・用語の印と重大印の線 3:1・強調はオレンジ・ディープダークの強調は本文の字より
// 暗い・差し色とログインの画面はグレー）で確かめ、通らない案は書き出さずに止める（checkTheme。条件で地を減らさない）。
// 形の案は、testid（src/features/top/testIds.ts）の印と、部品の CSS のクラスで差し替える（使うクラスが今の画面の CSS にあることは
// scripts/sample-variants.test.mjs で確かめる）。DS のラベルの24色・区分の地・土日祝・差し色の濃さの作り方は写さない（TS に無い色）。
// アプリの中には入らない（見本は e2e/samples/samples.spec.ts が page.addStyleTag で差し込んで撮る）。
// 作者の答え（ANSWERS）はまだ無い（2026-11-15。答えが来たら、選んだ値を src/styles.css に入れ、答える前の値を ASKED_TOKENS・ASKED_SHAPE_CSS に
// 残す。答えた問いの切り抜きは、その値を敷いてから撮るので、見本のページを作り直しても A・B・C は見比べてもらった時と同じ絵になる。DS の作り）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromaOf, contrast, hexToOklch, lightness } from './lib/color.mjs'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const STYLES_FILE = path.join(repoDir, 'src', 'styles.css')
export const VARIANTS_FILE = path.join(repoDir, 'e2e', 'samples', 'variants.json')

// ---------- 外観とトークン ----------

export const THEMES = ['white', 'dark', 'deep-dark']
export const THEME_NAMES = { white: 'ホワイト', dark: 'ダーク', 'deep-dark': 'ディープダーク' }
/** その外観の色を書く規則（src/styles.css。ホワイトは :root、ほかは :root[data-theme=…]） */
const SELECTORS = { white: ':root', dark: ":root[data-theme='dark']", 'deep-dark': ":root[data-theme='deep-dark']" }
/** 見本に差し込む時のセレクタ（ホワイトも data-theme='white' が入るので、:root より強くして今の値に勝たせる） */
export const SAMPLE_SELECTORS = {
  white: ":root[data-theme='white']",
  dark: ":root[data-theme='dark']",
  'deep-dark': ":root[data-theme='deep-dark']",
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** いちばん外側の規則（@media の中は含めない）を、セレクタと中身の組にする（src/styles.test.ts と同じ読み方） */
function topLevelRules(source) {
  const src = stripComments(source)
  const rules = []
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

function declarations(body) {
  const map = new Map()
  for (const part of body.split(';')) {
    const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(part)
    if (m) map.set(m[1], m[2].replace(/\s+/g, ' '))
  }
  return map
}

/**
 * src/styles.css から、外観ごとに効く変数の値を読む（ホワイトの :root に、ダーク・ディープダークの規則を重ねた物。値は書いたまま。
 * var(--x) もそのまま）。戻り値: { white: Map, dark: Map, 'deep-dark': Map }
 */
export function readThemes(css) {
  const rules = topLevelRules(css)
  const base = new Map()
  for (const r of rules.filter((r) => r.selector === ':root')) for (const [k, v] of declarations(r.body)) base.set(k, v)
  const out = { white: base }
  for (const theme of ['dark', 'deep-dark']) {
    const own = rules.filter((r) => r.selector === SELECTORS[theme])
    if (own.length !== 1) throw new Error(`${SELECTORS[theme]} の規則が1つではありません（${own.length}）`)
    const map = new Map(base)
    for (const [k, v] of declarations(own[0].body)) map.set(k, v)
    out[theme] = map
  }
  return out
}

/** var(--x) をたどった値（16進の色でなければ null） */
export function hexOf(vars, name) {
  let v = vars.get(name)
  for (let i = 0; i < 10 && v; i++) {
    const m = /^var\((--[\w-]+)\)$/.exec(v)
    if (!m) break
    v = vars.get(m[1])
  }
  return typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v) ? v : null
}

/** 案の値を重ねた外観の変数 */
export function withTokens(vars, tokens = {}) {
  const map = new Map(vars)
  for (const [k, v] of Object.entries(tokens)) map.set(k, v)
  return map
}

// ---------- 確かめ（src/styles.test.ts と同じ決まり） ----------

/** 字の色（5つの地の上で 4.5:1 以上。本文の強調と既読の見出しも同じ。条件で地を減らさない） */
const TEXTS = ['--text', '--text-muted', '--text-faint', '--accent', '--emphasis', '--read-text']
/** 字を置く5つの地（一覧の地・シートとパネルの地・--surface-2・訂正の箱の地・選んでいる所の地。設計: 段階2の 3.2） */
export const GROUNDS = ['--bg', '--surface', '--surface-2', '--surface-3', '--accent-soft']
/** 主なボタン・ログインの画面・選んだ文字・お知らせ・注意の字（4.5:1 以上） */
const PAIRS_45 = [
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
  ['--text', '--surface'],
]
/** 用語の印の点線・重大印の線（一覧とシートの地の上で 3:1 以上） */
const LINES = ['--term-line', '--major-line']
/** 差し色とログインの画面の色（OKLab の彩度 0.015 未満のグレー。--emphasis は入れない） */
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
/** 強調の色相の幅（OKLCH の度。起動アニメーションと同じオレンジ）と、灰色でない彩度の下限 */
export const EMPHASIS_HUE = [55, 65]
export const EMPHASIS_MIN_CHROMA = 0.08

const fmt = (n, d = 2) => n.toFixed(d)

/** その外観の変数が、src/styles.test.ts の決まりを満たすかを確かめる。戻り値は満たさない所の文（空なら通った） */
export function checkTheme(theme, vars) {
  const out = []
  const name = THEME_NAMES[theme]
  const hex = (n) => {
    const v = hexOf(vars, n)
    if (!v) out.push(`${name}: ${n} が16進の色になっていません（${vars.get(n)}）`)
    return v ?? '#000000'
  }
  const ratio = (fg, bg, min, why = '') => {
    const r = contrast(hex(fg), hex(bg))
    if (r < min) out.push(`${name}: ${fg} / ${bg} が ${fmt(r)}:1（${min}:1 未満${why}）`)
  }
  for (const fg of TEXTS) for (const bg of GROUNDS) ratio(fg, bg, 4.5)
  for (const [fg, bg] of PAIRS_45) ratio(fg, bg, 4.5)
  for (const line of LINES) for (const bg of ['--bg', '--surface']) ratio(line, bg, 3, '・線')
  for (const bg of GROUNDS) ratio('--accent', bg, 3, '・フォーカスの輪')
  ratio('--on-cover', '--cover', 3, '・ログインの画面のフォーカスの輪')
  ratio('--cover-border', '--cover', 3, '・ログインの画面のボタンの枠')
  ratio('--switch-on', '--border-strong', 2, '・切り替えのオンとオフ')
  ratio('--switch-on', '--surface', 3, '・切り替えのオン')
  for (const t of GRAY_TOKENS) {
    const c = chromaOf(hex(t))
    if (c >= 0.015) out.push(`${name}: ${t} の彩度が ${fmt(c, 4)}（グレーは 0.015 未満）`)
  }
  // 本文の強調はオレンジ（起動アニメーションと同じ色相・灰色でない）。ディープダークは本文の字より明るくしない（明るい色を抑える外観）
  const [, c, h] = hexToOklch(hex('--emphasis'))
  if (h < EMPHASIS_HUE[0] || h > EMPHASIS_HUE[1])
    out.push(`${name}: --emphasis の色相が ${fmt(h, 1)}°（${EMPHASIS_HUE[0]}〜${EMPHASIS_HUE[1]}° の外）`)
  if (c <= EMPHASIS_MIN_CHROMA) out.push(`${name}: --emphasis の彩度が ${fmt(c, 3)}（${EMPHASIS_MIN_CHROMA} 以下で灰色に近い）`)
  if (theme === 'deep-dark' && lightness(hex('--emphasis')) >= lightness(hex('--text')))
    out.push(`${name}: --emphasis が --text より明るい（ディープダークは本文の字より暗くする）`)
  return out
}

/** その色が、その外観の5つの地の上でいちばん低い比（見本の案の notes に書く） */
function lowestRatio(vars, color) {
  return Math.min(...GROUNDS.map((g) => contrast(color, hexOf(vars, g) ?? '#000000')))
}

// ---------- 案 ----------

/**
 * ■1 の強調の色の案（設計: 段階2の 3.2 の表。WCAG の比を src/styles.test.ts と同じ式で計算して決めた値）。A（今）は src/styles.css の値。
 * ホワイトは今の #9a5200 が5つの地で 4.5:1 を守るいちばん明るい所なので、明るめ（B）は作らない（WHITE_BRIGHTER_TRIED）
 */
export const EMPHASIS_OPTIONS = {
  'emphasis-brighter': { dark: '#f4ad6e', 'deep-dark': '#d08a50' },
  'emphasis-darker': { white: '#8f4c00', dark: '#e0975a', 'deep-dark': '#b8773f' },
}
/** ホワイトで、今の色より一段明るくした時の色（--accent-soft の上で 4.45:1 と落ちる。ホワイトに明るめの案が無い理由） */
export const WHITE_BRIGHTER_TRIED = '#a15600'

/**
 * 形の案の CSS（撮る時だけ差し込む）。探す所は testid（data-testid と、その data-* の印）を主にし、要る所だけ部品の CSS のクラス
 * （.emph は src/styles.css、.topic-major は src/features/topic/topic.css、.top-card-corrected は src/features/top/top.css）を使う
 */
export const SHAPE_CSS = {
  // ■2 B: 点線をやめ、語の後ろに小さな「？」（押すと同じ説明の箱）
  'term-question': `[data-testid='term-mark'] {
  text-decoration: none !important;
}
[data-testid='term-mark']::after {
  content: '？';
  margin-left: 1px;
  font-size: 0.72em;
  font-weight: 700;
  line-height: 0;
  vertical-align: super;
  color: var(--text-muted);
}
`,
  // ■2 C: 本文には印を付けない（字はふつうの本文のまま。押す所も説明の箱も無い。下の用語の一覧だけ）
  'term-none': `[data-testid='term-mark'] {
  text-decoration: none !important;
  cursor: text !important;
}
[data-testid='term-note'] {
  display: none !important;
}
`,
  // ■3 B: 「重大」の札だけ（カードの左の太い線を消し、ほかのカードと同じ左の端にそろえる）
  'major-badge': `[data-testid='top-card'][data-major='true'] {
  border-left: 0 !important;
  padding-left: 0 !important;
}
`,
  // ■3 C: 札に加えて、重大の話題の見出しを少し大きく（カードと詳細。カードの左の線は消す）
  'major-bigger': `[data-testid='top-card'][data-major='true'] {
  border-left: 0 !important;
  padding-left: 0 !important;
}
[data-testid='top-card'][data-major='true'] h3 {
  font-size: calc(var(--read-head) + 3px) !important;
}
[data-testid='topic-detail']:has(.topic-major) h3 {
  font-size: calc(var(--read-title) + 3px) !important;
}
`,
  // ■4 B: 「訂正あり」に加えて、訂正のある話題は強調を外す（オレンジの太字をふつうの字に。カードと詳細）
  'correction-plain': `[data-testid='top-card'][data-correction='true'] .emph,
[data-testid='topic-detail']:has([data-testid='topic-correction']) .emph {
  color: inherit !important;
  font-weight: inherit !important;
}
`,
  // ■4 C: カードに「訂正あり」を出さない（詳細の上の「訂正: …」だけ）
  'correction-detail-only': `.top-card-corrected {
  display: none !important;
}
`,
  // ■12 B: 字だけ（アイコンを出さない。スマホは段階1の短い字。字は撮る時に data-sample-short へ入れる）。スマホの字は段階1と同じ 12px で、
  // 入らない時は「…」で省く（段階1の src/ui/layout.css の .sync-indicator と同じ。S のアイコンのボタンは縮まず、字はヘッダーの大きさを
  // 受け継ぐので、そのままだと「無料枠を使い切りました」が歯車に重なって画面の外へ出ていた。見本の見直しで分かった）
  'sync-text': `[data-testid='sync-indicator'] svg {
  display: none !important;
}
[data-testid='sync-indicator'][data-sample-short] {
  flex: 0 1 auto !important;
  min-width: 0 !important;
  padding: 0 4px !important;
  font-size: 12px !important;
}
[data-testid='sync-indicator'][data-sample-short]::after {
  content: attr(data-sample-short);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`,
}

/**
 * 作者に聞く問いのうち、案を撮って見比べる物（見本のページの並び。now は今の src/styles.css のまま）。問いの文は docs/STAGE2-LOOKS.md。
 * 絵の無い案（■4 の D・■12 の C）と、「今の決め方」の絵だけの問い（■5〜■11・■13・■14）はここに無い
 */
export const QUESTIONS = {
  1: {
    title: '強調の色',
    appearances: THEMES,
    options: [
      { letter: 'A', id: 'now', label: '今' },
      { letter: 'B', id: 'emphasis-brighter', label: '明るめ（ダーク・ディープダークだけ）' },
      { letter: 'C', id: 'emphasis-darker', label: '暗め' },
    ],
  },
  2: {
    title: '本文の中の用語の印',
    appearances: THEMES,
    options: [
      { letter: 'A', id: 'now', label: '語の下に点線' },
      { letter: 'B', id: 'term-question', label: '語の後ろに小さな「？」' },
      { letter: 'C', id: 'term-none', label: '本文には付けない' },
    ],
  },
  3: {
    title: '重大印の見た目',
    appearances: THEMES,
    options: [
      { letter: 'A', id: 'now', label: '「重大」の札＋カードの左の太い線' },
      { letter: 'B', id: 'major-badge', label: '「重大」の札だけ' },
      { letter: 'C', id: 'major-bigger', label: '札に加えて見出しを少し大きく' },
    ],
  },
  4: {
    title: '訂正の出し方',
    appearances: THEMES,
    options: [
      { letter: 'A', id: 'now', label: 'カードに「訂正あり」を出す' },
      { letter: 'B', id: 'correction-plain', label: 'A に加えて、訂正のある話題は強調を外す' },
      { letter: 'C', id: 'correction-detail-only', label: 'カードには出さない（詳細の上だけ）' },
    ],
  },
  12: {
    title: 'ヘッダーの同期の表示',
    // 色の段はグレーと注意の色だけで、外観ごとの見比べは要らない（設計: 段階2の 5.2）
    appearances: ['white'],
    options: [
      { letter: 'A', id: 'now', label: '雲のアイコンと字（スマホはアイコンと小窓）' },
      { letter: 'B', id: 'sync-text', label: '字だけ（スマホは短い字）' },
    ],
  },
}

// ---------- 作者の答え（まだ無い。docs/STAGE2-LOOKS.md の「作者の答え」・仕様書 17.1） ----------

/** 答えた問い → 選んだ案の id（例 { 1: 'emphasis-darker@white' }）。答えが来たら足す */
export const ANSWERS = {}
/**
 * 答える前の色の値（{ 外観: { トークン: 値 } }）。答えで src/styles.css の値を替えた時に、替える前の値をここに残す（答えた問いの切り抜きは、
 * これを敷いてから案を重ねる。敷かないと、「今」の絵が選んだ案と同じ絵になる）
 */
export const ASKED_TOKENS = { white: {}, dark: {}, 'deep-dark': {} }
/** 答える前の形（形の案を選んで部品の CSS を替えた時に、替える前の形に戻す CSS をここに残す） */
export const ASKED_SHAPE_CSS = ''

/** 案のトークンを、見本に差し込む CSS にする（外観ごとに :root[data-theme=…]） */
export function tokensCss(tokens) {
  return THEMES.filter((t) => tokens[t] && Object.keys(tokens[t]).length)
    .map(
      (t) =>
        `${SAMPLE_SELECTORS[t]} {\n${Object.entries(tokens[t])
          .map(([k, v]) => `  ${k}: ${v};\n`)
          .join('')}}\n`,
    )
    .join('')
}

/** 答えた問いの切り抜きを撮る時に、先に差し込む CSS（答える前の値と形） */
export function askedCss() {
  return `${tokensCss(ASKED_TOKENS)}${ASKED_SHAPE_CSS}`
}

/** その問いの案を作って確かめる時の土台（答えた問いは答える前の値、まだ答えの無い問いは今の値） */
export function askedFor(question, themes) {
  if (!(question in ANSWERS)) return themes
  return Object.fromEntries(THEMES.map((t) => [t, withTokens(themes[t], ASKED_TOKENS[t])]))
}

/**
 * すべての案を作り、確かめる。css = src/styles.css の中身。戻り値は e2e/samples/variants.json の中身。
 * 色の案が決まりを満たさない時は投げる（書き出さない）
 */
export function buildVariants(css) {
  const themes = readThemes(css)
  for (const theme of THEMES) {
    const problems = checkTheme(theme, themes[theme])
    if (problems.length) throw new Error(`今の src/styles.css が決まりを満たしていません:\n${problems.join('\n')}`)
    const before = checkTheme(theme, withTokens(themes[theme], ASKED_TOKENS[theme]))
    if (before.length) throw new Error(`答える前の値（ASKED_TOKENS）が決まりを満たしていません:\n${before.join('\n')}`)
  }
  const options = {}
  for (const [number, q] of Object.entries(QUESTIONS)) {
    const question = Number(number)
    const base = askedFor(question, themes)
    for (const opt of q.options) {
      if (opt.id === 'now') continue
      const colors = EMPHASIS_OPTIONS[opt.id]
      if (colors) {
        const tokens = Object.fromEntries(THEMES.filter((t) => colors[t]).map((t) => [t, { '--emphasis': colors[t] }]))
        const notes = []
        for (const theme of THEMES) {
          const vars = withTokens(base[theme], tokens[theme])
          const problems = checkTheme(theme, vars)
          if (problems.length) throw new Error(`案 ${opt.id} が決まりを満たしていません:\n${problems.join('\n')}`)
          if (tokens[theme])
            notes.push(
              `${THEME_NAMES[theme]} ${colors[theme]}（5つの地でいちばん低い比 ${fmt(lowestRatio(vars, colors[theme]))}:1・明るさ ${fmt(lightness(colors[theme]), 3)}）`,
            )
        }
        options[opt.id] = {
          question,
          letter: opt.letter,
          label: opt.label,
          appearances: q.appearances.filter((t) => tokens[t]),
          tokens,
          css: tokensCss(tokens),
          notes,
        }
        continue
      }
      const shape = SHAPE_CSS[opt.id]
      if (!shape) throw new Error(`案 ${opt.id} の作り方がありません`)
      options[opt.id] = {
        question,
        letter: opt.letter,
        label: opt.label,
        appearances: [...q.appearances],
        tokens: {},
        css: shape,
        notes: ['形の案（色は今のまま）'],
      }
    }
  }
  return {
    generatedBy: 'scripts/sample-variants.mjs',
    note: '段階2の見本の案（docs/SPEC.md の 9.・10.・12.。設計: 段階2の 5.1）。手で直さず、node scripts/sample-variants.mjs で作り直す',
    themes: THEMES,
    questions: QUESTIONS,
    options,
    // 答えた問いの切り抜きの下に敷く、答える前の値と形（askedCss。まだ答えが無いので空）
    asked: { questions: Object.keys(ANSWERS).map(Number), tokens: ASKED_TOKENS, css: askedCss() },
  }
}

/** 書き出す JSON の文字（いつも同じ並び・改行） */
export function variantsJson(css) {
  return `${JSON.stringify(buildVariants(css), null, 2)}\n`
}

/**
 * 書き出し済みの JSON の文字が、作り直した物と同じ中身か（空白・改行の違いは見ない。Prettier などで整えても、作り直し忘れとは
 * 言わない）。読めない・無い時は違うとする
 */
export function sameVariants(text, json) {
  try {
    return text !== null && JSON.stringify(JSON.parse(text)) === JSON.stringify(JSON.parse(json))
  } catch {
    return false
  }
}

// ---------- 選んだ案を書く形にする（答えが来た時） ----------

/** --pick の文字（'emphasis-darker@white,major-badge'）を [{ id, themes }] にする（知らない案・外観は投げる） */
function parsePick(variants, pick) {
  return String(pick ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const [id, only] = part.split('@')
      const opt = variants.options[id]
      if (!opt) throw new Error(`知らない案: ${id}（${Object.keys(variants.options).join('・')}）`)
      const themes = only ? only.split('+') : opt.appearances
      for (const t of themes) {
        if (!THEMES.includes(t)) throw new Error(`知らない外観: ${t}`)
        // 外観を名指ししたのに、その案がその外観を変えない時（■1 の B のホワイトなど）は、黙って何もしないで済ませない
        if (!opt.appearances.includes(t))
          throw new Error(
            `案 ${id} は${THEME_NAMES[t]}を変えません（${opt.appearances.map((a) => THEME_NAMES[a]).join('・')}だけ）`,
          )
      }
      return { id, themes }
    })
}

/**
 * 選んだ案の色の値: { theme: { token: value } }（同じ外観の同じトークンを2つの案が書き換える時は投げる）。形の案は値を持たない
 */
export function pickTokens(variants, pick) {
  const out = Object.fromEntries(THEMES.map((t) => [t, {}]))
  const from = Object.fromEntries(THEMES.map((t) => [t, {}]))
  for (const { id, themes } of parsePick(variants, pick)) {
    const opt = variants.options[id]
    for (const t of themes) {
      for (const [k, v] of Object.entries(opt.tokens[t] ?? {})) {
        if (from[t][k] && from[t][k] !== id)
          throw new Error(`${THEME_NAMES[t]}の ${k} を ${from[t][k]} と ${id} の両方が書き換えます`)
        out[t][k] = v
        from[t][k] = id
      }
    }
  }
  // 同じ問いの形の案を2つ選んだ時も止める（どちらの形にするか分からない）
  const shapes = parsePick(variants, pick).filter(({ id }) => !Object.keys(variants.options[id].tokens).length)
  const byQuestion = new Map()
  for (const { id } of shapes) {
    const q = variants.options[id].question
    if (byQuestion.has(q) && byQuestion.get(q) !== id)
      throw new Error(`■${q} の形の案を2つ選んでいます（${byQuestion.get(q)}・${id}）`)
    byQuestion.set(q, id)
  }
  return out
}

/** 選んだ案をまとめて今の src/styles.css に重ね、外観ごとに決まり（checkTheme）を確かめる。戻り値は満たさない所の文（空なら通った） */
export function checkPick(variants, pick, css) {
  const tokens = pickTokens(variants, pick)
  const themes = readThemes(css)
  return THEMES.flatMap((t) => checkTheme(t, withTokens(themes[t], tokens[t])))
}

/** 選んだ案を src/styles.css に書く形（外観ごとの規則の中の行）にする。形の案は、見本で差し込んだ CSS を、部品の CSS を直す手がかりとして出す */
export function emitCss(variants, pick) {
  const tokens = pickTokens(variants, pick)
  const lines = []
  for (const t of THEMES) {
    const entries = Object.entries(tokens[t])
    if (!entries.length) continue
    lines.push(`/* ${THEME_NAMES[t]}（${SELECTORS[t]}） */`)
    for (const [k, v] of entries) lines.push(`  ${k}: ${v};`)
  }
  for (const { id } of parsePick(variants, pick)) {
    const opt = variants.options[id]
    if (Object.keys(opt.tokens).length) continue
    lines.push(
      `/* ■${opt.question} ${opt.letter}（${id}）: 形の案。部品の CSS をこの形に直す（下は見本で差し込んだ CSS） */`,
      opt.css.trimEnd(),
    )
  }
  return `${lines.join('\n')}\n`
}

/** 選んだ案を仕様書の表の行（トークン | ホワイト | ダーク | ディープダーク）の形にする。今の値のままの所は src/styles.css の値 */
export function emitSpec(variants, pick, css) {
  const tokens = pickTokens(variants, pick)
  const themes = readThemes(css)
  const value = (t, k) => tokens[t][k] ?? themes[t].get(k)
  const changed = [...new Set(THEMES.flatMap((t) => Object.keys(tokens[t])))]
  const lines = []
  if (changed.length) {
    lines.push('| トークン | ホワイト | ダーク | ディープダーク |', '|---|---|---|---|')
    for (const k of changed) lines.push(`| \`${k}\` | ${THEMES.map((t) => `\`${value(t, k)}\``).join(' | ')} |`)
  }
  for (const { id } of parsePick(variants, pick)) {
    const opt = variants.options[id]
    if (!Object.keys(opt.tokens).length) lines.push(`- ■${opt.question} ${opt.letter}: ${opt.label}（形の案。${id}）`)
  }
  return `${lines.join('\n')}\n`
}

// ---------- 動かした時 ----------

function main() {
  const args = process.argv.slice(2)
  const flag = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? (args[i + 1] ?? '') : null
  }
  const css = fs.readFileSync(STYLES_FILE, 'utf8')
  const emit = flag('--emit')
  if (emit !== null) {
    const variants = JSON.parse(variantsJson(css))
    const pick = flag('--pick') ?? ''
    const problems = checkPick(variants, pick, css)
    if (problems.length) throw new Error(`選んだ案を合わせると決まりを満たしません:\n${problems.join('\n')}`)
    if (emit === 'css') process.stdout.write(emitCss(variants, pick))
    else if (emit === 'spec') process.stdout.write(emitSpec(variants, pick, css))
    else throw new Error(`--emit は css・spec のどちらかです（${emit}）`)
    return
  }
  const json = variantsJson(css)
  const rel = path.relative(repoDir, VARIANTS_FILE)
  if (args.includes('--check')) {
    const now = fs.existsSync(VARIANTS_FILE) ? fs.readFileSync(VARIANTS_FILE, 'utf8') : null
    if (!sameVariants(now, json)) {
      console.error(`${rel} が src/styles.css と合っていません。node scripts/sample-variants.mjs で作り直してください`)
      process.exit(1)
    }
    console.log(`${rel} は src/styles.css と合っています`)
    return
  }
  fs.mkdirSync(path.dirname(VARIANTS_FILE), { recursive: true })
  fs.writeFileSync(VARIANTS_FILE, json)
  const variants = JSON.parse(json)
  console.log(`${rel} に ${Object.keys(variants.options).length} の案を書き出しました`)
  for (const [id, o] of Object.entries(variants.options)) for (const n of o.notes) console.log(`  ${id}: ${n}`)
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) main()
