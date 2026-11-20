// 準備・公開・確かめのスクリプトの部品（Cloudflare にはつながない）と、公開する形の中身（NS の connector/test/unit/scripts.test.ts を写し、
// TS の名前・禁じる物にした）。手順書（docs/CONNECTOR.md）の確かめ: wrangler のコマンドの Worker の名前・DCR の案内・1-A の手順と
// スクリプトとコネクタの文が指す所・同意の画面の文・ツールの一覧・出どころ・接続の数と上限。仕様書の 7.7 のルールの文が firestore.rules と同じか。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_CONNECTIONS } from '../../../src/claude/pairing'
import { RECORD_NORMS } from '../../../src/domain/limits'
import { FAKE_OUTLET_NAMES } from '../../../src/test/fixtures/fakeOutlets'
import { CONSENT_CAN, CONSENT_CANNOT, CONSENT_SOURCES } from '../../src/auth/consentPage'
import { vaultConfig, workerConfig } from '../../src/config'
import { ANTHROPIC_AGENTS, USER_AGENT } from '../../src/fetch/aiAgents'
import { DEFAULT_SOURCES, PENDING_HOSTS } from '../../src/fetch/sources'
import { TOOL_DEFS } from '../../src/mcp/tools'
import { RATE_LIMITS } from '../../src/vault/ratelimit'
// prettier-ignore
// @ts-expect-error スクリプトは JavaScript（型の宣言なし）
import { MISSING_CONNECTOR_DEPS, OAUTH_KV_TITLE, WORKER_NAME, answerIsYes, appBuildEnv, dcrEnabledInConfig, deployVarArgs, ensureTokenKey, isConnectorOrigin, missingLocalNotice, newTokenKey, parseWorkersUrl, readLocalConfig, wranglerProblem, wranglerProblemHint, writeLocalConfig } from '../../scripts/lib.mjs'
// @ts-expect-error スクリプトは JavaScript（型の宣言なし）
import { checkConnector, parseCheckArgs } from '../../scripts/check.mjs'
// prettier-ignore
// @ts-expect-error スクリプトは JavaScript（型の宣言なし）
import { bundleCheck, bundleProblems, fakeOutletNames, forbiddenTexts, textProblems, unescapeBundle } from '../../scripts/bundle-check.mjs'

const connectorDir = path.resolve(import.meta.dirname, '../..')
const repoDir = path.resolve(connectorDir, '..')
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name))

describe('wrangler.jsonc の変数', () => {
  it('どの変数もコネクタのコードが読む（効かない設定を書かない）', () => {
    const text = fs.readFileSync(path.join(connectorDir, 'wrangler.jsonc'), 'utf8')
    const vars = /"vars"\s*:\s*\{([\s\S]*?)\}/.exec(text)?.[1] ?? ''
    const names = [...vars.matchAll(/^\s*"([A-Z0-9_]+)"\s*:/gm)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(5)
    const src = fs.readFileSync(path.join(connectorDir, 'src/config.ts'), 'utf8')
    for (const name of names) expect(src, name).toMatch(new RegExp(`env\\.${name}\\b`))
    // 設定から作った値も、どれかのコードが使う（読むだけで何にも効かない設定を作らない）
    const env = Object.fromEntries(names.map((n) => [n, '']))
    const keys = [...Object.keys(vaultConfig(env as never)), ...Object.keys(workerConfig(env as never, 'https://c.example/'))]
    const files = (fs.readdirSync(path.join(connectorDir, 'src'), { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.endsWith('config.ts'))
      .map((f) => fs.readFileSync(path.join(connectorDir, 'src', f), 'utf8'))
      .join('\n')
    for (const key of keys) expect(files, key).toMatch(new RegExp(`\\.${key}\\b`))
  })
})

describe('CI（.github/workflows/ci.yml）', () => {
  it('コネクタの部品を入れ、型・単体と Workers のテスト・公開する形の確かめを動かす（キャッシュはコネクタの package-lock.json も）', () => {
    const ci = fs.readFileSync(path.join(repoDir, '.github/workflows/ci.yml'), 'utf8')
    const at = (s: string) => ci.indexOf(s)
    for (const s of [
      'npm --prefix connector ci',
      'npm --prefix connector run typecheck',
      'npm run test:connector\n',
      'npm --prefix connector run bundle-check',
      'npm run test:connector:emu',
    ])
      expect(at(s), s).toBeGreaterThan(0)
    expect(at('npm --prefix connector ci')).toBeLessThan(at('npm --prefix connector run typecheck'))
    // エミュレーターの結合テストは、Java を入れて同期のテストを流した後
    expect(at('npm run test:sync')).toBeLessThan(at('npm run test:connector:emu'))
    expect(ci).toContain('connector/package-lock.json')
    // 同期の E2E の仕事にもコネクタの部品を入れる（連携の通しの E2E で本物のコネクタを動かす）
    const sync = ci.slice(at('e2e-sync:'))
    expect(sync).toContain('npm --prefix connector ci')
    expect(sync).toContain('connector/package-lock.json')
  })

  it('ルートの package.json: コネクタのテスト・準備・確かめの命令と、整形の確かめにコネクタ（作ったスキーマは除く）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['test:connector']).toBe('npm --prefix connector test')
    expect(pkg.scripts['test:connector:emu']).toContain('--project demo-topic-studio "npm --prefix connector run test:emu"')
    expect(pkg.scripts['connector:setup']).toBe('node connector/scripts/setup.mjs')
    expect(pkg.scripts['connector:check']).toBe('node connector/scripts/check.mjs')
    for (const k of ['format', 'format:check']) {
      expect(pkg.scripts[k], k).toContain('"connector/{src,test}/**/*.ts"')
      expect(pkg.scripts[k], k).toContain('"!connector/src/mcp/schemas.gen.ts"')
    }
  })

  it('手元だけの物（公開の URL・秘密・手元の Durable Object と KV・まとめた物）は Git に入れない', () => {
    const ignore = fs.readFileSync(path.join(repoDir, '.gitignore'), 'utf8').split('\n')
    for (const s of ['connector.local.json', 'connector/dist', 'connector/.wrangler', 'connector/.dev.vars'])
      expect(ignore, s).toContain(s)
  })
})

describe('docs/CONNECTOR.md（手順書）', () => {
  const doc = fs.readFileSync(path.join(repoDir, 'docs/CONNECTOR.md'), 'utf8')
  const read = (rel: string) => fs.readFileSync(path.join(connectorDir, rel), 'utf8')
  /** 表の行の頭の欄が text（整形で欄の後ろに空白が入っても当たる） */
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const cells = (...texts: string[]) => new RegExp(`^\\|${texts.map((t) => ` ${esc(t)} *\\|`).join('')}`, 'm')
  /** 見出しの節（## n. の見出しから、次の ## まで） */
  const section = (title: string) => {
    const at = doc.indexOf(`\n## ${title}`)
    expect(at, title).toBeGreaterThan(0)
    const next = doc.indexOf('\n## ', at + 1)
    return doc.slice(at, next < 0 ? undefined : next)
  }

  it('リポジトリの直下で動かす wrangler のコマンドには、Worker の名前を付ける（直下には wrangler.jsonc が無い）', () => {
    const name = /"name"\s*:\s*"([^"]+)"/.exec(read('wrangler.jsonc'))?.[1]
    expect(name).toBe(WORKER_NAME)
    const commands = [...doc.matchAll(/`(npx --prefix connector wrangler (?:delete|secret delete)[^`]*)`/g)].map((m) => m[1])
    expect(commands.length).toBeGreaterThanOrEqual(2)
    for (const c of commands) expect(c, c).toContain(`--name ${name}`)
    // KV の名前も wrangler が作る名前（lib.mjs の OAUTH_KV_TITLE）
    expect(doc).toContain(`\`${OAUTH_KV_TITLE}\``)
  })

  it('DCR は connector.local.json の "enableDcr": true で有効にする（Git に入る wrangler.jsonc を書き換えない）', () => {
    expect(doc).toContain('"enableDcr": true')
    expect(doc).not.toMatch(/wrangler\.jsonc` の `ENABLE_DCR` を `"true"` にして/)
    // wrangler.jsonc の注釈も同じ所を指す
    expect(read('wrangler.jsonc')).toContain('connector.local.json に "enableDcr": true を足す')
  })

  it('準備のスクリプト・コネクタの案内が指す 1-A の手順（匿名ログイン・準備のスクリプト・claude.ai への登録）と節の名前がある', () => {
    const handSteps = doc.slice(doc.indexOf('### 1-A.'), doc.indexOf('### 1-B.'))
    expect(handSteps.length).toBeGreaterThan(100)
    const stepOf = (re: RegExp) => Number(new RegExp(`^(\\d+)\\. \\*\\*${re.source}`, 'm').exec(handSteps)?.[1])
    const anon = stepOf(/Firebase で匿名ログインを有効にする/)
    const script = stepOf(/準備のスクリプトを動かす/)
    const register = stepOf(/claude\.ai への登録/)
    expect(anon).toBeGreaterThan(0)
    expect(script).toBeGreaterThan(anon)
    expect(register).toBeGreaterThan(script)
    // 手順の番号は 1 から抜けずに並ぶ（スクリプトの文が番号でなく名前で指すので、番号を変えても文は替えなくてよい）
    const numbers = [...handSteps.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]))
    expect(numbers).toEqual(numbers.map((_, i) => i + 1))
    // 匿名ログインの手順の後ろの「つながらない時」の行が、その番号を指す
    expect(section('6. つながらない時')).toContain(`1-A の手順 ${anon} をやり直して`)
    const setup = read('scripts/setup.mjs')
    for (const s of ['docs/CONNECTOR.md の 1-A', '1-A の匿名ログインの手順', '1-A の claude.ai への登録から'])
      expect(setup, s).toContain(s)
    // 確かめで止まった時は、アプリとアクセスルールを公開していないので、check ではなく setup をやり直す
    expect(setup).toContain('アプリとアクセスルールはまだ公開していません')
    expect(doc).toContain('アプリとアクセスルールはまだ公開されていません')
    expect(read('src/vault/errors.ts')).toContain('docs/CONNECTOR.md の 1-A）')
    // lib.mjs の KV の直し方が指す節
    expect(read('scripts/lib.mjs')).toContain('docs/CONNECTOR.md の「やめる時・止める時」')
    expect(doc).toMatch(/^## \d+\. やめる時・止める時$/m)
    // 手順書の名前と場所（アプリの設定の［手順を見る］のリンクと「まだ用意されていません」の文）
    const settings = fs.readFileSync(path.join(repoDir, 'src/features/claude/ClaudeSettings.tsx'), 'utf8')
    expect(settings).toMatch(/CONNECTOR_GUIDE_URL = '[^']*\/docs\/CONNECTOR\.md'/)
    expect(settings).toContain("CONNECTOR_UNSET_TEXT = 'コネクタはまだ用意されていません（docs/CONNECTOR.md）'")
  })

  it('手元のコネクタにつなぐ手順に、connector.local.json が先に効く事を書く（vite.config.ts の connectorOrigin と同じ。横断の点検）', () => {
    const at = doc.indexOf('VITE_CONNECTOR_ORIGIN=http://localhost:8787')
    expect(at).toBeGreaterThan(0)
    const bullet = doc.slice(doc.lastIndexOf('\n  - ', at), at)
    expect(bullet).toContain('`connector.local.json` があれば、')
    expect(bullet).toContain('そちらが優先されます')
    // vite.config.ts は、ファイルの origin を先に読み、無い時だけ環境変数を見る
    expect(fs.readFileSync(path.join(repoDir, 'vite.config.ts'), 'utf8')).toContain(
      "if (!raw) raw = env.VITE_CONNECTOR_ORIGIN ?? ''",
    )
  })

  it('9-C の「取りを止めました」の行は、robots.txt から出た止めが data では外れない事と、本文の止めの外し方を分けて書く（横断の点検）', () => {
    const row = doc.split('\n').find((l) => l.startsWith('| 「取りを止めました（AI への意思表示が出ました。作者に伺います）」'))
    expect(row).toBeDefined()
    expect(row).toContain('サイトの意思表示が無くなるまで外れない（data では外せない）')
    expect(row).toContain('止めた日より後の日を data の確かめた日（`terms.accepted`）に入れて公開し直すと外れる')
  })

  it('同意の画面と同じ「できること・できないこと」と資料の出どころの1行', () => {
    const intro = doc.slice(0, doc.indexOf('## 仕組み'))
    expect(intro).toContain(`Claude ができること: ${CONSENT_CAN.join('／')}`)
    expect(intro).toContain(`Claude ができないこと: ${CONSENT_CANNOT.join('／')}`)
    // 同意の画面にだけあった1行（設計に無い）を、手順書の 1-A の許可の手順にも同じ文で書く
    const handSteps = doc.slice(doc.indexOf('### 1-A.'), doc.indexOf('### 1-B.'))
    expect(handSteps).toContain(`「${CONSENT_SOURCES}」`)
    expect(read('src/auth/consentPage.ts')).toContain('${escapeHtml(CONSENT_SOURCES)}')
  })

  it('ツールの一覧に、コネクタのツールが全部、同じ題で並ぶ（数も）', () => {
    const table = section('2. 試す')
    for (const t of TOOL_DEFS) expect(table, t.name).toMatch(cells(`\`${t.name}\``, t.title))
    const rows = [...table.matchAll(/^\| `(topic_[a-z_]+)` +\|/gm)].map((m) => m[1])
    expect(rows).toEqual(TOOL_DEFS.map((t) => t.name))
    const reads = TOOL_DEFS.filter((t) => t.kind === 'read').length
    expect(doc).toContain(`読む ${reads}・足す ${TOOL_DEFS.length - reads}`)
    expect(doc).toContain(`${TOOL_DEFS.length}のツールを全部「常に許可」`)
  })

  it('出どころの節に、data の出どころの名前とホストが全部ある（取らない所も）', () => {
    const sources = section('9. 出どころ')
    for (const s of DEFAULT_SOURCES) {
      expect(sources, s.id).toMatch(cells(s.outlet))
      for (const h of [...s.hosts.list, ...s.hosts.body]) expect(sources, h).toContain(`\`${h}\``)
    }
    expect(sources).toContain(`使っている${DEFAULT_SOURCES.length}つ`)
    for (const p of PENDING_HOSTS) expect(sources, p.id).toContain(p.name)
    // 名乗りと、断れば取らない Claude・Anthropic の名前は、部品と同じ
    expect(doc).toContain(`\`${USER_AGENT}\``)
    for (const a of ANTHROPIC_AGENTS) expect(doc, a).toContain(`\`${a}\``)
  })

  it('接続の数と接続の要求の上限・数の門は、コードと同じ数を書く', () => {
    expect(doc).toContain(`照合済みの下書きが${RECORD_NORMS.editionGate}本そろうまで話題を足せません`)
    expect(doc).toContain(`照合済みが${RECORD_NORMS.editionGate}本そろってから`)
    const a = RATE_LIMITS.authorize
    expect(MAX_CONNECTIONS).toBe(2)
    expect(doc).toContain(`接続が${MAX_CONNECTIONS}あります（同時に${MAX_CONNECTIONS}まで）`)
    expect(doc).toContain(
      `1つのネットワークから1時間${a.source?.perHour}回・1日${a.source?.perDay}回まで、コネクタ全体で1日${a.global.perDay}回まで`,
    )
  })

  it('手順書に書いた npm のコマンド・node で動かすスクリプトは、package.json とリポジトリにある（README・DEPLOY.md・SCHEDULE.md も）', () => {
    const pkg = (rel: string) => Object.keys(JSON.parse(fs.readFileSync(path.join(repoDir, rel), 'utf8')).scripts)
    const rootScripts = new Set(pkg('package.json'))
    const connectorScripts = new Set(pkg('connector/package.json'))
    const docs = ['docs/CONNECTOR.md', 'docs/SCHEDULE.md', 'docs/DEPLOY.md', 'README.md', 'connector/README.md']
    let count = 0
    for (const rel of docs) {
      const text = fs.readFileSync(path.join(repoDir, rel), 'utf8')
      for (const m of text.matchAll(/npm (--prefix connector )?run ([a-z][\w:-]*)/g)) {
        count++
        expect((m[1] ? connectorScripts : rootScripts).has(m[2]), `${rel}: ${m[0]}`).toBe(true)
      }
      for (const m of text.matchAll(/\bnode ((?:connector\/)?scripts\/[\w.-]+\.mjs)/g))
        expect(fs.existsSync(path.join(repoDir, m[1])), `${rel}: ${m[0]}`).toBe(true)
      for (const m of text.matchAll(/npx vitest run ([\w./-]+\.test\.m?[jt]s)/g))
        expect(fs.existsSync(path.join(repoDir, m[1])), `${rel}: ${m[0]}`).toBe(true)
    }
    expect(count).toBeGreaterThan(20)
    // 準備・確かめ・公開・テストの命令は、手順書に必ず出る
    for (const name of ['connector:setup', 'connector:check', 'deploy', 'test:connector', 'test:connector:emu'])
      expect(doc, name).toContain(`npm run ${name}`)
  })

  it('「つながらない時」の表の、出ること（「…」）は、コネクタ・スクリプト・アプリの文と依頼文の報告の形にある（claude.ai・Cloudflare・npm・git の文を除く）', () => {
    const walk = (dir: string): string[] =>
      (fs.readdirSync(dir, { recursive: true }) as string[])
        .filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\./.test(f))
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    // コードの中の ${…} は値が入る所なので、区切りにする
    const code = [
      ...walk(path.join(connectorDir, 'src')),
      ...walk(path.join(connectorDir, 'scripts')),
      ...walk(path.join(repoDir, 'src')),
      fs.readFileSync(path.join(repoDir, 'scripts/deploy.mjs'), 'utf8'),
      // 定期実行の報告の言葉は、依頼文（docs/SCHEDULE.md）の報告の形
      fs.readFileSync(path.join(repoDir, 'docs/SCHEDULE.md'), 'utf8'),
    ]
      .join('\n')
      .replace(/\$\{[^}]*\}/g, '\u0000')
    /** ほかの物が出す文（claude.ai・Cloudflare・PowerShell・git） */
    const outside = ['Authorization with the MCP server failed', 'Exceeded CPU', 'npm.ps1', 'Your local changes']
    const table = section('6. つながらない時')
    const said = [...table.matchAll(/^\| ([^|]*?) *\|/gm)].flatMap((m) => [...m[1].matchAll(/「([^「」]+)」/g)].map((q) => q[1]))
    expect(said.length).toBeGreaterThan(15)
    for (const s of said) {
      if (outside.some((o) => s.includes(o))) continue
      // 「…」・値（数・名前）の所で区切った、4字以上の切れ端が、どれもコードの文にある
      const parts = s
        .split(/…|（[^）]*）|\d[\d,]*|topic-studio-connector-oauth-kv/)
        .map((p) => p.trim())
        .filter((p) => p.length >= 4)
      expect(parts.length, s).toBeGreaterThan(0)
      for (const p of parts) expect(code.includes(p), `${s}（${p}）`).toBe(true)
    }
  })

  it('「すぐに止める」には、Firebase に繋がらない間・無料枠を使い切った間の例外と、すぐに切る方法を添える', () => {
    const row = doc.split('\n').find((l) => cells('すぐに止める').test(l))
    expect(row).toContain('無料枠を使い切った間')
    expect(row).toContain('「カスタマイズ → コネクタ → Topic Studio」でもコネクタを削除する')
    // モデルの id・メールの住所・リポジトリの外の人の名前は書かない
    expect(doc).not.toMatch(/claude-[a-z0-9.-]*\d/i)
    expect(doc).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)
  })
})

describe('docs/SPEC.md の 7.7（ルールの文）', () => {
  it('コネクタの部分の関数と config/connector の決まりは、firestore.rules と同じ文（注釈を除く）', () => {
    const rules = fs.readFileSync(path.join(repoDir, 'firestore.rules'), 'utf8')
    const spec = fs.readFileSync(path.join(repoDir, 'docs/SPEC.md'), 'utf8')
    const at = spec.indexOf('#### ルール（段階3のコネクタの部分）')
    expect(at).toBeGreaterThan(0)
    const part = spec.slice(at, spec.indexOf('#### コネクタの認証のしかた', at))
    const code = (text: string) =>
      text
        .split('\n')
        .map((l) => l.replace(/\s*\/\/.*$/, '').trimEnd())
        .filter((l) => l.trim() !== '')
    /** 関数か match の塊（頭の行から、同じ字下げの } まで） */
    const blockOf = (text: string, head: string) => {
      const lines = code(text)
      const i = lines.findIndex((l) => l.trim().startsWith(head))
      expect(i, head).toBeGreaterThanOrEqual(0)
      const indent = lines[i].length - lines[i].trimStart().length
      const j = lines.findIndex((l, k) => k > i && l === `${' '.repeat(indent)}}`)
      return lines.slice(i, j + 1).map((l) => l.trim())
    }
    for (const head of [
      'function isConnector(uid)',
      'function connectorCreate(docId)',
      'function validConnection(c)',
      'function validConnector()',
      'function newApproval()',
      'match /config/connector',
    ])
      expect(blockOf(part, head), head).toEqual(blockOf(rules, head))
    // records の読みと作る・直す
    const records = blockOf(rules, 'match /users/{uid}/records/{docId}')
    const specRecords = blockOf(part, 'match /users/{uid}/records/{docId}')
    for (const l of records.filter((l) => !l.startsWith('allow delete') && !/^&& (expirableRecord|expiredDay)/.test(l)))
      expect(specRecords, l).toContain(l)
    expect(part).toContain('allow get: if isOwner(uid) || isConnector(uid);')
  })
})

describe('スクリプトの部品', () => {
  it('ENABLE_DCR を "true" にした時（最後の手段）は、確かめも DCR が有効なことを期待する。--dcr は URL として読まない', () => {
    const dir = tmp('ts-dcr-')
    const on = path.join(dir, 'on.jsonc')
    const off = path.join(dir, 'off.jsonc')
    fs.writeFileSync(on, '{\n  // "true" にすると…\n  "vars": { "ENABLE_DCR": "true" }\n}\n')
    fs.writeFileSync(
      off,
      '{\n  // つながらない時の最後の手段: "true" にすると DCR を受け付ける\n  "vars": { "ENABLE_DCR": "false" }\n}\n',
    )
    const noLocal = path.join(dir, 'none.json')
    expect(dcrEnabledInConfig(on, noLocal)).toBe(true)
    expect(dcrEnabledInConfig(off, noLocal)).toBe(false)
    expect(dcrEnabledInConfig(path.join(dir, 'none.jsonc'), noLocal)).toBe(false)
    expect(dcrEnabledInConfig(undefined, noLocal)).toBe(false)
    expect(parseCheckArgs(['--dcr'])).toEqual({ origin: '', dcr: true })
    expect(parseCheckArgs(['https://c.example.workers.dev', '--dcr'])).toEqual({
      origin: 'https://c.example.workers.dev',
      dcr: true,
    })
  })

  it('DCR は connector.local.json の "enableDcr": true で有効にする（Git に入る wrangler.jsonc を書き換えない）。準備し直しても残る', () => {
    const dir = tmp('ts-dcr-local-')
    const local = path.join(dir, 'connector.local.json')
    const jsonc = path.join(dir, 'wrangler.jsonc')
    fs.writeFileSync(jsonc, '{ "vars": { "ENABLE_DCR": "false" } }')
    const origin = 'https://topic-studio-connector.example.workers.dev'
    fs.writeFileSync(local, JSON.stringify({ origin, enableDcr: true }))
    const read = readLocalConfig(local)
    expect(read).toEqual({ origin, enableDcr: true })
    expect(dcrEnabledInConfig(jsonc, local)).toBe(true)
    expect(deployVarArgs(origin, { enableDcr: read.enableDcr })).toEqual([
      '--var',
      `MCP_RESOURCE:${origin}/mcp`,
      '--var',
      `PUBLIC_ORIGIN:${origin}`,
      '--var',
      'ENABLE_DCR:true',
    ])
    writeLocalConfig(origin, { enableDcr: read.enableDcr }, local)
    expect(readLocalConfig(local)).toEqual({ origin, enableDcr: true })
    writeLocalConfig(origin, {}, local)
    expect(JSON.parse(fs.readFileSync(local, 'utf8'))).toEqual({ origin })
    expect(dcrEnabledInConfig(jsonc, local)).toBe(false)
  })

  it('公開するアプリのビルドには、開発用の値（エミュレーター・手元のコネクタ）を入れない', () => {
    const dev = { VITE_FIREBASE_EMULATOR: '127.0.0.1', VITE_CONNECTOR_ORIGIN: 'http://localhost:8787' }
    expect(appBuildEnv(dev, null)).toEqual({ VITE_FIREBASE_EMULATOR: undefined, VITE_CONNECTOR_ORIGIN: undefined })
    expect(appBuildEnv(dev, { origin: 'https://c.example.workers.dev' })).toEqual({
      VITE_FIREBASE_EMULATOR: undefined,
      VITE_CONNECTOR_ORIGIN: 'https://c.example.workers.dev',
    })
    expect(appBuildEnv({ VITE_CONNECTOR_ORIGIN: 'https://d.example.workers.dev' }, null).VITE_CONNECTOR_ORIGIN).toBe(
      'https://d.example.workers.dev',
    )
    // undefined の値は子の環境から外れる（Node の spawn）
    expect('VITE_FIREBASE_EMULATOR' in appBuildEnv({}, null)).toBe(true)
  })

  it('wrangler deploy の出力から URL を取り出す（Worker の名前の物を先に）', () => {
    expect(WORKER_NAME).toBe('topic-studio-connector')
    const out = `Uploaded topic-studio-connector (3.21 sec)\nDeployed topic-studio-connector triggers (1.02 sec)\n  https://other.example.workers.dev\n  https://topic-studio-connector.example.workers.dev\n  schedule: 23 19 * * *`
    expect(parseWorkersUrl(out)).toBe('https://topic-studio-connector.example.workers.dev')
    expect(parseWorkersUrl('no url here')).toBeNull()
  })

  it('コネクタの URL の形・公開する時に渡す変数（: を含む値も1つの変数）', () => {
    expect(isConnectorOrigin('https://topic-studio-connector.example.workers.dev')).toBe(true)
    expect(isConnectorOrigin('https://x.workers.dev/mcp')).toBe(false)
    expect(isConnectorOrigin('http://x.workers.dev')).toBe(false)
    expect(deployVarArgs('https://a.b.workers.dev')).toEqual([
      '--var',
      'MCP_RESOURCE:https://a.b.workers.dev/mcp',
      '--var',
      'PUBLIC_ORIGIN:https://a.b.workers.dev',
    ])
  })

  it('connector.local.json を書いて読む（形が違えば null）', () => {
    const file = path.join(tmp('ts-conn-'), 'connector.local.json')
    expect(readLocalConfig(file)).toBeNull()
    writeLocalConfig('https://topic-studio-connector.example.workers.dev', {}, file)
    expect(readLocalConfig(file)).toEqual({ origin: 'https://topic-studio-connector.example.workers.dev', enableDcr: false })
    fs.writeFileSync(file, '{"origin":"javascript:alert(1)"}')
    expect(readLocalConfig(file)).toBeNull()
    expect(() => writeLocalConfig('http://insecure.example', {}, file)).toThrow()
  })

  it('はい・いいえの答え: 日本語入力のままの全角の ｙ も「はい」', () => {
    for (const a of ['y', 'Y', 'yes', 'はい', 'ｙ', 'Ｙ', 'ｙｅｓ', ' ｙ ']) expect(answerIsYes(a), a).toBe(true)
    for (const a of ['n', 'ｎ', 'no', 'いいえ']) expect(answerIsYes(a), a).toBe(false)
    expect(answerIsYes('')).toBe(true)
    expect(answerIsYes('', false)).toBe(false)
  })

  it('鍵: あればそのまま。確かめられない時（一時的な失敗）は作り直さずに止まり、wrangler の理由を見せる', async () => {
    type Call = { args: string[]; input?: string }
    const fake = (answers: Record<string, { code: number; stdout?: string; stderr?: string }>) => {
      const calls: Call[] = []
      const run = async (args: string[], opts: { input?: string } = {}) => {
        calls.push({ args, input: opts.input })
        const a = answers[args.slice(0, 2).join(' ')] ?? { code: 0 }
        return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }
      }
      return { run, calls }
    }
    const has = '[{"name":"TOKEN_ENC_KEY","type":"secret_text"}]'
    const kept = fake({ 'secret list': { code: 0, stdout: has } })
    expect(await ensureTokenKey(kept.run)).toEqual({ ok: true, created: false, rotated: false })
    expect(kept.calls.map((c) => c.args[1])).toEqual(['list'])
    const blip = fake({ 'secret list': { code: 1, stderr: '✘ [ERROR] A request to the Cloudflare API failed. (status 503)' } })
    const r = await ensureTokenKey(blip.run)
    expect(r).toMatchObject({ ok: false, reason: 'list_failed' })
    expect(r.why).toContain('status 503')
    expect(blip.calls.map((c) => c.args[1])).toEqual(['list'])
    const first = fake({ 'secret list': { code: 0, stdout: '[]' } })
    expect(await ensureTokenKey(first.run, { makeKey: () => 'k'.repeat(43) })).toEqual({
      ok: true,
      created: true,
      rotated: false,
    })
    expect(first.calls[1]).toEqual({ args: ['secret', 'put', 'TOKEN_ENC_KEY'], input: 'k'.repeat(43) })
    const denied = fake({
      'secret list': { code: 0, stdout: '[]' },
      'secret put': { code: 1, stderr: 'Authentication error [code: 10000]' },
    })
    const d = await ensureTokenKey(denied.run, { makeKey: () => 'secret-value' })
    expect(d).toMatchObject({ ok: false, reason: 'put_failed' })
    expect(d.why).toContain('code: 10000')
    expect(d.why).not.toContain('secret-value')
    let warned = false
    const rot = fake({ 'secret list': { code: 0, stdout: has } })
    expect(await ensureTokenKey(rot.run, { rotate: true, onRotate: () => (warned = true) })).toEqual({
      ok: true,
      created: true,
      rotated: true,
    })
    expect(warned).toBe(true)
  })

  it('wrangler の失敗の原因: ログインが切れた・前のコネクタの KV が残っている（直し方を日本語で）', () => {
    const expired =
      'Your auth token has expired and could not be refreshed, and the environment is non-interactive. Run `wrangler login` in an interactive terminal or set a CLOUDFLARE_API_TOKEN.'
    const kv =
      'Creating new KV Namespace "topic-studio-connector-oauth-kv"...\n  a namespace with this account ID and title already exists [code: 10014]'
    const offline =
      'Your auth token has expired and could not be refreshed because the Cloudflare auth server could not be reached. This is usually a network problem'
    expect(wranglerProblem(expired)).toBe('login')
    expect(wranglerProblem(kv)).toBe('kv_exists')
    expect(wranglerProblem(offline)).toBeNull()
    expect(wranglerProblem('✘ [ERROR] Build failed with 1 error')).toBeNull()
    expect(wranglerProblemHint('login')).toContain('npx --prefix connector wrangler login')
    expect(wranglerProblemHint('kv_exists', 'npm run connector:setup')).toContain(OAUTH_KV_TITLE)
    expect(wranglerProblemHint(null)).toBeNull()
    // KV の名前は wrangler が作る名前（Worker の名前 + バインディング名）と同じ
    const cfg = fs.readFileSync(path.join(connectorDir, 'wrangler.jsonc'), 'utf8')
    const name = /"name"\s*:\s*"([^"]+)"/.exec(cfg)?.[1]
    expect(cfg).toContain('"binding": "OAUTH_KV"')
    expect(OAUTH_KV_TITLE).toBe(`${name}-oauth-kv`)
  })

  it('connector.local.json の無いパソコンからアプリを公開する時は注意を出す（コネクタの部品が入っている時だけ）', () => {
    const notice = missingLocalNotice({ local: null, skipApp: false, connectorDeps: true })
    expect(notice?.join('\n')).toContain('コネクタ未設定')
    expect(notice?.join('\n')).toContain('npm run connector:setup')
    expect(
      missingLocalNotice({ local: { origin: 'https://c.example.workers.dev' }, skipApp: false, connectorDeps: true }),
    ).toBeNull()
    expect(missingLocalNotice({ local: null, skipApp: true, connectorDeps: true })).toBeNull()
    expect(missingLocalNotice({ local: null, skipApp: false, connectorDeps: false })).toBeNull()
    expect(MISSING_CONNECTOR_DEPS).toContain('npm --prefix connector ci')
  })

  it('鍵は32バイトの乱数（毎回違う）', () => {
    const a = newTokenKey()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newTokenKey()).not.toBe(a)
  })
})

describe('npm run connector:check（メタデータの確かめ）', () => {
  const origin = 'https://topic-studio-connector.example.workers.dev'
  function server(over: { dcr?: boolean; resource?: string; anonymous?: boolean } = {}) {
    return async (url: string, init?: RequestInit) => {
      const p = new URL(url).pathname
      if (p === '/') return new Response('<p data-state="unpaired">Topic Studio コネクタ</p>')
      if (p === '/.well-known/oauth-protected-resource/mcp')
        return Response.json({ resource: over.resource ?? `${origin}/mcp`, authorization_servers: [origin] })
      if (p === '/.well-known/oauth-authorization-server')
        return Response.json({
          issuer: origin,
          code_challenge_methods_supported: ['S256'],
          client_id_metadata_document_supported: true,
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
          scopes_supported: ['topic', 'offline_access'],
          ...(over.dcr ? { registration_endpoint: `${origin}/oauth/register` } : {}),
        })
      if (p === '/mcp' && init?.method === 'POST')
        return new Response('{}', {
          status: 401,
          headers: { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` },
        })
      if (p === '/connect/identity')
        return over.anonymous === false
          ? Response.json({ error: 'anonymous_disabled', message: '匿名ログインが無効' }, { status: 503 })
          : Response.json({ uid: 'anon1', version: '0.1.0', model: 2 })
      return new Response('', { status: 404 })
    }
  }

  it('すべて合えば ok', async () => {
    const r = await checkConnector(origin, { fetch: server() })
    expect(r.results.filter((x: { ok: boolean }) => !x.ok)).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.state).toBe('unpaired')
  })

  it('URL の違い・DCR が有効・匿名ログインが無効を見つける', async () => {
    const r = await checkConnector(origin, {
      fetch: server({ resource: 'https://other.example/mcp', dcr: true, anonymous: false }),
    })
    const bad = r.results.filter((x: { ok: boolean }) => !x.ok).map((x: { label: string }) => x.label)
    expect(bad).toEqual(
      expect.arrayContaining([
        `保護されたリソースの URL が ${origin}/mcp`,
        '自動的に登録（DCR）は無効',
        '匿名ログインが無効です',
      ]),
    )
    expect(r.ok).toBe(false)
  })
})

describe('テストの fetch の見張り（test/support/netGuard.ts）', () => {
  it('単体・Workers の実行環境・エミュレーターのどの設定も、setupFiles で見張りを入れる（テストは外のサイトへ出ない）', () => {
    for (const file of ['vitest.config.ts', 'vitest.workers.config.ts', 'vitest.emu.config.ts']) {
      const text = fs.readFileSync(path.join(connectorDir, file), 'utf8')
      expect(text, file).toMatch(/setupFiles:\s*\[[^\]]*'test\/support\/netGuard\.ts'/)
    }
    // このファイルは見張りを読み込まないので、グローバルの fetch に見張りがあるのは setupFiles が入れたから
    expect((globalThis.fetch as typeof fetch & { __netGuard?: true }).__netGuard).toBe(true)
  })
})

describe('公開する形（wrangler deploy --dry-run）', () => {
  it('入ってはいけないファイル（dexie・アプリの画面・同期のエンジン・テストの物）を見つける', () => {
    const { problems } = bundleProblems(
      [
        '../node_modules/@modelcontextprotocol/server/dist/index.mjs',
        '../../node_modules/dexie/dist/dexie.mjs',
        '../../src/store/appStore.ts',
        '../../src/sync/engine.ts',
        '../../src/sync/syncView.ts',
        '../../src/test/fixtures/fakeOutlets.ts',
        '../test/support/fakeFirebase.ts',
        '../../src/claude/pairing.ts',
        '../../src/sync/codec.ts',
        '../src/index.ts',
      ],
      repoDir,
    )
    expect(problems).toEqual([
      'node_modules/dexie/dist/dexie.mjs',
      'src/store/appStore.ts',
      'src/sync/engine.ts',
      'src/sync/syncView.ts',
      'src/test/fixtures/fakeOutlets.ts',
      'connector/test/support/fakeFirebase.ts',
    ])
  })

  it('入ってはいけない文字（作り物の名前・作り物のモデル・ブラウザの名前）を見つける', () => {
    const names = fakeOutletNames()
    // 作り物の社の一覧（src/test/fixtures/fakeOutlets.ts）の名前を読める（記号の伏せ字を含む名前だけ）。一覧のどの社の名前も、
    // 定数から引く書き方（FAKE_CREDIT_OUTLETS の 〇〇省・△△庁・□□ボイス など）の名前も漏らさない
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) expect(n).toMatch(/[^\x20-\x7e]/)
    expect(names).toEqual(expect.arrayContaining([...FAKE_OUTLET_NAMES, '〇〇省', '△△庁', '□□ボイス', '××ニュース']))
    const texts = forbiddenTexts(names)
    expect(texts).toEqual(expect.arrayContaining(['FAKE_', 'fake-writer-model', 'fake-checker-model', 'Mozilla/']))
    const code = `const x = "${names[0]}"; const ua = "Mozilla/5.0"; const FAKE_SOURCES = []`
    expect(textProblems(code, texts)).toEqual(expect.arrayContaining(['FAKE_', 'Mozilla/', names[0]]))
    expect(textProblems('const credit = "出典: △△庁「題」・□□ボイス"', forbiddenTexts())).toEqual(['△△庁', '□□ボイス'])
    expect(textProblems('const ua = "topic-studio-connector"', texts)).toEqual([])
    // wrangler（esbuild）は ASCII でない文字を \uXXXX（大文字の16進）に書き換えて出す。書き換えた形でも見つける
    const escaped = (t: string) =>
      Array.from(t)
        .map((c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
        .join('')
    expect(textProblems(`const site = "${escaped('△△庁')}"; const b = "\\u{1F600}"`, forbiddenTexts())).toEqual(['△△庁'])
    expect(unescapeBundle(`"${escaped('〇〇省')}"・"\\u{4E00}"`)).toBe('"〇〇省"・"一"')
    // 読めない時は空（名前のほかの文字は見る）
    expect(fakeOutletNames(path.join(tmp('ts-fake-'), 'none.ts'))).toEqual([])
  })

  it('まとめた中身に dexie・firebase・react・zustand・アプリの画面・テストの物・作り物が入っていない', async () => {
    const r = await bundleCheck({ quiet: true })
    expect(r.ok).toBe(true)
    expect(r.app).toEqual(expect.arrayContaining(['src/claude/pairing.ts', 'src/sync/appVersion.ts']))
  }, 180_000)
})
