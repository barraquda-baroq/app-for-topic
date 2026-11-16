// 端末の中のデータの入れ物（docs/SPEC.md の 7.8 の「端末の表」・「画面の状態の持ち方」・7.4・16.2 の 7）: 起動の時にアプリの記録と版の
// 一覧だけを読む・既読と「知ってる」を付ける関数（重なり無し・30件まで・その版の話題だけ・30日の外の版・新しい形の記録・上限を超える
// 記録は書かない・知らない欄を残す）・端末への書き込みと送信待ちが一緒・3層（保存の前も画面に出す・保存中の変更を重ねる・届いた変更と
// 3者マージ）・期限で消した物をメモリからも外す・版を開く（話題は版ごとに読む・そろうまで前の版・欠けた話題を直接読む・訂正を話題に付ける・
// 出典の社の一覧の差し替え）・別のタブの書き込みを読み直す・保存できない時。保存先（Dexie。fake-indexeddb）は本物。
// 段階2の読む口（設計: 段階2の 1.8・1.9・1.16）: loadTopicView・threadOf・catchUpTargets・loadCatchUp・editionRows
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence, type AnyRecord, type Change, type Persistence } from '../db/persistence'
import { correctionIdOf, termIdOf } from '../domain/ids'
import { pressKnownTerm } from '../domain/known'
import type { CorrectionRecord, EditionFail, KnownTerm, ReadMark } from '../domain/types'
import { FAKE_OUTLETS } from '../test/fixtures/fakeOutlets'
import {
  CHAIN_CORRECTION_TEXT,
  fakeRecordsOf,
  makeFakeEdition,
  makeFakeMonth,
  type FakeEdition,
  type FakeMonth,
} from '../test/fixtures/fakeEditions'
import {
  applyRemoteChanges,
  catchUpTargets,
  editionRows,
  expireLocalRecords,
  flushNow,
  getRawUserRecords,
  initStore,
  isKnown,
  know,
  loadCatchUp,
  loadEditionView,
  loadTopicView,
  markRead,
  markSeen,
  noteSyncDownloaded,
  onExternalSave,
  openEdition,
  reloadFromDisk,
  resetStoreForTests,
  setTopicFetcher,
  setTopicOutlets,
  threadOf,
  threadsOf,
  unknow,
  useApp,
  type EditionRow,
  type EditionView,
} from './appStore'

/** 2026-11-15 12:00（日本時間） */
const T0 = Date.UTC(2026, 10, 15, 3, 0)
const TODAY = makeFakeEdition({ date: '2026-11-15', slot: '12', seed: 'store-today' })
const YESTERDAY = makeFakeEdition({ date: '2026-11-14', slot: '20', seed: 'store-yesterday' })

let stores: Persistence[] = []

beforeEach(() => {
  // 時計だけを止める（端末の中の保存 fake-indexeddb は setImmediate・setTimeout で進むので、本物のまま）
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  resetStoreForTests()
  for (const p of stores) p.close()
  stores = []
  vi.useRealTimers()
})

function newDb(name = `store-${Math.random().toString(36).slice(2)}`): Persistence {
  const p = createPersistence(name)
  stores.push(p)
  return p
}

const asChange = (table: Change['table'], record: unknown): Change => ({
  table,
  id: (record as { id: string }).id,
  record: record as AnyRecord,
})

/** 版をクラウドから受け取った物として端末に入れる（辞書の束は端末に入らない） */
async function receive(p: Persistence, ...eds: FakeEdition[]): Promise<void> {
  await p.applyRemote(eds.flatMap((e) => fakeRecordsOf(e).map((r) => asChange(r.table, r.record))))
}

async function started(prepare?: (p: Persistence) => Promise<void>): Promise<Persistence> {
  const p = newDb()
  await prepare?.(p)
  await initStore(p)
  await openEdition(null)
  return p
}

function readMark(editionId: string, patch: Partial<ReadMark> & Record<string, unknown> = {}): ReadMark {
  return {
    id: editionId,
    v: 1,
    createdAt: T0 - 1000,
    updatedAt: T0 - 1000,
    by: 'user',
    ai: null,
    editionId,
    topicIds: [],
    seen: false,
    ...patch,
  }
}

const press = (key: string, asOf: string | null = '2026-11') => ({ termId: termIdOf(key), term: key, asOf })

function correction(topicId: string, text: string, createdAt: number): CorrectionRecord {
  return {
    id: correctionIdOf({ topicId, text }),
    v: 1,
    createdAt,
    by: 'connector',
    ai: 'claude',
    model: 'fake-writer-model',
    runId: 'r-fake-correction',
    topicId,
    editionId: topicId.slice(0, 13),
    text,
  }
}

const ready = (v: EditionView | null) => {
  if (v?.kind !== 'ready') throw new Error(`版を出せません: ${v?.kind ?? 'null'}`)
  return v
}

describe('起動（端末の中のアプリの記録と版の一覧だけを読む）', () => {
  it('アプリの記録・版の一覧・作れなかった印を表示用に直して持つ。端末の記録は受け取ったまま（知らない欄・新しい形の版も消さない）', async () => {
    const known = { ...pressKnownTerm(null, press('〇〇法'), T0 - 5000), note: '新しい版のアプリが足した欄' }
    const fail: EditionFail = {
      id: '2026-11-14-12-abcdefgh',
      v: 1,
      createdAt: T0 - 9000,
      by: 'connector',
      ai: 'claude',
      model: 'fake-writer-model',
      runId: 'r-fake',
      editionId: '2026-11-14-12',
      reasonKind: 'quota',
      reason: '使用量の上限に届きました',
    }
    const newer = { ...YESTERDAY.edition, id: '2026-11-13-20', date: '2026-11-13', v: 2 }
    await started(async (p) => {
      await receive(p, TODAY, YESTERDAY)
      await p.applyRemote([asChange('editionFails', fail), asChange('editions', newer), asChange('knownTerms', known)])
    })
    const s = useApp.getState()
    expect(s.status).toBe('ready')
    expect(s.editions.map((e) => e.id)).toEqual([YESTERDAY.edition.id, TODAY.edition.id])
    expect(s.newerEditions).toEqual(['2026-11-13-20'])
    expect(s.editionFails.map((f) => f.reasonKind)).toEqual(['quota'])
    expect(s.user.knownTerms[known.id]).toMatchObject({ term: '〇〇法', on: true, asOf: '2026-11' })
    expect(getRawUserRecords().knownTerms[known.id]).toEqual(known)
  })
})

describe('既読・「知ってる」を付ける（docs/SPEC.md の 7.4）', () => {
  it('話題を読んだ: 重なり無しで足し、端末への書き込みと送信待ちへの積み込みは一緒（保存の前も画面に出す）', async () => {
    const p = await started()
    const [a, b] = TODAY.edition.order
    const r1 = markRead(TODAY.edition.id, a)
    expect(r1).toMatchObject({ ok: true, changed: true })
    // 保存の前: 画面には出ていて、端末と送信待ちにはまだ無い
    expect(useApp.getState()).toMatchObject({ saveStatus: 'pending' })
    expect(useApp.getState().user.reads[TODAY.edition.id].topicIds).toEqual([a])
    expect(await p.outboxCount()).toBe(0)
    expect(await flushNow()).toBe(true)
    expect(useApp.getState().saveStatus).toBe('saved')
    expect((await p.loadUserRecords()).reads[TODAY.edition.id]).toMatchObject({ topicIds: [a], seen: false, by: 'user' })
    expect([...(await p.outboxKeys())]).toEqual([`reads/${TODAY.edition.id}`])
    // 同じ話題をもう一度: 書かない
    expect(markRead(TODAY.edition.id, a)).toMatchObject({ ok: true, changed: false })
    expect(useApp.getState().saveStatus).toBe('saved')
    // 別の話題・版の一覧を見た
    markRead(TODAY.edition.id, b)
    markSeen(TODAY.edition.id)
    await flushNow()
    expect((await p.loadUserRecords()).reads[TODAY.edition.id]).toMatchObject({ topicIds: [a, b], seen: true })
    // 見た版は戻さない（seen を付けない呼び方でも true のまま）
    markRead(TODAY.edition.id, TODAY.edition.order[2])
    expect(useApp.getState().user.reads[TODAY.edition.id].seen).toBe(true)
  })

  it('起動の前は付けない', () => {
    expect(markRead(TODAY.edition.id, null)).toEqual({ ok: false, reason: 'not-ready' })
    expect(know(press('〇〇法'))).toEqual({ ok: false, reason: 'not-ready' })
  })

  it('ほかの版の話題・形の違う版・30日の外の版・新しい形の既読には付けない', async () => {
    const newer = readMark(YESTERDAY.edition.id, { v: 2 as 1 })
    await started((p) =>
      p.save({ knownTerms: {}, reads: {} }, { knownTerms: {}, reads: { [newer.id]: newer } }).then(() => undefined),
    )
    expect(markRead(TODAY.edition.id, YESTERDAY.edition.order[0])).toEqual({ ok: false, reason: 'invalid' })
    expect(markRead('2026-11-15', null)).toEqual({ ok: false, reason: 'invalid' })
    // 2026-10-16 の版は、2026-11-15 には30日の外（11/15 の 0時から 10/16 の版が消える）
    expect(markRead('2026-10-16-20', null, { seen: true })).toEqual({ ok: false, reason: 'expired' })
    expect(markRead('2026-10-17-12', null, { seen: true })).toMatchObject({ ok: true })
    expect(markRead(YESTERDAY.edition.id, YESTERDAY.edition.order[0])).toEqual({ ok: false, reason: 'newer' })
  })

  it('読んだ話題は30件まで（ルールの上限。それより多くは足さない）', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `${TODAY.edition.id}-${String(i).padStart(8, 'a')}`)
    await started(async (p) => {
      await p.save(
        { knownTerms: {}, reads: {} },
        { knownTerms: {}, reads: { [TODAY.edition.id]: readMark(TODAY.edition.id, { topicIds: ids }) } },
      )
    })
    expect(markRead(TODAY.edition.id, `${TODAY.edition.id}-zzzzzzzz`)).toMatchObject({ ok: true, changed: false })
    expect(useApp.getState().user.reads[TODAY.edition.id].topicIds).toHaveLength(30)
  })

  it('「知ってる」を押す・外す: asOf は新しい方のまま（古い話題で押しても戻らない）、外しても記録は消さない、知らない欄は残す', async () => {
    const law = press('〇〇法', '2026-12')
    const p = await started(async (db) => {
      const prev = { ...pressKnownTerm(null, { ...law, asOf: '2026-10' }, T0 - 5000), on: false, note: '知らない欄' }
      await db.save({ knownTerms: {}, reads: {} }, { knownTerms: { [law.termId]: prev }, reads: {} })
    })
    expect(know(law)).toMatchObject({ ok: true, changed: true, record: { on: true, asOf: '2026-12' } })
    // 古い話題（2026-11 の説明）で押しても、2026-12 のまま。中身が同じなので書かない
    expect(know({ ...law, asOf: '2026-11' })).toMatchObject({ ok: true, changed: false })
    const user = useApp.getState().user
    expect(isKnown(user, law.termId, '2026-11')).toBe(true)
    expect(isKnown(user, law.termId, '2027-01')).toBe(false)
    expect(unknow(law.termId)).toMatchObject({ ok: true, changed: true, record: { on: false, asOf: '2026-12' } })
    expect(isKnown(useApp.getState().user, law.termId, null)).toBe(false)
    expect(unknow(law.termId)).toMatchObject({ ok: true, changed: false })
    await flushNow()
    const disk = (await p.loadUserRecords()).knownTerms[law.termId] as KnownTerm & { note?: string }
    expect(disk).toMatchObject({ on: false, asOf: '2026-12', term: '〇〇法', note: '知らない欄' })
    expect([...(await p.outboxKeys())]).toEqual([`knownTerms/${law.termId}`])
  })

  it('「知ってる」も、上限を超える記録・新しい形の記録・無い記録は書かない', async () => {
    const newer = { ...pressKnownTerm(null, press('〇〇市'), T0 - 5000), v: 2 }
    await started(async (db) => {
      await db.save({ knownTerms: {}, reads: {} }, { knownTerms: { [newer.id]: newer as unknown as KnownTerm }, reads: {} })
    })
    const long = 'あ'.repeat(41)
    expect(know({ termId: termIdOf(long), term: long, asOf: null })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(know({ termId: 'x', term: '〇〇', asOf: null })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(know(press('〇〇市'))).toEqual({ ok: false, reason: 'newer' })
    expect(unknow(termIdOf('△△県'))).toEqual({ ok: false, reason: 'missing' })
    expect(useApp.getState().saveStatus).toBe('saved')
  })
})

describe('3層（端末の記録・まだ保存していない変更・表示用の写し）', () => {
  it('保存している間に付けた既読は、保存の後に重ねて、もう一度保存する', async () => {
    const p = await started()
    const [a, b] = TODAY.edition.order
    markRead(TODAY.edition.id, a)
    const saving = flushNow()
    // 保存が端末の中の記録を書いている間に、もう1本読む
    await Promise.resolve()
    await Promise.resolve()
    markRead(TODAY.edition.id, b)
    expect(await saving).toBe(true)
    expect(useApp.getState().user.reads[TODAY.edition.id].topicIds).toEqual([a, b])
    expect(useApp.getState().saveStatus).toBe('pending')
    await flushNow()
    expect(useApp.getState().saveStatus).toBe('saved')
    expect((await p.loadUserRecords()).reads[TODAY.edition.id]).toMatchObject({ topicIds: [a, b] })
  })

  it('クラウドの変更が届いたら、先にこのタブの変更を保存してから3者マージする（既読の seen はどちらかが true・topicIds は足し合わせ）', async () => {
    const p = await started()
    const [a, b] = TODAY.edition.order
    markRead(TODAY.edition.id, a)
    const cloud = readMark(TODAY.edition.id, { topicIds: [b], seen: true, updatedAt: T0 - 10 })
    const written = await applyRemoteChanges([asChange('reads', cloud)])
    expect(written).toHaveLength(1)
    // 並びの順は 3者マージ（src/sync/merge.ts の mergeList）の決まりのまま
    const shown = useApp.getState().user.reads[TODAY.edition.id]
    expect([...shown.topicIds].sort()).toEqual([a, b].sort())
    expect(shown.seen).toBe(true)
    expect(useApp.getState().saveStatus).toBe('saved')
    // 合わせた中身はクラウドと違うので、送信待ちに残る（base はクラウドの内容）。画面と端末は同じ中身
    const [row] = await p.readOutbox(10)
    expect(row).toMatchObject({ table: 'reads', base: cloud, local: { topicIds: shown.topicIds, seen: true } })
  })

  it('クラウドの変更で、表示している版の一覧・作れなかった印も替わる（版の記録が届くと版を出す）', async () => {
    await started()
    expect(useApp.getState().opened).toEqual({ follow: true, view: null, waiting: null })
    await applyRemoteChanges(fakeRecordsOf(TODAY).map((r) => asChange(r.table, r.record)))
    await openEdition(null)
    expect(useApp.getState().editions.map((e) => e.id)).toEqual([TODAY.edition.id])
    expect(ready(useApp.getState().opened.view).topics).toHaveLength(20)
  })
})

describe('期限で消す（docs/SPEC.md の 7.8 の「端末の中で消す」）', () => {
  it('30日の外の版・既読を、端末（送信待ちも）とメモリから一緒に外す', async () => {
    const old = makeFakeEdition({ date: '2026-10-15', slot: '20', seed: 'store-old' })
    const p = await started(async (db) => {
      await receive(db, old, TODAY)
      await db.save({ knownTerms: {}, reads: {} }, { knownTerms: {}, reads: { [old.edition.id]: readMark(old.edition.id) } })
    })
    expect(useApp.getState().user.reads[old.edition.id]).toBeTruthy()
    expect(await p.outboxCount()).toBe(1)
    const out = await expireLocalRecords('2026-10-17')
    expect(out.outbox).toEqual([`reads/${old.edition.id}`])
    expect(useApp.getState().user.reads[old.edition.id]).toBeUndefined()
    expect(useApp.getState().editions.map((e) => e.id)).toEqual([TODAY.edition.id])
    expect(await p.outboxCount()).toBe(0)
    expect(await p.topicsOfEdition(old.edition.id)).toEqual([])
  })
})

describe('版を開く（話題は版ごとに読む。docs/SPEC.md の 7.8 の「版を出す条件」）', () => {
  it('トップはいちばん新しい出せる版。話題は order の順で、訂正はその話題に足された順で付く', async () => {
    const first = TODAY.edition.order[0]
    const c1 = correction(first, '新しい橋の歩道の幅は 2メートルではなく 3メートルでした', T0 - 2000)
    const c2 = correction(first, '開通の日は 15日ではなく 14日でした', T0 - 1000)
    await started(async (p) => {
      await receive(p, YESTERDAY, TODAY)
      await p.applyRemote([asChange('corrections', c2), asChange('corrections', c1)])
    })
    const opened = useApp.getState().opened
    expect(opened.follow).toBe(true)
    const view = ready(opened.view)
    expect(view.editionId).toBe(TODAY.edition.id)
    expect(view.topics.map((t) => t.id)).toEqual(TODAY.edition.order)
    expect(view.corrections[first].map((c) => c.text)).toEqual([c1.text, c2.text])
    expect(view.corrections[TODAY.edition.order[1]]).toEqual([])
    expect(opened.waiting).toBeNull()
  })

  it('いちばん新しい版の話題がそろうまでは前の版を出したまま（待っている版を知らせる）。そろったら替える', async () => {
    const late = TODAY.topics.slice(15)
    await started(async (p) => {
      await receive(p, YESTERDAY)
      await p.applyRemote([...TODAY.topics.slice(0, 15).map((t) => asChange('topics', t)), asChange('editions', TODAY.edition)])
    })
    let opened = useApp.getState().opened
    expect(ready(opened.view).editionId).toBe(YESTERDAY.edition.id)
    expect(opened.waiting).toBe(TODAY.edition.id)
    await applyRemoteChanges(late.map((t) => asChange('topics', t)))
    await openEdition(null)
    opened = useApp.getState().opened
    expect(ready(opened.view).editionId).toBe(TODAY.edition.id)
    expect(opened.waiting).toBeNull()
  })

  it('最初の受け取りが終わっても欠けている話題は、直接読む（版ごとに1回）。クラウドにも無ければ、そろっている話題だけで出す', async () => {
    const lost = TODAY.edition.order.slice(18)
    await started(async (p) => {
      await p.applyRemote([...TODAY.topics.slice(0, 18).map((t) => asChange('topics', t)), asChange('editions', TODAY.edition)])
    })
    const fetch = vi.fn(async (ids: readonly string[]) => ({ found: [], missing: [...ids] }))
    setTopicFetcher(fetch)
    await openEdition(null)
    // 最初の受け取りが終わるまでは読まない
    expect(fetch).not.toHaveBeenCalled()
    expect(useApp.getState().opened).toMatchObject({ view: null, waiting: TODAY.edition.id })
    noteSyncDownloaded(true)
    await vi.waitFor(() => expect(useApp.getState().opened.view?.kind).toBe('ready'))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(lost)
    const view = ready(useApp.getState().opened.view)
    expect(view.topics).toHaveLength(18)
    expect(view.missing).toEqual(lost)
    await openEdition(null)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('選んだ版を開く: 無い版・30日の外の版・新しい形の版はそう返す', async () => {
    const old = makeFakeEdition({ date: '2026-10-16', slot: '12', seed: 'store-expired' })
    const newer = { ...YESTERDAY.edition, id: '2026-11-13-12', date: '2026-11-13', slot: '12', v: 2 }
    await started(async (p) => {
      await receive(p, old, YESTERDAY)
      await p.applyRemote([asChange('editions', newer)])
    })
    await openEdition(YESTERDAY.edition.id)
    expect(useApp.getState().opened.follow).toBe(false)
    expect(ready(useApp.getState().opened.view).editionId).toBe(YESTERDAY.edition.id)
    expect((await loadEditionView(old.edition.id)).kind).toBe('expired')
    expect((await loadEditionView('2026-11-12-20')).kind).toBe('none')
    expect((await loadEditionView(newer.id)).kind).toBe('newer')
    // トップに戻す（付いていく）
    await openEdition(null)
    expect(useApp.getState().opened).toMatchObject({ follow: true, view: { editionId: YESTERDAY.edition.id } })
  })

  it('出典の社の一覧を作り物に差し替えると、example.com の出典がリンクになる（ふだんの一覧ではリンクにしない）', async () => {
    await started((p) => receive(p, TODAY))
    const links = () =>
      ready(useApp.getState().opened.view)
        .topics.flatMap((t) => t.sources)
        .map((s) => s.link)
    expect(links().every((l) => l === null)).toBe(true)
    setTopicOutlets(FAKE_OUTLETS)
    await openEdition(null)
    expect(links().some((l) => l?.startsWith('https://example.com/'))).toBe(true)
    // 受け取った記録は変えない
    const raw = await stores[0].getTopics(TODAY.edition.order)
    expect(raw).toEqual(TODAY.topics)
  })
})

describe('別のタブ・アカウントの切り替え・保存できない時', () => {
  it('別のタブが書いた既読・届いた版を、読み直して出す（中身が同じ記録は前の参照のまま）', async () => {
    const name = `store-tabs-${Math.random().toString(36).slice(2)}`
    const p = newDb(name)
    await initStore(p)
    know(press('〇〇法'))
    await flushNow()
    const before = useApp.getState().user.knownTerms
    // 別のタブ（同じ端末の DB）
    const other = newDb(name)
    const prev = await other.loadUserRecords()
    await other.save(prev, { ...prev, reads: { [TODAY.edition.id]: readMark(TODAY.edition.id, { seen: true }) } })
    await receive(other, TODAY)
    expect(await reloadFromDisk()).toBe(true)
    const s = useApp.getState()
    expect(s.user.reads[TODAY.edition.id].seen).toBe(true)
    expect(s.user.knownTerms).toBe(before)
    expect(ready(s.opened.view).editionId).toBe(TODAY.edition.id)
  })

  it('別のタブの知らせ（BroadcastChannel の topic-studio-sync）で、送るきっかけを知らせ、端末の中を読み直す（自分の知らせでは読まない）', async () => {
    const name = `store-channel-${Math.random().toString(36).slice(2)}`
    const p = newDb(name)
    await initStore(p)
    const external = vi.fn()
    onExternalSave(external)
    // 別のタブ（同じ端末の DB）が既読を書いて知らせる
    const other = newDb(name)
    const prev = await other.loadUserRecords()
    await other.save(prev, { ...prev, reads: { [TODAY.edition.id]: readMark(TODAY.edition.id, { seen: true }) } })
    const tab = new BroadcastChannel('topic-studio-sync')
    const heard: unknown[] = []
    tab.onmessage = (ev: MessageEvent) => heard.push(ev.data)
    try {
      tab.postMessage({ from: '別のタブ' })
      await vi.waitFor(() => expect(useApp.getState().user.reads[TODAY.edition.id]?.seen).toBe(true))
      expect(external).toHaveBeenCalledTimes(1)
      // このタブが書いた時は、別のタブへ知らせる（中身はこのタブの印だけ）
      know(press('〇〇法'))
      await flushNow()
      await vi.waitFor(() => expect(heard).toHaveLength(1))
      expect(Object.keys(heard[0] as object)).toEqual(['from'])
      expect(external).toHaveBeenCalledTimes(1)
    } finally {
      tab.close()
    }
  })

  it('アカウントを切り替えて Claude の記録の写しを消したら、版の一覧も空にする（アプリの記録は残す）', async () => {
    const p = await started((db) => receive(db, TODAY))
    know(press('〇〇法'))
    await flushNow()
    await p.markAllDirty()
    await reloadFromDisk()
    expect(useApp.getState().editions).toEqual([])
    expect(useApp.getState().opened.view).toBeNull()
    expect(Object.keys(useApp.getState().user.knownTerms)).toEqual([termIdOf('〇〇法')])
  })

  it('端末に書けない時は false で終わり、少し後で書き直す。クラウドの変更も反映しない（エンジンが後でやり直す）', async () => {
    const real = newDb()
    let fails = true
    const p: Persistence = {
      ...real,
      save: (prev, next) => (fails ? Promise.reject(new Error('容量が足りません')) : real.save(prev, next)),
    }
    await initStore(p)
    markRead(TODAY.edition.id, TODAY.edition.order[0])
    expect(await flushNow()).toBe(false)
    expect(useApp.getState()).toMatchObject({ saveStatus: 'error', saveError: '容量が足りません' })
    await expect(applyRemoteChanges([asChange('reads', readMark(TODAY.edition.id, { seen: true }))])).rejects.toThrow(
      '保存できないため',
    )
    // 書けるようになれば保存する（画面の既読は消えていない）
    fails = false
    expect(useApp.getState().user.reads[TODAY.edition.id].topicIds).toEqual([TODAY.edition.order[0]])
    expect(await flushNow()).toBe(true)
    expect(useApp.getState().saveStatus).toBe('saved')
  })
})

// ---------- 段階2の画面の読む口（設計: 段階2の 1.8・1.9・1.16・4.1） ----------

/** 2026-11-15 14:10（日本時間。段階2の E2E・見本の時刻） */
const T_1410 = Date.UTC(2026, 10, 15, 5, 10)
/** 2026-11-15 20:00（日本時間）から m 分 */
const at20 = (m: number) => Date.UTC(2026, 10, 15, 11, m)
/** 11/13 12:00版〜11/15 12:00版（11/14 12:00版は作れなかった印だけ。続報の鎖は 11/13 12:00 → 11/14 20:00 → 11/15 12:00） */
const MONTH = makeFakeMonth({ until: '2026-11-15', untilSlot: '12', days: 3, seed: 'store-stage2' })

async function receiveMonth(p: Persistence, month: FakeMonth = MONTH): Promise<void> {
  await p.applyRemote(
    fakeRecordsOf(month)
      .filter((r) => r.table !== 'termPacks')
      .map((r) => asChange(r.table, r.record)),
  )
}

async function startedWithMonth(prepare?: (p: Persistence) => Promise<void>): Promise<Persistence> {
  vi.setSystemTime(T_1410)
  const p = await started(async (db) => {
    await receiveMonth(db)
    await prepare?.(db)
  })
  setTopicOutlets(FAKE_OUTLETS)
  await openEdition(null)
  return p
}

const editionOf = (id: string) => MONTH.editions.find((e) => e.edition.id === id)!

describe('loadTopicView（1本の話題を id で読む）', () => {
  it('版の記録があり30日の内の話題を、写しと足された順の訂正で返す', async () => {
    await startedWithMonth()
    const first = await loadTopicView(MONTH.scenes.chain[0])
    expect(first.kind).toBe('ready')
    if (first.kind !== 'ready') return
    expect(first.topic.id).toBe(MONTH.scenes.chain[0])
    expect(first.corrections.map((c) => c.text)).toEqual([CHAIN_CORRECTION_TEXT])
    // 出典のリンクは、今の社の一覧（作り物）で決める
    expect(first.topic.sources.some((src) => src.link?.startsWith('https://example.com/'))).toBe(true)
    const twice = await loadTopicView(MONTH.scenes.corrections.twice)
    if (twice.kind !== 'ready') throw new Error(twice.kind)
    expect(twice.corrections).toHaveLength(2)
    expect(twice.corrections[0].createdAt).toBeLessThan(twice.corrections[1].createdAt)
  })

  it('30日の外・端末に無い・版の記録の無い・order に無い話題は none。話題か版の記録が新しい形なら newer', async () => {
    const newest = editionOf('2026-11-15-12')
    const stray = { ...newest.topics[3], id: '2026-11-15-12-zzzzzzzz' }
    const newerTopic = { ...newest.topics[19], v: 2 }
    const newerEdition = { ...editionOf('2026-11-14-20').edition, v: 2 }
    await startedWithMonth(async (p) => {
      await p.applyRemote([asChange('topics', stray), asChange('topics', newerTopic), asChange('editions', newerEdition)])
    })
    expect(await loadTopicView(MONTH.scenes.chain[0], { now: T_1410 + 40 * 24 * 60 * 60 * 1000 })).toEqual({ kind: 'none' })
    expect(await loadTopicView('2026-11-15-12-aaaaaaaa')).toEqual({ kind: 'none' })
    expect(await loadTopicView('2026-11-12-12-aaaaaaaa')).toEqual({ kind: 'none' })
    expect(await loadTopicView(stray.id)).toEqual({ kind: 'none' })
    expect(await loadTopicView('not-a-topic')).toEqual({ kind: 'none' })
    expect(await loadTopicView(newerTopic.id)).toEqual({ kind: 'newer' })
    expect(await loadTopicView(MONTH.scenes.chain[1])).toEqual({ kind: 'newer' })
  })

  it('端末の中を読む前は none', async () => {
    expect(await loadTopicView(MONTH.scenes.chain[0])).toEqual({ kind: 'none' })
  })
})

describe('threadOf（続報のつながり）', () => {
  it('同じ threadId の、出してよい話題を版の id の順に（id・版・見出し）', async () => {
    await startedWithMonth()
    const chain = await threadOf(MONTH.scenes.chain[0])
    expect(chain.map((t) => [t.id, t.editionId])).toEqual([
      [MONTH.scenes.chain[0], '2026-11-13-12'],
      [MONTH.scenes.chain[1], '2026-11-14-20'],
      [MONTH.scenes.chain[2], '2026-11-15-12'],
    ])
    expect(chain[0].headline).toBe(editionOf('2026-11-13-12').topics[13].headline)
    // 続報でない話題は自分だけ。形の違う id は空
    const lone = editionOf('2026-11-15-12').topics[0]
    expect(await threadOf(lone.threadId)).toEqual([{ id: lone.id, editionId: lone.editionId, headline: lone.headline }])
    expect(await threadOf('nope')).toEqual([])
    const both = await threadsOf([lone.threadId, MONTH.scenes.chain[0], lone.threadId])
    expect(Object.keys(both).sort()).toEqual([lone.threadId, MONTH.scenes.chain[0]].sort())
    expect(both[MONTH.scenes.chain[0]]).toHaveLength(3)
  })

  it('30日の外・版の記録が新しい形の話題は入れない', async () => {
    await startedWithMonth(async (p) => {
      await p.applyRemote([asChange('editions', { ...editionOf('2026-11-14-20').edition, v: 2 })])
    })
    expect((await threadOf(MONTH.scenes.chain[0])).map((t) => t.id)).toEqual([MONTH.scenes.chain[0], MONTH.scenes.chain[2]])
    // 12/13 からは 11/13 の版（鎖の1本目）が30日の外
    const later = Date.UTC(2026, 11, 13, 5, 0)
    expect((await threadOf(MONTH.scenes.chain[0], { now: later })).map((t) => t.id)).toEqual([MONTH.scenes.chain[2]])
  })
})

describe('catchUpTargets・loadCatchUp（追いつき）', () => {
  it('最後に見た版より後で、出している版より前の版（新しい順）。付いていかない時・見た版が無い時は []', async () => {
    await startedWithMonth()
    const now = Date.now()
    expect(catchUpTargets(useApp.getState(), now)).toEqual([])
    expect(markSeen('2026-11-13-12').ok).toBe(true)
    // 作れなかった枠（11/14 12:00）は数えない
    expect(catchUpTargets(useApp.getState(), now)).toEqual(['2026-11-14-20', '2026-11-13-20'])
    expect(markSeen('2026-11-13-20').ok).toBe(true)
    expect(catchUpTargets(useApp.getState(), now)).toEqual(['2026-11-14-20'])
    await openEdition('2026-11-14-20')
    expect(catchUpTargets(useApp.getState(), now)).toEqual([])
  })

  it('loadCatchUp: 版ごとに読み、続報は最新の1本（最新が今の版にある鎖は外す）・重大印 → order の位置 → 新しい版の順・訂正を付ける', async () => {
    await startedWithMonth()
    const items = await loadCatchUp(['2026-11-14-20', '2026-11-13-20', '2026-11-13-12'])
    const ids = items.map((i) => i.topic.id)
    // 3版 × 20本から、鎖の2本（今の版に3本目がある）を除く
    expect(items).toHaveLength(58)
    for (const c of MONTH.scenes.chain) expect(ids).not.toContain(c)
    expect(items.slice(0, 3).map((i) => [i.topic.major, i.edition.id])).toEqual([
      [true, '2026-11-14-20'],
      [true, '2026-11-13-20'],
      [true, '2026-11-13-12'],
    ])
    expect(items[3].edition.id).toBe('2026-11-14-20')
    expect(items[3].topic.id).toBe(editionOf('2026-11-14-20').edition.order[1])
    const old = items.find((i) => i.topic.id === MONTH.scenes.corrections.oldest)
    expect(old?.corrections).toHaveLength(1)
    expect(items.filter((i) => i.corrections.length).map((i) => i.topic.id)).toEqual([MONTH.scenes.corrections.oldest])
    // 今の版・出せない版は飛ばす
    expect(await loadCatchUp(['2026-11-15-12', '2026-11-14-12', '2026-11-01-12'])).toEqual([])
  })
})

describe('editionRows（版の一覧の行）', () => {
  const kinds = (rows: EditionRow[]) =>
    rows.map((r) => `${r.date}-${r.slot}:${r.kind}${r.kind === 'edition' && r.receiving ? '(受け取り中)' : ''}`)

  it('いちばん古い記録の枠から、時刻の上でいちばん新しい枠まで（新しい順）。作れなかった枠は理由と文', async () => {
    await startedWithMonth()
    const rows = await editionRows(T_1410, true)
    expect(kinds(rows)).toEqual([
      '2026-11-15-12:edition',
      '2026-11-14-20:edition',
      '2026-11-14-12:failed',
      '2026-11-13-20:edition',
      '2026-11-13-12:edition',
    ])
    expect(rows[2]).toEqual({
      date: '2026-11-14',
      slot: '12',
      kind: 'failed',
      reasonKind: 'quota',
      reason: MONTH.editionFails[0].reason,
    })
  })

  it('いちばん新しい枠に何も無い時は、30分たって同期が落ち着いてから「届いていません」。前の枠の抜けはすぐ', async () => {
    await startedWithMonth()
    expect(kinds(await editionRows(at20(29), true))[0]).toBe('2026-11-15-12:edition')
    expect(kinds(await editionRows(at20(40), false))[0]).toBe('2026-11-15-12:edition')
    expect(kinds(await editionRows(at20(30), true))[0]).toBe('2026-11-15-20:missing')
    // 次の日の 12:40 では、11/15 20:00 はもう前の枠（すぐ「届いていません」）、11/16 12:00 は30分たっている
    expect(kinds(await editionRows(Date.UTC(2026, 10, 16, 3, 40), false)).slice(0, 2)).toEqual([
      '2026-11-15-20:missing',
      '2026-11-15-12:edition',
    ])
  })

  it('新しい形の版・いちばん新しい枠の作れなかった印・話題がそろわない版（受け取り中）', async () => {
    const newest = editionOf('2026-11-15-12')
    const p = await startedWithMonth(async (db) => {
      await db.applyRemote([
        asChange('editions', { ...editionOf('2026-11-13-20').edition, v: 2 }),
        asChange('editionFails', {
          ...MONTH.editionFails[0],
          id: '2026-11-15-20-ffffffff',
          editionId: '2026-11-15-20',
          reason: '',
        }),
      ])
    })
    // いちばん新しい版の話題を2本消して、受け取り中にする（端末の中だけ。受け取る前の形）
    const stored = await p.getTopics(newest.edition.order)
    expect(stored.every(Boolean)).toBe(true)
    const partial = {
      ...newest.edition,
      order: [...newest.edition.order.slice(0, 18), '2026-11-15-12-xxxxxxx1', '2026-11-15-12-xxxxxxx2'],
    }
    await applyRemoteChanges([asChange('editions', partial)])
    const rows = await editionRows(at20(10), false)
    expect(kinds(rows)).toEqual([
      '2026-11-15-20:failed',
      '2026-11-15-12:edition(受け取り中)',
      '2026-11-14-20:edition',
      '2026-11-14-12:failed',
      '2026-11-13-20:newer',
      '2026-11-13-12:edition',
    ])
    expect(rows[0]).toMatchObject({ kind: 'failed', reason: null })
  })

  it('クラウドにも無いと分かった話題は欠けに数えない', async () => {
    const newest = editionOf('2026-11-15-12')
    await startedWithMonth(async (db) => {
      await db.applyRemote([
        asChange('editions', { ...newest.edition, order: [...newest.edition.order, '2026-11-15-12-xxxxxxx1'] }),
      ])
    })
    expect(kinds(await editionRows(T_1410, true))[0]).toBe('2026-11-15-12:edition(受け取り中)')
    setTopicFetcher(async (ids) => ({ found: [], missing: [...ids] }))
    noteSyncDownloaded(true)
    await vi.waitFor(() => expect(ready(useApp.getState().opened.view).editionId).toBe('2026-11-15-12'))
    expect(kinds(await editionRows(T_1410, true))[0]).toBe('2026-11-15-12:edition')
  })

  it('記録が1つも無ければ []。30日の外の記録は数えない', async () => {
    await started()
    expect(await editionRows(T_1410, true)).toEqual([])
    resetStoreForTests()
    await startedWithMonth()
    const late = Date.UTC(2026, 11, 13, 5, 0)
    const rows = await editionRows(late, true)
    // 12/13 からは 11/13 の版が30日の外。11/14 12:00 の作れなかった印から 12/13 12:00 まで
    expect(rows.at(-1)).toMatchObject({ date: '2026-11-14', slot: '12', kind: 'failed' })
    expect(rows[0]).toMatchObject({ date: '2026-12-13', slot: '12', kind: 'missing' })
  })
})
