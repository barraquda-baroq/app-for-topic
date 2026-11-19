// 連携の手順（src/features/claude/connectLogic.ts。NS の src/features/claude/connectLogic.test.ts を写し、見せるタイトル・送信待ちの
// 確かめ・2.8 までの v1 の記録の所を外して、接続の数を 2 にした物）: コネクタの場所・身元・k と指紋・［許可する］（指紋だけを書いて
// コネクタへ移る・身元が変わった時・上限・同じ名前・やり直し）・連携の記録の読み方・接続の一覧の書き換え（足す・入れ替える・名前・
// 1つ解除・最後の1つで消す）・［許可する］の前の確かめ（持ち主・同期・コネクタの版）・コネクタと同じ値（src/test/pairingFixture.ts）
import { describe, expect, it, vi } from 'vitest'
import { defaultConnectionName, MAX_CONNECTIONS } from '../../claude/pairing'
import { PAIRING_FIXTURE as F } from '../../test/pairingFixture'
import {
  addedConnectorDoc,
  approvePairing,
  base64url,
  callbackUrl,
  cleanNewConnectionName,
  connectionEntries,
  connectorMcpUrl,
  deviceLabel,
  fetchIdentity,
  normalizeOrigin,
  pairingHash,
  parseConnectorDoc,
  parseIdentity,
  prepareConnect,
  randomPairingKey,
  removedConnectorDoc,
  renamedConnectorDoc,
  validState,
  ConnectionGoneError,
  ConnectionLimitError,
  CONNECTION_LIMIT_ERROR,
  CONNECTION_NAME_ERROR,
  DuplicateNameError,
  DUPLICATE_NAME_ERROR,
  IdentityChangedError,
  type ConnectionApproval,
  type ConnectorStatus,
  type PairingDeps,
  type PrepareDeps,
} from './connectLogic'

const ORIGIN = F.connectorOrigin
/** 実装とは別に crypto.subtle で数える（式が sha256hex(s + '.' + k) であることを確かめる） */
async function sha(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function deps(over: Partial<PairingDeps> = {}) {
  const calls: string[] = []
  const written: ConnectionApproval[] = []
  let navigated = ''
  const d: PairingDeps = {
    origin: ORIGIN,
    addConnection: vi.fn(async (a: ConnectionApproval) => {
      calls.push('write')
      written.push(a)
    }),
    deleteConnector: vi.fn(async () => {
      calls.push('delete')
    }),
    navigate: (url) => {
      calls.push('navigate')
      navigated = url
    },
    randomKey: () => 'K'.repeat(43),
    deviceLabel: () => 'Mac',
    ...over,
  }
  return { d, calls, written, navigated: () => navigated }
}

const identity = { uid: 'anonUid123', version: '0.1.0', model: 2 }
/** ［許可する］の入力の接続（画面を開いた時に作った id と名前） */
const conn = { cid: 'cabc123def456', name: '接続2' }

describe('コネクタの場所（ビルドの時に決める）', () => {
  it('https の origin だけを受け付ける（パス・引数・http は不可。開発中の localhost は可）', () => {
    expect(normalizeOrigin(' https://a.example.workers.dev/ ')).toBe('https://a.example.workers.dev')
    expect(normalizeOrigin('https://a.example.workers.dev/mcp')).toBe('')
    expect(normalizeOrigin('https://a.example.workers.dev/?x=1')).toBe('')
    expect(normalizeOrigin('http://a.example.workers.dev')).toBe('')
    expect(normalizeOrigin('javascript:alert(1)')).toBe('')
    expect(normalizeOrigin('https://user:pw@a.example.workers.dev')).toBe('')
    expect(normalizeOrigin('http://localhost:8787')).toBe('http://localhost:8787')
    expect(normalizeOrigin('')).toBe('')
    expect(connectorMcpUrl(ORIGIN)).toBe(`${ORIGIN}/mcp`)
  })

  it('連携の印 s は空白・制御文字の無い 1〜2048 文字', () => {
    expect(validState('abc-_.~XYZ019')).toBe('abc-_.~XYZ019')
    expect(validState('')).toBeNull()
    expect(validState(null)).toBeNull()
    expect(validState('a b')).toBeNull()
    expect(validState('a\nb')).toBeNull()
    expect(validState('x'.repeat(2049))).toBeNull()
  })

  it('コネクタへ戻る URL は state と k を引数として書く', () => {
    const url = new URL(callbackUrl(ORIGIN, 'st+/=&x', 'k_-1'))
    expect(url.origin).toBe(ORIGIN)
    expect(url.pathname).toBe('/pair/callback')
    expect(url.searchParams.get('state')).toBe('st+/=&x')
    expect(url.searchParams.get('k')).toBe('k_-1')
  })
})

describe('コネクタの匿名のアカウント（/connect/identity）', () => {
  it('答えの形を確かめる', () => {
    expect(parseIdentity({ uid: 'abcDEF_-123', version: '1.2', model: 2 })).toEqual({
      uid: 'abcDEF_-123',
      version: '1.2',
      model: 2,
    })
    expect(parseIdentity({ uid: 'abc', model: 'x' })).toEqual({ uid: 'abc', version: '', model: null })
    expect(parseIdentity({ uid: '' })).toBeNull()
    expect(parseIdentity({ uid: 'a/b' })).toBeNull()
    expect(parseIdentity(null)).toBeNull()
    expect(parseIdentity([])).toBeNull()
  })

  it('ビルドの時に決めた origin だけに、Cookie を付けずに問い合わせる', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ uid: 'anonUid', version: '1', model: 2 }), { status: 200 }))
    const r = await fetchIdentity(ORIGIN, fetchImpl as unknown as typeof fetch)
    expect(r).toEqual({ ok: true, identity: { uid: 'anonUid', version: '1', model: 2 } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${ORIGIN}/connect/identity`)
    expect(init.credentials).toBe('omit')
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('error')
  })

  it('コネクタのエラー（匿名ログインが無効など）は短い説明にする。つながらない・形が違う・場所が無い時も先へ進まない', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'anonymous_disabled', message: '匿名ログインを有効にしてください' }), {
          status: 503,
        }),
    )
    const r = await fetchIdentity(ORIGIN, fetchImpl as unknown as typeof fetch)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('匿名ログインを有効にしてください')
    const offline = await fetchIdentity(ORIGIN, (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch)
    expect(offline.ok).toBe(false)
    const bad = await fetchIdentity(ORIGIN, (async () => new Response('{"x":1}', { status: 200 })) as unknown as typeof fetch)
    expect(bad.ok).toBe(false)
    expect((await fetchIdentity('', vi.fn() as unknown as typeof fetch)).ok).toBe(false)
  })
})

describe('連携の鍵と指紋', () => {
  it('k は 32 バイトの乱数の base64url（43 文字）', () => {
    const k = randomPairingKey()
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomPairingKey()).not.toBe(k)
    expect(base64url(new Uint8Array([251, 255, 254]))).toBe('-__-')
  })

  it("指紋は sha256hex(s + '.' + k)（コネクタと同じ式）", async () => {
    expect(await pairingHash('state1', 'key1')).toBe(await sha('state1.key1'))
    // 知られている値（SHA-256 の 'abc'）
    expect(await sha('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('許可した端末の呼び名', () => {
  it('iPhone・iPad・Android・Windows・Mac・ブラウザ（「この端末」とは書かない）', () => {
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone')
    expect(deviceLabel('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('iPad')
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 15; Pixel 7)')).toBe('Android')
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows')
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Mac')
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64)')).toBe('ブラウザ')
  })
})

describe('［許可する］', () => {
  it('k は Firestore に書かず指紋だけを書き、記録してからコネクタへ移る', async () => {
    const t = deps()
    const r = await approvePairing(t.d, { state: 'st-1', identity, ownerUid: 'ownerUid', writes: true, ...conn })
    expect(r.ok).toBe(true)
    const k = 'K'.repeat(43)
    expect(t.written).toEqual([
      {
        uid: 'anonUid123',
        pairing: await sha(`st-1.${k}`),
        approvedOn: 'Mac',
        writes: true,
        cid: 'cabc123def456',
        name: '接続2',
        defaultName: false,
        replaceCid: null,
      },
    ])
    expect(JSON.stringify(t.written)).not.toContain(k)
    // 連携の記録 → 移動 の順（TS は見せるタイトルを持たないので、送信待ちを送り終えるのを待たない）
    expect(t.calls).toEqual(['write', 'navigate'])
    const url = new URL(t.navigated())
    expect(url.origin).toBe(ORIGIN)
    expect(url.searchParams.get('state')).toBe('st-1')
    expect(url.searchParams.get('k')).toBe(k)
  })

  it('書き込みを許可しない時は writes: false。変えていなければ null と、既定の名前かどうかを渡す', async () => {
    const t = deps()
    await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: false, ...conn })
    expect(t.written[0].writes).toBe(false)
    const u = deps()
    await approvePairing(u.d, { state: 's', identity, ownerUid: 'o', writes: null, ...conn, defaultName: true })
    expect(u.written[0]).toMatchObject({ writes: null, name: '接続2', defaultName: true })
  })

  it('コネクタのアカウントが持ち主と同じ・印が正しくない・場所が無い時は何も書かない', async () => {
    for (const [over, input] of [
      [{}, { state: 's', identity: { ...identity, uid: 'owner' }, ownerUid: 'owner' }],
      [{}, { state: 'a b', identity, ownerUid: 'owner' }],
      [{ origin: '' }, { state: 's', identity, ownerUid: 'owner' }],
    ] as const) {
      const t = deps(over)
      const r = await approvePairing(t.d, { ...input, writes: true, ...conn })
      expect(r.ok).toBe(false)
      expect(t.calls).toEqual([])
    }
  })

  it('名前が空・長すぎる・接続の id が正しくなければ、何も書かない', async () => {
    for (const over of [{ name: '' }, { name: 'あ'.repeat(21) }, { cid: 'X1' }, { cid: 'c' }]) {
      const t = deps()
      const r = await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: true, ...conn, ...over })
      expect(r.ok).toBe(false)
      if (over.name !== undefined && !r.ok) expect(r.error).toBe(CONNECTION_NAME_ERROR)
      expect(t.calls).toEqual([])
    }
  })

  it('記録できなければ移らない（アクセスルールが古い時の説明）', async () => {
    const t = deps({
      addConnection: async () => {
        throw Object.assign(new Error('denied'), { code: 'permission-denied' })
      },
    })
    const r = await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: true, ...conn })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('アクセスルール')
    expect(t.calls).not.toContain('navigate')
  })

  it('作者が入れた名前と同じ名前の接続が記録にあれば（ほかの端末で足された）、知らせて移らない', async () => {
    const t = deps({
      addConnection: async () => {
        throw new DuplicateNameError()
      },
    })
    const r = await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: true, ...conn })
    expect(r).toEqual({ ok: false, error: DUPLICATE_NAME_ERROR })
    expect(DUPLICATE_NAME_ERROR).toBe(
      '同じ名前の接続があります。名前を変えて、もう一度［許可する］を押してください（連携はまだ記録していません）。',
    )
    expect(t.calls).not.toContain('navigate')
  })

  it('入れ替える接続を渡す', async () => {
    const t = deps()
    await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: true, ...conn, replaceCid: 'cold' })
    expect(t.written[0]).toMatchObject({ cid: 'cabc123def456', name: '接続2', replaceCid: 'cold' })
  })

  it('コネクタの身元が変わっていたら、記録を消してから新しく作る（1回だけ）', async () => {
    let n = 0
    const t = deps()
    t.d.addConnection = async (a) => {
      t.calls.push('write')
      if (n++ === 0) throw new IdentityChangedError()
      t.written.push(a)
    }
    const r = await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: true, ...conn, replaceCid: 'cold' })
    expect(r.ok).toBe(true)
    expect(t.calls).toEqual(['write', 'delete', 'write', 'navigate'])
    expect(t.written[0]).toMatchObject({ cid: conn.cid, replaceCid: null })
    // 2回目も変わっていれば（同時に別の許可）、移らない
    const u = deps({
      addConnection: async () => {
        u.calls.push('write')
        throw new IdentityChangedError()
      },
    })
    expect((await approvePairing(u.d, { state: 's', identity, ownerUid: 'o', writes: true, ...conn })).ok).toBe(false)
    expect(u.calls).toEqual(['write', 'delete', 'write'])
  })

  it('接続が2ある時は、入れ替えるか解除するように知らせ、移らない', async () => {
    const t = deps({
      addConnection: async () => {
        throw new ConnectionLimitError()
      },
    })
    const r = await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: true, ...conn })
    expect(r).toEqual({ ok: false, error: CONNECTION_LIMIT_ERROR })
    expect(CONNECTION_LIMIT_ERROR).toBe(
      '接続が2あります（同時に2まで）。入れ替える接続を選ぶか、一覧で1つ解除してから、もう一度［許可する］を押してください（連携はまだ記録していません）。',
    )
    expect(t.calls).not.toContain('navigate')
  })

  it('やり直し（記録に失敗した後）は同じ接続の id で足す（一覧に重ならない）', async () => {
    let fail = true
    const t = deps()
    t.d.addConnection = async (a) => {
      if (fail) {
        fail = false
        throw Object.assign(new Error('x'), { code: 'unavailable' })
      }
      t.written.push(a)
    }
    const input = { state: 's', identity, ownerUid: 'o', writes: true, ...conn }
    expect((await approvePairing(t.d, input)).ok).toBe(false)
    expect((await approvePairing(t.d, input)).ok).toBe(true)
    expect(t.written.map((a) => a.cid)).toEqual([conn.cid])
  })
})

/** Firestore の Timestamp の代わり（toMillis だけ） */
const ts = (ms: number) => ({ toMillis: () => ms })

describe('連携の記録を読む', () => {
  const doc = {
    uid: 'u',
    v: 2,
    pairing: 'p3',
    pairedAt: ts(300),
    approvedOn: 'iPhone',
    writes: false,
    pairingCid: 'cbbb',
    connections: {
      cbbb: { name: '仕事用', pairing: 'p3', pairedAt: ts(300), approvedOn: 'iPhone' },
      caaa: { name: '接続1', pairing: 'p1', pairedAt: ts(100), approvedOn: 'Mac' },
      'bad key': { name: 'x', pairing: 'x', pairedAt: ts(1), approvedOn: '' },
      cnot: 'map でない',
    },
  }

  it('接続の一覧（許可した時刻の順）。形の違う接続は外し、正しい接続が無ければ連携していない', () => {
    const s = parseConnectorDoc(doc)!
    expect(s.connections.map((c) => [c.cid, c.name, c.pairedAt])).toEqual([
      ['caaa', '接続1', 100],
      ['cbbb', '仕事用', 300],
    ])
    expect(s).toMatchObject({ uid: 'u', pairedAt: 300, approvedOn: 'iPhone', writes: false, pairingCid: 'cbbb' })
    expect(parseConnectorDoc({ ...doc, pairingCid: 'X' })!.pairingCid).toBeNull()
    expect(parseConnectorDoc({ ...doc, connections: { 'bad key': {} } })).toBeNull()
    expect(parseConnectorDoc({ ...doc, connections: {} })).toBeNull()
  })

  it('connections の無い記録（NS の 2.8 までの v1 の形）・身元の無い記録は連携していない（TS は初めから v2）', () => {
    expect(parseConnectorDoc({ uid: 'u', pairing: 'p', pairedAt: ts(123), approvedOn: 'Mac', writes: true, v: 1 })).toBeNull()
    expect(parseConnectorDoc({ ...doc, uid: '' })).toBeNull()
    expect(parseConnectorDoc({})).toBeNull()
    expect(parseConnectorDoc(null)).toBeNull()
  })
})

describe('接続の一覧を書き換える（トランザクションの中身）', () => {
  const SERVER = { server: true }
  const approval = (over: Partial<ConnectionApproval> = {}): ConnectionApproval => ({
    uid: 'anon',
    pairing: 'h-new',
    approvedOn: 'Mac',
    writes: true,
    cid: 'cnew',
    name: '接続2',
    replaceCid: null,
    ...over,
  })
  const entry = (name: string, pairing = `h-${name}`) => ({ name, pairing, pairedAt: ts(1), approvedOn: 'Mac' })
  const v2 = (n: number, over: Record<string, unknown> = {}) => ({
    uid: 'anon',
    v: 2,
    pairing: 'h-last',
    pairedAt: ts(5),
    approvedOn: 'Mac',
    writes: true,
    pairingCid: 'c1',
    connections: Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i + 1}`, entry(`接続${i + 1}`)])),
    ...over,
  })

  it('接続は同時に2まで（firestore.rules の connections.size() <= 2 と同じ）', () => {
    expect(MAX_CONNECTIONS).toBe(2)
  })

  it('記録が無ければ、その接続1つの v2 の記録を作る（時刻はサーバー時刻）', () => {
    expect(addedConnectorDoc(null, approval(), SERVER)).toEqual({
      uid: 'anon',
      writes: true,
      v: 2,
      pairing: 'h-new',
      pairedAt: SERVER,
      approvedOn: 'Mac',
      pairingCid: 'cnew',
      connections: { cnew: { name: '接続2', pairing: 'h-new', pairedAt: SERVER, approvedOn: 'Mac' } },
    })
  })

  it('ほかの接続は読んだ値のまま残す。入れ替える接続・同じ id（やり直し）は外してから足す', () => {
    const cur = v2(1)
    const added = addedConnectorDoc(cur, approval({ name: '新しい Mac' }), SERVER)
    expect(Object.keys(added.connections as object)).toEqual(['c1', 'cnew'])
    expect((added.connections as Record<string, unknown>).c1).toEqual(cur.connections.c1)
    expect(added).toMatchObject({ pairing: 'h-new', pairedAt: SERVER, pairingCid: 'cnew' })
    const replaced = addedConnectorDoc(v2(2), approval({ replaceCid: 'c2' }), SERVER)
    expect(Object.keys(replaced.connections as object)).toEqual(['c1', 'cnew'])
    const retried = addedConnectorDoc(added, approval({ name: '新しい Mac', pairing: 'h-retry' }), SERVER)
    expect(Object.keys(retried.connections as object)).toEqual(['c1', 'cnew'])
    expect((retried.connections as Record<string, { pairing: string }>).cnew.pairing).toBe('h-retry')
  })

  it('2 あれば足さない（入れ替えなら足せる）。別のコネクタの記録なら身元が変わった', () => {
    expect(() => addedConnectorDoc(v2(2), approval(), SERVER)).toThrow(ConnectionLimitError)
    expect(() => addedConnectorDoc(v2(2), approval(), SERVER)).toThrow('接続が2あります')
    expect(
      Object.keys(addedConnectorDoc(v2(2), approval({ replaceCid: 'c1', name: '新しい Mac' }), SERVER).connections as object),
    ).toHaveLength(2)
    // 入れ替える接続がもう無い（ほかの端末で解除した）: 2 のままなら足さない
    expect(() => addedConnectorDoc(v2(2), approval({ replaceCid: 'cgone' }), SERVER)).toThrow(ConnectionLimitError)
    // 形の違う項目は数えない（一覧に出ず、解除もできないため）
    const junk = v2(1, { connections: { ...v2(1).connections, 'BAD KEY': entry('x'), cjunk: 'x' } })
    expect(Object.keys(addedConnectorDoc(junk, approval({ name: '新しい Mac' }), SERVER).connections as object)).toHaveLength(2)
    expect(() => addedConnectorDoc(v2(1, { uid: 'other' }), approval(), SERVER)).toThrow(IdentityChangedError)
  })

  it('名前を変える: 身元・書き込み・最後の許可の指紋・時刻・接続はそのまま', () => {
    const cur = v2(2, { writes: false })
    const d = renamedConnectorDoc(cur, 'c2', '  仕事用 ')
    expect(d).toEqual({ ...cur, connections: { ...cur.connections, c2: { ...cur.connections.c2, name: '仕事用' } } })
    expect(() => renamedConnectorDoc(cur, 'cgone', '名前')).toThrow(ConnectionGoneError)
    expect(() => renamedConnectorDoc(null, 'c1', '名前')).toThrow(ConnectionGoneError)
    expect(() => renamedConnectorDoc(cur, 'c1', ' ')).toThrow(CONNECTION_NAME_ERROR)
    expect(() => renamedConnectorDoc(cur, 'c1', 'あ'.repeat(21))).toThrow(CONNECTION_NAME_ERROR)
  })

  it('1つ解除する: 一覧から外す（最後に許可した接続でも、pairingCid はそのまま）。最後の1つなら記録を消す', () => {
    const cur = v2(2, { pairingCid: 'c2' })
    const r = removedConnectorDoc(cur, 'c2')
    expect(r).toEqual({ kind: 'set', doc: { ...cur, connections: { c1: cur.connections.c1 } } })
    expect(removedConnectorDoc(v2(1), 'c1')).toEqual({ kind: 'delete' })
    expect(removedConnectorDoc(cur, 'cgone')).toEqual({ kind: 'none' })
    expect(removedConnectorDoc(null, 'c1')).toEqual({ kind: 'none' })
    // 正しい接続だけが残る（形の違う項目だけになれば、記録を消す）
    expect(removedConnectorDoc(v2(1, { connections: { c1: entry('a'), cjunk: 1 } }), 'c1')).toEqual({ kind: 'delete' })
  })

  it('同じ名前（字の幅・空白の違いは同じ）の接続が記録にあれば、既定の名前は空いている番号にし、作者が入れた名前は断る', () => {
    // 一覧を読めなかった画面の既定「接続1」を、「接続1」のある記録に足す: 「接続2」になる
    const names = (doc: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(doc.connections as Record<string, { name: string }>).map(([cid, c]) => [cid, c.name]))
    expect(names(addedConnectorDoc(v2(1), approval({ name: defaultConnectionName([]), defaultName: true }), SERVER))).toEqual({
      c1: '接続1',
      cnew: '接続2',
    })
    // 字の幅の違う「接続２」も同じ名前
    expect(
      names(addedConnectorDoc(v2(1, { connections: { c1: entry('接続２') } }), approval({ defaultName: true }), SERVER)),
    ).toEqual({ c1: '接続２', cnew: '接続1' })
    // 作者が入れた名前（defaultName が無い・false）は断る（何も書かない）
    expect(() => addedConnectorDoc(v2(1), approval({ name: '接続１', defaultName: false }), SERVER)).toThrow(DuplicateNameError)
    expect(() => addedConnectorDoc(v2(1), approval({ name: ' 接続1' }), SERVER)).toThrow(DuplicateNameError)
    // 入れ替える接続・同じ id（やり直し）の名前とは重なってよい
    expect(names(addedConnectorDoc(v2(2), approval({ replaceCid: 'c2' }), SERVER))).toEqual({ c1: '接続1', cnew: '接続2' })
    const retried = addedConnectorDoc(
      v2(1, { connections: { ...v2(1).connections, cnew: entry('接続5') } }),
      approval({ name: '接続5' }),
      SERVER,
    )
    expect(names(retried)).toEqual({ c1: '接続1', cnew: '接続5' })
  })

  it('「書き込みを許可」は、作者が変えていなければ（null）記録の値のまま（記録が無ければ許可）。変えたらその値', () => {
    const add = (cur: Record<string, unknown> | null, writes: boolean | null) =>
      addedConnectorDoc(cur, approval({ name: '新しい Mac', writes }), SERVER).writes
    expect(add(v2(1, { writes: false }), null)).toBe(false)
    expect(add(v2(1, { writes: true }), null)).toBe(true)
    expect(add(null, null)).toBe(true)
    expect(add(v2(1, { writes: false }), true)).toBe(true)
    expect(add(v2(1, { writes: true }), false)).toBe(false)
  })

  it('記録の接続の map: 形の合うものだけ（connections の無い記録は空）', () => {
    expect(connectionEntries({ ...v2(1), connections: 'x' })).toEqual({})
    expect(connectionEntries({ uid: 'anon', pairing: 'p', v: 1 })).toEqual({})
    expect(Object.keys(connectionEntries(v2(2)))).toEqual(['c1', 'c2'])
  })

  it('接続の名前は前後の空白を除いて1〜20字（制御文字は不可）', () => {
    expect(cleanNewConnectionName(' 仕事用 ')).toBe('仕事用')
    expect(cleanNewConnectionName('あ'.repeat(20))).toBe('あ'.repeat(20))
    expect(cleanNewConnectionName('あ'.repeat(21))).toBeNull()
    expect(cleanNewConnectionName('　')).toBeNull()
    expect(cleanNewConnectionName('a\nb')).toBeNull()
    expect(cleanNewConnectionName('a\u2028b')).toBeNull()
  })
})

describe('［許可する］の前の確かめ（持ち主・同期・コネクタの身元）', () => {
  function prep(over: Partial<PrepareDeps> = {}) {
    const steps: string[] = []
    const asked: string[] = []
    const d: PrepareDeps = {
      origin: ORIGIN,
      readOwnerUid: async () => 'owner',
      waitSynced: async () => true,
      fetchIdentity: async (origin) => {
        asked.push(origin)
        return { ok: true, identity }
      },
      readConnector: async () => null,
      dataModel: 2,
      cancelled: () => false,
      onStep: (s) => steps.push(s),
      ...over,
    }
    return { d, steps, asked }
  }

  it('持ち主なら同期を待ってから、ビルドの時に決めた origin にだけ問い合わせる', async () => {
    const t = prep()
    expect(await prepareConnect(t.d, 'owner')).toEqual({
      step: 'ready',
      identity,
      ownerUid: 'owner',
      existing: null,
      existingError: false,
    })
    expect(t.steps).toEqual(['checking', 'sync', 'identity'])
    expect(t.asked).toEqual([ORIGIN])
  })

  it('持ち主でない・持ち主が読めない・同期が終わらない時は、コネクタに問い合わせない', async () => {
    for (const [over, step] of [
      [{ readOwnerUid: async () => 'someone-else' }, 'notOwner'],
      [{ readOwnerUid: async () => Promise.reject(new Error('offline')) }, 'ownerError'],
      [{ waitSynced: async () => false }, 'syncTimeout'],
      [{ readOwnerUid: async () => null }, 'noOwner'],
      [{ cancelled: () => true }, 'cancelled'],
    ] as const) {
      const t = prep(over)
      expect((await prepareConnect(t.d, 'owner')).step).toBe(step)
      expect(t.asked).toEqual([])
    }
  })

  it('初めての同期で持ち主が記録されたら、もう一度読んで確かめる', async () => {
    let n = 0
    const t = prep({ readOwnerUid: async () => (n++ === 0 ? null : 'owner') })
    expect((await prepareConnect(t.d, 'owner')).step).toBe('ready')
    let m = 0
    const u = prep({ readOwnerUid: async () => (m++ === 0 ? null : 'someone-else') })
    expect((await prepareConnect(u.d, 'owner')).step).toBe('notOwner')
    expect(u.asked).toEqual([])
  })

  it('いまの連携の記録（接続の一覧）を渡す。読めなくても許可はできる', async () => {
    const existing: ConnectorStatus = {
      uid: 'anonUid123',
      pairedAt: 1,
      approvedOn: 'Mac',
      writes: false,
      connections: [{ cid: 'c1', name: '接続1', pairing: 'p', pairedAt: 1, approvedOn: 'Mac' }],
      pairingCid: 'c1',
    }
    const t = prep({ readConnector: async () => existing })
    expect(await prepareConnect(t.d, 'owner')).toMatchObject({ step: 'ready', existing, existingError: false })
    const u = prep({ readConnector: async () => Promise.reject(new Error('offline')) })
    expect(await prepareConnect(u.d, 'owner')).toMatchObject({ step: 'ready', existing: null, existingError: true })
  })

  it('コネクタのデータの形がこのアプリより古い・分からない時は許可させない（記録も読まない）', async () => {
    for (const model of [1, null]) {
      const readConnector = vi.fn(async () => null)
      const t = prep({ fetchIdentity: async () => ({ ok: true, identity: { ...identity, model } }), readConnector })
      expect(await prepareConnect(t.d, 'owner')).toEqual({ step: 'connectorOld', identity: { ...identity, model } })
      expect(readConnector).not.toHaveBeenCalled()
    }
    // 新しい版のコネクタ（アプリが古い）は許可できる（画面で書き込めないことを知らせる）
    const newer = prep({ fetchIdentity: async () => ({ ok: true, identity: { ...identity, model: 3 } }) })
    expect((await prepareConnect(newer.d, 'owner')).step).toBe('ready')
  })

  it('コネクタの身元が持ち主と同じアカウント・答えられない時は先へ進まない', async () => {
    const same = prep({ fetchIdentity: async () => ({ ok: true, identity: { ...identity, uid: 'owner' } }) })
    expect((await prepareConnect(same.d, 'owner')).step).toBe('identityError')
    const down = prep({ fetchIdentity: async () => ({ ok: false, error: '匿名ログインが無効です' }) })
    expect(await prepareConnect(down.d, 'owner')).toEqual({ step: 'identityError', error: '匿名ログインが無効です' })
  })
})

describe('コネクタと同じ値（src/test/pairingFixture.ts）', () => {
  it('印・k・指紋・戻る URL がコネクタの確かめと同じになる', async () => {
    const t = deps({ origin: F.connectorOrigin, randomKey: () => F.k })
    const r = await approvePairing(t.d, { state: F.state, identity: F.identity, ownerUid: 'owner', writes: true, ...conn })
    expect(r).toEqual({ ok: true, url: F.callbackUrl })
    expect(t.written[0].pairing).toBe(F.hash)
    expect(t.written[0].uid).toBe(F.identity.uid)
  })

  it('作った k の形が違えば何も書かない', async () => {
    const t = deps({ randomKey: () => 'short' })
    const r = await approvePairing(t.d, { state: F.state, identity, ownerUid: 'owner', writes: true, ...conn })
    expect(r.ok).toBe(false)
    expect(t.calls).toEqual([])
  })
})
