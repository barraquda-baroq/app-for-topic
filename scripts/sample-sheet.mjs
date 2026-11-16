// 段階2の見本のページを作る（docs/STAGE2-LOOKS.md。設計: 段階2の 5.1。DS の scripts/sample-sheet.mjs から、TS の画面と問いに直した）。
//   node scripts/sample-sheet.mjs   （npm run samples の最後の段。先に E2E_SAMPLES=1 npx playwright test --project=samples で撮る）
// 見本の置き場（SAMPLES_OUT。無ければ e2e/artifacts/samples。撮る e2e/samples/samples.spec.ts と同じ所。scripts/lib/samplesOut.mjs）の
// 絵と控え（parts/*.json）と、docs/STAGE2-LOOKS.md の「答え方」「### ■ 番号」「見本に写っているが、こちらで直す所」「お知らせ」の節を読み、
// 同じ所に2つ書く:
//   index.html  手元のブラウザで開く物（文書の頭まで付けた物）
//   page.html   作者だけが見られる（非公開の）見本のページとして、絵と一緒に送る物（頭は送る先が付ける。中身は index.html と同じ）
// 絵は同じフォルダーの JPEG をそのまま指す（倍率 2 で撮った物を、半分の大きさで出す）。リポジトリには入れない。
// 「今は … としています」の時刻は、撮った時の時刻（控えの now。e2e/samples/sampleEditions.ts の SAMPLE_NOW）から作り、ほかの時刻で撮った絵
// （20:00版の場面）には、その時刻を添える
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT, samplesOutDir } from './lib/samplesOut.mjs'

export const APPEARANCES = ['white', 'dark', 'deep-dark']
export const APPEARANCE_NAMES = { white: 'ホワイト', dark: 'ダーク', 'deep-dark': 'ディープダーク' }
const SIZE_NAMES = { L: 'PC 1400×900', S: 'スマホ 390×844' }

/** 画面の一覧の並び（撮った物の id で分ける） */
export const GROUPS = [
  { title: 'トップ', ids: ['top', 'top-genre', 'top-read', 'top-bottom', 'newer'] },
  {
    title: '詳細',
    ids: [
      'detail-major',
      'detail-world',
      'detail-politics',
      'detail-ai',
      'detail-none',
      'detail-chain',
      'detail-twice',
      'detail-long',
      'term-open',
      'clip-dialog',
    ],
  },
  { title: '追いつき・版の一覧', ids: ['catch-up', 'catch-up-none', 'editions'] },
  {
    title: 'トップの状態の1行・待つ間',
    ids: ['status-failed', 'status-not-arrived', 'status-waiting', 'status-receiving', 'status-newer', 'empty'],
  },
  { title: '設定・文字の大きさ', ids: ['settings', 'text-size'] },
]

/**
 * 問いごとに見せる画面の一覧の絵（撮った物の名前から外観を外した物。3つの外観を横に並べる）。その問いの案ごとの切り抜き
 * （e2e/samples/shots.ts の CROPS）は、この後に撮った順にすべて並べる
 */
export const QUESTION_SHOTS = {
  2: ['term-open-L', 'term-open-S'],
  4: ['detail-chain-S-top'],
  5: ['detail-major-L', 'detail-major-S-top'],
  6: ['top-S', 'top-genre-S', 'top-bottom-S'],
  7: ['detail-major-L', 'detail-world-L'],
  8: ['catch-up-L-band', 'catch-up-S-band', 'catch-up-L-page', 'catch-up-S-page', 'catch-up-none-S', 'editions-S'],
  9: [
    'settings-S-display',
    'text-size-S-top-s',
    'text-size-S-top-m',
    'text-size-S-top-l',
    'text-size-S-detail-s',
    'text-size-S-detail-m',
    'text-size-S-detail-l',
  ],
  10: ['detail-ai-S'],
  11: [
    'status-receiving-S',
    'status-waiting-S',
    'status-failed-S',
    'status-not-arrived-S',
    'empty-S',
    'status-newer-S',
    'newer-S',
  ],
  13: ['top-read-L', 'top-read-S'],
  14: ['top-bottom-S', 'detail-major-S-bottom'],
}

/** この幅（CSS の px）より広い切り抜きは、外観を横に並べずに、外観ごと・案ごとに縦に積む（横に並べると字が小さくなりすぎる） */
const WIDE_CROP = 700

export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 問いの文の字（HTML の印を置き換え、**…** だけを太字にする） */
function inline(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
}

/** JPEG の幅と高さ（ピクセル）。SOF の印を探して読む */
export function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      i += marker === 0xff ? 1 : 2
      continue
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
    }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  throw new Error('JPEG の大きさが読めません')
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

/** 撮った時の時刻（'2026-11-15T14:10:00+09:00' など）を、日本時間の「2026年11月15日（日）14:10」と「14:10」にする */
export function nowText(iso) {
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) throw new Error(`撮った時の時刻が読めません: ${iso}`)
  const j = new Date(ms + 9 * 60 * 60 * 1000)
  const hm = `${String(j.getUTCHours()).padStart(2, '0')}:${String(j.getUTCMinutes()).padStart(2, '0')}`
  return {
    full: `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月${j.getUTCDate()}日（${WEEKDAYS[j.getUTCDay()]}）${hm}`,
    time: hm,
  }
}

/**
 * docs/STAGE2-LOOKS.md から、問い（「### ■ 番号 題」と、その下の「- 見出し: 文」。見出しの下の「  - 」の箇条はその見出しの items）と、
 * 「## 答え方」「## 見本に写っているが、こちらで直す所」「## お知らせ」の箇条を読む。見出しは書いた順に持つ
 */
export function parseLooksDoc(md) {
  const questions = []
  const notes = { howTo: [], fixes: [], notices: [] }
  let current = null
  let field = null
  let list = null
  for (const line of md.split('\n')) {
    const q = /^### ■(\d+) (.+)$/.exec(line)
    if (q) {
      current = { number: Number(q[1]), title: q[2].trim(), fields: {}, items: {}, order: [] }
      questions.push(current)
      field = null
      list = null
      continue
    }
    if (/^##? /.test(line) || /^### /.test(line)) {
      current = null
      field = null
      list = line.startsWith('## 答え方')
        ? notes.howTo
        : line.startsWith('## 見本に写っているが')
          ? notes.fixes
          : line.startsWith('## お知らせ')
            ? notes.notices
            : null
      continue
    }
    const sub = /^ {2}- (.+)$/.exec(line)
    if (sub && current && field) {
      current.items[field].push(sub[1].trim())
      continue
    }
    const item = /^- (.+)$/.exec(line)
    if (!item) continue
    if (current) {
      const f = /^([^:：]+)[:：]\s*(.+)$/.exec(item[1])
      if (f) {
        field = f[1].trim()
        current.fields[field] = f[2].trim()
        current.items[field] = []
        current.order.push(field)
      }
    } else if (list) {
      list.push(item[1].trim())
    }
  }
  return { questions, notes }
}

/** 「A 今 ／ B 明るめ（…）／ C …」から、案の字ごとの名前（括弧の中は外す。字は A〜Z。聞き直しで D・E… も読む） */
export function optionNamesOf(choice) {
  const names = {}
  if (!choice) return names
  for (const piece of choice.replace(/（.*?）/g, '').split('／')) {
    const m = /^\s*([A-Z])\s+(.+?)\s*$/.exec(piece)
    if (m) names[m[1]] = m[2]
  }
  return names
}

/** 今の決め方の字（「A（点線）。」「A。」→ A） */
export function nowLetterOf(text) {
  const m = /^([A-Z])(?=[（(。、\s]|$)/.exec(text ?? '')
  return m ? m[1] : null
}

/** 控えの絵の名前から、外観を外した名前（例 top-L-white → top-L、q1-emphasis-card-A-dark → q1-emphasis-card-A） */
function baseName(part) {
  return part.file.replace(/\.jpg$/, '').slice(0, -(part.appearance.length + 1))
}

const byAppearance = (a, b) => APPEARANCES.indexOf(a.appearance) - APPEARANCES.indexOf(b.appearance)

function img(part, sizes, alt) {
  const size = sizes[part.file]
  const w = size ? Math.round(size.width / 2) : null
  const h = size ? Math.round(size.height / 2) : null
  const dims = size ? ` width="${w}" height="${h}"` : ''
  return (
    `<button type="button" class="zoom"${w ? ` style="max-width: ${w}px"` : ''} data-src="${escapeHtml(part.file)}" data-w="${w ?? ''}" data-cap="${escapeHtml(alt)}">` +
    `<img src="${escapeHtml(part.file)}" alt="${escapeHtml(alt)}"${dims} loading="lazy" decoding="async"></button>`
  )
}

function shotBlock(key, shots, sizes, baseNow, headingLevel = 3) {
  const list = shots.filter((p) => baseName(p) === key).sort(byAppearance)
  if (!list.length) return ''
  const first = list[0]
  const tag = `h${headingLevel}`
  const when = first.now !== baseNow ? nowText(first.now).time : null
  const figures = list
    .map((p) => {
      const alt = `${p.title}${when ? `（${when}）` : ''}・${SIZE_NAMES[p.size]}・${APPEARANCE_NAMES[p.appearance]}`
      return `<figure data-ap="${p.appearance}">${img(p, sizes, alt)}<figcaption>${APPEARANCE_NAMES[p.appearance]}</figcaption></figure>`
    })
    .join('')
  return (
    `<article class="shot" data-size="${first.size}">` +
    `<${tag}>${escapeHtml(first.title)} <span class="size">${SIZE_NAMES[first.size]}</span>` +
    `${when ? ` <span class="when">${escapeHtml(when)}</span>` : ''}</${tag}>` +
    `<div class="trio">${figures}</div></article>`
  )
}

function cropBlock(question, cropId, crops, sizes, optionNames, nowLetter) {
  const list = crops.filter((p) => p.question === question && p.id === cropId)
  if (!list.length) return ''
  const first = list[0]
  const width = sizes[first.file] ? sizes[first.file].width / 2 : 0
  const columns = [...new Set(list.map((p) => p.appearance))].sort((a, b) => APPEARANCES.indexOf(a) - APPEARANCES.indexOf(b))
  const cols = columns
    .map((ap) => {
      const inCol = list.filter((p) => p.appearance === ap).sort((a, b) => a.letter.localeCompare(b.letter))
      const reference = inCol.every((p) => p.reference)
      const figures = inCol
        .map((p) => {
          const isNow = p.option === 'now'
          const name = optionNames[p.letter] ?? p.label
          const alt = `${p.title}・${p.letter} ${name}・${APPEARANCE_NAMES[p.appearance]}`
          const head =
            `<figcaption><span class="letter">${escapeHtml(p.letter)}</span><span class="opt-name">${escapeHtml(name)}</span>` +
            `${isNow && p.letter === nowLetter ? '<span class="now">今の決め方</span>' : ''}</figcaption>`
          return `<figure class="opt">${head}${img(p, sizes, alt)}</figure>`
        })
        .join('')
      const apName = `${APPEARANCE_NAMES[ap]}${reference ? '（見比べ用。今の形だけ）' : ''}`
      return `<div class="col" data-ap="${ap}"><p class="ap">${escapeHtml(apName)}</p>${figures}</div>`
    })
    .join('')
  const wide = width > WIDE_CROP ? ' wide' : ''
  return `<div class="crop${wide}"><h4>${escapeHtml(first.title)}</h4><div class="cols">${cols}</div></div>`
}

/** いちばん多い値（同じ数なら先に出た物） */
function mostCommon(values) {
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best = null
  for (const [v, n] of counts) if (best === null || n > counts.get(best)) best = v
  return best
}

/** 見本のページの中身（頭を付けない形）と、手元で開く文書を作る */
export function buildSheet({ parts, sizes, doc }) {
  const { questions, notes } = parseLooksDoc(doc)
  const shots = parts.filter((p) => p.kind === 'shot').sort((a, b) => a.order - b.order || byAppearance(a, b))
  const crops = parts.filter((p) => p.kind === 'crop').sort((a, b) => a.order - b.order || byAppearance(a, b))
  const shotKeys = [...new Set(shots.map(baseName))]
  const baseNow = mostCommon(parts.map((p) => p.now))
  if (!baseNow) throw new Error('撮った時の時刻（控えの now）がありません')
  const lateTimes = [...new Set(parts.map((p) => p.now).filter((n) => n !== baseNow))].map((n) => nowText(n).time)

  const known = new Set(GROUPS.flatMap((g) => g.ids))
  const groups = [
    ...GROUPS,
    // 一覧に無い画面（撮る物を足して、ここを直し忘れた時）も落とさずに出す
    { title: 'そのほか', ids: [...new Set(shots.map((p) => p.id))].filter((id) => !known.has(id)) },
  ]
    .map((g) => {
      const keys = shotKeys.filter((k) => g.ids.includes(shots.find((p) => baseName(p) === k).id))
      if (!keys.length) return ''
      return `<section class="group"><h3 class="group-title">${g.title}</h3>${keys.map((k) => shotBlock(k, shots, sizes, baseNow, 4)).join('')}</section>`
    })
    .join('')

  const questionSections = questions
    .map((q) => {
      const optionNames = optionNamesOf(q.fields['選ぶ物'])
      const nowLetter = nowLetterOf(q.fields['今の決め方'])
      const rows = q.order
        .map((f) => {
          const sub = q.items[f].length ? `<ul>${q.items[f].map((t) => `<li>${inline(t)}</li>`).join('')}</ul>` : ''
          return `<dt>${escapeHtml(f)}</dt><dd${f === '今の決め方' ? ' class="current"' : ''}>${inline(q.fields[f])}${sub}</dd>`
        })
        .join('')
      const shotPictures = (QUESTION_SHOTS[q.number] ?? []).map((key) => shotBlock(key, shots, sizes, baseNow, 4)).join('')
      const cropIds = [...new Set(crops.filter((p) => p.question === q.number).map((p) => p.id))]
      const cropPictures = cropIds.map((id) => cropBlock(q.number, id, crops, sizes, optionNames, nowLetter)).join('')
      return (
        `<section class="question" id="q${q.number}">` +
        `<h2><span class="qmark">■${q.number}</span> ${escapeHtml(q.title)}</h2>` +
        `<dl class="fields">${rows}</dl>${shotPictures}${cropPictures}</section>`
      )
    })
    .join('')

  const toc = [
    '<a href="#screens">画面</a>',
    ...questions.map((q) => `<a href="#q${q.number}">■${q.number} ${escapeHtml(q.title.replace(/（.*?）/g, ''))}</a>`),
    '<a href="#notes">お知らせ</a>',
  ].join('')

  const bullets = (items) => `<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`
  const now = nowText(baseNow).full
  const late = lateTimes.length ? `（20:00版の場面など、時刻を添えた絵は ${lateTimes.join('・')}）` : ''

  const head = `<title>Topic Studio 段階2の見本</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;500&display=swap">
<style>${CSS}</style>`

  const fixes = notes.fixes.length
    ? `<h2>見本に写っているが、こちらで直す所</h2><p class="small">答えは要りません。</p>${bullets(notes.fixes)}`
    : ''
  const body = `<div class="page" id="page" data-show="all">
<header class="intro">
<p class="eyebrow">Topic Studio · 段階2 画面</p>
<h1>見本の画面</h1>
<p class="lead">作り物の版で撮った画面です。今は <b>${escapeHtml(now)}</b> としています${escapeHtml(late)}。話題・社・地名はすべて作り物です。開発の機械で撮ったので、字の形は iPhone などの実機と少し違います。絵を押すと大きく出ます。</p>
${notes.howTo.map((t) => `<p class="lead">${inline(t)}</p>`).join('\n')}
<nav class="toc" aria-label="目次">${toc}</nav>
</header>
<div class="bar" role="group" aria-label="外観で絞る">
<span class="bar-label">外観</span>
<button type="button" data-show="all" aria-pressed="true">すべて</button>
${APPEARANCES.map((a) => `<button type="button" data-show="${a}" aria-pressed="false">${APPEARANCE_NAMES[a]}</button>`).join('\n')}
</div>
<main>
<section class="screens" id="screens"><h2>画面</h2>${groups}</section>
${questionSections}
<section class="notes" id="notes">
${fixes}
<h2>お知らせ</h2><p class="small">答えは要りません。違う時だけ一言ください。</p>${bullets(notes.notices)}
</section>
</main>
</div>
<div class="lb" id="lb" hidden role="dialog" aria-modal="true" aria-labelledby="lb-cap">
<div class="lb-bar"><span class="lb-cap" id="lb-cap"></span><button type="button" class="lb-size" id="lb-size" aria-pressed="false">実寸</button><button type="button" class="lb-close" id="lb-close" aria-label="閉じる">✕</button></div>
<div class="lb-scroll" id="lb-scroll"><img class="lb-img" id="lb-img" alt=""></div>
</div>
<script>${SCRIPT}</script>`

  const page = `${head}\n${body}\n`
  const index = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${head}
</head>
<body>
${body}
</body>
</html>
`
  return { page, index, questions, notes }
}

// 見本のページの見た目。TS の外観（グレーの地に、グレーの差し色）に合わせ、絵が主役になるよう面と線は控えめにする（DS のページの作りのまま、
// 差し色を DS の紺から TS のグレーにした）。並び: 細い縦の列（最大 1180px）。上に目次、外観の絞り込みの帯（上に留まる）、画面の一覧、
// 問いの節、直す所・お知らせ。1つの外観だけの切り抜き（■12 はホワイトだけ）は、列を広げて大きく出す
const CSS = `
:root {
  --bg: #f6f6f4; --surface: #ffffff; --ink: #25282e; --muted: #5c6068; --line: #dcdcd7;
  --accent: #4f5259; --accent-soft: #e8e8e5; --shade: rgba(16, 18, 22, 0.95);
  --font: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif;
  --mono: "Roboto Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #101113; --surface: #17181b; --ink: #e6e5e1; --muted: #a8aab0; --line: #2a2c31;
    --accent: #bcbdc1; --accent-soft: #222428; --shade: rgba(4, 5, 6, 0.96); color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #101113; --surface: #17181b; --ink: #e6e5e1; --muted: #a8aab0; --line: #2a2c31;
  --accent: #bcbdc1; --accent-soft: #222428; --shade: rgba(4, 5, 6, 0.96); color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.7 var(--font); }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--bg); }
.page { max-width: 1180px; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 24px 64px; }
h1, h2, h3, h4 { text-wrap: balance; margin: 0; line-height: 1.35; }
h1 { font-size: 30px; font-weight: 700; letter-spacing: 0.02em; }
h2 { font-size: 21px; font-weight: 700; }
h3 { font-size: 17px; font-weight: 600; }
h4 { font-size: 15px; font-weight: 600; }
.eyebrow { font: 500 12px/1.4 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 6px; }
.intro { display: grid; gap: 10px; margin-bottom: 18px; }
.lead { margin: 0; max-width: 46em; }
.small { margin: 0; color: var(--muted); font-size: 13px; }
.toc { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; margin-top: 4px; }
.toc a { color: var(--accent); text-decoration: none; }
.toc a:hover, .toc a:focus-visible { text-decoration: underline; }
.bar { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  padding-block: 10px; margin-bottom: 8px; background: var(--bg); border-bottom: 1px solid var(--line); }
.bar-label { font: 500 12px/1 var(--mono); color: var(--muted); letter-spacing: 0.06em; margin-right: 4px; }
.bar button { font: inherit; font-size: 13px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 999px;
  padding: 4px 12px; cursor: pointer; min-height: 32px; }
.bar button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--surface); }
button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
main { display: grid; gap: 48px; }
.screens, .question, .notes { display: grid; gap: 18px; min-width: 0; scroll-margin-top: 64px; }
.group { display: grid; gap: 22px; }
.group-title { font-size: 13px; font-weight: 600; color: var(--muted); letter-spacing: 0.06em; padding-top: 6px; border-top: 1px solid var(--line); }
.shot { display: grid; gap: 8px; min-width: 0; }
.size, .when { font: 400 12px/1 var(--mono); color: var(--muted); margin-left: 6px; }
.when { border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; }
.trio { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); }
.shot[data-size="S"] .trio { grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 240px)); }
figure { margin: 0; display: grid; gap: 4px; min-width: 0; align-content: start; }
figcaption { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.zoom { display: block; padding: 0; margin: 0; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--surface);
  cursor: zoom-in; width: 100%; line-height: 0; }
.zoom img { width: 100%; height: auto; display: block; }
.qmark { font-family: var(--mono); color: var(--accent); }
.fields { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; max-width: 52em; }
.fields dt { font-size: 13px; color: var(--muted); padding-top: 2px; }
.fields dd { margin: 0; min-width: 0; }
.fields dd ul { margin: 4px 0 0; padding-left: 1.2em; display: grid; gap: 2px; }
.fields dd.current { font-weight: 600; }
.crop { display: grid; gap: 8px; min-width: 0; }
.cols { display: grid; gap: 14px 16px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); }
.crop.wide .cols { grid-template-columns: 1fr; }
.cols:has(> .col:only-child) { grid-template-columns: minmax(0, 600px); }
.col { display: grid; gap: 10px; align-content: start; min-width: 0; }
.ap { margin: 0; font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: 0.04em; }
.letter { font: 500 12px/1 var(--mono); display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 4px;
  background: var(--ink); color: var(--surface); }
.opt-name { color: var(--ink); }
.now { font-size: 11px; color: var(--ink); background: var(--accent-soft); border-radius: 999px; padding: 1px 8px; }
.notes ul { margin: 0; padding-left: 1.2em; display: grid; gap: 6px; max-width: 52em; }
.notes h2 + .small { margin-top: -12px; }
.page[data-show="white"] [data-ap]:not([data-ap="white"]),
.page[data-show="dark"] [data-ap]:not([data-ap="dark"]),
.page[data-show="deep-dark"] [data-ap]:not([data-ap="deep-dark"]) { display: none; }
.page:not([data-show="all"]) .shot[data-size="S"] .trio { grid-template-columns: minmax(0, 390px); }
.lb { position: fixed; inset: 0; z-index: 20; background: var(--shade); display: grid; grid-template-rows: auto 1fr; }
.lb[hidden] { display: none; }
.lb-bar { display: flex; align-items: center; gap: 8px; color: #f2f3f5;
  padding: calc(env(safe-area-inset-top, 0px) + 8px) max(16px, env(safe-area-inset-right, 0px)) 8px max(16px, env(safe-area-inset-left, 0px)); }
.lb-cap { flex: 1; min-width: 0; font-size: 13px; }
.lb-bar button { font: inherit; font-size: 13px; color: #f2f3f5; background: transparent; border: 1px solid rgba(255,255,255,0.4); border-radius: 999px;
  padding: 4px 12px; min-height: 34px; cursor: pointer; }
.lb-bar button[aria-pressed="true"] { background: #f2f3f5; color: #25282e; }
.lb-scroll { overflow: auto; overscroll-behavior: contain; padding: 0 max(16px, env(safe-area-inset-right, 0px)) calc(env(safe-area-inset-bottom, 0px) + 16px) max(16px, env(safe-area-inset-left, 0px)); }
.lb-img { display: block; margin: 0 auto; max-width: 100%; height: auto; border-radius: 4px; }
.lb.actual .lb-img { max-width: none; }
@media (max-width: 560px) {
  h1 { font-size: 25px; }
  .bar-label { display: none; }
  .bar button { padding: 4px 10px; }
  .fields { grid-template-columns: 1fr; gap: 2px; }
  .fields dd { margin-bottom: 8px; }
}
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
`

// 外観で絞る（見る人のブラウザだけに覚える）・絵を押すと大きく出す（［実寸］で倍率 1 の大きさ。Esc・✕・地を押すと閉じる）
const SCRIPT = `
(function () {
  var page = document.getElementById('page');
  var KEY = 'ts-samples-show';
  var buttons = document.querySelectorAll('.bar button');
  function show(value) {
    page.setAttribute('data-show', value);
    buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-show') === value)); });
  }
  try { var saved = localStorage.getItem(KEY); if (saved && document.querySelector('.bar button[data-show="' + saved + '"]')) show(saved); } catch (e) {}
  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      var value = b.getAttribute('data-show');
      show(value);
      try { localStorage.setItem(KEY, value); } catch (e) {}
    });
  });

  var lb = document.getElementById('lb');
  var lbImg = document.getElementById('lb-img');
  var lbCap = document.getElementById('lb-cap');
  var lbSize = document.getElementById('lb-size');
  var lbClose = document.getElementById('lb-close');
  var lbScroll = document.getElementById('lb-scroll');
  var opener = null;
  function setActual(on, w) {
    lb.classList.toggle('actual', on);
    lbSize.setAttribute('aria-pressed', String(on));
    lbImg.style.width = on && w ? w + 'px' : '';
  }
  function open(btn) {
    opener = btn;
    lbImg.src = btn.getAttribute('data-src');
    lbImg.alt = btn.getAttribute('data-cap');
    lbImg.setAttribute('data-w', btn.getAttribute('data-w') || '');
    lbCap.textContent = btn.getAttribute('data-cap');
    setActual(false);
    lb.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    lbScroll.scrollTop = 0;
    lbScroll.scrollLeft = 0;
    lbClose.focus();
  }
  function close() {
    lb.hidden = true;
    lbImg.removeAttribute('src');
    document.documentElement.style.overflow = '';
    if (opener) opener.focus();
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.zoom');
    if (btn) open(btn);
  });
  lbClose.addEventListener('click', close);
  lbSize.addEventListener('click', function () {
    setActual(lbSize.getAttribute('aria-pressed') !== 'true', lbImg.getAttribute('data-w'));
  });
  lbScroll.addEventListener('click', function (e) { if (e.target === lbScroll) close(); });
  document.addEventListener('keydown', function (e) {
    if (lb.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      var items = [lbSize, lbClose];
      var i = items.indexOf(document.activeElement);
      e.preventDefault();
      items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus();
    }
  });
})();
`

/** 見本の置き場を読んで書く（dir = 絵と parts/ のある所） */
export function writeSheet(dir, docPath) {
  const partsDir = `${dir}/parts`
  if (!existsSync(partsDir))
    throw new Error(`${partsDir} がありません。先に E2E_SAMPLES=1 npx playwright test --project=samples で撮ってください`)
  const parts = readdirSync(partsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(`${partsDir}/${f}`, 'utf8')))
    .filter((p) => existsSync(`${dir}/${p.file}`))
  if (!parts.length) throw new Error(`${dir} に撮った絵がありません`)
  const missing = parts.filter((p) => typeof p.order !== 'number' || typeof p.now !== 'string')
  if (missing.length) throw new Error(`撮り直してください（並びの順か撮った時の時刻の無い控え: ${missing[0].file} など）`)
  const sizes = Object.fromEntries(parts.map((p) => [p.file, jpegSize(readFileSync(`${dir}/${p.file}`))]))
  const { page, index, questions } = buildSheet({ parts, sizes, doc: readFileSync(docPath, 'utf8') })
  writeFileSync(`${dir}/page.html`, page)
  writeFileSync(`${dir}/index.html`, index)
  return { count: parts.length, questions: questions.length }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = samplesOutDir()
  const { count, questions } = writeSheet(dir, `${REPO_ROOT}/docs/STAGE2-LOOKS.md`)
  console.log(`見本のページを書きました: ${dir}/index.html（絵 ${count} 枚・問い ${questions}）`)
}
