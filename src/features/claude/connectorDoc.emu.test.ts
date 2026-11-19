// 連携の記録を読み書きする部品（src/features/claude/connectorDoc.ts。アプリの連携の画面と設定の「Claude との連携」が使う）を、本番の
// アクセスルール（firestore.rules）の上で、持ち主の Firebase の SDK から流す（Firebase エミュレーター。npm run test:sync）。NS の
// src/claude/rules.emu.test.ts の「アプリの操作（トランザクション）」を写した物（TS は初めから v2 なので、2.8 までの v1 の記録からの移し替えは
// 写さない。接続は2まで）。確かめる事: 新しい許可で足す・名前を変えても指紋・時刻・pairingCid はそのまま・1つ解除しても pairingCid は
// そのまま・2つある時に3つ目を足すと断る・replaceCid で入れ替える・最後の1つの解除で記録を消し、消した後はコネクタが読めない。
// コネクタは記録された匿名のアカウント（SDK の匿名のログイン。コネクタの REST の口の確かめは src/sync/rules.emu.test.ts）。
// アカウントと記録はすべて作り物（公開のリポジトリ。docs/SPEC.md の 3.）
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, GoogleAuthProvider, signInAnonymously, signInWithCredential } from 'firebase/auth'
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  initializeFirestore,
  memoryLocalCache,
  query,
  serverTimestamp,
  setDoc,
  terminate,
  Timestamp,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore'
import emuRules from '../../../firestore.emu.rules?raw'
import prodRules from '../../../firestore.rules?raw'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CONNECTOR_DOC_VERSION, MAX_CONNECTIONS, type ConnectionApproval } from '../../claude/pairing'
import { adminCreateOwner, clearFirestore, EMU_PROJECT, useRules } from '../../test/emulatorAdmin'
import { ConnectionGoneError, ConnectionLimitError, IdentityChangedError } from './connectLogic'
import {
  addConnection,
  deleteConnector,
  readConnectorDoc,
  readOwnerUid,
  removeConnection,
  renameConnection,
  setConnectorWrites,
  watchConnector,
  type ConnectorState,
} from './connectorDoc'

// ---------- アカウント（src/sync/rules.emu.test.ts と同じ作り方） ----------

interface Who {
  name: string
  uid: string
  fs: Firestore
}

let seq = 0
const apps: FirebaseApp[] = []
const stores: Firestore[] = []

function newApp(label: string): FirebaseApp {
  const app = initializeApp(
    { projectId: EMU_PROJECT, apiKey: 'fake-api-key', authDomain: 'localhost' },
    `connector-doc-${label}-${++seq}`,
  )
  apps.push(app)
  return app
}

function firestoreOf(app: FirebaseApp): Firestore {
  const fs = initializeFirestore(app, { localCache: memoryLocalCache() })
  connectFirestoreEmulator(fs, '127.0.0.1', 8080)
  stores.push(fs)
  return fs
}

const account = (name: string) => `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** エミュレーターの仮の Google アカウントでログインする（作り物の sub） */
async function googleUser(name: string): Promise<Who> {
  const app = newApp(name)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const sub = account(name)
  const cred = GoogleAuthProvider.credential(JSON.stringify({ sub, email: `${sub}@example.com`, email_verified: true }))
  const { user } = await signInWithCredential(auth, cred)
  return { name, uid: user.uid, fs: firestoreOf(app) }
}

/** 匿名のアカウント（コネクタと同じ種類のアカウント） */
async function anonymousUser(): Promise<Who> {
  const app = newApp('anon')
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const { user } = await signInAnonymously(auth)
  return { name: 'コネクタ（匿名のアカウント）', uid: user.uid, fs: firestoreOf(app) }
}

let owner: Who
let stranger: Who
let anon: Who

beforeAll(async () => {
  await useRules(prodRules)
  owner = await googleUser('owner')
  stranger = await googleUser('stranger')
  anon = await anonymousUser()
})

beforeEach(async () => {
  await useRules(prodRules)
  await clearFirestore()
  await adminCreateOwner(owner.uid)
})

afterAll(async () => {
  for (const fs of stores.splice(0)) await terminate(fs)
  for (const app of apps.splice(0)) await deleteApp(app)
  // 次のテストファイルを本番のルールのまま流さない
  await useRules(emuRules)
})

// ---------- 連携の記録 ----------

/** 作り物の指紋（64字） */
const H = (c: string) => c.repeat(64)

type Saved = Record<string, unknown> & {
  uid: string
  v: number
  writes: boolean
  pairing: string
  pairedAt: Timestamp
  approvedOn: string
  pairingCid: string
  connections: Record<string, { name: string; pairing: string; pairedAt: Timestamp; approvedOn: string }>
}

/** 持ち主の SDK で、いまの記録をサーバーから読む（無ければ null） */
async function saved(): Promise<Saved | null> {
  const snap = await getDoc(doc(owner.fs, 'config', 'connector'))
  return snap.exists() ? (snap.data() as Saved) : null
}

/** 足す接続（連携の画面の［許可する］が渡す形。指紋と接続の id・名前だけを替える） */
const approval = (over: Partial<ConnectionApproval> = {}): ConnectionApproval => ({
  uid: anon.uid,
  pairing: H('a'),
  approvedOn: 'テストの Mac',
  writes: null,
  cid: 'cfirst0000001',
  name: '接続1',
  defaultName: true,
  replaceCid: null,
  ...over,
})

/** コネクタ（匿名のアカウント）が、持ち主の Claude の表を一覧で読めるか（ルールは table == を付けた一覧だけを通す） */
async function connectorCanRead(): Promise<boolean> {
  try {
    await getDocs(query(collection(anon.fs, 'users', owner.uid, 'records'), where('table', '==', 'editions')))
    return true
  } catch {
    return false
  }
}

describe('連携の記録の部品（connectorDoc.ts）を本番のアクセスルールの上で流す', () => {
  it('持ち主の記録を読む。記録が無ければ連携していない（null）', async () => {
    expect(await readOwnerUid(owner.fs)).toBe(owner.uid)
    expect(await readConnectorDoc(owner.fs)).toBeNull()
    // 記録されていない匿名のアカウントは、持ち主の記録を読めない
    expect(await connectorCanRead()).toBe(false)
  })

  it('新しい許可で足す → 名前を変える → 3つ目は断る → 入れ替える → 1つ解除 → 最後の1つで記録を消し、コネクタは読めなくなる', async () => {
    // 1. 新しい許可（記録が無い）: v2 の形・最後の許可の指紋と時刻（サーバー時刻）・接続 = その1つ。「書き込みを許可」は既定で許可
    await addConnection(approval(), owner.fs)
    let d = (await saved())!
    expect(d).toMatchObject({
      uid: anon.uid,
      v: CONNECTOR_DOC_VERSION,
      writes: true,
      pairing: H('a'),
      approvedOn: 'テストの Mac',
      pairingCid: 'cfirst0000001',
    })
    expect(Object.keys(d.connections)).toEqual(['cfirst0000001'])
    expect(d.connections.cfirst0000001).toMatchObject({ name: '接続1', pairing: H('a'), approvedOn: 'テストの Mac' })
    expect(d.connections.cfirst0000001.pairedAt.toMillis()).toBe(d.pairedAt.toMillis())
    expect(Math.abs(d.pairedAt.toMillis() - Date.now())).toBeLessThan(60_000)
    // 記録されたコネクタは、連携の記録と持ち主の Claude の表を読める
    expect((await getDoc(doc(anon.fs, 'config', 'connector'))).exists()).toBe(true)
    expect(await connectorCanRead()).toBe(true)
    // 部品で読み直す（画面に出す形）
    const status = (await readConnectorDoc(owner.fs))!
    expect(status.connections.map((c) => [c.cid, c.name])).toEqual([['cfirst0000001', '接続1']])
    expect(status).toMatchObject({ uid: anon.uid, writes: true, pairingCid: 'cfirst0000001' })

    // 2. 2つ目を足す（既定の名前「接続1」が重なるので、空いている番号の「接続2」になる）
    await addConnection(approval({ pairing: H('b'), cid: 'csecond000001', approvedOn: 'テストの iPhone' }), owner.fs)
    const second = (await saved())!
    expect(Object.keys(second.connections).sort()).toEqual(['cfirst0000001', 'csecond000001'])
    expect(second.connections.csecond000001.name).toBe('接続2')
    expect([second.pairing, second.pairingCid, second.approvedOn]).toEqual([H('b'), 'csecond000001', 'テストの iPhone'])
    // 1つ目の接続は読んだ値のまま（指紋・時刻・端末）
    expect(second.connections.cfirst0000001.pairing).toBe(H('a'))
    expect(second.connections.cfirst0000001.pairedAt.toMillis()).toBe(d.pairedAt.toMillis())

    // 3. 名前を変えても、最後の許可の指紋・時刻・接続（pairingCid）はそのまま
    await renameConnection('cfirst0000001', ' 仕事用 ', owner.fs)
    d = (await saved())!
    expect(d.connections.cfirst0000001.name).toBe('仕事用')
    expect([d.pairing, d.pairedAt.toMillis(), d.pairingCid]).toEqual([
      second.pairing,
      second.pairedAt.toMillis(),
      'csecond000001',
    ])
    expect(d.connections.cfirst0000001.pairing).toBe(H('a'))
    // もう無い接続の名前は変えない
    await expect(renameConnection('cgone00000001', '別', owner.fs)).rejects.toBeInstanceOf(ConnectionGoneError)

    // 4. 2つある時に3つ目を足すと断る（部品が断る。ルールも3つの記録を断る）
    expect(MAX_CONNECTIONS).toBe(2)
    await expect(addConnection(approval({ pairing: H('c'), cid: 'cthird000001' }), owner.fs)).rejects.toBeInstanceOf(
      ConnectionLimitError,
    )
    const three = {
      ...d,
      pairing: H('c'),
      pairedAt: serverTimestamp(),
      pairingCid: 'cthird000001',
      connections: {
        ...d.connections,
        cthird000001: { name: '接続3', pairing: H('c'), pairedAt: serverTimestamp(), approvedOn: 'テストの Mac' },
      },
    }
    await expect(setDoc(doc(owner.fs, 'config', 'connector'), three)).rejects.toThrow()
    expect(Object.keys((await saved())!.connections)).toHaveLength(2)

    // 5. replaceCid で入れ替える（2つのまま。新しい接続が最後の許可）
    await addConnection(
      approval({ pairing: H('c'), cid: 'cthird000001', name: '新しい Mac', defaultName: false, replaceCid: 'cfirst0000001' }),
      owner.fs,
    )
    d = (await saved())!
    expect(Object.keys(d.connections).sort()).toEqual(['csecond000001', 'cthird000001'])
    expect(d.connections.cthird000001.name).toBe('新しい Mac')
    expect([d.pairing, d.pairingCid]).toEqual([H('c'), 'cthird000001'])
    const replaced = d

    // 6. 1つ解除する（最後に許可した接続でも、pairingCid・指紋・時刻はそのまま）
    expect(await removeConnection('cthird000001', owner.fs)).toBe('removed')
    d = (await saved())!
    expect(Object.keys(d.connections)).toEqual(['csecond000001'])
    expect([d.pairingCid, d.pairing, d.pairedAt.toMillis()]).toEqual([
      'cthird000001',
      replaced.pairing,
      replaced.pairedAt.toMillis(),
    ])
    expect(await removeConnection('cthird000001', owner.fs)).toBe('none')
    expect(await connectorCanRead()).toBe(true)

    // 7. 最後の1つの解除で記録を消す。消した後は、コネクタは連携の記録も持ち主の表も読めない
    expect(await removeConnection('csecond000001', owner.fs)).toBe('deleted')
    expect(await saved()).toBeNull()
    expect(await readConnectorDoc(owner.fs)).toBeNull()
    await expect(getDoc(doc(anon.fs, 'config', 'connector'))).rejects.toThrow()
    expect(await connectorCanRead()).toBe(false)
    expect(await removeConnection('csecond000001', owner.fs)).toBe('none')
  })

  it('「書き込みを許可」だけを変える（指紋・時刻・一覧はそのまま）。作者が変えていなければ、次の許可でも記録の値のまま', async () => {
    await addConnection(approval(), owner.fs)
    const before = (await saved())!
    await setConnectorWrites(false, owner.fs)
    const off = (await saved())!
    expect(off.writes).toBe(false)
    expect([off.pairing, off.pairedAt.toMillis(), off.pairingCid]).toEqual([
      before.pairing,
      before.pairedAt.toMillis(),
      before.pairingCid,
    ])
    // 作者が触っていない（writes: null）許可は、止めたまま
    await addConnection(approval({ pairing: H('b'), cid: 'csecond000001' }), owner.fs)
    expect((await saved())!.writes).toBe(false)
    // 触った許可はその値
    await addConnection(approval({ pairing: H('c'), cid: 'csecond000001', writes: true }), owner.fs)
    expect((await saved())!.writes).toBe(true)
  })

  it('別のコネクタの記録（身元を作り直した）には足さず、消してから作り直す。持ち主でない・コネクタは書き換えも消すこともできない', async () => {
    await addConnection(approval(), owner.fs)
    await expect(addConnection(approval({ uid: 'another-anon-uid', cid: 'cnew000000001' }), owner.fs)).rejects.toBeInstanceOf(
      IdentityChangedError,
    )
    expect((await saved())!.uid).toBe(anon.uid)
    // 持ち主でないアカウント・コネクタは、連携の記録を書き換えられず、消せない
    await expect(updateDoc(doc(stranger.fs, 'config', 'connector'), { writes: false })).rejects.toThrow()
    await expect(updateDoc(doc(anon.fs, 'config', 'connector'), { writes: false })).rejects.toThrow()
    await expect(addConnection(approval({ pairing: H('d'), cid: 'cstranger0001' }), stranger.fs)).rejects.toThrow()
    // 身元が変わった時の手順（連携の画面の approvePairing）: 記録を消してから、新しく作る
    await deleteConnector(owner.fs)
    expect(await saved()).toBeNull()
    await addConnection(approval({ uid: 'another-anon-uid', cid: 'cnew000000001', pairing: H('e') }), owner.fs)
    const d = (await saved())!
    expect([d.uid, d.pairingCid, Object.keys(d.connections)]).toEqual(['another-anon-uid', 'cnew000000001', ['cnew000000001']])
    // 前のコネクタは、もう読めない
    await expect(getDoc(doc(anon.fs, 'config', 'connector'))).rejects.toThrow()
  })

  it('連携の記録を見張る（サーバーから届いた内容だけ。無い → 連携した → 解除した）', async () => {
    const seen: ConnectorState[] = []
    const stop = watchConnector((s) => seen.push(s), owner.fs)
    try {
      await expect.poll(() => seen.at(-1)?.state, { timeout: 10_000 }).toBe('none')
      await addConnection(approval(), owner.fs)
      await expect.poll(() => seen.at(-1)?.state, { timeout: 10_000 }).toBe('paired')
      const last = seen.at(-1)
      expect(last?.state === 'paired' ? last.status.connections.map((c) => c.name) : null).toEqual(['接続1'])
      await deleteConnector(owner.fs)
      await expect.poll(() => seen.at(-1)?.state, { timeout: 10_000 }).toBe('none')
    } finally {
      stop()
    }
  })
})
