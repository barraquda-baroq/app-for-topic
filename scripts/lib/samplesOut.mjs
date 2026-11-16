// 段階2の見本の絵と見本のページを置く所（設計: 段階2の 5.1）。撮る e2e/samples/samples.spec.ts と、見本のページを作る
// scripts/sample-sheet.mjs の2つが、ここの同じ既定の値を使う（DS は2つのファイルに e2e/artifacts/samples を決め打ちしていたので、
// 片方だけ env で替えると、絵は替えた所に出るのに見本のページは古い所・空の所から作られる。それを防ぐため1か所に置く）。
// env の SAMPLES_OUT を渡すと、そこへ書き、そこから読む（リポジトリの外の作業の場所へ書く時。相対の場所はリポジトリの根から）。
// 渡さないと e2e/artifacts/samples（.gitignore の e2e/artifacts の中。絵・ページ・控えはリポジトリに入れない）
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** リポジトリの根 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
/** 既定の置き場（リポジトリの根からの場所） */
export const DEFAULT_SAMPLES_OUT = 'e2e/artifacts/samples'

/** 見本の置き場（絶対の場所）。env.SAMPLES_OUT が空でなければそこ（相対ならリポジトリの根から）、無ければ既定の置き場 */
export function samplesOutDir(env = process.env, root = REPO_ROOT) {
  const given = typeof env.SAMPLES_OUT === 'string' ? env.SAMPLES_OUT.trim() : ''
  return path.resolve(root, given || DEFAULT_SAMPLES_OUT)
}

/** 撮った絵ごとの控え（scripts/sample-sheet.mjs が読む。1枚に1つの JSON）を置く所 */
export function samplesPartsDir(env = process.env, root = REPO_ROOT) {
  return path.join(samplesOutDir(env, root), 'parts')
}
