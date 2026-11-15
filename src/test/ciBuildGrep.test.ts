// CI のビルドの確かめ（.github/workflows/ci.yml の「ビルドにテスト用の入口と作り物の版が無いことの確かめ」。docs/SPEC.md の 16.3・14.7）が、
// アプリのコードが読む作り物（src/test/fixtures の物）を見逃さないか。公開するビルドに漏れた時は、分けた部品のファイル
// （{ファイルの名前}-{指紋}.js）ができ、中に作り物の社の名前などが残る（関数の名前は縮めると消える）
import { describe, expect, it } from 'vitest'
import { FAKE_VIA } from './fixtures/fakeEditions'
import { FAKE_OUTLET_NAMES } from './fixtures/fakeOutlets'

// node:fs の型はアプリの tsconfig に無いので、名前を変数にして読み込み、使う関数の形だけを書く（src/styles.test.ts と同じ）
const NODE_FS = 'node:fs'
const { readFileSync, readdirSync } = (await import(/* @vite-ignore */ NODE_FS)) as {
  readFileSync: (path: string, encoding: 'utf8') => string
  readdirSync: (path: string, options: { recursive: true }) => string[]
}
/** src/ の場所（import.meta.url のファイルの場所から作る） */
const SRC_DIR = decodeURIComponent(new URL(import.meta.url).pathname).replace(/test\/[^/]*$/, '')
const ci = readFileSync(`${SRC_DIR}../.github/workflows/ci.yml`, 'utf8')
const pattern = /grep -rqE '([^']+)' dist\//.exec(ci)?.[1]
const grep = new RegExp(pattern ?? '(?!)')

/** アプリのコード（src の下の、テストでも src/test でもない物）が値として読む作り物（import type の行は、ビルドで消えるので除く） */
const loadedFixtures = [
  ...new Set(
    readdirSync(SRC_DIR, { recursive: true })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith('test/'))
      .flatMap((f) =>
        readFileSync(`${SRC_DIR}${f}`, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*import\s+type\b/.test(line))
          .flatMap((line) => [...line.matchAll(/'(?:\.\.?\/)+test\/fixtures\/([\w-]+)'/g)].map((m) => m[1])),
      ),
  ),
].sort()

describe('CI のビルドの確かめ（ci.yml の grep）', () => {
  it('grep の式を ci.yml から読める', () => {
    expect(pattern).toBeTruthy()
  })

  it('アプリのコードが読む作り物は、分けた部品のファイルの名前で当たる', () => {
    expect(loadedFixtures).toEqual(['fakeEditions', 'fakeOutlets'])
    for (const name of loadedFixtures) expect([name, grep.test(`assets/${name}-DduJ0qO1.js`)]).toEqual([name, true])
  })

  it('作り物の社の名前（作り物の社の一覧・読んだ所）で当たる', () => {
    for (const name of [...FAKE_OUTLET_NAMES, FAKE_VIA]) expect([name, grep.test(`"${name}"`)]).toEqual([name, true])
  })

  it('ふつうのコードの言葉には当たらない（example.com は firebase の部品にもある）', () => {
    for (const s of ['https://example.com/', 'outlets', 'setTopicOutlets', 'unknown'])
      expect([s, grep.test(s)]).toEqual([s, false])
  })
})
