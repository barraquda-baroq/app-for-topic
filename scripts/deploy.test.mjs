// @vitest-environment node
// 公開の前の確かめ（scripts/deploy.mjs の checkConfig。docs/DEPLOY.md の 1 の 7・docs/SPEC.md の 14.6）と、段階3で戻した Claude 用の
// コネクタの公開の決め方（deployPlan・appEnv。NS の scripts/deploy.mjs と connector/scripts/lib.mjs）。
// 読み込んだだけでは公開を始めない（直接動かした時だけ main が動く）ことも、この読み込みで確かめている
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PLACEHOLDER_PROJECT, appEnv, checkConfig, deployPlan } from './deploy.mjs'

const realConfig = readFileSync(new URL('../src/sync/firebaseConfig.ts', import.meta.url), 'utf8')
const realRc = readFileSync(new URL('../.firebaserc', import.meta.url), 'utf8')

/** 作者が差し替えた後の形（値は例） */
const filled = (id = 'topic-studio-1a2b3', quote = "'") =>
  [
    'export const firebaseConfig = {',
    `  apiKey: ${quote}AIzaSyExampleExampleExampleExample00${quote},`,
    `  authDomain: ${quote}${id}.firebaseapp.com${quote},`,
    `  projectId: ${quote}${id}${quote},`,
    `  appId: ${quote}1:123456789012:web:abcdef0123456789${quote},`,
    '}',
  ].join('\n')
const rc = (id = 'topic-studio-1a2b3') => JSON.stringify({ projects: { default: id } })

describe('checkConfig（公開を始めてよいか）', () => {
  it('差し替えた値で、2つのプロジェクトがそろっていれば公開してよい', () => {
    expect(checkConfig(filled(), rc())).toEqual({ projectId: 'topic-studio-1a2b3', problems: [] })
    // " で書いてあってもよい
    expect(checkConfig(filled('topic-studio-1a2b3', '"'), rc()).problems).toEqual([])
  })

  it('リポジトリの今の値（作者が 2026-11-14 までに作ったプロジェクト topic-studio-1a463）は、公開してよい', () => {
    expect(checkConfig(realConfig, realRc)).toEqual({ projectId: 'topic-studio-1a463', problems: [] })
  })

  it('差し替える前の仮の値（新しいプロジェクトで作り直す時。docs/DEPLOY.md の 1 の 7）は、仮のままの所をすべて挙げて止める', () => {
    const placeholder = filled(PLACEHOLDER_PROJECT).replace(
      /AIzaSyExampleExampleExampleExample00/,
      'REPLACE_WITH_FIREBASE_API_KEY',
    )
    const { projectId, problems } = checkConfig(placeholder, rc(PLACEHOLDER_PROJECT))
    expect(projectId).toBeNull()
    expect(problems.join('\n')).toMatch(/apiKey が仮の値/)
    expect(problems.join('\n')).toMatch(/projectId が仮の値/)
    expect(problems.join('\n')).toMatch(/\.firebaserc のプロジェクトが仮の値/)
    // 形（export の行・半角の引用符）は崩れていない
    expect(problems.join('\n')).not.toMatch(/飾りの引用符|export const firebaseConfig|形が崩れて/)
  })

  it('2つのプロジェクトが食い違っていたら止める', () => {
    const { problems } = checkConfig(filled('topic-studio-1a2b3'), rc('topic-studio-other'))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/食い違っています/)
  })

  it('飾りの引用符（Mac のスマート引用符）は知らせ、値はそのまま読める', () => {
    const { problems } = checkConfig(filled('topic-studio-1a2b3', '‘').replace(/‘,/g, '’,'), rc())
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/飾りの引用符/)
  })

  it('export の行を消した・.firebaserc が壊れている・無い・設定のファイルが無い時も止める', () => {
    expect(checkConfig(filled().replace('export const firebaseConfig = {', '{'), rc()).problems.join('\n')).toMatch(
      /export const firebaseConfig/,
    )
    expect(checkConfig(filled(), '{ "projects": ').problems.join('\n')).toMatch(/形が崩れて/)
    expect(checkConfig(filled(), null).problems.join('\n')).toMatch(/\.firebaserc が見つかりません/)
    expect(checkConfig(null, rc()).problems.join('\n')).toMatch(/firebaseConfig\.ts が見つかりません/)
  })
})

// 段階3: Claude 用のコネクタの公開（NS の scripts/deploy.mjs から戻した。docs/CONNECTOR.md）
describe('deployPlan（何を公開するか）', () => {
  const local = { origin: 'https://topic-studio-connector.example.workers.dev', enableDcr: false }

  it('connector.local.json があれば、アプリ・ルールとコネクタを公開する', () => {
    expect(deployPlan([], local, true)).toEqual({ app: true, connector: 'deploy', notice: null })
    // コマンドの引数は Set でも並びでもよい
    expect(deployPlan(new Set(), local, true)).toEqual({ app: true, connector: 'deploy', notice: null })
  })

  it('--skip-connector はコネクタを公開しない（npm run connector:setup がアプリとルールを公開する時）。--skip-app はコネクタだけ', () => {
    expect(deployPlan(['--skip-connector'], local, true)).toMatchObject({ app: true, connector: 'skip' })
    expect(deployPlan(['--skip-app'], local, true)).toMatchObject({ app: false, connector: 'deploy', notice: null })
  })

  it('connector.local.json が無いパソコンでは、コネクタを公開せず、コネクタの部品が入っていれば先に注意して聞く', () => {
    const plan = deployPlan([], null, true)
    expect(plan.connector).toBe('no-local')
    expect(plan.notice?.join('\n')).toContain('connector.local.json がありません')
    expect(plan.notice?.join('\n')).toContain('コネクタ未設定')
    expect(plan.notice?.join('\n')).toContain('npm run connector:setup')
    // コネクタを使っていない（部品が入っていない）パソコン・アプリを公開しない時は聞かない
    expect(deployPlan([], null, false)).toEqual({ app: true, connector: 'no-local', notice: null })
    expect(deployPlan(['--skip-app'], null, true).notice).toBeNull()
  })

  it('connector.local.json があっても、コネクタの部品が入っていなければ止める', () => {
    expect(deployPlan([], local, false)).toMatchObject({ connector: 'missing-deps' })
    // --skip-connector なら部品が無くてもアプリは公開できる
    expect(deployPlan(['--skip-connector'], local, false)).toMatchObject({ app: true, connector: 'skip' })
  })
})

describe('appEnv（公開するアプリのビルドの環境変数）', () => {
  it('開発用の値（エミュレーター・E2E の持ち主の確かめ・手元のコネクタ）は入れず、コネクタの URL は connector.local.json を優先する', () => {
    const dev = { VITE_FIREBASE_EMULATOR: '127.0.0.1', VITE_E2E_OWNER_LOCK: '1', VITE_CONNECTOR_ORIGIN: 'http://localhost:8787' }
    expect(appEnv(dev, null)).toEqual({
      VITE_FIREBASE_EMULATOR: undefined,
      VITE_E2E_OWNER_LOCK: undefined,
      VITE_CONNECTOR_ORIGIN: undefined,
    })
    expect(appEnv(dev, { origin: 'https://c.example.workers.dev' }).VITE_CONNECTOR_ORIGIN).toBe('https://c.example.workers.dev')
    expect(appEnv({ VITE_CONNECTOR_ORIGIN: 'https://d.example.workers.dev' }, null).VITE_CONNECTOR_ORIGIN).toBe(
      'https://d.example.workers.dev',
    )
    // undefined の値は子の環境から外れる（Node の spawn）
    for (const k of ['VITE_FIREBASE_EMULATOR', 'VITE_E2E_OWNER_LOCK', 'VITE_CONNECTOR_ORIGIN'])
      expect(k in appEnv({}, null)).toBe(true)
  })
})
