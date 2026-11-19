// domain の読み込みの向き（docs/SPEC.md の 7.7 の「名札」・段階3の設計の 6.1 の B1）: src/domain の部品（テストでない物）は、同じ所の
// ファイル（'./…'）だけを読む。アプリと段階3のコネクタ（Cloudflare Workers）で同じ物を使うので、sync・store・Firebase・React・作り物
// （src/test）を読まない。例外は editionStatus.ts の型だけの読み込み（'../sync/syncView' の型。ビルドで消える。コネクタは読まない部品）
import { describe, expect, it } from 'vitest'

// node:fs の型はアプリの tsconfig に無いので、名前を変数にして読み込み、使う関数の形だけを書く（src/test/ciBuildGrep.test.ts と同じ）
const NODE_FS = 'node:fs'
const { readFileSync, readdirSync } = (await import(/* @vite-ignore */ NODE_FS)) as {
  readFileSync: (path: string, encoding: 'utf8') => string
  readdirSync: (path: string) => string[]
}
/** src/domain/ の場所 */
const DOMAIN_DIR = decodeURIComponent(new URL(import.meta.url).pathname).replace(/[^/]*$/, '')

/** 読み込みの一覧（import … from '…'・import '…'・export … from '…'・import('…')・require('…')） */
function importsOf(source: string): { spec: string; typeOnly: boolean }[] {
  const out: { spec: string; typeOnly: boolean }[] = []
  const re =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g
  for (const m of source.matchAll(re)) {
    if (m[3] !== undefined) out.push({ spec: m[3], typeOnly: m[2] !== undefined })
    else out.push({ spec: (m[4] ?? m[5]) as string, typeOnly: false })
  }
  return out
}

const files = readdirSync(DOMAIN_DIR)
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  .sort()

describe('domain の読み込みの向き', () => {
  it('部品のファイルを読める（段階3で足した部品も入っている）', () => {
    for (const f of ['assemble.ts', 'credit.ts', 'input.ts', 'patch.ts', 'terms.ts', 'outlets.ts', 'validate.ts'])
      expect(files).toContain(f)
  })

  it("どの部品も './' だけを読む（例外は editionStatus.ts の '../sync/syncView' の型だけ）", () => {
    const outside: string[] = []
    for (const f of files)
      for (const { spec, typeOnly } of importsOf(readFileSync(`${DOMAIN_DIR}${f}`, 'utf8'))) {
        if (spec.startsWith('./') && !spec.slice(2).includes('/')) continue
        if (f === 'editionStatus.ts' && spec === '../sync/syncView' && typeOnly) continue
        outside.push(`${f}: ${spec}${typeOnly ? '（型）' : ''}`)
      }
    expect(outside).toEqual([])
  })

  it('読み込みの一覧を取り出す関数（複数行の import・型だけ・export from・動的な読み込み）', () => {
    const src = [
      "import { a,\n  b } from './x'",
      "import type { T } from '../sync/y'",
      "export { c } from './z'",
      "import './side'",
      "const m = await import('node:fs')",
      "const r = require('firebase')",
    ].join('\n')
    expect(importsOf(src)).toEqual([
      { spec: './x', typeOnly: false },
      { spec: '../sync/y', typeOnly: true },
      { spec: './z', typeOnly: false },
      { spec: './side', typeOnly: false },
      { spec: 'node:fs', typeOnly: false },
      { spec: 'firebase', typeOnly: false },
    ])
  })
})
