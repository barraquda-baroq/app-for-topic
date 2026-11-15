// 同期の司令塔（docs/SPEC.md の 7.8 の「部品」の controller.ts・16.2 の 6）: 持ち主だと確かめてから同期のエンジンを始める・前に別の
// アカウントで同期していた端末は確かめるまで始めない・エンジンの持ち主の知らせ（記録が無い → トップのまま同期の表示に理由・記録が戻ると
// 始め直す／ほかのアカウント → ログインの画面へ）・タブの受け持ち（Web Locks・新しい版の画面に譲る・受け持たない画面は届いた状態を出す）・
// 裏に回る時にすぐ送る・20分より長く裏にあった後に購読し直す・日付が変わったら端末の中の30日の外を消す・1日1回の手入れ・ログアウトの前に
// 送る・最初の受け取りの後に欠けた話題を直接読む・エンジンの口がストアを通る。
// Firebase・Firestore・持ち主の記録・同期のエンジンは仮の物（エンジンは作られた時の口を覚え、状態をテストが知らせる）、保存先とストアは本物
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineOptions, MaintainResult, SyncEngine, SyncStatus, TopicFetchResult } from './engine'

interface FakeEngine {
  opts: EngineOptions
  status: SyncStatus
  started: number
  stopped: boolean
  uploads: (boolean | undefined)[]
  flushes: number
  reanchors: number
  maintains: number
  expires: number
  fetched: string[][]
  /** エンジンの状態が変わったと知らせる */
  emit(patch: Partial<SyncStatus>): void
}

const h = vi.hoisted(() => ({
  onUser: null as null | ((u: unknown) => void),
  /** 持ち主の確かめの答え（offline = 通信できない） */
  answer: 'ok' as 'ok' | 'missing' | 'mismatch' | 'offline',
  checks: 0,
  usingEmulator: false,
  engines: [] as FakeEngine[],
  order: [] as string[],
  maintainResult: { deleted: {}, total: 0, capped: false, skipped: null } as MaintainResult,
  fetchResult: null as null | ((ids: readonly string[]) => TopicFetchResult),
  modelWatches: 0,
}))

vi.mock('./firebase', () => ({
  get usingEmulator() {
    return h.usingEmulator
  },
  firebase: () => ({ app: {}, auth: { currentUser: null } }),
  completeRedirect: async () => {},
  describeAuthError: () => null,
  watchUser: (fn: (u: unknown) => void) => {
    h.onUser = fn
    return () => {}
  },
  signOutUser: async () => {
    h.order.push('ログアウト')
  },
  signInWithGoogle: async () => {},
  signInForTest: async () => {},
}))
vi.mock('./firestore', () => ({ firestore: () => ({}) }))
vi.mock('./owner', () => ({
  checkOwner: async () => {
    h.checks += 1
    if (h.answer === 'offline') throw new Error('offline')
    return h.answer
  },
}))
vi.mock('./appModel', () => ({
  DATA_MODEL: 1,
  APP_VERSION: '0.1',
  watchAppModel: () => {
    h.modelWatches += 1
    return () => {}
  },
}))
vi.mock('./engine', () => ({
  createSyncEngine: (opts: EngineOptions): SyncEngine => {
    const fake: FakeEngine = {
      opts,
      status: { phase: 'starting', pending: 0, lastSyncedAt: null, error: null },
      started: 0,
      stopped: false,
      uploads: [],
      flushes: 0,
      reanchors: 0,
      maintains: 0,
      expires: 0,
      fetched: [],
      emit(patch) {
        fake.status = { ...fake.status, ...patch }
        opts.onStatus?.(fake.status)
      },
    }
    h.engines.push(fake)
    return {
      get status() {
        return fake.status
      },
      start: async () => {
        fake.started += 1
      },
      stop: () => {
        fake.stopped = true
      },
      requestUpload: (immediate?: boolean) => {
        fake.uploads.push(immediate)
      },
      flush: async () => {
        fake.flushes += 1
        h.order.push('送る')
      },
      reanchor: () => {
        fake.reanchors += 1
      },
      idle: async () => {},
      maintain: async () => {
        fake.maintains += 1
        return h.maintainResult
      },
      expireLocal: async () => {
        fake.expires += 1
        return null
      },
      fetchTopics: async (ids: readonly string[]) => {
        fake.fetched.push([...ids])
        return h.fetchResult ? h.fetchResult(ids) : { found: [], missing: [...ids] }
      },
      serverNow: () => null,
    }
  },
}))

import { createPersistence, type AnyRecord, type Persistence } from '../db/persistence'
import { termIdOf } from '../domain/ids'
import { initStore, know, flushNow, resetStoreForTests, useApp } from '../store/appStore'
import { useToasts } from '../store/uiStore'
import { makeFakeEdition } from '../test/fixtures/fakeEditions'
import { DATA_MODEL } from './appVersion'
import {
  canShowData,
  confirmAccountSwitch,
  fakeSignInForTest,
  initSync,
  MAINTAIN_IDLE_MS,
  noteAppHidden,
  noteAppVisible,
  onTabMessage,
  REANCHOR_AFTER_MS,
  resetSyncForTests,
  signOut,
  syncNow,
  useSync,
} from './controller'
import { useSyncView } from './syncView'

let p: Persistence | null = null

afterEach(() => {
  resetSyncForTests()
  resetStoreForTests()
  p?.close()
  p = null
  h.answer = 'ok'
  h.checks = 0
  h.usingEmulator = false
  h.engines = []
  h.order = []
  h.maintainResult = { deleted: {}, total: 0, capped: false, skipped: null }
  h.fetchResult = null
  h.modelWatches = 0
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'locks')
})

/** Node の setImmediate（偽の時計にしない。画面の型には無いので、ここで型を付ける） */
const nextTurn = (globalThis as unknown as { setImmediate: (fn: () => void) => void }).setImmediate
/** 端末の中の保存（fake-indexeddb は setImmediate で進む）と後から読む部品を待つ（偽の時計の間も使える） */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise<void>((r) => nextTurn(r))
}

async function start(prepare?: (db: Persistence) => Promise<void>): Promise<Persistence> {
  p = createPersistence(`ctl-${Math.random().toString(36).slice(2)}`)
  await prepare?.(p)
  await initStore(p)
  await initSync()
  return p
}

/** ログインした時の、トップの画面を出してよいかの移り変わり */
async function signInAs(uid: string, email = `${uid}@example.com`): Promise<boolean[]> {
  const seen: boolean[] = []
  const off = useSync.subscribe((s) => seen.push(canShowData(s)))
  h.onUser!({ uid, displayName: '', email })
  await settle()
  off()
  return seen
}

const engine = (i = h.engines.length - 1): FakeEngine => {
  const e = h.engines[i]
  if (!e) throw new Error('エンジンがまだありません')
  return e
}

describe('同期のエンジンを始める（持ち主だと確かめてから）', () => {
  it('この端末で確かめたアカウントは、すぐトップを出して同期を始める（保存先の口・データの形の版・持ち主の確かめを渡す）', async () => {
    const db = await start((d) => d.setMeta('ownerSeen', 'uid-a'))
    const seen = await signInAs('uid-a')
    expect(seen.every(Boolean)).toBe(true)
    expect(h.engines).toHaveLength(1)
    const e = engine()
    expect(e.started).toBe(1)
    expect(e.opts).toMatchObject({ uid: 'uid-a', ownerLock: true, appModel: { model: DATA_MODEL, appVersion: '0.1' } })
    // 端末の ID を作って覚える（次からも同じ）。最後に同期したアカウントのメールのアドレスも覚える
    const id = await db.getMeta<string>('deviceId')
    expect(e.opts.deviceId).toBe(id)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await db.getMeta('uidEmail')).toBe('uid-a@example.com')
    expect(useSync.getState()).toMatchObject({ leader: true })
    // エンジンの状態は、司令塔の状態とヘッダーの同期の表示に入る
    e.emit({ phase: 'downloading' })
    expect(useSync.getState().status?.phase).toBe('downloading')
    expect(useSyncView.getState().view).toEqual({ kind: 'downloading' })
    e.emit({ phase: 'synced', pending: 2 })
    expect(useSyncView.getState().view).toEqual({ kind: 'pending', count: 2 })
  })

  it('まだ確かめていないアカウントは、持ち主だと分かるまでエンジンを作らない。ほかのアカウント・記録が無い時は作らない', async () => {
    await start()
    h.answer = 'missing'
    await signInAs('uid-a')
    expect(h.engines).toHaveLength(0)
    expect(useSyncView.getState().view).toBeNull()
    h.onUser!(null)
    await settle()
    h.answer = 'mismatch'
    await signInAs('uid-b')
    expect(h.engines).toHaveLength(0)
    h.onUser!(null)
    await settle()
    h.answer = 'ok'
    await signInAs('uid-c')
    expect(h.engines).toHaveLength(1)
    expect(engine().opts.uid).toBe('uid-c')
  })

  it('エミュレーターにつないだ開発サーバーは、持ち主を確かめないエンジン（ownerLock: false）', async () => {
    h.usingEmulator = true
    await start()
    await signInAs('uid-a')
    expect(h.checks).toBe(0)
    expect(engine().opts.ownerLock).toBe(false)
  })

  it('画面のテスト用のログインでは同期を始めない（同期の表示も出さない）', async () => {
    await start()
    fakeSignInForTest()
    await settle()
    expect(h.engines).toHaveLength(0)
    expect(useSyncView.getState().view).toBeNull()
  })
})

describe('前に別のアカウントで同期していた端末（docs/SPEC.md の 7.8）', () => {
  it('確かめるまで同期を始めず、トップを一瞬も出さない。［このアカウントで同期する］で始める', async () => {
    const db = await start(async (d) => {
      await d.setMeta('uid', 'uid-a')
      await d.setMeta('uidEmail', 'a@example.com')
      await d.setMeta('ownerSeen', 'uid-b')
    })
    const seen = await signInAs('uid-b', 'b@example.com')
    expect(seen).not.toContain(true)
    expect(useSync.getState()).toMatchObject({
      owner: 'ok',
      ownerSeen: true,
      accountMismatch: { previousEmail: 'a@example.com' },
    })
    expect(h.engines).toHaveLength(0)
    await confirmAccountSwitch()
    await settle()
    expect(canShowData(useSync.getState())).toBe(true)
    expect(h.engines).toHaveLength(1)
    expect(await db.getMeta('uidEmail')).toBe('b@example.com')
  })

  it('初めて持ち主だと確かめたアカウントでも、前のアカウントの印があれば確かめる', async () => {
    await start((d) => d.setMeta('uid', 'uid-a'))
    const seen = await signInAs('uid-b')
    expect(h.checks).toBe(1)
    expect(seen).not.toContain(true)
    expect(useSync.getState().accountMismatch).toEqual({ previousEmail: '' })
    expect(h.engines).toHaveLength(0)
  })
})

describe('エンジンの持ち主の知らせ（docs/SPEC.md の 7.8 の「持ち主」・14.8 の 4）', () => {
  it('記録が無い: トップは出したまま、同期の表示に「同期できません（持ち主の記録がまだありません）」。記録が戻ると同期を始め直す', async () => {
    await start((d) => d.setMeta('ownerSeen', 'uid-a'))
    h.answer = 'missing'
    await signInAs('uid-a')
    engine().emit({ phase: 'error', errorCode: 'owner-missing', error: '持ち主の記録がまだありません（docs/DEPLOY.md の 3）' })
    expect(canShowData(useSync.getState())).toBe(true)
    expect(useSync.getState().owner).toBe('missing')
    expect(useSyncView.getState().view).toEqual({ kind: 'error', reason: '持ち主の記録がまだありません' })
    // 表に戻っても、記録がまだ無ければ始め直さない
    noteAppVisible()
    await settle()
    expect(h.engines).toHaveLength(1)
    // 作者が記録を作ってから表に戻る
    h.answer = 'ok'
    noteAppVisible()
    await settle()
    expect(h.engines).toHaveLength(2)
    expect(engine(0).stopped).toBe(true)
    engine().emit({ phase: 'downloading' })
    expect(useSync.getState().owner).toBe('ok')
    expect(useSyncView.getState().view).toEqual({ kind: 'downloading' })
  })

  it('ほかのアカウントの記録: 同期を止め、ログインの画面に戻す', async () => {
    await start((d) => d.setMeta('ownerSeen', 'uid-a'))
    await signInAs('uid-a')
    const e = engine()
    e.emit({ phase: 'error', errorCode: 'owner-mismatch' })
    expect(e.stopped).toBe(true)
    expect(useSync.getState()).toMatchObject({ owner: 'mismatch', ownerSeen: false, leader: false, status: null })
    expect(canShowData(useSync.getState())).toBe(false)
  })

  it('司令塔の裏の確かめでほかのアカウントの記録だと分かっても、同期を止める', async () => {
    await start((d) => d.setMeta('ownerSeen', 'uid-a'))
    h.answer = 'mismatch'
    await signInAs('uid-a')
    expect(h.engines.every((e) => e.stopped)).toBe(true)
    expect(useSync.getState()).toMatchObject({ owner: 'mismatch', leader: false })
  })
})

describe('タブの受け持ち（Web Locks topic-studio-sync・BroadcastChannel topic-studio-sync-status）', () => {
  it('ほかの画面が受け持っている間はエンジンを作らず、データの形の版だけを見張る。受け持ちが空いたら始める', async () => {
    const waiting: (() => void)[] = []
    const names: string[] = []
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (name: string, cb: () => Promise<void>) => {
          names.push(name)
          return new Promise<void>((resolve) => waiting.push(() => void cb().then(resolve)))
        },
      },
    })
    await start((d) => d.setMeta('ownerSeen', 'uid-a'))
    await signInAs('uid-a')
    expect(names).toEqual(['topic-studio-sync'])
    expect(h.engines).toHaveLength(0)
    expect(h.modelWatches).toBe(1)
    expect(useSync.getState().leader).toBe(false)
    waiting.shift()!()
    await settle()
    expect(h.engines).toHaveLength(1)
    expect(useSync.getState().leader).toBe(true)
  })

  it('自分より新しいデータの形の版の画面の知らせが来たら、受け持ちをやめて読み込み直しを促す', async () => {
    await start((d) => d.setMeta('ownerSeen', 'uid-a'))
    await signInAs('uid-a')
    engine().emit({ phase: 'synced' })
    onTabMessage({ request: true, model: DATA_MODEL })
    expect(useSync.getState().leader).toBe(true)
    onTabMessage({ request: true, model: DATA_MODEL + 1 })
    expect(engine().stopped).toBe(true)
    expect(useSync.getState().leader).toBe(false)
    expect(useToasts.getState().toasts.at(-1)?.message).toBe(
      'アプリの新しい版が別の画面で開かれました。この画面を読み込み直してください。',
    )
  })

  it('受け持たない画面は、受け持つ画面から届いた状態を出す（同じ版・古い版の画面の知らせでは譲らない）', () => {
    useSync.setState({ auth: 'signedIn', owner: 'ok', ownerSeen: true, leader: false, status: null })
    const status: SyncStatus = { phase: 'uploading', pending: 1, lastSyncedAt: 1, error: null }
    onTabMessage({ status, model: DATA_MODEL - 1 })
    expect(useSync.getState().status).toEqual(status)
    expect(useSyncView.getState().view).toEqual({ kind: 'sending' })
  })
})

describe('画面の出し入れと日付（docs/SPEC.md の 7.8）', () => {
  it('裏に回るとすぐ送る。20分より長く裏にあった後だけ購読し直す。表に戻ると日付が変わったかを確かめる（端末の中の30日の外）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 15, 3, 0))
    await start((d) => d.setMeta('ownerSeen', 'uid-a'))
    await signInAs('uid-a')
    const e = engine()
    noteAppHidden()
    expect(e.uploads.at(-1)).toBe(true)
    vi.setSystemTime(Date.now() + 10 * 60 * 1000)
    noteAppVisible()
    expect(e.reanchors).toBe(0)
    expect(e.expires).toBe(1)
    noteAppHidden()
    vi.setSystemTime(Date.now() + REANCHOR_AFTER_MS + 1)
    noteAppVisible()
    expect(e.reanchors).toBe(1)
    expect(e.expires).toBe(2)
  })

  it('開いたまま日本時間の 0時を過ぎたら、端末の中の30日の外を消す', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // 日本時間 23:59:30
    vi.setSystemTime(Date.UTC(2026, 10, 15, 14, 59, 30))
    await start((d) => d.setMeta('ownerSeen', 'uid-a'))
    h.onUser!({ uid: 'uid-a', displayName: '', email: 'a@example.com' })
    await settle()
    const e = engine()
    expect(e.expires).toBe(0)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(e.expires).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(e.expires).toBe(1)
  })

  it('1日1回の30日の手入れ: 同期済みになってから操作の無い 30秒の後。操作があると待ち直す。その日に済んだら頼まない', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await start((d) => d.setMeta('ownerSeen', 'uid-a'))
    h.onUser!({ uid: 'uid-a', displayName: '', email: 'a@example.com' })
    await settle()
    const e = engine()
    e.emit({ phase: 'downloading' })
    await vi.advanceTimersByTimeAsync(MAINTAIN_IDLE_MS)
    expect(e.maintains).toBe(0)
    e.emit({ phase: 'synced', downloaded: true })
    await vi.advanceTimersByTimeAsync(MAINTAIN_IDLE_MS - 1000)
    // 操作した（「知ってる」を押して端末に保存した）: そこから 30秒待ち直す。保存したので送るのも頼む
    know({ termId: termIdOf('〇〇法'), term: '〇〇法', asOf: null })
    await flushNow()
    await settle()
    expect(e.uploads.length).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(e.maintains).toBe(0)
    await vi.advanceTimersByTimeAsync(MAINTAIN_IDLE_MS)
    expect(e.maintains).toBe(1)
    // 今日はもう済んだ: 同期済みの知らせが来ても頼まない
    e.emit({ phase: 'uploading' })
    e.emit({ phase: 'synced' })
    await vi.advanceTimersByTimeAsync(MAINTAIN_IDLE_MS * 2)
    expect(e.maintains).toBe(1)
  })

  it('最初の受け取りの前・サーバーの時刻の見積もりが無かった時は、次に同期済みになった時に頼み直す', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    h.maintainResult = { deleted: {}, total: 0, capped: false, skipped: 'no-server-time' }
    await start((d) => d.setMeta('ownerSeen', 'uid-a'))
    h.onUser!({ uid: 'uid-a', displayName: '', email: 'a@example.com' })
    await settle()
    const e = engine()
    e.emit({ phase: 'synced' })
    await vi.advanceTimersByTimeAsync(MAINTAIN_IDLE_MS)
    expect(e.maintains).toBe(1)
    e.emit({ phase: 'uploading' })
    e.emit({ phase: 'synced' })
    await vi.advanceTimersByTimeAsync(MAINTAIN_IDLE_MS)
    expect(e.maintains).toBe(2)
  })
})

describe('ログアウト・いますぐ同期', () => {
  it('ログアウトする時は、送れる物を送ってから。ログアウトしたらエンジンを止める', async () => {
    await start((d) => d.setMeta('ownerSeen', 'uid-a'))
    await signInAs('uid-a')
    await syncNow()
    expect(engine().flushes).toBe(1)
    await signOut()
    expect(h.order).toEqual(['送る', '送る', 'ログアウト'])
    h.onUser!(null)
    await settle()
    expect(engine().stopped).toBe(true)
    expect(useSync.getState()).toMatchObject({ leader: false, status: null })
    expect(useSyncView.getState().view).toBeNull()
  })
})

describe('エンジンの口がストアを通る（docs/SPEC.md の 7.8 の「画面の状態の持ち方」）', () => {
  const today = makeFakeEdition({ date: '2026-11-15', slot: '12', seed: 'ctl-today' })

  it('届いた版はストアの版の一覧に入り、期限で消した版は一覧から外れる', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 15, 3, 0))
    await start((d) => d.setMeta('ownerSeen', 'uid-a'))
    await signInAs('uid-a')
    const target = engine().opts.target
    const changes = [...today.topics, today.edition].map((r) => ({
      table: (r === today.edition ? 'editions' : 'topics') as 'editions' | 'topics',
      id: r.id,
      record: r as unknown as AnyRecord,
    }))
    await target.applyRemote(changes)
    expect(useApp.getState().editions.map((e) => e.id)).toEqual([today.edition.id])
    await target.expireBefore('2026-11-16')
    expect(useApp.getState().editions).toEqual([])
  })

  it('最初の受け取りが終わったら、話題の欠けた版の欠けた話題をエンジンで直接読む', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 15, 3, 0))
    await start(async (d) => {
      await d.setMeta('ownerSeen', 'uid-a')
      await d.applyRemote([
        ...today.topics.slice(0, 19).map((t) => ({ table: 'topics' as const, id: t.id, record: t as unknown as AnyRecord })),
        { table: 'editions', id: today.edition.id, record: today.edition as unknown as AnyRecord },
      ])
    })
    await signInAs('uid-a')
    const e = engine()
    e.emit({ phase: 'downloading' })
    await settle()
    expect(e.fetched).toEqual([])
    e.emit({ phase: 'synced', downloaded: true })
    await vi.waitFor(() => expect(useApp.getState().opened.view?.kind).toBe('ready'))
    expect(e.fetched).toEqual([[today.edition.order[19]]])
  })
})
