// Claude 用のコネクタとアプリの連携を、本物どうしで通しで確かめる E2E（B8。段階3の設計の 7. の「E2E」。NS の e2e/pairing.sync.spec.ts の形）。
// Firebase エミュレーター（playwright.sync.config.ts。npm run test:e2e:sync）と、本番のアクセスルール（firestore.rules）で流す。
// - コネクタ: connector/ の Worker を wrangler の createTestHarness でこのテストの中に立ち上げる（workerd。Durable Object・KV も本物）。
//   入口は E2E のテストの入口（connector/wrangler.e2e.jsonc → connector/test/e2e/worker.ts）: Worker の口は本番の src/index.ts のまま、
//   Durable Object の Vault だけが作り物の社（〇〇省・△△庁など）・作り物の出どころの data・作り物の出どころの fetch で動く（府省・庁や
//   Global Voices のサイトへは出ない。その Worker のグローバルの fetch も、手元のエミュレーターのほかへは出ない）。
//   ブラウザからコネクタ（https://connector.e2e.test。開発サーバーの VITE_CONNECTOR_ORIGIN）への通信は、ページの通信を横取りして
//   この Worker に渡す（ブラウザの cookie の代わりに、このテストが連携を始めたブラウザの cookie を持つ）
// - コネクタの Firebase: 匿名のアカウントを Auth エミュレーターに作り、Firestore エミュレーターを REST で読む・書く
// - アプリ: 開発サーバーの本物の画面（#/claude/connect の連携の画面・設定の「Claude との連携」・トップ・詳細）
// - claude.ai: このテストが代わりに務める（DCR で登録したクライアント。DCR はこのテストの設定でだけ有効にする（ENABLE_DCR）。claude.ai の
//   公開の識別子（CIMD）は connector/test/worker の workerd のテストで確かめている）
// 流れ: 接続（/authorize）→ 同意［Topic Studio で確認する］→ アプリの連携の画面で［許可する］→ /pair/callback → claude.ai へ code
//   → トークン → 道具（試しの回: 候補を集め・下書き・照合・話題・版を確かめるだけで何も書かない → 版の回: 同じ流れで版を足す）
//   → トップに版が出て、作り物の〇〇省の話題の詳細に出典の表示（「…を加工して作成」）→ 設定（URL のコピー・状態・接続の一覧）
//   →「書き込みを許可」をオフ（版の回も訂正も断る・読むのは続く）→ 2つ目の接続（前の接続は切れない。topic_status の最後の行「この接続」）
//   → 名前を変える → 1つ解除（その接続だけ 401）→［連携をすべて解除］（401）
// コネクタの部品（npm --prefix connector ci）が無ければ、このテストは飛ばす（CI では飛ばさずに落とす）。データは作り物だけ
import { expect, test, type BrowserContext, type Locator, type Page, type Route } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { creditText } from '../src/domain/credit'
import { topicShortId } from '../src/domain/ids'
import type { TopicDraftInput } from '../src/domain/input'
import type { Source } from '../src/domain/types'
import {
  adminCreateOwner,
  adminDocIds,
  adminGoogleUser,
  adminStringField,
  clearFirestore,
  EMU_PROJECT,
  useRules,
} from '../src/test/emulatorAdmin'
import { FAKE_CHECK_MODEL, FAKE_MODEL } from '../src/test/fixtures/fakeEditions'
import { FAKE_CREDIT_OUTLETS, FAKE_OUTLETS } from '../src/test/fixtures/fakeOutlets'
import { cardOf, collectDiagnosticsOnFailure, signInSync } from './helpers'

collectDiagnosticsOnFailure()

const here = path.dirname(fileURLToPath(import.meta.url))
const connectorDir = path.resolve(here, '../connector')
const DOCS = `http://127.0.0.1:8080/v1/projects/${EMU_PROJECT}/databases/(default)/documents`
// エミュレーターでアクセスルールを通さずに読む
const ADMIN = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'

/** wrangler の createTestHarness（使う所だけ） */
interface Harness {
  listen(): Promise<{ url: URL }>
  fetch(input: string, init?: RequestInit & { redirect?: 'manual' | 'follow' }): Promise<Response>
  close(): Promise<void>
}

function wranglerEntry(): string | null {
  try {
    return createRequire(path.join(connectorDir, 'package.json')).resolve('wrangler')
  } catch {
    return null
  }
}

const entry = fs.existsSync(path.join(connectorDir, 'package.json')) ? wranglerEntry() : null
// CI ではコネクタの部品を必ず入れる（無ければ飛ばさずに失敗させる。.github/workflows/ci.yml の e2e-sync）
if (!entry && process.env.CI) throw new Error('コネクタの部品がありません（CI では npm --prefix connector ci が必要）')
test.skip(!entry, 'コネクタの部品がありません（npm --prefix connector ci）')

let harness: Harness | null = null
/** ブラウザから見たコネクタの origin（開発サーバーのビルドの時の値。https://connector.e2e.test） */
let origin = ''
/**
 * 立ち上げた Worker の origin（http://127.0.0.1:…）。ブラウザからの通信はここへ渡す（OAuth のライブラリが受け付ける http は
 * ループバックの時だけ）
 */
let workerOrigin = ''

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const b64url = (b: Buffer) => b.toString('base64url')

type Fields = Record<string, { stringValue?: string; booleanValue?: boolean; mapValue?: { fields: Fields } }>

async function readDoc(p: string): Promise<Fields | null> {
  const res = await fetch(`${DOCS}/${p}`, { headers: ADMIN })
  if (res.status === 404) return null
  expect(res.ok).toBe(true)
  return ((await res.json()) as { fields: Fields }).fields
}

/** 連携を始めたブラウザの cookie（コネクタの origin の分）。Set-Cookie を受け取り、次の通信に付ける */
class CookieJar {
  #jar = new Map<string, string>()
  take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';')
      const i = pair.indexOf('=')
      const name = pair.slice(0, i).trim()
      const value = pair.slice(i + 1).trim()
      const gone = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === ''
      if (gone) this.#jar.delete(name)
      else this.#jar.set(name, value)
    }
  }
  header(): string {
    return [...this.#jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

interface ProxyEvents {
  /** アプリがコネクタへ戻った URL（/pair/callback?state=…&k=…） */
  onCallback(url: string): void
  /** コネクタが claude.ai へ戻した URL（ブラウザは claude.ai へは行かせない） */
  onClaude(url: string): void
}

/**
 * ブラウザからコネクタへの通信を、立ち上げた Worker に渡す（ブラウザが送る Origin などはそのまま）。横取りして返した 302 の行き先は
 * ブラウザがそのまま通信する（横取りされない）ので、claude.ai へ戻す 302 だけはここで受け取り、ブラウザには「claude.ai に戻った」
 * ページを返す
 */
async function routeConnector(context: BrowserContext, jar: CookieJar, seen: string[], events: ProxyEvents) {
  const keep = [
    'accept',
    'content-type',
    'origin',
    'referer',
    'user-agent',
    'access-control-request-method',
    'access-control-request-headers',
  ]
  await context.route(`${origin}/**`, async (route: Route) => {
    const req = route.request()
    const all = await req.allHeaders()
    const headers: Record<string, string> = {}
    for (const k of keep) if (all[k]) headers[k] = all[k]
    const cookie = jar.header()
    if (cookie) headers.cookie = cookie
    const url = new URL(req.url())
    seen.push(`${req.method()} ${url.pathname}`)
    if (url.pathname === '/pair/callback') events.onCallback(req.url())
    const body = req.postDataBuffer()
    const res = await harness!.fetch(`${workerOrigin}${url.pathname}${url.search}`, {
      method: req.method(),
      headers,
      body: body && req.method() !== 'GET' ? new Uint8Array(body) : undefined,
      redirect: 'manual',
    })
    jar.take(res)
    const location = res.headers.get('location') ?? ''
    if (res.status >= 300 && res.status < 400 && location.startsWith('https://claude.ai/')) {
      events.onClaude(location)
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!doctype html><title>Claude</title><p data-testid="claude-returned">claude.ai に戻りました</p>',
      })
    }
    const out: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      if (k !== 'set-cookie') out[k] = v
    })
    await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) })
  })
}

/** claude.ai の MCP の呼び出し（JSON か SSE の答え） */
async function mcp(accessToken: string, method: string, params: Record<string, unknown> = {}) {
  const res = await harness!.fetch(`${workerOrigin}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  const body = res.status === 200 ? JSON.parse(text.startsWith('{') ? text : /data: (.*)/.exec(text)![1]) : null
  return { status: res.status, body }
}

async function callTool(accessToken: string, name: string, args: Record<string, unknown> = {}) {
  const r = await mcp(accessToken, 'tools/call', { name, arguments: args })
  if (r.status !== 200) return { status: r.status, text: '', isError: true }
  const result = r.body.result as { content: { text: string }[]; isError?: boolean }
  return { status: r.status, text: result.content.map((c) => c.text).join('\n'), isError: result.isError === true }
}

/** 作り物の下書き（作り物の文だけ。n で中身を変える。出典は集めた候補の id と社） */
function draftOf(n: number, source: { cid: string; outlet: string }): TopicDraftInput {
  return {
    rank: n,
    rankReason: `作り物の順位の理由${n}`,
    region: 'jp',
    genre: 'politics',
    major: false,
    headline: `作り物の見出し${n}　${source.outlet}の作り物の発表をまとめた`,
    summary: `${source.outlet}は、作り物の制度の見直しについて作り物の検討会の議論をまとめた（${n}番目の作り物）。作り物の窓口の受け付けの時間を延ばす案などが示された。作り物の文で長さを足す。作り物の文で長さを足す。作り物の文で長さを足す。`,
    conclusion: { label: 'settled', note: '作り物の見直しの案が示された', breaking: false },
    soWhat: { life: null, system: '作り物の仕組みの説明', world: null, whyNews: null },
    stakeholders: [],
    view: { kind: 'none', noneReason: '発表された事実だけの作り物の話題のため' },
    timeline: [{ when: new Date().toISOString().slice(0, 10), text: '作り物の検討会の議論がまとまった' }],
    followUp: null,
    terms:
      n === 1
        ? [
            {
              new: {
                key: '作り物の通しの語',
                term: '作り物の通しの語',
                aliases: [],
                explanation: '作り物の語の説明',
                asOf: '2026-11',
              },
            },
          ]
        : [],
    sources: [{ ref: source.cid, outlet: source.outlet }],
    unverified: [],
    emphasis: { summary: ['作り物の窓口'] },
  }
}

/**
 * claude.ai の定期実行の代わりに、1つの回を流す: 回を始め、候補集めを待ち、候補の一覧から5本（〇〇省を先に）を読み、下書きを置き、
 * 読んでから照合済みにし、話題を足し（照合済み5本で門が開く）、最後に版を足す。試しの回は確かめだけ（書かない）
 */
async function runEdition(token: string, kind: 'edition' | 'trial') {
  const begun = await callTool(token, 'topic_begin_run', { kind, model: FAKE_MODEL })
  expect(begun.isError, begun.text).toBe(false)
  const runId = /runId: (r\d{12}-[0-9a-z]{4})/.exec(begun.text)![1]
  const call = (name: string, args: Record<string, unknown> = {}) => callTool(token, name, { runId, ...args })
  // 候補集め（コネクタの alarm で進む。作り物の出どころは1つのホストなので、取りに行く間（1秒）をあけて順に取る）
  let readable = 0
  await expect
    .poll(
      async () => {
        const s = await call('topic_status')
        const m = /候補集め: 終わりました（読める候補 (\d+)件/.exec(s.text)
        readable = m ? Number(m[1]) : -1
        return readable
      },
      { timeout: 120_000, intervals: [1_000] },
    )
    .toBeGreaterThanOrEqual(5)
  const list = await call('topic_list_candidates')
  expect(list.isError, list.text).toBe(false)
  const names = new Set<string>(Object.values(FAKE_CREDIT_OUTLETS))
  const cands = [...list.text.matchAll(/^(c\d{4}) (\S+)/gm)]
    .map((m) => ({ cid: m[1], outlet: m[2] }))
    .filter((c) => names.has(c.outlet))
  const picked = [
    ...cands.filter((c) => c.outlet === FAKE_CREDIT_OUTLETS.site),
    ...cands.filter((c) => c.outlet !== FAKE_CREDIT_OUTLETS.site && c.outlet !== FAKE_CREDIT_OUTLETS.ccBy),
  ].slice(0, 5)
  expect(picked.map((c) => c.outlet)).toContain(FAKE_CREDIT_OUTLETS.site)
  expect(picked).toHaveLength(5)
  const drafts: string[] = []
  for (const [i, c] of picked.entries()) {
    const read = await call('topic_read_article', { ref: c.cid })
    expect(read.isError, read.text).toBe(false)
    const saved = await call('topic_save_draft', { model: FAKE_MODEL, topic: draftOf(i + 1, c) })
    expect(saved.isError, saved.text).toBe(false)
    drafts.push(/(d:\d{2})/.exec(saved.text)![1])
  }
  for (const d of drafts) {
    expect((await call('topic_get_draft', { draft: d })).isError).toBe(false)
    const checked = await call('topic_check_draft', { draft: d, model: FAKE_CHECK_MODEL, claims: 3, patches: [] })
    expect(checked.isError, checked.text).toBe(false)
  }
  const added = await call('topic_add_topics', { items: drafts.map((draft, i) => ({ draft, rank: i + 1 })) })
  expect(added.isError, added.text).toBe(false)
  const edition = await call('topic_add_edition', { order: drafts, candidateCount: readable, notChosen: [] })
  expect(edition.isError, edition.text).toBe(false)
  return { runId, picked, added: added.text, edition: edition.text }
}

test.beforeAll(async ({}, testInfo) => {
  await useRules(fs.readFileSync(path.resolve(here, '../firestore.rules'), 'utf8'))
  const appOrigin = new URL(String(testInfo.project.use.baseURL)).origin
  // テストからネットに出ない: miniflare が Request.cf の見本を Cloudflare から取りに行くのと、wrangler の利用の統計を送るのを止める
  process.env.CLOUDFLARE_CF_FETCH_ENABLED = 'false'
  process.env.WRANGLER_SEND_METRICS = 'false'
  const { createTestHarness } = (await import(pathToFileURL(entry!).href)) as {
    createTestHarness(o: unknown): Harness
  }
  harness = createTestHarness({
    root: connectorDir,
    workers: [
      {
        // E2E のテストの入口（本番の wrangler.jsonc と入口は替えない）
        configPath: './wrangler.e2e.jsonc',
        vars: {
          // コネクタの Firebase はエミュレーター（アプリの開発サーバーと同じ demo-topic-studio）
          FIREBASE_EMULATOR_HOST: '127.0.0.1',
          FIREBASE_PROJECT_ID: EMU_PROJECT,
          FIREBASE_API_KEY: 'fake-api-key',
          // アプリ（この開発サーバー）。/connect/identity の CORS と、同意の後に開く連携の画面
          APP_ORIGIN: appOrigin,
          // claude.ai の代わりにこのテストがクライアントを登録する
          ENABLE_DCR: 'true',
        },
        secrets: { TOKEN_ENC_KEY: b64url(randomBytes(32)) },
      },
    ],
  })
  workerOrigin = (await harness.listen()).url.origin
})

test.afterAll(async () => {
  await harness?.close()
  harness = null
})

test.beforeEach(async () => {
  // 持ち主の記録 config/owner はデータベースに1つなので、テストごとに空にする
  await clearFirestore()
})

test.afterEach(async ({ browser }) => {
  await Promise.all(browser.contexts().map((c) => c.close()))
})

/** topic_status の最後の行（許可のある呼び出しだけ「この接続: …」） */
const lastLine = (text: string) => text.split('\n').at(-1)
const thisConnection = (name: string, n: number) =>
  `この接続: ${name}（接続 ${n} / 2。名前はアプリの 設定 →「Claude との連携」で変えられます）`

interface Connected {
  accessToken: string
  /** アプリの連携の画面の URL */
  appUrl: URL
  /** コネクタが渡した連携の印 */
  state: string
  /** アプリがコネクタへ戻った URL（/pair/callback?state=…&k=…） */
  pair: URL
}

test(
  '本物のコネクタと: claude.ai の接続 → アプリで許可 → トークン → 道具（試しの回・版の回）→ トップに版と出典の表示 → 設定 → 書き込みの停止 → 2つ目の接続 → 名前を変える → 1つ解除 → すべて解除',
  { tag: ['@pc'] },
  async ({ browser }) => {
    test.setTimeout(420_000)
    const sub = `e2e-pair-${Date.now()}`
    const ownerUid = await adminGoogleUser(sub)
    await adminCreateOwner(ownerUid)
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await context.newPage()
    await page.goto('/#/')
    await page.waitForFunction(() => Boolean(window.__ts))
    // 開発サーバーのビルドの時に決めたコネクタの場所（playwright.sync.config.ts の VITE_CONNECTOR_ORIGIN）
    origin = await page.evaluate(async (file) => {
      const m = (await import(/* @vite-ignore */ file)) as { CONNECTOR_ORIGIN: string }
      return m.CONNECTOR_ORIGIN
    }, '/src/features/claude/connectLogic.ts')
    expect(origin, '開発サーバーに VITE_CONNECTOR_ORIGIN が無い（playwright.sync.config.ts の webServer.env）').toMatch(
      /^https:\/\//,
    )
    // 持ち主としてログインし、トップが出るまで待つ（同期が始まり、データの形の版をこのアプリの版にする）
    await signInSync(page, sub)
    expect(await page.evaluate(() => window.__ts.syncUid())).toBe(ownerUid)

    const jar = new CookieJar()
    const seen: string[] = []
    let pairUrl = ''
    let claudeCallback = ''
    await routeConnector(context, jar, seen, { onCallback: (u) => (pairUrl = u), onClaude: (u) => (claudeCallback = u) })
    // 本物の claude.ai へは行かない
    await context.route('https://claude.ai/**', (route) => route.abort())

    // claude.ai: クライアントを登録する
    const reg = await harness!.fetch(`${workerOrigin}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: [CLAUDE_CALLBACK],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })
    expect(reg.status).toBe(201)
    const clientId = ((await reg.json()) as { client_id: string }).client_id

    /** claude.ai の代わりに、ブラウザで接続を始めて、アプリの連携の画面で許可し（onForm で確かめる）、code をトークンにする */
    async function connect(p: Page, claudeState: string, onForm: (form: Locator) => Promise<void>): Promise<Connected> {
      pairUrl = ''
      claudeCallback = ''
      const verifier = b64url(randomBytes(32))
      const challenge = b64url(createHash('sha256').update(verifier).digest())
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: CLAUDE_CALLBACK,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: claudeState,
        scope: 'topic offline_access',
        resource: `${workerOrigin}/mcp`,
      })
      await p.goto(`${origin}/authorize?${q}`)
      await expect(p.getByText('Topic Studio への接続を求めています')).toBeVisible()
      await p.getByTestId('consent-approve').click()
      // アプリの連携の画面（コネクタが渡した印だけ。uid・origin は URL から受け取らない）
      const form = p.getByTestId('connect-form')
      await expect(form).toBeVisible({ timeout: 60_000 })
      const appUrl = new URL(p.url())
      const state = new URLSearchParams(appUrl.hash.split('?')[1]).get('s')!
      await onForm(form)
      await form.getByTestId('connect-approve').click()
      // コネクタが指紋を確かめて claude.ai へ戻す
      await expect.poll(() => claudeCallback, { timeout: 60_000 }).not.toBe('')
      await expect(p.getByTestId('claude-returned')).toBeVisible()
      const back = new URL(claudeCallback)
      expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK)
      expect(back.searchParams.get('state')).toBe(claudeState)
      const code = back.searchParams.get('code')!
      expect(code).toBeTruthy()
      const pair = new URL(pairUrl)
      // claude.ai: code をトークンにする
      const tokenRes = await harness!.fetch(`${workerOrigin}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: CLAUDE_CALLBACK,
          resource: `${workerOrigin}/mcp`,
        }).toString(),
      })
      expect(tokenRes.status).toBe(200)
      const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string }
      return { accessToken, appUrl, state, pair }
    }

    // 1つ目の接続
    const first = await connect(page, 'oauth-state-one', async (form) => {
      expect(seen).toContain('GET /connect/identity')
      await expect(form.getByTestId('connect-connection-count')).toHaveText('0 / 2')
      await expect(form.getByTestId('connect-name')).toHaveValue('接続1')
      await expect(form.getByTestId('connect-writes')).toBeChecked()
    })
    expect(first.appUrl.origin).toBe(new URL(String(test.info().project.use.baseURL)).origin)
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // アプリはビルドの時に決めたコネクタへ、印と k を URL の引数で渡した
    expect(first.pair.origin).toBe(origin)
    expect(first.pair.searchParams.get('state')).toBe(first.state)
    const k = first.pair.searchParams.get('k')!
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/)

    // 連携の記録: コネクタの匿名のアカウントと指紋だけ（k は書かない）
    const conn = (await readDoc('config/connector'))!
    const connectorUid = conn.uid.stringValue!
    expect(connectorUid).toBeTruthy()
    expect(connectorUid).not.toBe(ownerUid)
    expect(conn.writes.booleanValue).toBe(true)
    expect(conn.pairing.stringValue).toBe(sha256(`${first.state}.${k}`))
    expect(JSON.stringify(conn)).not.toContain(k)

    // 同じ戻りの URL はもう使えない（一度だけ）
    const replay = await harness!.fetch(`${workerOrigin}${first.pair.pathname}${first.pair.search}`, {
      redirect: 'manual',
      headers: { cookie: jar.header() },
    })
    expect(replay.status).toBeGreaterThanOrEqual(400)

    // 道具: 状態（連携した・この接続）
    const status = await callTool(first.accessToken, 'topic_status')
    expect(status.isError, status.text).toBe(false)
    expect(lastLine(status.text)).toBe(thisConnection('接続1', 1))

    // 試しの回: 版の回と同じ流れを通すが、クラウドには何も書かない
    const trial = await runEdition(first.accessToken, 'trial')
    expect(trial.picked).toHaveLength(5)
    expect(await adminDocIds(ownerUid, 'records')).toEqual([])

    // 版の回: 辞書の束 → 話題 → 版をクラウドに足す
    const real = await runEdition(first.accessToken, 'edition')
    const docs = await adminDocIds(ownerUid, 'records')
    expect(docs.filter((d) => d.startsWith('termPacks:'))).toHaveLength(1)
    expect(docs.filter((d) => d.startsWith('topics:'))).toHaveLength(5)
    const editionDoc = docs.find((d) => d.startsWith('editions:'))!
    expect(editionDoc).toBeTruthy()
    expect(await adminStringField(`users/${ownerUid}/records/${editionDoc}`, 'device')).toBe('claude-connector')
    // 〇〇省の話題の記録（出典の URL は作り物の出どころ）
    const siteTopicDoc = (
      await Promise.all(
        docs
          .filter((d) => d.startsWith('topics:'))
          .map(async (d) => ({ d, json: (await adminStringField(`users/${ownerUid}/records/${d}`, 'json')) ?? '' })),
      )
    ).find((t) => t.json.includes(`${FAKE_CREDIT_OUTLETS.site}の作り物の発表をまとめた`))!
    expect(siteTopicDoc).toBeTruthy()
    const siteTopic = JSON.parse(siteTopicDoc.json) as { id: string; sources: Source[] }
    expect(siteTopic.sources[0].url).toMatch(/^https:\/\/example\.com\/fake-ministry\/press\/\d+\.html$/)
    const credit = creditText(siteTopic.sources[0], FAKE_OUTLETS)!
    expect(credit).toContain('を加工して作成')
    expect(real.edition).not.toContain(FAKE_MODEL)

    // トップに版が出て、〇〇省の話題の詳細に出典の表示（連携を終えたタブは claude.ai に移ったので、アプリを開き直す）
    const app = await context.newPage()
    await app.goto('/#/')
    await expect(app.getByTestId('top-page')).toBeVisible({ timeout: 30_000 })
    const card = cardOf(app, siteTopic.id)
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card).toContainText(`${FAKE_CREDIT_OUTLETS.site}の作り物の発表をまとめた`)
    await expect(card).toContainText(`出典: ${FAKE_CREDIT_OUTLETS.site}`)
    expect(await app.evaluate((id) => window.__ts.openTopic(id), siteTopic.id)).toBe(true)
    const detail = app.getByTestId('topic-detail')
    await expect(detail).toBeVisible()
    await expect(detail.getByTestId('topic-credit').first()).toHaveText(credit)

    // 設定の「Claude との連携」: コネクタの URL のコピー・連携の状態・接続の一覧
    const settings = app
    await settings.goto('/#/settings')
    const claude = settings.getByTestId('claude-settings')
    await expect(claude.getByTestId('claude-connector-url')).toHaveText(`${origin}/mcp`)
    await claude.getByTestId('claude-copy-url').click()
    await expect(settings.getByText('コネクタの URL をコピーしました')).toBeVisible()
    expect(await settings.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/mcp`)
    const info = claude.getByTestId('claude-pairing-info')
    await expect(info).toBeVisible({ timeout: 30_000 })
    await expect(info.getByTestId('claude-connection-count')).toContainText('接続 1 / 2')
    const rows = info.getByTestId('claude-connection')
    await expect(rows.getByTestId('claude-connection-name')).toHaveText(['接続1'])
    await expect(info.getByTestId('claude-writes-state')).toHaveText('許可')

    // 書き込みを止めると、版の回も訂正だけの回も始めない（読むのは続く）
    await settings.locator('label:has([data-testid="claude-writes-toggle"])').click()
    await expect(info.getByTestId('claude-writes-state')).toHaveText('停止中（読むだけ）', { timeout: 30_000 })
    // （コネクタは連携の記録を1分ごとに読み直す。回を始める道具で待つと回の数を使うので、状態の道具で待つ）
    await expect
      .poll(async () => (await callTool(first.accessToken, 'topic_status')).text, { timeout: 90_000, intervals: [2_000] })
      .toContain('書き込み: 停止中')
    for (const kind of ['edition', 'correction'] as const) {
      const refused = await callTool(first.accessToken, 'topic_begin_run', { kind, model: FAKE_MODEL })
      expect(refused.isError, kind).toBe(true)
      expect(refused.text).toContain('書き込みは停止中です')
    }
    const recent = await callTool(first.accessToken, 'topic_list_recent')
    expect(recent.isError, recent.text).toBe(false)
    expect(recent.text).toContain(topicShortId(siteTopic.id))

    // 2つ目の接続（別の claude.ai のアカウントの見立て）。前の接続は切れない
    const second = await connect(page, 'oauth-state-two', async (form) => {
      await expect(form.getByTestId('connect-connection-count')).toHaveText('1 / 2')
      await expect(form.getByTestId('connect-name')).toHaveValue('接続2')
      await expect(form.getByTestId('connect-mode-add')).toBeChecked()
      // 書き込みの許可は、いまの記録の値（止めたまま）
      await expect(form.getByTestId('connect-writes')).not.toBeChecked()
    })
    const conn2 = (await readDoc('config/connector'))!
    expect(conn2.uid.stringValue).toBe(connectorUid)
    const k2 = second.pair.searchParams.get('k')!
    expect(conn2.pairing.stringValue).toBe(sha256(`${second.state}.${k2}`))
    expect(Object.keys(conn2.connections.mapValue!.fields)).toHaveLength(2)
    for (const [token, name] of [
      [first.accessToken, '接続1'],
      [second.accessToken, '接続2'],
    ] as const) {
      const s = await callTool(token, 'topic_status')
      expect(s.isError).toBe(false)
      expect(lastLine(s.text)).toBe(thisConnection(name, 2))
    }

    // 設定: 名前を変えると、topic_status の「この接続」も変わる
    await settings.goto('/#/settings')
    await expect(rows.getByTestId('claude-connection-name')).toHaveText(['接続1', '接続2'], { timeout: 30_000 })
    await rows.nth(1).getByTestId('claude-connection-rename').click()
    const dialog = settings.getByRole('dialog')
    await dialog.getByRole('textbox').fill('仕事用')
    await dialog.getByRole('button', { name: '変更' }).click()
    await expect(rows.getByTestId('claude-connection-name')).toHaveText(['接続1', '仕事用'], { timeout: 30_000 })
    await expect
      .poll(async () => lastLine((await callTool(second.accessToken, 'topic_status')).text), {
        timeout: 90_000,
        intervals: [2_000],
      })
      .toBe(thisConnection('仕事用', 2))

    // 1つ解除: その接続だけが 401。ほかの接続はそのまま使える
    await rows.first().getByTestId('claude-connection-remove').click()
    await settings.getByRole('dialog').getByRole('button', { name: 'この接続を解除' }).click()
    await expect(rows.getByTestId('claude-connection-name')).toHaveText(['仕事用'], { timeout: 30_000 })
    await expect.poll(async () => (await callTool(first.accessToken, 'topic_status')).status, { timeout: 90_000 }).toBe(401)
    expect((await callTool(first.accessToken, 'topic_list_recent')).status).toBe(401)
    const still = await callTool(second.accessToken, 'topic_status')
    expect(still.status).toBe(200)
    expect(lastLine(still.text)).toBe(thisConnection('仕事用', 1))
    expect((await callTool(second.accessToken, 'topic_list_recent')).text).toContain(topicShortId(siteTopic.id))

    // ［連携をすべて解除］: その場でコネクタは読めなくなり、claude.ai には接続し直しを求める（401）
    await settings.getByTestId('claude-unpair').click()
    await settings.getByRole('dialog').getByRole('button', { name: '連携をすべて解除' }).click()
    await expect(settings.getByTestId('claude-pairing-none')).toBeVisible({ timeout: 30_000 })
    // （画面は送った削除を先に映すので、クラウドの記録が消えるのを待つ）
    await expect.poll(() => readDoc('config/connector'), { timeout: 30_000 }).toBeNull()
    await expect.poll(async () => (await callTool(second.accessToken, 'topic_status')).status, { timeout: 90_000 }).toBe(401)
    await context.close()
  },
)
