// @vitest-environment node
// 段階2の見本のページ（scripts/sample-sheet.mjs）: 問いの文を docs/STAGE2-LOOKS.md から読み、撮った絵を1枚も落とさずに並べ、字を HTML として
// 壊さないこと、見本の置き場（SAMPLES_OUT）を撮る側と同じ所にすること（設計: 段階2の 5.6。DS の scripts/sample-sheet.test.mjs から）。
// 絵そのものはブラウザで撮るので、ここでは控え（parts）の形と、小さな作り物の JPEG だけを使う
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SAMPLES_OUT, REPO_ROOT, samplesOutDir, samplesPartsDir } from './lib/samplesOut.mjs'
import {
  GROUPS,
  QUESTION_SHOTS,
  buildSheet,
  escapeHtml,
  jpegSize,
  nowLetterOf,
  nowText,
  optionNamesOf,
  parseLooksDoc,
  writeSheet,
} from './sample-sheet.mjs'

const doc = readFileSync(new URL('../docs/STAGE2-LOOKS.md', import.meta.url), 'utf8')
const APPEARANCES = ['white', 'dark', 'deep-dark']
const NOW = '2026-11-15T14:10:00+09:00'
const LATE = '2026-11-15T20:40:00+09:00'

function shot(order, id, size, title, part = null, now = NOW) {
  return APPEARANCES.map((appearance) => ({
    file: `${id}-${size}${part ? `-${part}` : ''}-${appearance}.jpg`,
    kind: 'shot',
    order,
    id,
    size,
    part,
    title,
    appearance,
    now,
  }))
}

function crop(order, question, id, title, options, appearances = APPEARANCES) {
  const out = []
  for (const appearance of appearances) {
    for (const [letter, option, label] of options) {
      out.push({
        file: `q${question}-${id}-${letter}-${appearance}.jpg`,
        kind: 'crop',
        order,
        question,
        id,
        title,
        letter,
        option,
        label,
        appearance,
        reference: false,
        now: NOW,
      })
    }
  }
  return out
}

const EMPHASIS = [
  ['A', 'now', '今'],
  ['C', 'emphasis-darker', '暗め'],
]
const MAJOR = [
  ['A', 'now', '札＋線'],
  ['B', 'major-badge', '札だけ'],
  ['C', 'major-bigger', '大きく'],
]

const parts = [
  ...shot(0, 'top', 'L', 'トップ（国内｜世界）'),
  ...shot(1, 'top', 'S', 'トップ（総合の頭）'),
  ...shot(6, 'detail-major', 'S', '詳細（1位）上', 'top'),
  ...shot(30, 'status-failed', 'S', '「20:00版は作れませんでした（使用量の上限）」', null, LATE),
  ...shot(44, 'brand-new', 'S', '一覧に足し忘れた画面'),
  ...crop(0, 1, 'emphasis-card', '一覧のカードの要約', EMPHASIS),
  ...crop(3, 3, 'major-card', '1位のカード', MAJOR),
  ...crop(
    9,
    12,
    'sync-synced-S',
    '同期済み（スマホ）',
    [
      ['A', 'now', '今'],
      ['B', 'sync-text', '字だけ'],
    ],
    ['white'],
  ),
]
const sizes = Object.fromEntries(parts.map((p) => [p.file, { width: 1000, height: 400 }]))

describe('問いの文（docs/STAGE2-LOOKS.md）', () => {
  const { questions, notes } = parseLooksDoc(doc)

  it('■1〜■14 を順に読み、どの問いにも「見る所」と「今の決め方」がある', () => {
    expect(questions.map((q) => q.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    for (const q of questions) {
      expect(q.fields['見る所'], `■${q.number}`).toBeTruthy()
      expect(q.fields['今の決め方'], `■${q.number}`).toBeTruthy()
      expect(q.fields['答えが来るまで'], `■${q.number}`).toBeTruthy()
    }
  })

  it('どの問いも選ぶ物があり、今の決め方がその中の1つ（A〜Z の字で読む。■4・■7 の D も読む）', () => {
    for (const q of questions) {
      const names = optionNamesOf(q.fields['選ぶ物'])
      const letter = nowLetterOf(q.fields['今の決め方'])
      expect(Object.keys(names).length, `■${q.number}`).toBeGreaterThanOrEqual(2)
      expect(names[letter], `■${q.number} の今の決め方 ${letter}`).toBeTruthy()
    }
    const byNumber = Object.fromEntries(questions.map((q) => [q.number, q]))
    expect(Object.keys(optionNamesOf(byNumber[4].fields['選ぶ物']))).toEqual(['A', 'B', 'C', 'D'])
    expect(optionNamesOf(byNumber[7].fields['選ぶ物'])).toMatchObject({ A: '反対の列に重ねる', D: '真ん中の小さな画面' })
    // ■1 の選ぶ物の括弧の中（ダーク・ディープダークだけ）は、名前に入れない
    expect(optionNamesOf(byNumber[1].fields['選ぶ物'])).toEqual({ A: '今', B: '明るめ', C: '暗め' })
  })

  it('見出しの下の箇条（■11 の言葉・■12 の8つの状態）と、書いてある見出し（■8 の「出す境とさかのぼる幅」）を落とさない', () => {
    const byNumber = Object.fromEntries(questions.map((q) => [q.number, q]))
    expect(byNumber[11].items['見る所']).toHaveLength(7)
    expect(byNumber[11].items['見る所'][0]).toContain('「版を受け取っています…」')
    expect(byNumber[12].items['見る所']).toHaveLength(3)
    expect(byNumber[8].order).toEqual(['見る所', '出す境とさかのぼる幅', '選ぶ物', '今の決め方', '答えが来るまで'])
  })

  it('答え方とお知らせを読む。お知らせには作者の答え（強調 A・クリップ A・別のアカウントの文）と、仕様と違う所を書いてある', () => {
    expect(notes.howTo.join('')).toContain('「このまま」か A・B・C')
    const notices = notes.notices.join('\n')
    expect(notices).toContain('本文の強調は A')
    expect(notices).toContain('［クリップ］で写す文は A')
    expect(notices).toContain('別のアカウント')
    for (const word of ['共通の注記', '「そのほか」', '600px 未満', '行き先', 'ジャンルには色を付けません', '［取り消す］'])
      expect(notices, word).toContain(word)
  })

  it('今の決め方の字: 「A（…）。」「A。」を読み、字で始まらない文は読まない', () => {
    expect(nowLetterOf('A（点線）。')).toBe('A')
    expect(nowLetterOf('A。')).toBe('A')
    expect(nowLetterOf('D（聞き直し）')).toBe('D')
    expect(nowLetterOf('今の色のまま')).toBeNull()
    expect(nowLetterOf('AI の文')).toBeNull()
  })
})

describe('見本のページ', () => {
  const { page, index } = buildSheet({ parts, sizes, doc })

  it('撮った絵をすべて、少なくとも1回は並べる（一覧に無い画面も「そのほか」に出す）', () => {
    for (const p of parts) expect(page, p.file).toContain(`src="${p.file}"`)
    expect(page).toContain('<h3 class="group-title">そのほか</h3>')
  })

  it('■1〜■14 の節とお知らせがあり、問いの切り抜きは今の決め方の案に印が付く', () => {
    for (let n = 1; n <= 14; n++) expect(page).toContain(`id="q${n}"`)
    expect(page).toContain('id="notes"')
    const q3 = page.slice(page.indexOf('id="q3"'), page.indexOf('id="q4"'))
    expect(q3).toMatch(
      /<span class="letter">A<\/span><span class="opt-name">「重大」の札＋カードの左の太い線<\/span><span class="now">今の決め方<\/span>/,
    )
    expect(q3).not.toMatch(/<span class="letter">B<\/span><span class="opt-name">[^<]*<\/span><span class="now">/)
    // ■1 のホワイトは A・C だけ（撮っていない B を出さない）
    const q1 = page.slice(page.indexOf('id="q1"'), page.indexOf('id="q2"'))
    expect(q1).not.toContain('q1-emphasis-card-B-white.jpg')
  })

  it('見出しの下の箇条と太字（**…**）を、HTML として壊さずに出す', () => {
    const q8 = page.slice(page.indexOf('id="q8"'), page.indexOf('id="q9"'))
    expect(q8).toContain('<b>2つ以上</b>')
    expect(q8).toContain('<dt>出す境とさかのぼる幅</dt>')
    const q11 = page.slice(page.indexOf('id="q11"'), page.indexOf('id="q12"'))
    expect(q11).toContain('<li>「版を受け取っています…」（出せる版がまだ1つも無い時。見本の status-receiving）</li>')
  })

  it('「今は …」は撮った時の時刻から作り、ほかの時刻で撮った絵にはその時刻を添える', () => {
    expect(page).toContain('今は <b>2026年11月15日（日）14:10</b> としています')
    expect(page).toContain('時刻を添えた絵は 20:40')
    const failed = page.slice(page.indexOf('status-failed-S-white.jpg') - 600, page.indexOf('status-failed-S-white.jpg'))
    expect(failed).toContain('<span class="when">20:40</span>')
    expect(nowText('2026-11-14T08:05:00+09:00')).toEqual({ full: '2026年11月14日（土）08:05', time: '08:05' })
  })

  it('送る形は文書の頭を持たず、手元で開く形は持つ。題は「Topic Studio 段階2の見本」で、外観の絞り込みは ts-samples-show に覚える', () => {
    expect(page).not.toMatch(/<!doctype|<html|<head>|<body/i)
    expect(page.slice(0, 200)).toContain('<title>Topic Studio 段階2の見本</title>')
    expect(page).toContain("var KEY = 'ts-samples-show'")
    expect(index).toMatch(/^<!doctype html>/)
    expect(index).toContain('<html lang="ja">')
  })

  it('絵の大きさは撮った大きさの半分（倍率 2 で撮っている）', () => {
    expect(page).toContain('src="top-L-white.jpg" alt="トップ（国内｜世界）・PC 1400×900・ホワイト" width="500" height="200"')
  })

  it('問いに添える画面の絵の名前は、画面の一覧の分け方にある画面の物', () => {
    const ids = new Set(GROUPS.flatMap((g) => g.ids))
    for (const [n, keys] of Object.entries(QUESTION_SHOTS))
      for (const key of keys)
        expect(
          [...ids].some((id) => key.startsWith(`${id}-`)),
          `■${n} ${key}`,
        ).toBe(true)
  })
})

describe('見本の置き場（SAMPLES_OUT）', () => {
  const made = []
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('渡さないと e2e/artifacts/samples（撮る e2e/samples/samples.spec.ts と同じ値）、渡すとそこ（相対はリポジトリの根から）', () => {
    expect(DEFAULT_SAMPLES_OUT).toBe('e2e/artifacts/samples')
    expect(samplesOutDir({})).toBe(path.join(REPO_ROOT, 'e2e', 'artifacts', 'samples'))
    expect(samplesOutDir({ SAMPLES_OUT: '  ' })).toBe(path.join(REPO_ROOT, 'e2e', 'artifacts', 'samples'))
    expect(samplesOutDir({ SAMPLES_OUT: '/tmp/somewhere' })).toBe('/tmp/somewhere')
    expect(samplesOutDir({ SAMPLES_OUT: 'out/try' })).toBe(path.join(REPO_ROOT, 'out', 'try'))
    expect(samplesPartsDir({ SAMPLES_OUT: '/tmp/somewhere' })).toBe('/tmp/somewhere/parts')
    // 撮る側も同じ関数で置き場を決める
    const spec = readFileSync(new URL('../e2e/samples/samples.spec.ts', import.meta.url), 'utf8')
    expect(spec).toContain("import { samplesOutDir } from '../../scripts/lib/samplesOut.mjs'")
    expect(spec).toContain('const OUT = samplesOutDir()')
  })

  it('渡した置き場の絵と控えを読み、そこに page.html と index.html を書く', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ts-samples-'))
    made.push(dir)
    mkdirSync(path.join(dir, 'parts'))
    // SOI, APP0（長さ 4）, SOF0（高さ 0x0100 = 256, 幅 0x0200 = 512）
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03,
    ])
    for (const p of shot(0, 'top', 'S', 'トップ')) {
      writeFileSync(path.join(dir, p.file), jpeg)
      writeFileSync(path.join(dir, 'parts', p.file.replace(/\.jpg$/, '.json')), JSON.stringify(p))
    }
    const docPath = path.join(dir, 'looks.md')
    writeFileSync(docPath, doc)
    expect(writeSheet(samplesOutDir({ SAMPLES_OUT: dir }), docPath)).toEqual({ count: 3, questions: 14 })
    const page = readFileSync(path.join(dir, 'page.html'), 'utf8')
    expect(page).toContain('src="top-S-white.jpg" alt="トップ・スマホ 390×844・ホワイト" width="256" height="128"')
    expect(readFileSync(path.join(dir, 'index.html'), 'utf8')).toMatch(/^<!doctype html>/)
  })

  it('控えの無い置き場・撮った時の時刻の無い控えは、撮り直すように言って止まる', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ts-samples-'))
    made.push(dir)
    expect(() => writeSheet(dir, path.join(REPO_ROOT, 'docs', 'STAGE2-LOOKS.md'))).toThrow(/撮ってください/)
    mkdirSync(path.join(dir, 'parts'))
    const [p] = shot(0, 'top', 'S', 'トップ')
    writeFileSync(path.join(dir, p.file), Buffer.alloc(4))
    writeFileSync(path.join(dir, 'parts', 'top.json'), JSON.stringify({ ...p, now: undefined }))
    expect(() => writeSheet(dir, path.join(REPO_ROOT, 'docs', 'STAGE2-LOOKS.md'))).toThrow(/撮り直してください/)
  })
})

describe('部品', () => {
  it('escapeHtml は HTML の印になる字を置き換える', () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
  })

  it('jpegSize は SOF0 の印から幅と高さを読む', () => {
    // SOI, APP0（長さ 4）, SOF0（高さ 0x0102 = 258, 幅 0x0304 = 772）
    const buf = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x02, 0x03, 0x04, 0x03,
    ])
    expect(jpegSize(buf)).toEqual({ width: 772, height: 258 })
  })
})
