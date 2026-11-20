// コネクタとアプリの同期のエンジンを一緒に動かす結合のテスト（B8。段階3の設計の 7. の「エミュレーター」・1.8・1.9・2.1）。
// 実行: リポジトリの直下で npm run test:connector:emu（Firebase エミュレーターの Auth・Firestore と、本番のアクセスルール firestore.rules）。
// NS の connector/test/emu/connector.emu.test.ts の形（持ち主の端末をアプリの同期のエンジンと端末内の保存で動かし、コネクタの Vault の
// 中身（node:sqlite）と、アプリの連携の部品（src/features/claude/connectLogic.ts・connectorDoc.ts）で連携する）を TS に直した。
// コネクタだけの場面（写しの読み方・足す道具のルール）は mirror.emu.test.ts・write.emu.test.ts にあり、ここはアプリと一緒の場面だけ:
// - 連携 → 版の回（作り物の出どころから候補を集める）→ 下書き → 照合 → 話題 → 版 を、持ち主の端末2台が「読み取れませんでした」なしに
//   受け取って版を出す（出典の社・出典の表示も作れる）
// - アプリの設定の部品で「書き込みを許可」をオフにすると、コネクタは版の回も訂正も断る（始めていた回の訂正も。読むのは続く）。端末の既読・知ってる（private）は
//   コネクタに届かず、コネクタはクラウドの記録を直せない
// - 作り物の1か月分（npm run seed:emu と同じ道具）の上で、前の版の一覧（直近3日・6版）・30日の外・訂正・続報が端末に届く
// 作り物だけ（社は FAKE_OUTLETS、出どころは test/support/fakeNews.ts の作り物（https://example.com/…）、モデルは fake-writer-model・
// fake-checker-model、アカウントはテストの回ごとに名前を替える）。テストの fetch は、エミュレーター（127.0.0.1）のほかへ出たら落ちる
// （test/support/netGuard.ts）。出どころへの取りに行きは作り物の fetch（FakeNews）で、グローバルの fetch を通らない
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, GoogleAuthProvider, signInWithCredential } from 'firebase/auth'
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache, terminate, type Firestore } from 'firebase/firestore'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultConnectionName, newConnectionId, pairingHash, randomPairingKey } from '../../../src/claude/pairing'
import { createPersistence, type Persistence } from '../../../src/db/persistence'
import { creditText } from '../../../src/domain/credit'
import { correctionsByTopic, editionShowState } from '../../../src/domain/editionShow'
import { correctionIdOf, topicShortId } from '../../../src/domain/ids'
import { addDaysToDate, isWithinRetention, jstDateOf } from '../../../src/domain/jst'
import { repairCorrection, repairEdition, repairTopic } from '../../../src/domain/repair'
import type { ReadMark, Topic } from '../../../src/domain/types'
import { approvePairing, prepareConnect } from '../../../src/features/claude/connectLogic'
import {
  addConnection,
  deleteConnector,
  readConnectorDoc,
  readOwnerUid,
  setConnectorWrites,
} from '../../../src/features/claude/connectorDoc'
import { APP_VERSION, DATA_MODEL } from '../../../src/sync/appModel'
import { createSyncEngine, type SyncEngine } from '../../../src/sync/engine'
import { adminCreateOwner, adminDocIds, adminGoogleUser } from '../../../src/test/emulatorAdmin'
import { FAKE_CREDIT_OUTLETS, FAKE_OUTLETS } from '../../../src/test/fixtures/fakeOutlets'
import { seedEmulator } from '../../../src/test/seedEmulator'
import type { GrantProps, VaultCore } from '../../src/vault/core'
import { seedFreshNews } from '../e2e/freshNews'
import { draftInput, newTerm, placeVerified, quietFetchWork, seedMaterial, WRITER } from '../support/drafts'
import { fakeFetchWork, FakeNews } from '../support/fakeNews'
import { clearFirestore, drainAlarms, emuRules, EMU_PROJECT, makeVault, prodRules, useRules } from './harness'

beforeAll(async () => {
  await useRules(prodRules)
})

afterAll(async () => {
  await useRules(emuRules)
})

beforeEach(async () => {
  // 持ち主の記録 config/owner はデータベースに1つ（本番のルールでは作り直せない）ので、テストごとに空にする
  await clearFirestore()
})

afterEach(async () => {
  for (const d of devices.splice(0)) await d.close()
  warn.mockClear()
})

// アプリの同期のエンジンが、読めないクラウドの記録に出す知らせ（「クラウドの記録を読み取れませんでした」）を数える
const warn = vi.spyOn(console, 'warn')
const unreadable = () => warn.mock.calls.filter((c) => String(c[0]).includes('読み取れませんでした'))

// ---------- 持ち主の端末（アプリの同期のエンジンと端末内の保存。fake-indexeddb） ----------

interface Device {
  name: string
  uid: string
  fs: Firestore
  p: Persistence
  engine: SyncEngine
  close(): Promise<void>
}

const devices: Device[] = []
let seq = 0

/** 持ち主のアカウント（エミュレーターの仮の Google アカウント）と、持ち主の記録 config/owner */
async function ownerAccount(): Promise<{ sub: string; uid: string }> {
  const sub = `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const uid = await adminGoogleUser(sub)
  await adminCreateOwner(uid)
  return { sub, uid }
}

/** 端末を作って同期を始める（同じ sub なら同じアカウント。持ち主を確かめ、データの形の版をこのアプリの版にする。アプリと同じ） */
async function makeDevice(name: string, sub: string): Promise<Device> {
  const app: FirebaseApp = initializeApp(
    { projectId: EMU_PROJECT, apiKey: 'fake-api-key', authDomain: 'localhost' },
    `${name}-${++seq}`,
  )
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const cred = GoogleAuthProvider.credential(JSON.stringify({ sub, email: `${sub}@example.com`, email_verified: true }))
  const { user } = await signInWithCredential(auth, cred)
  const fs = initializeFirestore(app, { localCache: memoryLocalCache() })
  connectFirestoreEmulator(fs, '127.0.0.1', 8080)
  const p = createPersistence(`conn-emu-${name}-${seq}-${Math.random().toString(36).slice(2)}`)
  const engine = createSyncEngine({
    firestore: fs,
    uid: user.uid,
    deviceId: name,
    target: p,
    uploadDelay: 10,
    uploadMaxWait: 50,
    ownerLock: true,
    appModel: { model: DATA_MODEL, appVersion: APP_VERSION },
  })
  await engine.start()
  let closed = false
  const d: Device = {
    name,
    uid: user.uid,
    fs,
    p,
    engine,
    async close() {
      if (closed) return
      closed = true
      engine.stop()
      p.close()
      await terminate(fs)
      await deleteApp(app)
    },
  }
  devices.push(d)
  await waitFor(() => engine.status.downloaded === true, `${name} の最初の受け取り`, 60_000)
  return d
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false> | T, label: string, timeout = 30_000): Promise<T> {
  const until = Date.now() + timeout
  let last: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    if (Date.now() > until) throw new Error(`待ちきれませんでした: ${label}${last ? ` (${String(last)})` : ''}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** 端末が版を出すか（画面のストアと同じく、端末の版と order の話題と訂正で決める。src/domain/editionShow.ts） */
async function shown(d: Device, editionId: string) {
  const raw = (await d.p.listEditions()).find((e) => e.id === editionId)
  if (!raw) return null
  const ed = repairEdition(raw)
  if (ed.kind !== 'ok') return null
  const state = editionShowState(ed.value, await d.p.getTopics(ed.value.order), Date.now())
  if (state.kind !== 'ready') return null
  const corrections = (await d.p.correctionsOfEdition(editionId))
    .map((c) => repairCorrection(c))
    .flatMap((r) => (r.kind === 'ok' ? [r.value] : []))
  return {
    topics: state.topics,
    corrections: correctionsByTopic(
      corrections,
      state.topics.map((t) => t.id),
    ),
  }
}

// ---------- コネクタ ----------

/**
 * アプリの連携の画面と同じ手順で連携する（src/features/claude/connectLogic.ts の prepareConnect・approvePairing と、connectorDoc.ts の
 * readOwnerUid・readConnectorDoc・addConnection・deleteConnector をそのまま使う。Firestore は持ち主の端末のもの）。アプリが移る
 * /pair/callback の URL の state と k で、コネクタの /pair/callback と同じ確かめ（verifyPairing）をする。返す grant は、その接続の
 * OAuth の許可の props と同じ
 */
async function pairWithApp(core: VaultCore, owner: Device, opts: { writes?: boolean } = {}): Promise<GrantProps> {
  const origin = 'https://connector.emu.test'
  const state = `state-${Math.random().toString(36).slice(2)}`
  const prep = await prepareConnect(
    {
      origin,
      readOwnerUid: () => readOwnerUid(owner.fs),
      waitSynced: async () => true,
      fetchIdentity: async () => ({ ok: true, identity: await core.connectIdentity() }),
      readConnector: () => readConnectorDoc(owner.fs),
      dataModel: DATA_MODEL,
      cancelled: () => false,
    },
    owner.uid,
  )
  if (prep.step !== 'ready') throw new Error(`連携の画面が先へ進みません: ${prep.step}`)
  const cid = newConnectionId()
  let url = ''
  const approved = await approvePairing(
    {
      origin,
      addConnection: (a) => addConnection(a, owner.fs),
      deleteConnector: () => deleteConnector(owner.fs),
      navigate: (u) => (url = u),
      randomKey: () => randomPairingKey(),
      deviceLabel: () => 'テストの端末',
    },
    {
      state,
      identity: prep.identity,
      ownerUid: prep.ownerUid,
      writes: opts.writes ?? null,
      cid,
      name: defaultConnectionName((prep.existing?.connections ?? []).map((c) => c.name)),
      defaultName: true,
    },
  )
  if (!approved.ok) throw new Error(`連携を記録できません: ${approved.error}`)
  const back = new URL(url)
  const r = await core.verifyPairing(await pairingHash(back.searchParams.get('state') ?? '', back.searchParams.get('k') ?? ''))
  if (!r.ok) throw new Error(`連携できません: ${r.reason} ${r.message}`)
  expect(r.cid).toBe(cid)
  return { ownerUid: r.ownerUid, gen: r.gen, cid: r.cid }
}

type Vault = ReturnType<typeof makeVault>

/** 回を始める（答えの runId）。回の物を呼ぶ関数も返す */
async function begin(v: Vault, grant: GrantProps, kind: 'edition' | 'trial' | 'correction') {
  await drainAlarms(v)
  const r = await v.core.callTool('topic_begin_run', { kind, model: WRITER }, { grant })
  const m = /runId: (r\d{12}-[0-9a-z]{4})/.exec(r.text)
  if (!m) throw new Error(`回を始められません: ${r.text}`)
  const runId = m[1]
  const call = (tool: string, args: Record<string, unknown> = {}) => v.core.callTool(tool, { runId, ...args }, { grant })
  return { runId, call, text: r.text }
}

/** 候補の一覧の行（c0001 〇〇省 …）の id と社 */
function candidatesOf(text: string): { cid: string; outlet: string }[] {
  const names = new Set<string>(Object.values(FAKE_CREDIT_OUTLETS))
  return [...text.matchAll(/^(c\d{4}) (\S+)/gm)].map((m) => ({ cid: m[1], outlet: m[2] })).filter((c) => names.has(c.outlet))
}

/** 管理者の権限で読む、そのアカウントの記録の文書の id（表:id） */
const cloudIds = async (uid: string, table: string) =>
  (await adminDocIds(uid, 'records')).filter((d) => d.startsWith(`${table}:`)).map((d) => d.slice(table.length + 1))

/** エミュレーターの Firestore の文書（REST） */
const docUrl = (path: string) => `http://127.0.0.1:8080/v1/projects/${EMU_PROJECT}/databases/(default)/documents/${path}`

describe('コネクタとアプリの同期のエンジン（エミュレーター・本番のアクセスルール）', () => {
  it('アプリの連携の部品で連携 → 作り物の出どころから候補を集めた版の回 → 下書き → 照合 → 話題 → 版。持ち主の端末2台が「読み取れませんでした」なしに受け取り、版を出す（出典の社と出典の表示も）', async () => {
    const who = await ownerAccount()
    const pc = await makeDevice('pc', who.sub)
    const phone = await makeDevice('phone', who.sub)
    expect(pc.uid).toBe(who.uid)
    const news = new FakeNews()
    const v = makeVault({ outlets: FAKE_OUTLETS, fetchWork: fakeFetchWork(), sourceFetch: news.fetch as typeof fetch })
    news.clock = v.clock
    seedFreshNews(news, () => v.clock.now)
    const grant = await pairWithApp(v.core, pc)
    // 連携の記録: コネクタの匿名のアカウントと指紋だけ（アプリの部品が書いた。ルールを通った）
    const conn = await readConnectorDoc(pc.fs)
    expect(conn?.uid).toBe((await v.core.connectIdentity()).uid)
    expect(conn?.connections.map((c) => c.name)).toEqual(['接続1'])

    const { runId, call } = await begin(v, grant, 'edition')
    // 候補集め（alarm で続ける。取りに行くやる事は1回の alarm に1つ。時計はホストの間の分だけ進める）
    await drainAlarms(v, { n: 400, within: 60 * 60_000 })
    const status = await v.core.callTool('topic_status', { runId }, { grant })
    const readable = Number(/候補集め: 終わりました（読める候補 (\d+)件/.exec(status.text)?.[1] ?? '0')
    expect(readable, status.text).toBeGreaterThanOrEqual(5)
    const list = await call('topic_list_candidates')
    expect(list.isError, list.text).toBeUndefined()
    // 窓の外・PDF・ほかのホスト・外すカテゴリー・著者の無い全文は候補にしない
    for (const gone of [
      '作り物の統計（PDF）',
      'ほかのホストの作り物の発表',
      '作り物の物品の調達',
      'A fake article without author',
    ])
      expect(list.text).not.toContain(gone)
    const cands = candidatesOf(list.text)
    expect(cands.length).toBe(readable)
    // 〇〇省（出典の表示が site の形の作り物の社）の候補を先に
    const picked = [
      ...cands.filter((c) => c.outlet === FAKE_CREDIT_OUTLETS.site),
      ...cands.filter((c) => c.outlet !== FAKE_CREDIT_OUTLETS.site && c.outlet !== FAKE_CREDIT_OUTLETS.ccBy),
    ].slice(0, 5)
    expect(picked).toHaveLength(5)
    expect(picked[0].outlet).toBe(FAKE_CREDIT_OUTLETS.site)
    // HTML の一覧の形（〇〇省）と RSS の形（△△庁・▽▽府）の両方の作り物の出どころを通す（設計の 7. の「エミュレーター」）
    expect(picked.some((c) => c.outlet === FAKE_CREDIT_OUTLETS.title || c.outlet === FAKE_CREDIT_OUTLETS.pdl)).toBe(true)

    const ids: string[] = []
    for (const [i, c] of picked.entries()) {
      const read = await call('topic_read_article', { ref: c.cid })
      expect(read.isError, read.text).toBeUndefined()
      const n = i + 1
      ids.push(
        await placeVerified(
          call,
          v.clock,
          draftInput(n, {
            headline: `作り物の見出し${n}　${c.outlet}の作り物の発表をまとめた`,
            sources: [{ ref: c.cid, outlet: c.outlet }],
            terms: n === 1 ? [newTerm('作り物の結合の語')] : [],
          }),
        ),
      )
    }
    const added = await call('topic_add_topics', { items: ids.map((draft, i) => ({ draft, rank: i + 1 })) })
    expect(added.isError, added.text).toBeUndefined()
    const edition = await call('topic_add_edition', { order: ids, candidateCount: readable, notChosen: [] })
    expect(edition.isError, edition.text).toBeUndefined()
    const editionId = v.core.store.getRun(runId)?.editionId ?? (await cloudIds(who.uid, 'editions'))[0]
    expect(editionId).toBeTruthy()
    const topicIds = await cloudIds(who.uid, 'topics')
    expect(topicIds).toHaveLength(5)
    expect(await cloudIds(who.uid, 'termPacks')).toHaveLength(1)

    // 両方の端末が受け取って版を出す（端末の保存の形のまま読み直し、アプリと同じ確かめを通る）
    for (const d of [pc, phone]) {
      const view = await waitFor(() => shown(d, editionId), `${d.name} が版を出す`, 60_000)
      expect(view.topics.map((t) => t.id).sort()).toEqual([...topicIds].sort())
      for (const raw of view.topics) {
        const r = repairTopic(raw, { outlets: FAKE_OUTLETS })
        expect(r.kind, raw.id).toBe('ok')
        if (r.kind !== 'ok') continue
        const t = r.value as unknown as Topic
        // 出典の社は出典だけから（読んでいない所は入れない）。出典の表示は作り物の社の書き方で作れる（「…を加工して作成」）
        expect(t.outletNames).toEqual([...new Set(t.sources.map((s) => s.outlet))])
        for (const s of t.sources) {
          expect(s.url.startsWith('https://example.com/')).toBe(true)
          expect(creditText(s, FAKE_OUTLETS) ?? '').toContain('を加工して作成')
        }
      }
      const site = view.topics.find((t) => (t as unknown as Topic).outletNames.includes(FAKE_CREDIT_OUTLETS.site))
      expect(site, '〇〇省の話題').toBeTruthy()
    }
    expect(unreadable()).toEqual([])
    // コネクタの写しにも、書いた版と話題が入っている（前の版の一覧に出る）
    const recent = await v.core.callTool('topic_list_recent', {}, { grant })
    expect(recent.text).toContain(topicShortId(topicIds[0]))
  })

  it('アプリの設定の部品で「書き込みを許可」をオフにすると、コネクタは版の回も訂正だけの回も始めず、始めていた回の訂正も足さない（読むのは続く）。端末の既読・知ってる（private）はコネクタに届かず、コネクタはクラウドの記録を直せない', async () => {
    const who = await ownerAccount()
    const pc = await makeDevice('pc', who.sub)
    const v = makeVault({ outlets: FAKE_OUTLETS, fetchWork: quietFetchWork() })
    const grant = await pairWithApp(v.core, pc)
    // 版を1つ足しておく（コネクタの道具で。読む物）
    const { runId, call } = await begin(v, grant, 'edition')
    const ids: string[] = []
    for (let i = 1; i <= 5; i++) {
      seedMaterial(v.core, runId, i)
      ids.push(await placeVerified(call, v.clock, draftInput(i)))
    }
    expect((await call('topic_add_topics', { items: ids.map((draft, i) => ({ draft, rank: i + 1 })) })).isError).toBeUndefined()
    expect((await call('topic_add_edition', { order: ids, candidateCount: 5 })).isError).toBeUndefined()
    const editionId = v.core.store.getRun(runId)!.editionId!
    const view = await waitFor(() => shown(pc, editionId), '端末が版を出す', 60_000)

    // 端末で既読にする（private に送られる）
    const topic = view.topics[0]
    const prev = await pc.p.loadUserRecords()
    const now = Date.now()
    const read: ReadMark = {
      id: editionId,
      v: 1,
      createdAt: now,
      updatedAt: now,
      by: 'user',
      ai: null,
      editionId,
      topicIds: [topic.id],
      seen: true,
    }
    await pc.p.save(prev, { ...prev, reads: { [editionId]: read } })
    pc.engine.requestUpload(true)
    await waitFor(async () => (await adminDocIds(who.uid, 'private')).includes(`reads:${editionId}`), '既読がクラウドに届く')

    // コネクタの匿名のアカウントは private を読めず、records の記録を直せない（アクセスルール。2.1）
    const token = await v.core.identity.idToken()
    const auth = { Authorization: `Bearer ${token}` }
    expect((await fetch(docUrl(`users/${who.uid}/private/reads:${editionId}`), { headers: auth })).status).toBe(403)
    expect((await fetch(docUrl(`users/${who.uid}/records/topics:${topic.id}`), { headers: auth })).status).toBe(200)
    const patch = await fetch(`${docUrl(`users/${who.uid}/records/topics:${topic.id}`)}?updateMask.fieldPaths=deleted`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { deleted: { booleanValue: true } } }),
    })
    expect(patch.status).toBe(403)
    // コネクタの答え（写し）に既読は出ない（D21。読み手の記録を持たない）
    const recent = await v.core.callTool('topic_list_recent', {}, { grant })
    expect(recent.text).toContain(topicShortId(topic.id))
    expect(recent.text).not.toMatch(/既読|読んだ/)

    // 設定の「書き込みを許可」をオフ（アプリの部品。すべての接続に効く）。オフにする前に始めていた回も、その後は足せない
    const corr = await begin(v, grant, 'correction')
    const fix = { model: WRITER, topic: topicShortId(topic.id), text: '作り物の数は 2本ではなく 3本でした' }
    await setConnectorWrites(false, pc.fs)
    expect((await readConnectorDoc(pc.fs))?.writes).toBe(false)
    v.clock.now += 2 * 60_000
    const midRun = await corr.call('topic_add_correction', fix)
    expect(midRun.isError, midRun.text).toBe(true)
    expect(midRun.text).toContain('書き込みは停止中です')
    expect(await cloudIds(who.uid, 'corrections')).toEqual([])
    for (const kind of ['edition', 'correction'] as const) {
      const r = await v.core.callTool('topic_begin_run', { kind, model: WRITER }, { grant })
      expect(r.isError, kind).toBe(true)
      expect(r.text).toContain('書き込みは停止中です')
    }
    // 読むのは続く
    const still = await v.core.callTool('topic_list_recent', {}, { grant })
    expect(still.isError).toBeUndefined()
    expect(still.text).toContain(topicShortId(topic.id))
    // オンに戻すと、訂正だけの回を始められる
    await setConnectorWrites(true, pc.fs)
    v.clock.now += 2 * 60_000
    const back = await v.core.callTool('topic_begin_run', { kind: 'correction', model: WRITER }, { grant })
    expect(back.isError, back.text).toBeUndefined()
    // 止める前に始めていた回も、同じ訂正を足せる（断ったのは「書き込みを許可」だけのため）
    const resumed = await corr.call('topic_add_correction', fix)
    expect(resumed.isError, resumed.text).toBeUndefined()
    expect(await cloudIds(who.uid, 'corrections')).toEqual([correctionIdOf({ topicId: topic.id, text: fix.text })])
    expect(unreadable()).toEqual([])
  })

  it('作り物の1か月分（npm run seed:emu と同じ道具）の上で: 前の版の一覧は直近3日・6版だけ、30日の外の話題は探しても出ない。訂正だけの回の訂正と、版の回の続報の話題が持ち主の端末に届き、話題に付く', async () => {
    const who = await ownerAccount()
    // いちばん新しい作り物の版は2日前の 20:00版（今の枠の版の回を始められるように）。35日分なので30日の外の版も混ざる
    const until = addDaysToDate(jstDateOf(Date.now()), -2)
    const plan = await seedEmulator(who.uid, { owner: true, until, untilSlot: '20', days: 35 })
    expect(plan.outsideRetention).toBeGreaterThan(0)
    const cloudTopics = await cloudIds(who.uid, 'topics')
    const pc = await makeDevice('pc', who.sub)
    const v = makeVault({ outlets: FAKE_OUTLETS, fetchWork: quietFetchWork() })
    const grant = await pairWithApp(v.core, pc)
    await drainAlarms(v, { n: 200 })

    const editions = plan.month.editions.map((e) => e.edition)
    const newest = editions[editions.length - 1]
    const older = editions[editions.length - 7]
    const expired = editions.find((e) => !isWithinRetention(e.id.slice(0, 10), Date.now()))!
    expect(expired).toBeTruthy()
    // 30日の外の版の話題も、クラウドには置いてある（コネクタが写しに入れないことを見る）
    expect(cloudTopics).toContain(expired.order[0])
    // 前の版の一覧: 直近3日（今日・昨日・一昨日。日本時間）の、新しい方から6版までの話題だけ。値は仕様の値をここに書く（部品の定数を
    // 読むと、定数を替えた時にテストも一緒に替わってしまう）
    const firstDay = addDaysToDate(jstDateOf(Date.now()), 1 - 3)
    const inRecent = editions.filter((e) => e.id.slice(0, 10) >= firstDay)
    const beforeRecent = editions.filter((e) => e.id.slice(0, 10) < firstDay)
    expect(inRecent.length).toBeGreaterThan(0)
    expect(inRecent.length).toBeLessThanOrEqual(6)
    // 3日より前でいちばん新しい版は、新しい方から6版の内（6版の数ではなく、3日の決まりで外れる）
    const justBefore = beforeRecent[beforeRecent.length - 1]
    expect(editions.length - editions.indexOf(justBefore)).toBeLessThanOrEqual(6)
    const recent = await v.core.callTool('topic_list_recent', {}, { grant })
    expect(recent.isError, recent.text).toBeUndefined()
    for (const e of inRecent) expect(recent.text, e.id).toContain(topicShortId(e.order[0]))
    expect(recent.text).toContain(topicShortId(newest.order[0]))
    expect(recent.text).not.toContain(topicShortId(justBefore.order[0]))
    expect(recent.text).not.toContain(topicShortId(older.order[0]))
    expect(recent.text).not.toContain(topicShortId(expired.order[0]))
    // 30日の外の話題は、訂正する話題を探しても出ない（クラウドに残っていても、写しから先に消える）。30日の内の話題は出る
    const corr = await begin(v, grant, 'correction')
    const found = await corr.call('topic_find_topics', { date: expired.id.slice(0, 10) })
    expect(found.isError, found.text).toBeUndefined()
    expect(found.text).not.toContain(topicShortId(expired.order[0]))
    const foundNewest = await corr.call('topic_find_topics', { date: newest.id.slice(0, 10) })
    expect(foundNewest.text).toContain(topicShortId(newest.order[0]))

    // 訂正だけの回の訂正 → 端末の話題に付く
    const target = newest.order[0]
    const text = '作り物の数は 3本ではなく 4本でした'
    const added = await corr.call('topic_add_correction', { model: WRITER, topic: topicShortId(target), text })
    expect(added.isError, added.text).toBeUndefined()
    const correctionId = correctionIdOf({ topicId: target, text })
    const withCorrection = await waitFor(async () => {
      const s = await shown(pc, newest.id)
      return s && (s.corrections.get(target) ?? []).some((c) => c.id === correctionId) ? s : null
    }, '端末の話題に訂正が付く')
    expect(withCorrection.corrections.get(target)!.map((c) => c.text)).toContain(text)

    // 版の回の続報: 前の版の話題を prev にした話題は、同じ続きもの（threadId）として端末に届く
    v.clock.now += 11 * 60_000
    const ed = await begin(v, grant, 'edition')
    const ids: string[] = []
    for (let i = 1; i <= 5; i++) {
      seedMaterial(v.core, ed.runId, i)
      ids.push(
        await placeVerified(
          ed.call,
          v.clock,
          draftInput(i, i === 1 ? { followUp: { prev: topicShortId(target), whatsNew: '作り物の続きの新しい点' } } : {}),
        ),
      )
    }
    expect(
      (await ed.call('topic_add_topics', { items: ids.map((draft, i) => ({ draft, rank: i + 1 })) })).isError,
    ).toBeUndefined()
    const done = await ed.call('topic_add_edition', { order: ids, candidateCount: 5 })
    expect(done.isError, done.text).toBeUndefined()
    const editionId = v.core.store.getRun(ed.runId)!.editionId!
    const view = await waitFor(() => shown(pc, editionId), '端末が続報の版を出す', 60_000)
    const prevTopic = (await pc.p.getTopics([target]))[0] as unknown as Topic
    const follow = view.topics.find((t) => (t as unknown as Topic).threadId === prevTopic.threadId)
    expect(follow, '続報の話題').toBeTruthy()
    const thread = await pc.p.topicsOfThread(prevTopic.threadId)
    expect(thread.map((t) => t.id)).toEqual(expect.arrayContaining([target, follow!.id]))
    expect(unreadable()).toEqual([])
  })
})
