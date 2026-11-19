// 小さな部品: 値の変換・太平洋時間の日付・暗号・アプリとの決まり・Firestore の失敗の扱い・接続の要求の回数の上限と OAuth の KV の
// 書き込みの最悪の数（NS と同じアカウントで分け合う）・答えの共通の道具・テストの fetch の見張り（NS の connector/test/unit/basics.test.ts を
// 元に、TS の物にした）。
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_CONNECTIONS } from '../../../src/claude/pairing'
import { CONNECTOR_DEVICE as APP_CONNECTOR_DEVICE } from '../../../src/domain/types'
import { APP_VERSION, DATA_MODEL } from '../../../src/sync/appVersion'
import { firebaseConfig } from '../../../src/sync/firebaseConfig'
import { PAIRING_FIXTURE as F } from '../../../src/test/pairingFixture'
import { DEFAULT_APP_ORIGIN, DEFAULT_PROJECT_ID, vaultConfig, workerConfig } from '../../src/config'
import { CONNECTOR_DEVICE, CONNECTOR_MODEL, CONNECTOR_VERSION } from '../../src/version'
import { DecryptError, isPairingKey, pairingHash, seal, unseal } from '../../src/vault/crypto'
import { FirestoreError, FirestoreRest } from '../../src/vault/firestore'
import { nextPacificMidnight, pacificDay, resetLabel } from '../../src/vault/quota'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CONSENT_CLAIM_MS,
  KV_WRITES,
  NS_KV_WRITES_WORST,
  RATE_LIMITS,
  claimConsent,
  sourceBucket,
  sourceNetwork,
  takeRate,
} from '../../src/vault/ratelimit'
import { MirrorStore } from '../../src/vault/store'
import { RESULT_LIMIT, capText, fail, headLine, nowLine, withHead } from '../../src/vault/tools/common'
import { fromFields, fromValue, timestampMicros, toValue } from '../../src/vault/values'
import { FakeFirebase } from '../support/fakeFirebase'
import { OWNER, makeCore, pairedCore } from '../support/harness'
import { NetGuardError, allowedUrl, takeBlocked } from '../support/netGuard'
import { nodeSql } from '../support/nodeSql'

const connectorDir = path.resolve(import.meta.dirname, '../..')
const repoDir = path.resolve(connectorDir, '..')

describe('Firestore の値', () => {
  it('文字列・整数（10進の文字列）・真偽・null・時刻・入れ子', () => {
    const v = toValue({ a: 'x', n: 12, b: true, z: null, list: [1, 'y'], t: { timestamp: '2026-11-19T00:00:00.123456Z' } })
    expect(v).toEqual({
      mapValue: {
        fields: {
          a: { stringValue: 'x' },
          n: { integerValue: '12' },
          b: { booleanValue: true },
          z: { nullValue: null },
          list: { arrayValue: { values: [{ integerValue: '1' }, { stringValue: 'y' }] } },
          t: { timestampValue: '2026-11-19T00:00:00.123456Z' },
        },
      },
    })
    expect(fromValue(v)).toEqual({
      a: 'x',
      n: 12,
      b: true,
      z: null,
      list: [1, 'y'],
      t: { timestamp: '2026-11-19T00:00:00.123456Z' },
    })
    expect(fromFields({ chunks: { integerValue: '3' } })).toEqual({ chunks: 3 })
  })

  it('時刻をマイクロ秒にする（ミリ秒・マイクロ秒・ナノ秒の文字列）', () => {
    const base = Date.UTC(2026, 10, 19) * 1000
    expect(timestampMicros('2026-11-19T00:00:00Z')).toBe(base)
    expect(timestampMicros('2026-11-19T00:00:00.5Z')).toBe(base + 500_000)
    expect(timestampMicros('2026-11-19T00:00:00.123456Z')).toBe(base + 123_456)
    expect(timestampMicros('2026-11-19T00:00:00.123456789Z')).toBe(base + 123_456)
    expect(Number.isNaN(timestampMicros('yesterday'))).toBe(true)
  })
})

describe('太平洋時間の日付（Firestore の無料枠の切り替わり）', () => {
  it('夏時間の間は日本時間16時、2026-11-01 の切り替え後は17時', () => {
    // 2026-10-31 12:00 JST = 太平洋時間 10/30 20:00（夏時間）
    const a = Date.UTC(2026, 9, 31, 3, 0)
    expect(pacificDay(a)).toBe('2026-10-30')
    expect(new Date(nextPacificMidnight(a)).toISOString()).toBe('2026-10-31T07:00:00.000Z')
    expect(resetLabel(a)).toBe('日本時間16時')
    // 2026-11-01 17:00 JST = 太平洋時間 11/1 1:00（まだ夏時間）→ 次は 11/2 0:00（冬時間）= 11/2 17:00 JST
    const c = Date.UTC(2026, 10, 1, 8, 0)
    expect(pacificDay(c)).toBe('2026-11-01')
    expect(new Date(nextPacificMidnight(c)).toISOString()).toBe('2026-11-02T08:00:00.000Z')
    expect(resetLabel(c)).toBe('明日の日本時間17時')
    // 冬時間の間（2026-11-19 12:00 JST）は日本時間17時に戻る
    expect(resetLabel(Date.UTC(2026, 10, 19, 3, 0))).toBe('日本時間17時')
  })
})

describe('暗号', () => {
  it('暗号化して戻せる。鍵が違えば戻せない', async () => {
    const key = 'k'.repeat(40)
    const sealed = await seal(key, 'refresh-token-value')
    expect(sealed).not.toContain('refresh')
    expect(sealed).toMatch(/^v1\./)
    expect(await unseal(key, sealed)).toBe('refresh-token-value')
    await expect(unseal('x'.repeat(40), sealed)).rejects.toBeInstanceOf(DecryptError)
    await expect(unseal(key, 'v2.a.b')).rejects.toBeInstanceOf(DecryptError)
  })

  it('連携の確かめの指紋は sha256hex(s + "." + k)（アプリと同じ）', async () => {
    const s = 'state-abc'
    const k = 'A'.repeat(43)
    expect(await pairingHash(s, k)).toBe(createHash('sha256').update(`${s}.${k}`).digest('hex'))
    expect(isPairingKey(k)).toBe(true)
    expect(isPairingKey('short')).toBe(false)
    expect(isPairingKey(`${k}=`)).toBe(false)
  })

  it('アプリと同じ値で同じ指紋（src/test/pairingFixture.ts）', async () => {
    expect(await pairingHash(F.state, F.k)).toBe(F.hash)
    expect(await pairingHash(F.oddState, F.k)).toBe(F.oddHash)
    expect(isPairingKey(F.k)).toBe(true)
  })
})

describe('アプリとの決まり', () => {
  it('データの形の版はアプリ（src/sync/appVersion.ts の DATA_MODEL）と同じ。版の頭はアプリの版', () => {
    expect(CONNECTOR_MODEL).toBe(DATA_MODEL)
    expect(CONNECTOR_VERSION.startsWith(`${APP_VERSION}.`)).toBe(true)
    expect(CONNECTOR_DEVICE).toBe(APP_CONNECTOR_DEVICE)
    expect(CONNECTOR_DEVICE).toBe('claude-connector')
  })

  it('コネクタの package.json・package-lock.json の名前と版は CONNECTOR_VERSION と同じ。部品の版は決め打ち（^ を付けない）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(connectorDir, 'package.json'), 'utf8')) as {
      name: string
      version: string
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    const lock = JSON.parse(fs.readFileSync(path.join(connectorDir, 'package-lock.json'), 'utf8')) as {
      name: string
      version: string
      packages: Record<string, { name?: string; version?: string }>
    }
    expect([pkg.name, lock.name, lock.packages[''].name]).toEqual(Array(3).fill('topic-studio-connector'))
    expect(pkg.version).toBe(CONNECTOR_VERSION)
    expect(lock.version).toBe(CONNECTOR_VERSION)
    expect(lock.packages[''].version).toBe(CONNECTOR_VERSION)
    for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }))
      expect(v, name).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('wrangler.jsonc の Firebase とアプリの値は、アプリの設定（src/sync/firebaseConfig.ts・.firebaserc）と同じ。既定の値も同じ', () => {
    const text = fs.readFileSync(path.join(connectorDir, 'wrangler.jsonc'), 'utf8')
    const v = (name: string) => new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(text)?.[1]
    const rc = JSON.parse(fs.readFileSync(path.join(repoDir, '.firebaserc'), 'utf8')) as { projects: { default: string } }
    expect(v('name')).toBe('topic-studio-connector')
    expect(v('FIREBASE_PROJECT_ID')).toBe(firebaseConfig.projectId)
    expect(v('FIREBASE_PROJECT_ID')).toBe(rc.projects.default)
    expect(v('FIREBASE_API_KEY')).toBe(firebaseConfig.apiKey)
    expect(v('APP_ORIGIN')).toBe(`https://${firebaseConfig.projectId}.web.app`)
    expect(DEFAULT_PROJECT_ID).toBe(firebaseConfig.projectId)
    expect(DEFAULT_APP_ORIGIN).toBe(v('APP_ORIGIN'))
    expect(v('ENABLE_DCR')).toBe('false')
    expect(v('ALLOW_CLAUDE_CODE')).toBe('false')
    // 毎日 4:23（日本時間）= 19:23（UTC）
    expect(/"crons"\s*:\s*\["([^"]+)"\]/.exec(text)?.[1]).toBe('23 19 * * *')
    // 空の値・知らない値の既定（エミュレーターのホストを渡した時だけエミュレーターへ）
    const empty = vaultConfig({} as never)
    expect(empty.projectId).toBe(DEFAULT_PROJECT_ID)
    expect(empty.firestoreUrl).toBe('https://firestore.googleapis.com/v1')
    expect(vaultConfig({ FIREBASE_EMULATOR_HOST: '127.0.0.1' } as never).firestoreUrl).toBe('http://127.0.0.1:8080/v1')
    expect(workerConfig({} as never, 'https://c.example/x').appOrigin).toBe(DEFAULT_APP_ORIGIN)
  })
})

describe('Firestore の失敗の扱い', () => {
  function client(responses: (() => Response)[], tokens: boolean[] = []) {
    let i = 0
    const f = (async () => responses[Math.min(i++, responses.length - 1)]()) as unknown as typeof fetch
    return {
      fs: new FirestoreRest({
        fetch: f,
        baseUrl: 'http://x/v1',
        projectId: 'p',
        token: async (force) => {
          tokens.push(Boolean(force))
          return 'tok'
        },
        sleep: async () => undefined,
      }),
      count: () => i,
    }
  }
  const json =
    (v: unknown, status = 200) =>
    () =>
      new Response(JSON.stringify(v), { status })

  it('5xx は2回まで試し直す', async () => {
    const c = client([json({}, 503), json({}, 500), json({ writeResults: [], commitTime: 't' })])
    await expect(c.fs.commit([])).resolves.toMatchObject({ commitTime: 't' })
    expect(c.count()).toBe(3)
    const d = client([json({}, 503), json({}, 503), json({}, 503)])
    await expect(d.fs.commit([])).rejects.toMatchObject({ status: 503, afterUnsure: true })
  })

  it('401 は ID トークンを更新して1回だけ試し直す', async () => {
    const tokens: boolean[] = []
    const c = client([json({ error: { status: 'UNAUTHENTICATED' } }, 401), json([])], tokens)
    await expect(c.fs.runQuery('users/u', {})).resolves.toEqual([])
    expect(tokens).toEqual([false, true, false])
  })

  it('403・409・429 は状態と印を付けて返す', async () => {
    for (const [status, code] of [
      [403, 'PERMISSION_DENIED'],
      [409, 'ALREADY_EXISTS'],
      [429, 'RESOURCE_EXHAUSTED'],
      [400, 'FAILED_PRECONDITION'],
    ] as const) {
      const c = client([json({ error: { code: status, status: code, message: 'm' } }, status)])
      const e = await c.fs.commit([]).catch((x) => x)
      expect(e).toBeInstanceOf(FirestoreError)
      expect([e.status, e.code]).toEqual([status, code])
    }
  })

  it('件数（count）は表の絞りを渡せる（TS のルールはコネクタの読みを表で絞る）', async () => {
    let body = ''
    const fs = new FirestoreRest({
      fetch: (async (_: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body ?? '')
        return new Response(JSON.stringify([{ result: { aggregateFields: { n: { integerValue: '7' } } } }]))
      }) as typeof fetch,
      baseUrl: 'http://x/v1',
      projectId: 'p',
      token: async () => 't',
    })
    const where = { fieldFilter: { field: { fieldPath: 'table' }, op: 'EQUAL', value: { stringValue: 'termPacks' } } }
    expect(await fs.count('users/u', { from: [{ collectionId: 'records' }], where })).toBe(7)
    expect(JSON.parse(body).structuredAggregationQuery.structuredQuery.where).toEqual(where)
  })
})

describe('接続の要求の回数の上限（ネットワークごと＋全体。NS より小さく）', () => {
  const at = Date.UTC(2026, 10, 19, 3, 0, 0)

  it('上限は ネットワークごと 5/時・10/日、全体 20/日。DCR の登録は 10/時・10/日（NS の式のまま）', () => {
    expect(RATE_LIMITS.authorize).toEqual({ source: { perHour: 5, perDay: 10 }, global: { perDay: 20 } })
    expect(RATE_LIMITS.register).toEqual({ global: { perHour: 10, perDay: 10 } })
  })

  it('1つのネットワークからは1時間5回まで。ほかのネットワークは通る。次の時間・次の日にまた通る', () => {
    const store = new MirrorStore(nodeSql())
    const a = 'bucket-a'
    for (let i = 0; i < 5; i++) expect(takeRate(store, 'authorize', at + i, a)).toEqual({ ok: true })
    expect(takeRate(store, 'authorize', at + 5, a)).toEqual({ ok: false, scope: 'source', window: 'hour' })
    expect(takeRate(store, 'authorize', at + 6, 'bucket-b')).toEqual({ ok: true })
    // 1時間後: その時間の分は戻るが、1日10回まで
    for (let i = 0; i < 5; i++) expect(takeRate(store, 'authorize', at + 3_600_000 + i, a).ok).toBe(true)
    expect(takeRate(store, 'authorize', at + 7_200_000, a)).toEqual({ ok: false, scope: 'source', window: 'day' })
    // 次の日（UTC の0時 = 日本時間の9時）にまた通り、前の日のネットワークの数は残さない
    expect(takeRate(store, 'authorize', Date.UTC(2026, 10, 20, 0, 0, 1), a)).toEqual({ ok: true })
    expect(Object.keys(store.getMeta<{ buckets: Record<string, unknown> }>('rate:authorize:sources')!.buckets)).toEqual([a])
  })

  it('たくさんのネットワークからでも、全体で1日20回まで（断った分は数えない）', () => {
    const store = new MirrorStore(nodeSql())
    let ok = 0
    for (let i = 0; i < 100; i++) if (takeRate(store, 'authorize', at + i, `net-${i % 10}`).ok) ok++
    expect(ok).toBe(RATE_LIMITS.authorize.global.perDay)
    expect(takeRate(store, 'authorize', at + 500, 'net-new')).toEqual({ ok: false, scope: 'global', window: 'day' })
  })

  it('OAuth の KV の書き込み（アカウントで1日 1,000 回）: TS の最悪と NS の最悪を足しても 1,000 回の中（設計の 1.11）', () => {
    // 接続の要求1回で2回（同意の取引と承認の後の取引。承認は同じ同意で1回だけ）、更新はアクセストークンが切れるたびに2回
    const refreshes = MAX_CONNECTIONS * Math.ceil(86_400 / ACCESS_TOKEN_TTL_SECONDS) * KV_WRITES.perRefresh
    const requests = RATE_LIMITS.authorize.global.perDay * KV_WRITES.perAuthorize
    // 連携を終える分（接続をそれぞれ1日1回つなぎ直す）と、DCR の登録（ENABLE_DCR の時だけ。オフだが数える）
    const pairings = MAX_CONNECTIONS * KV_WRITES.perPairing + RATE_LIMITS.register.global.perDay
    expect([refreshes, requests, pairings]).toEqual([96, 40, 16])
    const worst = refreshes + requests + pairings
    expect(worst).toBe(152)
    expect(NS_KV_WRITES_WORST).toBe(480 + 150 * 2 + 40)
    expect(worst + NS_KV_WRITES_WORST).toBeLessThanOrEqual(KV_WRITES.perDay)
  })

  it('同意の承認は1回だけ通す（送り直しは false）。覚えておくのは期限まで', () => {
    const store = new MirrorStore(nodeSql())
    expect(claimConsent(store, 'key-a', at)).toBe(true)
    expect(claimConsent(store, 'key-a', at + 1_000)).toBe(false)
    expect(claimConsent(store, 'key-b', at + 2_000)).toBe(true)
    expect(claimConsent(store, 'key-a', at + CONSENT_CLAIM_MS - 1)).toBe(false)
    expect(claimConsent(store, 'key-c', at + CONSENT_CLAIM_MS + 3_000)).toBe(true)
    expect(Object.keys(store.getMeta<Record<string, number>>('consentClaims')!)).toEqual(['key-c'])
  })

  it('bucket が無ければ unknown にまとめる。DCR の登録は全体だけ', () => {
    const store = new MirrorStore(nodeSql())
    for (let i = 0; i < 5; i++) expect(takeRate(store, 'authorize', at + i).ok).toBe(true)
    expect(takeRate(store, 'authorize', at + 10, 'unknown')).toEqual({ ok: false, scope: 'source', window: 'hour' })
    for (let i = 0; i < 10; i++) expect(takeRate(store, 'register', at + i, `net-${i}`).ok).toBe(true)
    expect(takeRate(store, 'register', at + 10, 'net-x')).toEqual({ ok: false, scope: 'global', window: 'day' })
  })

  it('数える単位: IPv4 はアドレス、IPv6 は /48。生の IP は残さない', async () => {
    expect(sourceNetwork('203.0.113.7')).toBe('203.0.113.7')
    expect(sourceNetwork('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(sourceNetwork('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48')
    expect(sourceNetwork('2001:db8::1')).toBe('2001:db8:0::/48')
    expect(sourceNetwork('')).toBe('unknown')
    expect(sourceNetwork(null)).toBe('unknown')
    expect(sourceNetwork('not-an-ip')).toBe('unknown')
    const b = await sourceBucket('203.0.113.7', 'salt')
    expect(b).toMatch(/^[0-9a-f]{16}$/)
    expect(b).not.toContain('203')
    expect(await sourceBucket('2001:db8:abcd:1::1', 'salt')).toBe(await sourceBucket('2001:db8:abcd:ffff::2', 'salt'))
    expect(await sourceBucket(null, 'salt')).toBe('unknown')
  })
})

describe('答えの共通の道具（tools/common.ts）', () => {
  it('答えの頭の1行は今の時刻（日本時間）。回の締め切りを渡すと、書く係の締め切りと照合の打ち切りまでの分も', () => {
    const now = Date.UTC(2026, 10, 19, 2, 42, 30) // 11:42:30 JST
    expect(nowLine(now)).toBe('いま 11:42（日本時間）')
    expect(headLine(now)).toBe('いま 11:42（日本時間）')
    const deadlines = { writeBy: now + 25 * 60_000 + 10_000, verifyBy: now + 60 * 60_000 }
    expect(headLine(now, deadlines)).toBe('いま 11:42（日本時間）・書く係の締め切りまで 25分・照合の打ち切りまで 60分')
    expect(headLine(now, { writeBy: now - 1, verifyBy: now + 30_000 })).toBe(
      'いま 11:42（日本時間）・書く係の締め切りを過ぎています・照合の打ち切りを過ぎています',
    )
    // 日をまたぐ（23:59 → 0:00 JST）
    expect(nowLine(Date.UTC(2026, 10, 19, 15, 0))).toBe('いま 00:00（日本時間）')
  })

  it('頭の1行は失敗の答えにも付け、結果は10万字で行の切れ目で切る', () => {
    const r = withHead(fail('だめです', ['a', 'b']), 'いま 09:00（日本時間）')
    expect(r).toEqual({ text: 'いま 09:00（日本時間）\nだめです\n候補:\n- a\n- b', isError: true })
    const long = Array.from({ length: 20_000 }, (_, i) => `行${i}あいうえお`).join('\n')
    const cut = capText(long)
    expect(cut.length).toBeLessThanOrEqual(RESULT_LIMIT)
    expect(cut).toContain('結果が長いため、ここで切りました')
    expect(capText('短い')).toBe('短い')
  })
})

describe('テストの fetch の見張り（test/support/netGuard.ts）', () => {
  it('手元のエミュレーター（ループバック）のほかへの fetch は送らずに失敗させる（府省・庁などのサイトへ出ない）', async () => {
    expect(allowedUrl('http://127.0.0.1:8080/v1/projects/x')).toBe(true)
    expect(allowedUrl('http://localhost:9099/identitytoolkit.googleapis.com/v1/accounts:signUp')).toBe(true)
    for (const url of [
      'https://example.com/a',
      'https://firestore.googleapis.com/v1',
      'http://fake-fs/v1',
      'ftp://127.0.0.1/',
      'not a url',
    ])
      expect(allowedUrl(url), url).toBe(false)
    await expect(fetch('https://example.com/press/1.html')).rejects.toBeInstanceOf(NetGuardError)
    await expect(fetch(new URL('https://www.example.com/feed/'))).rejects.toThrow(
      'テストから外への要求は送りません（www.example.com）',
    )
    // 断った要求はテストの終わりに落とす（ここでは確かめたので取り出す）
    expect(takeBlocked()).toEqual(['example.com', 'www.example.com'])
  })
})

describe('Vault の連携の状態と、ツールの振り分け（B0・B3）', () => {
  it('連携した許可は通る。接続の無い許可・前の代の許可・連携していない呼び出しは断る（auth: HTTP 401）', async () => {
    const fake = new FakeFirebase()
    const { core, grant, clock } = await pairedCore(fake, { cid: 'caaa' })
    expect(core.pairingState()).toBe('paired')
    expect(core.health()).toBe('ready')
    expect(await core.checkGrant(grant)).toBe(true)
    expect(await core.checkGrant({ ...grant, cid: undefined })).toBe(false)
    expect(await core.checkGrant({ ...grant, gen: 'older' })).toBe(false)
    expect(await core.checkGrant(null)).toBe(false)
    const stale = await core.callTool('topic_status', {}, { grant: { ...grant, gen: 'older' } })
    expect(stale).toMatchObject({ isError: true, auth: true })
    expect(stale.text).toContain('Topic Studio 側で連携が解除されています')
    // 状態のツール（B3。答えの頭に今の時刻）。知らないツールは断る
    const status = await core.callTool('topic_status', {}, { grant })
    expect(status.isError).toBeUndefined()
    expect(status.text).toMatch(/^いま 12:00（日本時間）\nTopic Studio コネクタ /)
    expect(status.text).toContain('連携: 済み')
    const unknown = await core.callTool('topic_nothing', {}, { grant })
    expect(unknown.isError).toBe(true)
    expect(unknown.auth).toBeUndefined()
    expect(unknown.text).toBe('いま 12:00（日本時間）\n知らないツールです（topic_nothing）。ツールの一覧を読み直してください。')
    expect(await core.nightly()).toBe('ok')
    // 夜の仕事が置いたやる事（写しの続き・毎日の決まりの読み）を alarm が済ませると、次のやる事は無い
    clock.now += 2_000
    expect(await core.alarm()).toBeNull()
    // ［連携をすべて解除］: 1分後に読み直すと連携を外す
    fake.setConnector(null)
    clock.now += 61_000
    expect(await core.checkGrant(grant)).toBe(false)
    expect(core.pairingState()).toBe('unpaired')
    expect(await core.nightly()).toBe('skipped')
    const gone = await core.callTool('topic_status', {}, { grant })
    expect(gone).toMatchObject({ isError: true, auth: true })
  })

  it('アプリの許可（config/connector）の uid・指紋・期限・使い回しを確かめる', async () => {
    const fake = new FakeFirebase()
    const { core, clock } = makeCore(fake)
    const { uid } = await core.connectIdentity()
    expect(core.health()).toBe('unpaired')
    expect(await core.verifyPairing('not-a-hash')).toMatchObject({ ok: false, reason: 'hash' })
    const hash = await pairingHash('state-1', 'k'.repeat(43))
    // 持ち主の記録が無い
    expect(await core.verifyPairing(hash)).toMatchObject({ ok: false, reason: 'owner' })
    fake.setOwner(OWNER)
    // アプリがまだ許可していない（記録が無い = ルールで読めない）
    expect(await core.verifyPairing(hash)).toMatchObject({ ok: false, reason: 'not_found' })
    // 別のコネクタの記録
    fake.addConnection({ uid: 'anon-other', cid: 'cx', pairing: hash, pairedAt: clock.now })
    expect(await core.verifyPairing(hash)).toMatchObject({ ok: false, reason: 'not_found' })
    // 期限切れ（15分）
    fake.setConnector(null)
    fake.addConnection({ uid, cid: 'cold', pairing: hash, pairedAt: clock.now - 16 * 60_000 })
    expect(await core.verifyPairing(hash)).toMatchObject({ ok: false, reason: 'expired' })
    fake.addConnection({ uid, cid: 'cnew', pairing: hash, pairedAt: clock.now, replaceCid: 'cold' })
    expect(await core.verifyPairing(hash)).toMatchObject({ ok: true, ownerUid: OWNER, cid: 'cnew' })
    expect(await core.verifyPairing(hash)).toMatchObject({ ok: false, reason: 'used' })
  })
})
