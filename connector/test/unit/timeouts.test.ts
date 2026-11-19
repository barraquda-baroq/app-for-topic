// Firebase の待ちに上限（NS の connector/test/unit/timeouts.test.ts の形）: 答えの来ない要求（Firestore・トークンの更新）は、1回ごとの上限
// （テストでは 100ms）で「つながらない」にし、試し直さない。連携の確かめ・許可の確かめ・ツールの呼び出しが止まったままにならない。
// トークンの更新の前の許可の確かめ（checkGrant）は、つながらない時に接続を切らない
import { describe, expect, it } from 'vitest'
import { ConnectorError, MESSAGES } from '../../src/vault/errors'
import { REQUEST_TIMEOUT_MS, RequestTimeout, withTimeout } from '../../src/vault/timeout'
import { FakeFirebase } from '../support/fakeFirebase'
import { batchGet, gatedFetch, tokenRefresh, within } from '../support/gate'
import { OWNER, makeCore, pairedCore } from '../support/harness'
import { pairingHash } from '../../src/vault/crypto'

async function paired() {
  const fake = new FakeFirebase()
  const gate = gatedFetch(fake)
  const made = await pairedCore(fake, { cid: 'caaa', fetch: gate.fetch, timeoutMs: 100 })
  return { fake, gate, ...made }
}

describe('Firebase の待ちに上限', () => {
  it('withTimeout: 上限を過ぎると要求を取り消し（signal）、RequestTimeout で失敗にする。上限の既定は 15 秒', async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(15_000)
    let signal: AbortSignal | undefined
    const never = ((_: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => undefined)
    }) as typeof fetch
    await expect(withTimeout(never, 30)('http://x/')).rejects.toBeInstanceOf(RequestTimeout)
    expect(signal?.aborted).toBe(true)
    // 上限より前に答えれば、そのまま
    const quick = (async () => new Response('ok')) as typeof fetch
    expect(await (await withTimeout(quick, 30)('http://x/')).text()).toBe('ok')
    // 上限より前の失敗（つながらない）は、そのままの失敗
    const broken = (async () => {
      throw new TypeError('network')
    }) as typeof fetch
    await expect(withTimeout(broken, 30)('http://x/')).rejects.toBeInstanceOf(TypeError)
  })

  it('トークンの更新の前の許可の確かめ: 連携の記録の読み直しが答えない時は上限で止め、接続を切らない（true）', async () => {
    const { core, gate, clock, grant } = await paired()
    // 連携の記録を読み直す時刻（1分）を過ぎてから、Firestore が答えなくなった
    clock.now += 61_000
    const hang = gate.hold(batchGet)
    expect(await within(core.checkGrant(grant), 3_000, '答えの来ない読み直しの後の許可の確かめ')).toBe(true)
    expect(hang.matched).toBe(true)
    hang.release()
  })

  it('答えの来ないトークンの更新は上限で止め、試し直さない（身元を消さない）', async () => {
    const { core, gate, clock, uid } = await paired()
    // ID トークン（1時間）が切れた後
    clock.now += 2 * 3_600_000
    const before = gate.count(tokenRefresh)
    const hang = gate.hold(tokenRefresh)
    const e = await within(
      core.connectIdentity().catch((x: unknown) => x),
      3_000,
      '答えの来ないトークンの更新',
    )
    expect(e).toBeInstanceOf(ConnectorError)
    expect((e as ConnectorError).code).toBe('unavailable')
    expect(gate.count(tokenRefresh) - before).toBe(1)
    hang.release()
    // 身元は残っている（次は更新できる）
    expect((await core.connectIdentity()).uid).toBe(uid)
  })

  it('連携の確かめ（/pair/callback）: 持ち主の記録の読み取りが答えない時は上限で止め、「確かめられませんでした」', async () => {
    const fake = new FakeFirebase()
    const gate = gatedFetch(fake)
    const { core, clock } = makeCore(fake, { fetch: gate.fetch, timeoutMs: 100 })
    const { uid } = await core.connectIdentity()
    fake.setOwner(OWNER)
    const hash = await pairingHash('state-x', 'k'.repeat(43))
    fake.addConnection({ uid, cid: 'cbbb', pairing: hash, pairedAt: clock.now })
    const hang = gate.hold(batchGet)
    const r = await within(core.verifyPairing(hash), 3_000, '答えの来ない連携の確かめ')
    expect(r).toMatchObject({ ok: false, reason: 'error' })
    hang.release()
    // 使っていないので、もう一度確かめられる
    expect(await core.verifyPairing(hash)).toMatchObject({ ok: true, cid: 'cbbb' })
  })

  it('Firestore がまったく答えない時も、ツールの呼び出しは上限で答える（前に読んだ連携の記録で続ける）', async () => {
    const { core, gate, clock, grant } = await paired()
    clock.now += 61_000
    const firestore = (r: { url: string }) => r.url.includes('/v1/projects/')
    const hangs = Array.from({ length: 5 }, () => gate.hold(firestore))
    const started = Date.now()
    const r = await within(core.callTool('topic_unknown', {}, { grant }), 3_000, 'Firestore が答えない時のツールの呼び出し')
    expect(Date.now() - started).toBeLessThan(1_000)
    // 振り分けまで届く（知らないツールの名前で、中身は動かさない。知らないツールの答え）。頭に今の時刻
    expect(r.isError).toBe(true)
    expect(r.auth).toBeUndefined()
    expect(r.text).toMatch(/^いま \d{2}:\d{2}（日本時間）\n知らないツールです/)
    expect(r.text).not.toBe(MESSAGES.unavailable)
    for (const h of hangs) h.release()
  })
})
