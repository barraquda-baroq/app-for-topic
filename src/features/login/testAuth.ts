// テストの時だけ効く「ログインした状態」の印（E2E で空のトップ画面・設定を開くため。DS の物をそのまま写した。docs/SPEC.md の 14.7）。
// 開発サーバー（import.meta.env.DEV）の時だけ、localStorage の topic-studio:test-auth があれば、Firebase を使わずに
// ログインした状態にする。公開するビルドでは import.meta.env.DEV が false になり、この処理はビルドから消える（印を置いても効かない）。
// 使い方（Playwright）: page.addInitScript(() => localStorage.setItem('topic-studio:test-auth', '1')) の後にページを開く
// 段階1で、作り物の版を端末（Dexie）に入れる道を足した（Firebase 無しで、版のある画面を確かめる。段階2の画面の見本にも使う。
// docs/SPEC.md の 16.3 の「開発サーバー」）: topic-studio:test-editions も置くと、ログインした状態にした後に作り物の版を入れる
// （値は '1' か、makeFakeMonth の作り方の JSON。例 '{"days":3,"seed":"fake-month"}'）。window.__ts.fakeSignIn({ editions: true }) も同じ。
// 作り物の版（src/test/fixtures/fakeEditions.ts）は使う時にだけ読み込むので、公開するビルドには入らない
import type { AnyRecord, Change } from '../../db/persistence'
import { latestSlotAt } from '../../domain/jst'
import type { Slot } from '../../domain/types'
import { applyRemoteChanges, openEdition, setTopicOutlets, useApp } from '../../store/appStore'
import { fakeSignInForTest, initSync, useSync } from '../../sync/controller'
import type { FakeMonthScenes } from '../../test/fixtures/fakeEditions'

export const TEST_AUTH_KEY = 'topic-studio:test-auth'
/** 作り物の版を入れる印（TEST_AUTH_KEY と一緒に置いた時だけ効く） */
export const TEST_EDITIONS_KEY = 'topic-studio:test-editions'

/** 開発サーバーで、テスト用のログインの印が置いてあるか */
export function testAuthRequested(): boolean {
  if (!import.meta.env.DEV) return false
  try {
    return localStorage.getItem(TEST_AUTH_KEY) !== null
  } catch {
    return false
  }
}

/**
 * 作り物の版の作り方（src/test/fixtures/fakeEditions.ts の makeFakeMonth。省いた所は既定）。
 * 既定は3日分（作り物の場面がそろう最も短い日数）・種 fake-month・いちばん新しい版は今の時刻のいちばん新しい枠
 */
export interface TestEditionsOptions {
  days?: number
  seed?: string
  /** いちばん新しい版の日付（'YYYY-MM-DD'。日本時間） */
  until?: string
  /** until の日の最後の枠（until だけ渡した時は '20'） */
  untilSlot?: Slot
}

/** 作り物の版を入れた結果（入れた数・いちばん新しい版・場面の id） */
export interface TestEditionsResult {
  editions: number
  topics: number
  editionFails: number
  corrections: number
  newestEditionId: string
  scenes: FakeMonthScenes
}

/** 開発サーバーで、作り物の版を入れる印が置いてあれば、その作り方（読めない JSON は既定の作り方） */
export function testEditionsRequested(): TestEditionsOptions | null {
  if (!import.meta.env.DEV) return null
  let value: string | null
  try {
    value = localStorage.getItem(TEST_EDITIONS_KEY)
  } catch {
    return null
  }
  if (value === null) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as TestEditionsOptions) : {}
  } catch {
    return {}
  }
}

/** 端末の中の保存先を読み終えるまで待つ（読めなかったら投げる） */
function whenStoreReady(): Promise<void> {
  const settled = () => {
    const s = useApp.getState()
    return s.status === 'ready' ? 'ready' : s.status === 'error' ? (s.loadError ?? '端末の中の保存先を開けませんでした') : null
  }
  return new Promise((resolve, reject) => {
    const check = () => {
      const r = settled()
      if (r === null) return false
      if (r === 'ready') resolve()
      else reject(new Error(r))
      return true
    }
    if (check()) return
    const off = useApp.subscribe(() => {
      if (check()) off()
    })
  })
}

/**
 * 作り物の版を端末（Dexie）に入れる（開発サーバーだけ）。同期のエンジンが受け取った時と同じ道（ストアの applyRemoteChanges →
 * src/db/persistence.ts の applyRemote）で入れるので、送信待ちには積まず、メモリの版の一覧にも当たる。辞書の束はアプリが受け取らない
 * ので入れない（7.3）。出典のリンクは作り物の社の一覧で決める（src/test/fixtures/fakeOutlets.ts）。入れ終えたら、トップ（いちばん新しい
 * 出せる版）を開き直して終わる
 */
export async function putFakeEditions(opts: TestEditionsOptions = {}): Promise<TestEditionsResult> {
  if (!import.meta.env.DEV) throw new Error('開発サーバーだけで使えます')
  const [{ fakeRecordsOf, makeFakeMonth }, { FAKE_OUTLETS }] = await Promise.all([
    import('../../test/fixtures/fakeEditions'),
    import('../../test/fixtures/fakeOutlets'),
  ])
  await whenStoreReady()
  const latest = latestSlotAt(Date.now())
  const month = makeFakeMonth({
    until: opts.until ?? latest.date,
    untilSlot: opts.untilSlot ?? (opts.until ? '20' : latest.slot),
    days: opts.days ?? 3,
    seed: opts.seed,
  })
  setTopicOutlets(FAKE_OUTLETS)
  const changes: Change[] = fakeRecordsOf(month)
    .filter((r) => r.table !== 'termPacks')
    .map((r) => ({ table: r.table, id: r.record.id, record: r.record as unknown as AnyRecord }))
  await applyRemoteChanges(changes)
  await openEdition(null)
  return {
    editions: month.editions.length,
    topics: month.editions.reduce((n, e) => n + e.topics.length, 0),
    editionFails: month.editionFails.length,
    corrections: month.corrections.length,
    newestEditionId: month.editions[month.editions.length - 1].edition.id,
    scenes: month.scenes,
  }
}

/**
 * Firebase を使わずにログインした状態にし（src/sync/controller.ts の fakeSignInForTest。同期は始めない）、editions を渡した時は
 * 作り物の版も端末に入れる（入れ終えるまで待つ）。window.__ts.fakeSignIn と、印のある時の startTestAuth が使う
 */
export async function fakeSignInWithEditions(editions?: TestEditionsOptions | null): Promise<TestEditionsResult | null> {
  if (!import.meta.env.DEV) throw new Error('開発サーバーだけで使えます')
  fakeSignInForTest()
  return editions ? putFakeEditions(editions) : null
}

let started: Promise<void> | null = null

/**
 * 印があれば、ログインの状態を確かめ終えた所で（起動時の確かめに上書きされないように）、ログインした状態にする。
 * 作り物の版の印もあれば、その後に作り物の版を入れる。1回だけ動く（ログアウトしたら、読み込み直すまでログインの画面のまま）
 */
export function startTestAuth(): Promise<void> | null {
  if (!import.meta.env.DEV || !testAuthRequested()) return null
  started ??= initSync().then(async () => {
    if (useSync.getState().auth === 'signedIn') return
    await fakeSignInWithEditions(testEditionsRequested()).catch((e: unknown) =>
      console.warn('作り物の版を端末に入れられませんでした', e),
    )
  })
  return started
}

/** テスト用 */
export function resetTestAuthForTests(): void {
  started = null
}
