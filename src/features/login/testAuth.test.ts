// テストの時だけ効く「ログインした状態」の印（localStorage の topic-studio:test-auth。DS の docs/SPEC.md の 2.10）と、段階1で足した
// 作り物の版を端末（Dexie）に入れる道（topic-studio:test-editions・putFakeEditions。docs/SPEC.md の 16.3 の「開発サーバー」）。
// 公開するビルド（import.meta.env.DEV が false）で効かないことは、処理の頭の import.meta.env.DEV の確かめで決まる。
// 作り物の版を入れる所は、本物のストアと保存先（fake-indexeddb）で確かめる（司令塔だけを差し替える）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence, type Persistence } from '../../db/persistence'
import { initStore, resetStoreForTests, useApp } from '../../store/appStore'

const mocks = vi.hoisted(() => ({
  initSync: vi.fn(async () => {}),
  fakeSignInForTest: vi.fn(),
  auth: 'signedOut' as string,
}))

vi.mock('../../sync/controller', () => ({
  initSync: mocks.initSync,
  fakeSignInForTest: mocks.fakeSignInForTest,
  useSync: { getState: () => ({ auth: mocks.auth }) },
}))

const {
  fakeSignInWithEditions,
  putFakeEditions,
  resetTestAuthForTests,
  startTestAuth,
  TEST_AUTH_KEY,
  TEST_EDITIONS_KEY,
  testAuthRequested,
  testEditionsRequested,
} = await import('./testAuth')

/** 2026-11-15 13:00（日本時間） */
const NOW = Date.UTC(2026, 10, 15, 4, 0)
let stores: Persistence[] = []

beforeEach(() => {
  localStorage.clear()
  resetTestAuthForTests()
  mocks.initSync.mockClear()
  mocks.fakeSignInForTest.mockClear()
  mocks.auth = 'signedOut'
  // 時計だけを止める（端末の中の保存 fake-indexeddb は setImmediate・setTimeout で進むので、本物のまま）
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  localStorage.clear()
  resetStoreForTests()
  for (const p of stores) p.close()
  stores = []
  vi.useRealTimers()
})

async function openStore(): Promise<Persistence> {
  const p = createPersistence(`test-auth-${Math.random().toString(36).slice(2)}`)
  stores.push(p)
  await initStore(p)
  return p
}

describe('testAuth', () => {
  it('印の名前は topic-studio:test-auth', () => {
    expect(TEST_AUTH_KEY).toBe('topic-studio:test-auth')
  })

  it('印が無ければ何もしない（ログインの状態はふだんどおり Firebase で確かめる）', () => {
    expect(testAuthRequested()).toBe(false)
    expect(startTestAuth()).toBeNull()
    expect(mocks.initSync).not.toHaveBeenCalled()
    expect(mocks.fakeSignInForTest).not.toHaveBeenCalled()
  })

  it('印があれば、起動時のログインの確かめを終えてから、ログインした状態にする（1回だけ）', async () => {
    localStorage.setItem(TEST_AUTH_KEY, '1')
    expect(testAuthRequested()).toBe(true)
    const first = startTestAuth()
    expect(startTestAuth()).toBe(first)
    await first
    expect(mocks.initSync).toHaveBeenCalledTimes(1)
    expect(mocks.fakeSignInForTest).toHaveBeenCalledTimes(1)
  })

  it('もうログインしていれば（エミュレーターなど）、そのまま', async () => {
    localStorage.setItem(TEST_AUTH_KEY, '1')
    mocks.auth = 'signedIn'
    await startTestAuth()
    expect(mocks.fakeSignInForTest).not.toHaveBeenCalled()
  })
})

describe('作り物の版を端末に入れる（docs/SPEC.md の 16.3 の「開発サーバー」）', () => {
  it('印の名前は topic-studio:test-editions。値は 1 か作り方の JSON（読めない値は既定の作り方）', () => {
    expect(TEST_EDITIONS_KEY).toBe('topic-studio:test-editions')
    expect(testEditionsRequested()).toBeNull()
    localStorage.setItem(TEST_EDITIONS_KEY, '1')
    expect(testEditionsRequested()).toEqual({})
    localStorage.setItem(TEST_EDITIONS_KEY, '{"days":5,"seed":"s"}')
    expect(testEditionsRequested()).toEqual({ days: 5, seed: 's' })
    localStorage.setItem(TEST_EDITIONS_KEY, '{broken')
    expect(testEditionsRequested()).toEqual({})
    localStorage.setItem(TEST_EDITIONS_KEY, '[3]')
    expect(testEditionsRequested()).toEqual({})
  })

  it('受け取った物として入れる: 版・話題・訂正・作れなかった印は端末に入り、辞書の束は入れず、送信待ちに積まない', async () => {
    const p = await openStore()
    const r = await putFakeEditions()
    // 既定は3日分で、いちばん新しい版は今（13:00）のいちばん新しい枠（12:00版。その日の 20:00版は作らない）。作れなかった枠が1つ
    expect(r).toMatchObject({
      editions: 3 * 2 - 1 - 1,
      topics: 80,
      editionFails: 1,
      corrections: 4,
      newestEditionId: '2026-11-15-12',
    })
    expect(r.scenes.chain).toHaveLength(3)
    expect((await p.listEditions()).map((e) => e.id)).toHaveLength(4)
    expect(await p.listEditionFails()).toHaveLength(1)
    expect(await p.listCorrections()).toHaveLength(4)
    expect(await p.outboxCount()).toBe(0)
    // メモリの版の一覧にも当たり、トップはいちばん新しい版を出す
    const s = useApp.getState()
    expect(s.editions.map((e) => e.id).at(-1)).toBe('2026-11-15-12')
    expect(s.opened.follow).toBe(true)
    expect(s.opened.view?.kind).toBe('ready')
    if (s.opened.view?.kind !== 'ready') return
    expect(s.opened.view.editionId).toBe('2026-11-15-12')
    expect(s.opened.view.topics).toHaveLength(20)
    // 出典のリンクは作り物の社の一覧（example.com）で決める
    expect(s.opened.view.topics.flatMap((t) => t.sources).some((src) => src.link?.startsWith('https://example.com/'))).toBe(true)
  })

  it('作り方（日数・種・日付・枠）を渡せる。同じ作り方なら同じ物（入れ直しても増えない）', async () => {
    const p = await openStore()
    const a = await putFakeEditions({ days: 4, seed: 'screen', until: '2026-11-14' })
    expect(a).toMatchObject({ editions: 4 * 2 - 1, newestEditionId: '2026-11-14-20' })
    const b = await putFakeEditions({ days: 4, seed: 'screen', until: '2026-11-14' })
    expect(b.scenes).toEqual(a.scenes)
    expect(await p.listEditions()).toHaveLength(7)
    expect(await p.outboxCount()).toBe(0)
  })

  it('両方の印があれば、ログインした状態にしてから作り物の版を入れる', async () => {
    await openStore()
    localStorage.setItem(TEST_AUTH_KEY, '1')
    localStorage.setItem(TEST_EDITIONS_KEY, '{"days":3}')
    await startTestAuth()
    expect(mocks.fakeSignInForTest).toHaveBeenCalledTimes(1)
    expect(useApp.getState().editions).toHaveLength(4)
  })

  it('作り物の版の印だけでは何もしない（ログインの印と一緒の時だけ）', async () => {
    await openStore()
    localStorage.setItem(TEST_EDITIONS_KEY, '1')
    expect(startTestAuth()).toBeNull()
    expect(useApp.getState().editions).toHaveLength(0)
  })

  it('fakeSignInWithEditions: 版を渡さなければログインした状態にするだけ', async () => {
    await openStore()
    expect(await fakeSignInWithEditions()).toBeNull()
    expect(mocks.fakeSignInForTest).toHaveBeenCalledTimes(1)
    expect(useApp.getState().editions).toHaveLength(0)
    expect((await fakeSignInWithEditions({ days: 3 }))?.editions).toBe(4)
  })
})
