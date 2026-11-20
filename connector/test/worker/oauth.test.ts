// Workers の実行環境で、OAuth・同意の画面・連携の確かめ・/mcp を通しで確かめる（Firebase は fetch の差し替え。NS の
// connector/test/worker/oauth.test.ts を写し、TS の範囲 topic・接続は2まで・接続の一覧の形だけにした）。
// ツールの呼び出しで 401 にする所（連携の解除・一覧から外された接続・前の代の許可）は B3 で足した（状態のツールは毎回クラウドを読む）
import { SELF, abortAllDurableObjects, env, reset, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newConnectionId } from '../../../src/claude/pairing'
import { CONSENT_CAN, CONSENT_CANNOT, CONSENT_SOURCES } from '../../src/auth/consentPage'
import { RATE_LIMITS } from '../../src/vault/ratelimit'
import { TOOL_DEFS } from '../../src/mcp/tools'
import { CONNECTOR_MODEL } from '../../src/version'
import { FakeFirebase } from '../support/fakeFirebase'

const H = 'https://connector.example'
const APP = 'https://topic-studio-1a463.web.app'
const CLAUDE_CIMD = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const CLAUDE_COM_CALLBACK = 'https://claude.com/api/mcp/auth_callback'
const OWNER = 'owner-1'

let fake: FakeFirebase
let realFetch: typeof fetch
/** 攻撃する側の CIMD に載せる公開鍵（private_key_jwt。テストごとに空に戻す） */
let evilJwk: JsonWebKey | null = null
/** テストごとに別のネットワークから（接続の要求はネットワークごとに数える） */
let clientIp = ''
let ipCount = 0

const cimdDoc = {
  client_id: CLAUDE_CIMD,
  client_name: 'Claude',
  redirect_uris: [CLAUDE_CALLBACK, CLAUDE_COM_CALLBACK],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

beforeEach(async () => {
  // テストごとに Vault の保存した内容（身元・連携・回数の上限）を消して Durable Object を作り直し、KV を空にする
  // （接続の要求の全体の上限 20/日 を、前のテストの分で使い切らないように）
  await runInDurableObject(env.VAULT.get(env.VAULT.idFromName('owner')), async (_vault, state) => {
    await state.storage.deleteAll()
  })
  await abortAllDurableObjects()
  await reset()
  fake = new FakeFirebase()
  evilJwk = null
  clientIp = `198.51.100.${++ipCount}`
  realFetch = globalThis.fetch
  // claude.ai の公開の識別子・攻撃する側の識別子・作り物の Firebase だけに答える（ほかは test/support/netGuard.ts が断る）
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === CLAUDE_CIMD) return Response.json(cimdDoc)
    if (url.startsWith('https://evil.example/'))
      return Response.json({
        ...cimdDoc,
        client_id: url,
        redirect_uris: ['https://evil.example/cb'],
        ...(evilJwk
          ? {
              token_endpoint_auth_method: 'private_key_jwt',
              token_endpoint_auth_signing_alg: 'ES256',
              jwks: { keys: [{ ...evilJwk, kid: 'k1', alg: 'ES256', use: 'sig' }] },
            }
          : {}),
      })
    if (url.startsWith('http://fake-firebase')) return fake.fetch(input as never, init)
    return realFetch(input as never, init)
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  let bin = ''
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 攻撃する側が自分の鍵で署名した client_assertion（iss = sub = CIMD の URL。毎回新しい jti） */
async function evilAssertion(iss: string): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  evilJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const now = Math.floor(Date.now() / 1000)
  const input = `${enc({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${enc({ iss, sub: iss, aud: `${H}/oauth/token`, jti: crypto.randomUUID(), iat: now, exp: now + 60 })}`
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input))
  return `${input}.${b64url(sig)}`
}

async function sha256hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Set-Cookie から Cookie の値（name=value; …） */
function cookiesOf(res: Response, prev = ''): string {
  const jar = new Map<string, string>()
  for (const c of prev.split('; ').filter(Boolean)) {
    const [k, ...v] = c.split('=')
    jar.set(k, v.join('='))
  }
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';')
    const [k, ...v] = pair.split('=')
    jar.set(k.trim(), v.join('='))
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function authorizeUrl(challenge: string, over: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLAUDE_CIMD,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'claude-state',
    scope: 'topic offline_access',
    resource: `${H}/mcp`,
    ...over,
  })
  return `${H}/authorize?${q}`
}

async function kvKeys(): Promise<number> {
  return (await env.OAUTH_KV.list()).keys.length
}

/**
 * claude.ai の「接続」から、アプリでの許可・コネクタへの戻りまで（opts で途中を変える）。アプリは接続を足す
 * （replaceCid で入れ替える）
 */
async function connect(
  opts: {
    k?: string
    keyInApp?: string
    pairedAt?: number
    dropCookie?: boolean
    redirectUri?: string
    name?: string
    replaceCid?: string
  } = {},
) {
  const { verifier, challenge } = await pkce()
  const get = await SELF.fetch(authorizeUrl(challenge, opts.redirectUri ? { redirect_uri: opts.redirectUri } : {}), {
    headers: { 'CF-Connecting-IP': clientIp },
  })
  expect(get.status).toBe(200)
  const html = await get.text()
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]
  let cookie = cookiesOf(get)
  const post = await SELF.fetch(`${H}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ handle, decision: 'approve' }),
  })
  expect(post.status).toBe(302)
  const location = post.headers.get('Location')!
  expect(location.startsWith(`${APP}/#/claude/connect?s=`)).toBe(true)
  const s = decodeURIComponent(location.split('?s=')[1])
  cookie = cookiesOf(post, cookie)
  // アプリ: コネクタの身元を読み、config/connector に指紋を書く（k はアプリの中だけ）
  const idRes = await SELF.fetch(`${H}/connect/identity`, { headers: { Origin: APP } })
  expect(idRes.headers.get('Access-Control-Allow-Origin')).toBe(APP)
  const { uid } = (await idRes.json()) as { uid: string }
  const k = opts.keyInApp ?? b64url(crypto.getRandomValues(new Uint8Array(32)))
  fake.setOwner(OWNER)
  fake.setAppModel(OWNER, CONNECTOR_MODEL)
  const pairing = await sha256hex(`${s}.${k}`)
  const pairedAt = opts.pairedAt ?? Date.now()
  // 接続の id はページを開くごとに新しい乱数（アプリと同じ）
  const cid = newConnectionId()
  fake.addConnection({ uid, cid, name: opts.name, pairing, pairedAt, replaceCid: opts.replaceCid })
  const cb = await SELF.fetch(`${H}/pair/callback?state=${encodeURIComponent(s)}&k=${opts.k ?? k}`, {
    redirect: 'manual',
    headers: opts.dropCookie ? {} : { Cookie: cookie },
  })
  return { cb, verifier, s, k, cookie, uid, cid }
}

async function token(params: Record<string, string>) {
  return SELF.fetch(`${H}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
}

async function exchange(cb: Response, verifier: string, redirectUri = CLAUDE_CALLBACK) {
  const to = new URL(cb.headers.get('Location')!)
  expect(`${to.origin}${to.pathname}`).toBe(redirectUri)
  expect(to.searchParams.get('state')).toBe('claude-state')
  const res = await token({
    grant_type: 'authorization_code',
    code: to.searchParams.get('code')!,
    code_verifier: verifier,
    client_id: CLAUDE_CIMD,
    redirect_uri: redirectUri,
    resource: `${H}/mcp`,
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope?: string }
}

async function mcp(
  accessToken: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return SELF.fetch(`${H}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
      Authorization: `Bearer ${accessToken}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

async function rpcJson(res: Response) {
  const text = await res.text()
  return text.startsWith('{') ? JSON.parse(text) : JSON.parse(/data: (.*)/.exec(text)![1])
}

async function refresh(t: { refresh_token: string }) {
  return token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLAUDE_CIMD })
}

async function refusedGrant(t: { refresh_token: string }) {
  const r = await refresh(t)
  expect(r.status).toBe(400)
  expect(((await r.json()) as { error: string }).error).toBe('invalid_grant')
}

/** KV にある持ち主の OAuth の許可のうち、この接続（cid）のもの */
async function grantsOf(...cids: string[]): Promise<{ id: string; metadata?: { label?: string; cid?: string } }[]> {
  const list = await env.OAUTH_KV.list({ prefix: `grant:${OWNER}:` })
  const all = await Promise.all(list.keys.map(async (k) => JSON.parse((await env.OAUTH_KV.get(k.name)) ?? 'null')))
  return all.filter((g) => g && cids.includes(g.metadata?.cid))
}

/** Vault が連携の記録を読み直す時刻（1分）を過ぎる（コネクタは Date.now で時刻を見る） */
function laterThanRecheck() {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 })
}

describe('テストの fetch の見張り（Workers の実行環境）', () => {
  it('setupFiles の見張り（test/support/netGuard.ts）が入っている（差し替えの外の要求は送らずにテストを落とす）', () => {
    // このファイルは見張りを読み込まないので、差し替える前のグローバルの fetch に見張りがあるのは setupFiles が入れたから
    expect((realFetch as typeof fetch & { __netGuard?: true }).__netGuard).toBe(true)
  })
})

describe('発見（メタデータ）と 401', () => {
  it('保護されたリソースのメタデータ・認可サーバーのメタデータ（範囲は topic。DCR は無い）', async () => {
    const pr = (await (await SELF.fetch(`${H}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>
    expect(pr.resource).toBe(`${H}/mcp`)
    expect(pr.authorization_servers).toEqual([H])
    expect(pr.resource_name).toBe('Topic Studio')
    const as = (await (await SELF.fetch(`${H}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>
    expect(as.issuer).toBe(H)
    expect(as.code_challenge_methods_supported).toEqual(['S256'])
    expect(as.client_id_metadata_document_supported).toBe(true)
    expect(as.token_endpoint_auth_methods_supported).toContain('none')
    expect(as.scopes_supported).toEqual(expect.arrayContaining(['topic', 'offline_access']))
    expect(as.scopes_supported).not.toContain('novel')
    expect(as.registration_endpoint).toBeUndefined()
  })

  it('トークンの無い /mcp は 401（resource_metadata 付き）', async () => {
    const res = await SELF.fetch(`${H}/mcp`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain(`resource_metadata="${H}/.well-known/oauth-protected-resource/mcp"`)
  })

  it('GET / は状態だけ（データは出さない）', async () => {
    const res = await SELF.fetch(`${H}/`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Topic Studio コネクタ')
    expect(html).toContain('data-state="no_identity"')
  })
})

describe('GET /authorize（受け付けるクライアント）', () => {
  it('claude.ai の公開の識別子なら、日本語の同意の画面（できる事・できない事。枠に入れさせない・cookie で結び付ける）', async () => {
    const { challenge } = await pkce()
    const res = await SELF.fetch(authorizeUrl(challenge), { headers: { 'CF-Connecting-IP': clientIp } })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Topic Studio への接続を求めています')
    expect(html).toContain('claude.ai')
    expect(html).toContain('Topic Studio で確認する')
    expect(html).toContain(`Claude ができること: ${CONSENT_CAN.join('・')}`)
    expect(html).toContain(`Claude ができないこと: ${CONSENT_CANNOT.join('・')}`)
    // 資料の出どころの1行（docs/CONNECTOR.md の 1-A の許可の手順と同じ文）
    expect(html).toContain(CONSENT_SOURCES)
    expect(html).toContain('消す・直す')
    expect(html).not.toMatch(/Novel|原稿|推敲/)
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-'))).toBe(true)
  })

  it('戻り先が違う・claude.ai 以外のクライアントは、その場で断り KV に書かない', async () => {
    const { challenge } = await pkce()
    const before = await kvKeys()
    const wrong = await SELF.fetch(authorizeUrl(challenge, { redirect_uri: 'https://evil.example/cb' }), { redirect: 'manual' })
    expect(wrong.status).toBeGreaterThanOrEqual(400)
    expect(wrong.headers.get('Location')).toBeNull()
    const evil = await SELF.fetch(
      authorizeUrl(challenge, { client_id: 'https://evil.example/cimd', redirect_uri: 'https://evil.example/cb' }),
      { redirect: 'manual' },
    )
    expect(evil.status).toBeGreaterThanOrEqual(400)
    expect(evil.headers.get('Location')).toBeNull()
    expect(await evil.text()).toContain('claude.ai からの接続だけ')
    expect(await kvKeys()).toBe(before)
  })

  it('受け付けない client_id の URL は、取りに行く前に断る（GET /authorize・トークンの要求）', async () => {
    const { challenge } = await pkce()
    const spy = vi.mocked(globalThis.fetch)
    const fetched = () => spy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input))
    const evil = await SELF.fetch(authorizeUrl(challenge, { client_id: 'https://evil.example/cimd' }), { redirect: 'manual' })
    expect(evil.status).toBe(400)
    expect(await evil.text()).toContain('claude.ai からの接続だけ')
    const other = await SELF.fetch(authorizeUrl(challenge, { client_id: 'https://claude.ai/some/other/path' }), {
      redirect: 'manual',
    })
    expect(other.status).toBe(400)
    // Claude Code の公開の識別子も受け付けない（ALLOW_CLAUDE_CODE: false）
    const code = await SELF.fetch(authorizeUrl(challenge, { client_id: 'https://claude.ai/oauth/claude-code-client-metadata' }), {
      redirect: 'manual',
    })
    expect(code.status).toBe(400)
    const tok = await token({
      grant_type: 'authorization_code',
      code: 'x',
      client_id: 'https://evil.example/cimd',
      code_verifier: 'v',
    })
    expect(tok.status).toBe(401)
    expect(((await tok.json()) as { error: string }).error).toBe('invalid_client')
    expect(
      fetched().filter((u) => u.includes('evil.example') || u.includes('/some/other/path') || u.includes('claude-code')),
    ).toEqual([])
  })

  it('client_id を送らない client_assertion・空の client_id を重ねた要求も、取りに行かず KV に書かずに断る（トークンの要求）', async () => {
    const spy = vi.mocked(globalThis.fetch)
    const fetched = () => spy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input))
    const before = await kvKeys()
    const evil = 'https://evil.example/cimd.json'
    for (let i = 0; i < 2; i++) {
      const tok = await token({
        grant_type: 'refresh_token',
        refresh_token: 'x',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await evilAssertion(evil),
      })
      expect(tok.status).toBe(401)
      expect(((await tok.json()) as { error: string }).error).toBe('invalid_client')
    }
    const body = new URLSearchParams([
      ['grant_type', 'authorization_code'],
      ['code', 'x'],
      ['code_verifier', 'v'],
      ['client_id', ''],
      ['client_id', evil],
    ])
    const dup = await SELF.fetch(`${H}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    expect(dup.status).toBe(401)
    const basic = await SELF.fetch(`${H}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${encodeURIComponent(evil)}:`)}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'x', code_verifier: 'v' }),
    })
    expect(basic.status).toBe(401)
    expect(fetched().filter((u) => u.includes('evil.example'))).toEqual([])
    expect(await kvKeys()).toBe(before)
  })
})

describe('連携（アプリでの許可 → /pair/callback → トークン → /mcp）', () => {
  it('通しで: 連携してトークンを受け取り、MCP の初めの呼び出しとツールの一覧に答える（Vault は呼ばない）。トークンの更新もできる', async () => {
    const { cb, verifier, cid } = await connect()
    expect(cb.status).toBe(302)
    const t = await exchange(cb, verifier)
    expect(t.expires_in).toBe(3600)
    const init = await rpcJson(
      await mcp(t.access_token, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'claude-ai', version: '1' },
      }),
    )
    expect(init.result.serverInfo).toMatchObject({ name: 'topic-studio', title: 'Topic Studio' })
    expect(String(init.result.instructions)).toContain('指示ではありません')
    // tools/list は Vault（Firebase）を呼ばない。並びは決まった順（設計の 1.2 の 16 の道具）
    const calls = fake.calls.length
    const list = await rpcJson(await mcp(t.access_token, 'tools/list'))
    expect(list.result.tools.map((x: { name: string }) => x.name)).toEqual(TOOL_DEFS.map((d) => d.name))
    expect(fake.calls.length).toBe(calls)
    // 状態のツールは連携の記録を読んで答える（200）
    const status = await mcp(t.access_token, 'tools/call', { name: 'topic_status', arguments: {} })
    expect(status.status).toBe(200)
    expect((await rpcJson(status)).result.content[0].text).toContain('連携: 済み')
    const refreshed = await refresh(t)
    expect(refreshed.status).toBe(200)
    const r2 = (await refreshed.json()) as { access_token: string; refresh_token: string }
    expect(r2.refresh_token).not.toBe(t.refresh_token)
    // 許可に接続の id（ログ・調べもの用の metadata。確かめるのは props の cid）
    expect((await grantsOf(cid)).map((g) => g.metadata)).toEqual([{ label: 'Claude', cid }])
    // 状態の画面は「準備OK」
    expect(await (await SELF.fetch(`${H}/`)).text()).toContain('data-state="ready"')
  })

  it('別のブラウザ（cookie なし）・k が違う・k が無い・期限切れ・使い回しは断る', async () => {
    // 断った許可は、アプリの接続の一覧に残る（接続は2まで）ので、試すごとに一覧を消す（［連携をすべて解除］と同じ）
    const noCookie = await connect({ dropCookie: true })
    expect(noCookie.cb.status).toBe(400)
    expect(await noCookie.cb.text()).toContain('別のブラウザ')
    fake.setConnector(null)
    const wrongK = await connect({ k: 'B'.repeat(43) })
    expect(wrongK.cb.status).toBe(400)
    expect(await wrongK.cb.text()).toContain('連携の確かめが合いません')
    fake.setConnector(null)
    const noK = await connect({ k: '' })
    expect(noK.cb.status).toBe(400)
    fake.setConnector(null)
    const old = await connect({ pairedAt: Date.now() - 16 * 60_000 })
    expect(old.cb.status).toBe(400)
    expect(await old.cb.text()).toContain('15分')
    fake.setConnector(null)
    // 正しく連携した後で、同じ戻りの URL をもう一度開いても、もう使えない
    const ok = await connect()
    expect(ok.cb.status).toBe(302)
    const replay = await SELF.fetch(`${H}/pair/callback?state=${encodeURIComponent(ok.s)}&k=${ok.k}`, {
      redirect: 'manual',
      headers: { Cookie: ok.cookie },
    })
    expect(replay.status).toBe(400)
  })

  it('アプリで連携を解除すると、次のツールの呼び出しは 401（状態のツールは毎回クラウドを読む）、トークンの更新は invalid_grant', async () => {
    const { cb, verifier } = await connect()
    const t = await exchange(cb, verifier)
    expect((await mcp(t.access_token, 'tools/call', { name: 'topic_status', arguments: {} })).status).toBe(200)
    fake.setConnector(null)
    const gone = await mcp(t.access_token, 'tools/call', { name: 'topic_status', arguments: {} })
    expect(gone.status).toBe(401)
    expect(gone.headers.get('WWW-Authenticate')).toContain('invalid_token')
    // 連携が外れた後は、どのツールも 401
    expect((await mcp(t.access_token, 'tools/call', { name: 'topic_list_recent', arguments: {} })).status).toBe(401)
    await refusedGrant(t)
  })

  it('アプリで［連携をすべて解除］すると、連携の記録を読み直した後のトークンの更新は invalid_grant', async () => {
    const { cb, verifier } = await connect()
    const t = await exchange(cb, verifier)
    fake.setConnector(null)
    // 連携の記録は1分ごとに読み直す
    laterThanRecheck()
    await refusedGrant(t)
    expect(await (await SELF.fetch(`${H}/`)).text()).toContain('data-state="unpaired"')
  })
})

describe('連携の代（解除した Claude のアカウントは、連携し直した後も使えない）', () => {
  it('解除の後に別の戻り先から連携し直すと、前の許可のトークンの更新は invalid_grant。新しい許可は使える', async () => {
    const first = await connect()
    const x = await exchange(first.cb, first.verifier)
    // ［連携をすべて解除］（X はその後ツールを呼ばない）→ claude.com から別の Claude のアカウント（Y）で連携し直す
    fake.setConnector(null)
    const second = await connect({ redirectUri: CLAUDE_COM_CALLBACK })
    expect(second.cb.status).toBe(302)
    const y = await exchange(second.cb, second.verifier, CLAUDE_COM_CALLBACK)
    await refusedGrant(x)
    expect((await refresh(y)).status).toBe(200)
    // 前の代の許可のツールの呼び出しも 401。新しい許可は使える
    expect((await mcp(x.access_token, 'tools/call', { name: 'topic_list_recent', arguments: {} })).status).toBe(401)
    expect((await mcp(y.access_token, 'tools/call', { name: 'topic_status', arguments: {} })).status).toBe(200)
  })
})

describe('複数の接続（2まで。claude.ai のアカウントごと）', () => {
  it('2つ接続しても、前の接続は取り消されない（どちらもトークンを更新できる）。許可に接続の id', async () => {
    const first = await connect({ name: '接続1' })
    const x = await exchange(first.cb, first.verifier)
    const second = await connect({ name: '接続2' })
    expect(second.cb.status).toBe(302)
    const y = await exchange(second.cb, second.verifier)
    expect(first.cid).not.toBe(second.cid)
    for (const t of [x, y]) expect((await refresh(t)).status).toBe(200)
    const grants = await grantsOf(first.cid, second.cid)
    expect(grants.map((g) => g.metadata?.cid).sort()).toEqual([first.cid, second.cid].sort())
    // 3つ目はアプリが足さない（入れ替えを求める。ルールも connections.size() <= 2）
    expect(() => fake.addConnection({ uid: first.uid, cid: 'cthird', pairing: 'h' })).toThrow('接続が2あります')
  })

  it('1つ解除すると、連携の記録を読み直した後は、その接続だけトークンの更新が invalid_grant（許可を取り消す）。ほかの接続はそのまま', async () => {
    const first = await connect()
    const x = await exchange(first.cb, first.verifier)
    const second = await connect()
    const y = await exchange(second.cb, second.verifier)
    fake.removeConnection(first.cid)
    // 状態のツール（毎回クラウドを読む）: 外した接続だけ 401。ほかの接続はそのまま
    const gone = await mcp(x.access_token, 'tools/call', { name: 'topic_status', arguments: {} })
    expect(gone.status).toBe(401)
    expect((await mcp(y.access_token, 'tools/call', { name: 'topic_status', arguments: {} })).status).toBe(200)
    laterThanRecheck()
    await refusedGrant(x)
    expect((await refresh(y)).status).toBe(200)
  })

  it('「○○と入れ替える」: 入れ替えた接続は、すぐにトークンの更新が invalid_grant。新しい接続は使える', async () => {
    const first = await connect()
    const x = await exchange(first.cb, first.verifier)
    const second = await connect({ replaceCid: first.cid })
    expect(second.cb.status).toBe(302)
    const y = await exchange(second.cb, second.verifier)
    await refusedGrant(x)
    expect((await refresh(y)).status).toBe(200)
  })

  it('連携をすべて解除すると、どの接続もトークンの更新は invalid_grant', async () => {
    const first = await connect()
    const x = await exchange(first.cb, first.verifier)
    const second = await connect()
    const y = await exchange(second.cb, second.verifier)
    fake.setConnector(null)
    laterThanRecheck()
    await refusedGrant(x)
    await refusedGrant(y)
  })
})

describe('/mcp の Origin と本文の大きさ', () => {
  it('Origin が無い・claude.ai・claude.com はよい。ほかは 403', async () => {
    const { cb, verifier } = await connect()
    const t = await exchange(cb, verifier)
    const init = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } }
    expect((await mcp(t.access_token, 'initialize', init)).status).toBe(200)
    expect((await mcp(t.access_token, 'initialize', init, { Origin: 'https://claude.ai' })).status).toBe(200)
    expect((await mcp(t.access_token, 'initialize', init, { Origin: 'https://claude.com' })).status).toBe(200)
    expect((await mcp(t.access_token, 'initialize', init, { Origin: 'https://evil.example' })).status).toBe(403)
  })

  it('1,000,000 バイトを超える呼び出しは、何も呼ばずに 413 と日本語の文（ライブラリの英語の文にしない）', async () => {
    const { cb, verifier } = await connect()
    const t = await exchange(cb, verifier)
    const before = fake.calls.length
    // 日本語は1字3バイト: 340,000字で 1,020,000 バイトを超える（字数では上限より少ない）
    const big = await mcp(t.access_token, 'tools/call', {
      name: 'topic_add_topics',
      arguments: { items: ['字'.repeat(340_000)] },
    })
    expect(big.status).toBe(413)
    const err = (await big.json()) as { jsonrpc: string; id: null; error: { code: number; message: string } }
    expect(err.error.code).toBe(-32000)
    expect(err.error.message).toContain('1回の呼び出しが大きすぎます（送る内容は合わせて 1,000,000 バイトまで')
    expect(fake.calls.length).toBe(before)
  })
})

describe('/connect/identity（アプリの連携の画面が読む）', () => {
  it('アプリの origin だけに CORS。ほかの origin は 403。preflight は 204', async () => {
    const ok = await SELF.fetch(`${H}/connect/identity`, { headers: { Origin: APP } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(APP)
    const body = (await ok.json()) as { uid: string; version: string; model: number }
    expect(body.model).toBe(CONNECTOR_MODEL)
    expect(body.uid).toMatch(/^anon/)
    const evil = await SELF.fetch(`${H}/connect/identity`, { headers: { Origin: 'https://evil.example' } })
    expect(evil.status).toBe(403)
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull()
    const pre = await SELF.fetch(`${H}/connect/identity`, {
      method: 'OPTIONS',
      headers: { Origin: APP, 'Access-Control-Request-Method': 'GET' },
    })
    expect(pre.status).toBe(204)
  })

  it('匿名ログインが無効なら 503 と日本語の説明', async () => {
    fake.anonymousDisabled = true
    const res = await SELF.fetch(`${H}/connect/identity`, { headers: { Origin: APP } })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('anonymous_disabled')
    expect(body.message).toContain('匿名')
    expect(await (await SELF.fetch(`${H}/`)).text()).toContain('data-state="anonymous_disabled"')
  })
})

describe('OAuth の KV の書き込み（NS と分け合う無料枠 1日 1,000 回）', () => {
  it('接続の要求1回（同意の画面 → 承認）で KV に書くのは2回。承認の送り直しは、KV の削除が届く前でも書かずに断る', async () => {
    const puts: string[] = []
    const put = env.OAUTH_KV.put.bind(env.OAUTH_KV)
    vi.spyOn(env.OAUTH_KV, 'put').mockImplementation((async (key: string, ...rest: unknown[]) => {
      puts.push(key)
      return (put as (...a: unknown[]) => Promise<void>)(key, ...rest)
    }) as never)
    // KV の削除は、ほかの場所にはすぐには届かない（承認で消した同意の取引を、送り直した要求がまだ読める）
    vi.spyOn(env.OAUTH_KV, 'delete').mockImplementation((async () => undefined) as never)
    const { challenge } = await pkce()
    const get = await SELF.fetch(authorizeUrl(challenge), { headers: { 'CF-Connecting-IP': clientIp } })
    expect(get.status).toBe(200)
    const handle = /name="handle" value="([^"]+)"/.exec(await get.text())![1]
    const cookie = cookiesOf(get)
    expect(puts).toHaveLength(1)
    const approve = () =>
      SELF.fetch(`${H}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({ handle, decision: 'approve' }),
      })
    expect((await approve()).status).toBe(302)
    expect(puts).toHaveLength(2)
    expect(puts.every((k) => k.startsWith('transaction:'))).toBe(true)
    for (let i = 0; i < 2; i++) {
      const again = await approve()
      expect(again.status).toBe(400)
      expect(await again.text()).toContain('この接続の要求はもう使われています')
    }
    expect(puts).toHaveLength(2)
  })
})

describe('接続の要求の回数の上限', () => {
  it('1つのネットワークから1時間に5回を超える接続の要求は断る（それまでは同意の画面）。ほかのネットワークからは接続できる', async () => {
    const perHour = RATE_LIMITS.authorize.source!.perHour!
    expect(perHour).toBe(5)
    const { challenge } = await pkce()
    const from = (ip: string) => SELF.fetch(authorizeUrl(challenge), { headers: { 'CF-Connecting-IP': ip } })
    const statuses: number[] = []
    for (let i = 0; i < perHour + 1; i++) statuses.push((await from('203.0.113.50')).status)
    expect(statuses.slice(0, perHour).every((x) => x === 200)).toBe(true)
    expect(statuses[perHour]).toBe(429)
    const refused = await from('203.0.113.50')
    expect(refused.status).toBe(429)
    const text = await refused.text()
    expect(text).toContain('このネットワークからの接続の要求が多すぎます')
    expect(text).toContain('ほかの人が送った要求かもしれません')
    // IPv6 は /48 ごと: 同じ /48 の別のアドレスも同じに数える
    for (let i = 0; i < perHour; i++) expect((await from(`2001:db8:77:${i.toString(16)}::1`)).status).toBe(200)
    expect((await from('2001:db8:77:ff::2')).status).toBe(429)
    // 持ち主のほかのネットワーク（モバイル通信など）からは通る
    const owner = await from('192.0.2.10')
    expect(owner.status).toBe(200)
    expect(await owner.text()).toContain('Topic Studio への接続を求めています')
  })

  it('全体で1日20回を超える接続の要求は、どのネットワークからも断る（全体で1日20回までと日本語で）', async () => {
    const { challenge } = await pkce()
    const perDay = RATE_LIMITS.authorize.global.perDay
    for (let i = 0; i < perDay; i++)
      expect((await SELF.fetch(authorizeUrl(challenge), { headers: { 'CF-Connecting-IP': `192.0.2.${100 + i}` } })).status).toBe(
        200,
      )
    const over = await SELF.fetch(authorizeUrl(challenge), { headers: { 'CF-Connecting-IP': '192.0.2.250' } })
    expect(over.status).toBe(429)
    expect(await over.text()).toContain(`全体で1日${perDay}回まで`)
  })
})
