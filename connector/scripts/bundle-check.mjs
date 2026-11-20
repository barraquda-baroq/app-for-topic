#!/usr/bin/env node
// 公開する形にまとめた中身の確かめ: npm --prefix connector run bundle-check（NS の connector/scripts/bundle-check.mjs を写し、TS の
// 禁じる物を足した。設計の 7. の「公開する形」）。
// 本番の wrangler.jsonc だけを wrangler deploy --dry-run --outdir dist でまとめ（Cloudflare には送らない。テストの入口は入れない）、
// ソースマップで入っているファイルを、まとめた中身で文字を見る。
// - アプリの純粋な部品（src/domain・src/claude・src/sync/codec.ts・appVersion.ts など）だけが入り、
//   dexie・firebase・react・zustand、アプリの画面・端末内の保存・同期のエンジンは入っていない
// - テストの物（src/test/・connector/test/）が入っていない。作り物の名前（FAKE_ の名前・作り物の社の名前）も、ブラウザの名前
//   （Mozilla/。コネクタは取りに行く時にブラウザを名乗らない）も、まとめた中身に無い
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { connectorDir, repoDir, say, wrangler } from './lib.mjs'

const FORBIDDEN_PACKAGES = [
  'dexie',
  'firebase',
  '@firebase',
  'react',
  'react-dom',
  'react-router',
  'react-router-dom',
  'zustand',
  'idb',
]
const FORBIDDEN_APP = [
  /^src\/(store|db|features|ui|test)\//,
  /^src\/sync\/(engine|firebase|firestore|controller|appModel|syncView|syncPlan|batch|owner)\.ts$/,
  /^src\/(App|main|routes)\.tsx?$/,
  /^connector\/test\//,
]

/** 作り物の名前の伏せ字（〇〇省・△△庁・□□ボイス・××ニュース・◇◇日報・▽▽府・▲▲台 など） */
const FAKE_MARK = /[〇○△▽▲□■◇◆×✕●]/

/**
 * 作り物の社の一覧（src/test/fixtures/fakeOutlets.ts）の社の名前。ファイルの中の文字列（'…'）のうち、伏せ字を含む3字以上の物を
 * すべて読む（name: '…' のほか、FAKE_CREDIT_OUTLETS の site: '〇〇省' のように定数から名前を引く書き方・別名・サイトの名前も拾う）。
 * 短い ASCII の語や2字の伏せ字（別名の 〇〇）には当てない。読めなければ空
 */
export function fakeOutletNames(file = path.join(repoDir, 'src', 'test', 'fixtures', 'fakeOutlets.ts')) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const names = new Set()
  for (const m of text.matchAll(/'([^'\n]+)'/g)) if (FAKE_MARK.test(m[1]) && Array.from(m[1]).length >= 3) names.add(m[1])
  return [...names]
}

/** まとめた中身に入ってはいけない文字（作り物の名前・ブラウザの名前） */
export function forbiddenTexts(names = fakeOutletNames()) {
  return ['FAKE_', 'fake-writer-model', 'fake-checker-model', 'Mozilla/', ...names]
}

/** ソースマップの sources からリポジトリの直下からの相対パスにする */
export function bundleProblems(sources, repoRoot) {
  const problems = []
  const app = []
  for (const s of sources) {
    const abs = path.resolve(connectorDir, 'dist', s)
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/')
    const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(rel)
    if (nm && FORBIDDEN_PACKAGES.includes(nm[1])) problems.push(rel)
    if (!rel.includes('node_modules/')) {
      if (!rel.startsWith('connector/')) app.push(rel)
      if (FORBIDDEN_APP.some((re) => re.test(rel))) problems.push(rel)
    }
  }
  return { problems, app }
}

/**
 * まとめた中身の \uXXXX・\u{XXXXX} の書き換えを戻す。wrangler（esbuild）は ASCII でない文字を \uXXXX（16進は大文字）に書き換えて出すので、
 * そのままでは日本語の名前（作り物の社の名前）を見つけられない
 */
export function unescapeBundle(code) {
  return code
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (m, h) => {
      const n = parseInt(h, 16)
      return n <= 0x10ffff ? String.fromCodePoint(n) : m
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

/** まとめた中身（code）に入っている、入ってはいけない文字（書き換えたままの形と、書き換えを戻した形の両方で見る） */
export function textProblems(code, texts = forbiddenTexts()) {
  const plain = unescapeBundle(code)
  return texts.filter((t) => code.includes(t) || plain.includes(t))
}

export async function bundleCheck({ quiet = false } = {}) {
  const outdir = path.join(connectorDir, 'dist')
  fs.rmSync(outdir, { recursive: true, force: true })
  // 本番の設定（wrangler.jsonc）だけをまとめる
  const r = await wrangler(['deploy', '--dry-run', '--outdir', 'dist', '--config', 'wrangler.jsonc'], {
    capture: true,
    quiet: true,
  })
  if (r.code !== 0) {
    say(r.stdout)
    say(r.stderr)
    say('✗ まとめられませんでした（wrangler deploy --dry-run）')
    return { ok: false }
  }
  const map = JSON.parse(fs.readFileSync(path.join(outdir, 'index.js.map'), 'utf8'))
  const code = fs.readFileSync(path.join(outdir, 'index.js'), 'utf8')
  const size = fs.statSync(path.join(outdir, 'index.js')).size
  const { problems, app } = bundleProblems(map.sources ?? [], repoDir)
  const texts = textProblems(code)
  if (!quiet) {
    say(`  まとめた大きさ: ${(size / 1024).toFixed(0)} KiB（${(map.sources ?? []).length} ファイル。アプリの部品 ${app.length}）`)
    for (const a of app) say(`    - ${a}`)
  }
  if (problems.length || texts.length) {
    say('✗ 入ってはいけないものが入っています:')
    for (const p of problems) say(`    ${p}`)
    for (const t of texts) say(`    文字「${t}」`)
    return { ok: false, problems, texts, app, size }
  }
  say(
    '  ✓ dexie・firebase・react・zustand とアプリの画面・同期のエンジン・テストの物・作り物の名前・ブラウザの名前は入っていません',
  )
  return { ok: true, problems, texts, app, size }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = await bundleCheck()
  if (!r.ok) process.exitCode = 1
}
