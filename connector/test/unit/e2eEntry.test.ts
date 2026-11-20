// E2E のテストの入口（B8。connector/test/e2e/worker.ts と connector/wrangler.e2e.jsonc）が、本番の形から離れていない事の確かめ
// （段階3の設計の 7. の「E2E」: 入口は本番の src/index.ts をそのまま使い、Durable Object の Vault だけを作り物の社・出どころの物に替える）。
// - wrangler.e2e.jsonc は、本番の wrangler.jsonc と名前・入口（main）・vars の値のほかが同じ（互換の日付・フラグ・KV・Durable Object・
//   移し替え・cron）。vars は同じ名前だけ（値はテストが上書きする。本物の Firebase のプロジェクトと鍵は書かない）
// - E2E の Vault は本番の Vault の子の型で、替えるのは VaultCore に渡す物（static coreDeps）だけ。本番の渡す物をそのまま受け、作り物に
//   替える3つ（outlets・fetchWork・sourceFetch）だけを足す。RPC の口・alarm・SQL の口は本番の物を受け継ぐ。Worker の口は本番の src/index.ts
// - 本番の入口（src/）は E2E の入口・作り物を読み込まない（公開する中身に入らない。まとめた中身は bundle-check でも見る）
// - E2E の入口の作り物の出どころは example.com だけ。その Worker のグローバルの fetch は、ループバックのほかへ送らない（loopbackFetch.ts）
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loopbackOnly, loopbackUrl } from '../e2e/loopbackFetch'
import { FAKE_SOURCES } from '../support/fakeNews'

const connectorDir = path.resolve(import.meta.dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(connectorDir, p), 'utf8')

/** JSONC（// の注釈と終わりのカンマ）を読む（文字列の中の // はそのまま） */
function parseJsonc(text: string): Record<string, unknown> {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') out += text[++i] ?? ''
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    out += ch
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>
}

/** 行の注釈（// と /** … *\/ の行）と空の行を除いた文 */
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.trim() !== '' && !/^\s*(?:\/\/|\/\*\*|\*\/|\*(?:\s|$))/.test(l))
    .join('\n')

/** start で始まり、行の頭の end で終わる所（end を含む） */
function block(source: string, start: string, end: string): string {
  const i = source.indexOf(start)
  expect(i, start).toBeGreaterThanOrEqual(0)
  const j = source.indexOf(end, i)
  expect(j, `${start} の終わり`).toBeGreaterThan(i)
  return source.slice(i, j + end.length)
}

describe('E2E のテストの入口', () => {
  it('wrangler.e2e.jsonc は本番の wrangler.jsonc と、名前・入口・vars の値のほかが同じ', () => {
    const prod = parseJsonc(read('wrangler.jsonc'))
    const e2e = parseJsonc(read('wrangler.e2e.jsonc'))
    expect(e2e.main).toBe('test/e2e/worker.ts')
    expect(prod.main).toBe('src/index.ts')
    expect(e2e.name).not.toBe(prod.name)
    const rest = (c: Record<string, unknown>) => {
      const { name: _n, main: _m, vars, ...others } = c
      return { ...others, vars: Object.keys(vars as Record<string, string>).sort() }
    }
    expect(rest(e2e)).toEqual(rest(prod))
    // 本物の Firebase のプロジェクト・鍵とアプリの公開の場所は書かない（テストはエミュレーター）
    const vars = e2e.vars as Record<string, string>
    const prodVars = prod.vars as Record<string, string>
    for (const k of ['FIREBASE_PROJECT_ID', 'FIREBASE_API_KEY', 'APP_ORIGIN']) expect(vars[k], k).not.toBe(prodVars[k])
    expect(vars.FIREBASE_PROJECT_ID).toMatch(/^demo-/)
  })

  it('E2E の Vault は本番の Vault の子の型で、VaultCore に渡す物（static coreDeps）だけを替える。Worker の口は本番の src/index.ts の物', () => {
    const prod = read('src/vault/Vault.ts')
    const e2e = read('test/e2e/worker.ts')
    expect(e2e).toMatch(/^import \{ Vault as ProdVault \} from '\.\.\/\.\.\/src\/vault\/Vault'$/m)
    expect(e2e).toMatch(/^import worker from '\.\.\/\.\.\/src\/index'$/m)
    expect(e2e).toMatch(/^export default worker$/m)
    // 子の型の中身は coreDeps の1つだけ（RPC の口・alarm・SQL の口は本番の物を受け継ぐ。E2E の入口は Durable Object の型を自分で作らない）
    const cls = code(block(e2e, 'export class Vault extends ProdVault {', '\n}\n'))
    expect([...cls.matchAll(/^ {2}(?:static |async |override )*([a-zA-Z]\w*)\(/gm)].map((m) => m[1])).toEqual(['coreDeps'])
    expect(cls).toMatch(/^ {2}static override coreDeps\(ctx: DurableObjectState, env: Env\): VaultDeps \{$/m)
    expect(e2e).not.toMatch(/DurableObject\b(?!State)/)
    expect(e2e).not.toMatch(/new VaultCore\(/)
    // 本番の渡す物をそのまま受け（...super.coreDeps）、作り物に替える3つだけを足す
    const ret = code(block(cls, '    return {', '\n    }'))
    const lines = ret.split('\n').slice(1, -1)
    expect(lines[0]).toBe('      ...super.coreDeps(ctx, env),')
    expect(lines.slice(1).map((l) => /^ {6}(\w+): /.exec(l)?.[1])).toEqual(['outlets', 'fetchWork', 'sourceFetch'])
    expect(e2e).toContain('outlets: FAKE_OUTLETS')
    expect(e2e).toContain('sources: FAKE_SOURCES')
    expect(e2e).toContain('sourceFetch: news.fetch')
    // 本番の Vault は、作った型（new.target）の coreDeps で VaultCore を作り、作り物に替える3つを渡さない（既定の DEFAULT_OUTLETS・
    // 出どころの data・グローバルの fetch）。coreDeps は static（RPC の口に出さない）
    expect(prod).toContain('this.#core = new VaultCore((new.target as typeof Vault).coreDeps(ctx, env))')
    const prodDeps = code(block(prod, '  static coreDeps(', '\n  }\n'))
    expect(prodDeps).not.toMatch(/outlets|fetchWork|sourceFetch/)
    expect(prodDeps).toMatch(/sql: doSql\(ctx\.storage\)/)
    expect(prod.match(/new VaultCore\(/g)).toHaveLength(1)
  })

  it('E2E の入口の Worker のグローバルの fetch は、手元のエミュレーター（ループバック）のほかへ要求を送らない', async () => {
    const e2e = read('test/e2e/worker.ts')
    expect(e2e).toMatch(/^globalThis\.fetch = loopbackOnly\(globalThis\.fetch\.bind\(globalThis\)\)$/m)
    const inner = vi.fn(async () => new Response('ok'))
    const guarded = loopbackOnly(inner as unknown as typeof fetch)
    for (const url of [
      'http://127.0.0.1:8080/v1/projects/demo-topic-studio/databases/(default)/documents/config/connector',
      'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp',
      'http://localhost:5180/',
      'http://[::1]:8080/',
    ]) {
      expect(loopbackUrl(url), url).toBe(true)
      expect(await (await guarded(url)).text()).toBe('ok')
    }
    expect(inner).toHaveBeenCalledTimes(4)
    inner.mockClear()
    for (const input of [
      'https://example.com/fake-ministry/press/index.html',
      'https://other.example.org/fake/press/1004.html',
      new URL('https://example.com/robots.txt'),
      new Request('https://example.com/fake-voices/feed/'),
      'http://10.0.0.1/',
      'http://127.0.0.1.example.com/',
      'ftp://127.0.0.1/',
      'not a url',
    ]) {
      expect(loopbackUrl(input), String(input)).toBe(false)
      await expect(guarded(input)).rejects.toThrow('外へ要求を送りません')
    }
    expect(inner).not.toHaveBeenCalled()
  })

  it('本番の入口（src/）は E2E の入口と作り物を読み込まない', () => {
    const files = (fs.readdirSync(path.join(connectorDir, 'src'), { recursive: true }) as string[]).filter((f) =>
      f.endsWith('.ts'),
    )
    expect(files.length).toBeGreaterThan(10)
    for (const f of files) {
      const text = fs.readFileSync(path.join(connectorDir, 'src', f), 'utf8')
      expect(text, f).not.toMatch(/from '[^']*(?:test\/|fixtures\/|fakeOutlets|fakeNews)[^']*'/)
    }
  })

  it('E2E の入口の作り物の出どころは example.com だけ', () => {
    for (const s of FAKE_SOURCES) {
      for (const h of [...s.hosts.list, ...s.hosts.body]) expect(h, s.id).toBe('example.com')
      for (const l of s.lists) expect(new URL(l.url).hostname, s.id).toBe('example.com')
    }
  })
})
