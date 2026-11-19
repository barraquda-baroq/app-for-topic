// 持ち主の関所（docs/SPEC.md の 14.4。形1）: 確かめる前にトップの画面を一瞬も出さない・確かめたアカウントは次からすぐ出す・
// ほかのアカウントの記録になったら戻す・作者が記録を作ってからアプリに戻ると読み込み直さずに進む・通信できない時は確かめ直す・
// 確かめの途中でアカウントが替わったら、前のアカウントの答えは捨てる。
// Firebase・Firestore・持ち主の記録は仮の物（checkOwner の答えをテストが決める。止めておいて後で答えることもできる）、
// 端末の中の保存（fake-indexeddb）は本物。
// この端末で確かめたアカウントの照らし合わせは、段階1から同期のエンジンの claimOwner がする（docs/SPEC.md の 7.8 の controller.ts）。
// エンジンは仮の物で、本物の claimOwner と同じに確かめて知らせる（同じ checkOwner の答えを使う。読んだ回数は司令塔と別に数える）。
// DS の src/sync/controllerAccount.test.ts と同じ作り
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineOptions, SyncEngine, SyncStatus } from './engine'

type OwnerState = 'ok' | 'missing' | 'mismatch'
type OwnerAnswer = OwnerState | 'offline'

const h = vi.hoisted(() => {
  const h = {
    onUser: null as null | ((u: unknown) => void),
    answer: 'ok' as OwnerAnswer,
    /** 司令塔が持ち主の記録を読んだ回数 */
    checks: 0,
    /** 同期のエンジンが持ち主の記録を読んだ回数（claimOwner） */
    engineChecks: 0,
    usingEmulator: false,
    /** true の間は、checkOwner の答えを止めておく（held の resolve でテストが後から答える） */
    hold: false,
    held: [] as { uid: string; by: 'controller' | 'engine'; resolve: (a: OwnerState) => void }[],
    async check(uid: string, by: 'controller' | 'engine'): Promise<OwnerState> {
      if (by === 'controller') h.checks += 1
      else h.engineChecks += 1
      if (h.hold) return new Promise<OwnerState>((resolve) => h.held.push({ uid, by, resolve }))
      if (h.answer === 'offline') throw new Error('offline')
      return h.answer
    },
  }
  return h
})

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
  signOutUser: async () => {},
  signInWithGoogle: async () => {},
  signInForTest: async () => {},
}))
vi.mock('./firestore', () => ({ firestore: () => ({}) }))
vi.mock('./owner', () => ({
  checkOwner: (_fs: unknown, uid: string) => h.check(uid, 'controller'),
}))
vi.mock('./appModel', () => ({ DATA_MODEL: 2, APP_VERSION: '0.1', watchAppModel: () => () => {} }))
// 同期のエンジン: 始めると本物の claimOwner（src/sync/engine.ts）と同じに持ち主を確かめ、記録が無い・ほかのアカウントなら止まって知らせる
// （ほかのアカウントなら、この端末の持ち主の印を消す）。止めた後に届いた答えは知らせない
vi.mock('./engine', () => ({
  createSyncEngine: (opts: EngineOptions): SyncEngine => {
    let status: SyncStatus = { phase: 'starting', pending: 0, lastSyncedAt: null, error: null }
    let stopped = false
    const set = (patch: Partial<SyncStatus>) => {
      if (stopped) return
      status = { ...status, ...patch }
      opts.onStatus?.(status)
    }
    return {
      get status() {
        return status
      },
      start: async () => {
        if (opts.ownerLock === false) return set({ phase: 'synced', downloaded: true })
        let state: OwnerState
        try {
          state = await h.check(opts.uid, 'engine')
        } catch {
          return set({ phase: 'offline', error: 'オフライン', errorCode: 'offline' })
        }
        if (state === 'mismatch') {
          if ((await opts.target.getMeta<string>('ownerSeen')) === opts.uid) await opts.target.setMeta('ownerSeen', null)
          return set({ phase: 'error', error: 'ほかのアカウント', errorCode: 'owner-mismatch' })
        }
        if (state === 'missing') return set({ phase: 'error', error: '記録が無い', errorCode: 'owner-missing' })
        await opts.target.setMeta('ownerSeen', opts.uid)
        set({ phase: 'synced', downloaded: true })
      },
      stop: () => {
        stopped = true
      },
      requestUpload: () => {},
      flush: async () => {},
      reanchor: () => {},
      idle: async () => {},
      maintain: async () => ({ deleted: {}, total: 0, capped: false, skipped: null }),
      expireLocal: async () => null,
      fetchTopics: async (ids: readonly string[]) => ({ found: [], missing: [...ids] }),
      serverNow: () => null,
    }
  },
}))

import { createPersistence, type Persistence } from '../db/persistence'
import { initStore, resetStoreForTests } from '../store/appStore'
import { canShowData, initSync, noteAppVisible, resetSyncForTests, useSync } from './controller'

let p: Persistence | null = null

afterEach(() => {
  resetSyncForTests()
  resetStoreForTests()
  p?.close()
  p = null
  h.answer = 'ok'
  h.checks = 0
  h.engineChecks = 0
  h.usingEmulator = false
  h.hold = false
  h.held = []
  vi.useRealTimers()
})

const settle = () => new Promise((r) => setTimeout(r, 50))
/** Node の setImmediate（偽の時計にしない。画面の型には無いので、ここで型を付ける） */
const nextTurn = (globalThis as unknown as { setImmediate: (fn: () => void) => void }).setImmediate
/** 偽の時計（setTimeout だけ）の間に、端末の中の保存（fake-indexeddb は setImmediate で進む）と後から読む部品を待つ */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => nextTurn(r))
}

async function start(): Promise<Persistence> {
  p = createPersistence(`owner-${Math.random().toString(36).slice(2)}`)
  await initStore(p)
  await initSync()
  return p
}

/** ログインした時の、トップの画面を出してよいかの移り変わり */
async function signInAs(uid: string): Promise<boolean[]> {
  const seen: boolean[] = []
  const off = useSync.subscribe((s) => seen.push(canShowData(s)))
  h.onUser!({ uid, displayName: '', email: `${uid}@example.com` })
  await settle()
  off()
  return seen
}

describe('持ち主の関所', () => {
  it('初めてのアカウントは、ネットで持ち主だと分かるまでトップの画面を出さない。分かったらこの端末に覚える', async () => {
    const db = await start()
    h.answer = 'ok'
    const seen = await signInAs('uid-a')
    expect(seen[0]).toBe(false)
    expect(seen.at(-1)).toBe(true)
    // 確かめる前の状態は「確かめています…」
    expect(seen.indexOf(true)).toBeGreaterThan(0)
    expect(h.checks).toBe(1)
    expect(await db.getMeta('ownerSeen')).toBe('uid-a')
  })

  it('この端末で確かめたアカウントは、ログインした最初の状態からトップの画面を出す（電波が無くても）', async () => {
    const db = await start()
    await db.setMeta('ownerSeen', 'uid-a')
    h.answer = 'offline'
    const seen = await signInAs('uid-a')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(Boolean)).toBe(true)
    expect(useSync.getState()).toMatchObject({ owner: 'ok', ownerSeen: true })
  })

  it('確かめたアカウントでも、クラウドの記録がほかのアカウントになっていたら、印を消してログインの画面に戻す', async () => {
    const db = await start()
    await db.setMeta('ownerSeen', 'uid-a')
    h.answer = 'mismatch'
    const seen = await signInAs('uid-a')
    expect(seen[0]).toBe(true)
    expect(seen.at(-1)).toBe(false)
    expect(useSync.getState()).toMatchObject({ owner: 'mismatch', ownerSeen: false })
    expect(await db.getMeta('ownerSeen')).toBeNull()
    // 照らし合わせは同期のエンジンだけがする（司令塔とエンジンで2回読まない。docs/SPEC.md の 7.8 の controller.ts）
    expect([h.checks, h.engineChecks]).toEqual([0, 1])
  })

  it('確かめたアカウントで記録が消えていた時はトップの画面のまま。記録が戻って表に戻ると ok', async () => {
    const db = await start()
    await db.setMeta('ownerSeen', 'uid-a')
    h.answer = 'missing'
    const seen = await signInAs('uid-a')
    expect(seen.every(Boolean)).toBe(true)
    expect(useSync.getState()).toMatchObject({ owner: 'missing', ownerSeen: true })
    h.answer = 'ok'
    noteAppVisible()
    await settle()
    expect(useSync.getState()).toMatchObject({ owner: 'ok', ownerSeen: true })
    // 表に戻ると同期を始め直し、エンジンがもう一度確かめる（司令塔は読まない）
    expect([h.checks, h.engineChecks]).toEqual([0, 2])
  })

  it('記録が無い間はログインの画面のまま。作者が記録を作ってから窓を選ぶと、読み込み直さずにトップの画面を出す', async () => {
    const db = await start()
    h.answer = 'missing'
    const seen = await signInAs('uid-a')
    expect(seen).not.toContain(true)
    expect(useSync.getState()).toMatchObject({ owner: 'missing', ownerSeen: false })
    // 表に戻っても、記録がまだ無ければそのまま
    noteAppVisible()
    await settle()
    expect(useSync.getState().owner).toBe('missing')
    h.answer = 'ok'
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(canShowData(useSync.getState())).toBe(true)
    expect(await db.getMeta('ownerSeen')).toBe('uid-a')
  })

  it('ほかのアカウントは、確かめ直してもトップの画面を出さない', async () => {
    const db = await start()
    h.answer = 'mismatch'
    const seen = await signInAs('uid-b')
    expect(seen).not.toContain(true)
    noteAppVisible()
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(useSync.getState()).toMatchObject({ owner: 'mismatch', ownerSeen: false })
    expect(await db.getMeta('ownerSeen')).toBeUndefined()
  })

  it('通信できない時は「確かめています…」のまま、つながったら確かめ直す', async () => {
    await start()
    h.answer = 'offline'
    const seen = await signInAs('uid-a')
    expect(seen).not.toContain(true)
    expect(useSync.getState().owner).toBe('checking')
    h.answer = 'ok'
    window.dispatchEvent(new Event('online'))
    await settle()
    expect(canShowData(useSync.getState())).toBe(true)
  })

  it('通信できない時は、つながった知らせが無くても 15秒ごとに確かめ直す', async () => {
    // 偽の時計は setTimeout だけ（端末の中の保存は setImmediate で進むので、本物のまま）
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await start()
    h.answer = 'offline'
    h.onUser!({ uid: 'uid-a', displayName: '', email: 'uid-a@example.com' })
    await flush()
    expect(useSync.getState().owner).toBe('checking')
    expect(h.checks).toBe(1)
    // 15秒たつまでは確かめ直さない
    await vi.advanceTimersByTimeAsync(14_999)
    await flush()
    expect(h.checks).toBe(1)
    // 15秒後: まだ通信できない →「確かめています…」のまま、また 15秒後に
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(h.checks).toBe(2)
    expect(useSync.getState().owner).toBe('checking')
    // 次の 15秒後: つながっていれば進む（'online' の知らせは無い）
    h.answer = 'ok'
    await vi.advanceTimersByTimeAsync(15_000)
    await flush()
    expect(h.checks).toBe(3)
    expect(canShowData(useSync.getState())).toBe(true)
  })

  it('ログアウトしても印は消さない。同じアカウントで入り直すと、ログインした最初の状態からトップ（電波が無くても）', async () => {
    const db = await start()
    h.answer = 'ok'
    await signInAs('uid-a')
    expect(await db.getMeta('ownerSeen')).toBe('uid-a')
    h.onUser!(null)
    await settle()
    expect(useSync.getState()).toMatchObject({ auth: 'signedOut', owner: 'unknown', ownerSeen: false })
    expect(await db.getMeta('ownerSeen')).toBe('uid-a')
    h.answer = 'offline'
    const again = await signInAs('uid-a')
    expect(again.length).toBeGreaterThan(0)
    expect(again.every(Boolean)).toBe(true)
    expect(useSync.getState()).toMatchObject({ auth: 'signedIn', owner: 'ok', ownerSeen: true })
    // ほかのアカウントでログインし直しても、前のアカウントの印では出さない
    h.onUser!(null)
    await settle()
    h.answer = 'mismatch'
    const other = await signInAs('uid-b')
    expect(other).not.toContain(true)
    expect(await db.getMeta('ownerSeen')).toBe('uid-a')
  })

  it('確かめの途中でログアウトしたら、その答えは捨てる（後から ok が届いても印を覚えない）', async () => {
    const db = await start()
    h.hold = true
    await signInAs('uid-a')
    expect(useSync.getState()).toMatchObject({ owner: 'checking', ownerSeen: false })
    expect(h.held.map((c) => c.uid)).toEqual(['uid-a'])
    h.onUser!(null)
    await settle()
    h.held[0].resolve('ok')
    await settle()
    expect(useSync.getState()).toMatchObject({ auth: 'signedOut', owner: 'unknown', ownerSeen: false })
    expect(await db.getMeta('ownerSeen')).toBeUndefined()
  })

  it('確かめの途中でほかのアカウントに替わったら、前のアカウントの ok では替わったアカウントにトップを出さない', async () => {
    const db = await start()
    h.hold = true
    await signInAs('uid-a')
    h.onUser!(null)
    await settle()
    const seen: boolean[] = []
    const off = useSync.subscribe((s) => seen.push(canShowData(s)))
    h.onUser!({ uid: 'uid-b', displayName: '', email: 'uid-b@example.com' })
    await settle()
    expect(h.held.map((c) => c.uid)).toEqual(['uid-a', 'uid-b'])
    // 前のアカウント（uid-a）の答えが遅れて届く
    h.held[0].resolve('ok')
    await settle()
    expect(seen).not.toContain(true)
    expect(useSync.getState()).toMatchObject({ user: { uid: 'uid-b' }, owner: 'checking', ownerSeen: false })
    expect(await db.getMeta('ownerSeen')).toBeUndefined()
    // uid-b の答えで決まる
    h.held[1].resolve('mismatch')
    await settle()
    off()
    expect(seen).not.toContain(true)
    expect(useSync.getState()).toMatchObject({ user: { uid: 'uid-b' }, owner: 'mismatch', ownerSeen: false })
    expect(await db.getMeta('ownerSeen')).toBeUndefined()
  })

  it('確かめた端末の裏の確かめの途中でほかのアカウントに替わったら、前のアカウントの答えは替わったアカウントに使わない', async () => {
    const db = await start()
    await db.setMeta('ownerSeen', 'uid-a')
    h.hold = true
    const first = await signInAs('uid-a')
    expect(first.every(Boolean)).toBe(true)
    expect(h.held.map((c) => c.uid)).toEqual(['uid-a'])
    h.onUser!(null)
    await settle()
    h.onUser!({ uid: 'uid-b', displayName: '', email: 'uid-b@example.com' })
    await settle()
    expect(useSync.getState()).toMatchObject({ user: { uid: 'uid-b' }, owner: 'checking', ownerSeen: false })
    // uid-a の裏の確かめの答え（記録が無い）が遅れて届いても、uid-b の画面は「確かめています…」のまま
    h.held[0].resolve('missing')
    await settle()
    expect(useSync.getState()).toMatchObject({ user: { uid: 'uid-b' }, owner: 'checking', ownerSeen: false })
    expect(await db.getMeta('ownerSeen')).toBe('uid-a')
    h.held[1].resolve('mismatch')
    await settle()
    expect(useSync.getState()).toMatchObject({ user: { uid: 'uid-b' }, owner: 'mismatch', ownerSeen: false })
    // uid-a の印はそのまま（uid-a で入り直せばすぐトップ）
    expect(await db.getMeta('ownerSeen')).toBe('uid-a')
  })

  it('エミュレーターにつないだ開発サーバーは確かめない（印も覚えない）', async () => {
    h.usingEmulator = true
    const db = await start()
    h.answer = 'missing'
    const seen = await signInAs('uid-a')
    expect(seen.every(Boolean)).toBe(true)
    expect(h.checks).toBe(0)
    expect(await db.getMeta('ownerSeen')).toBeUndefined()
  })
})
