// 足す道具を本番のアクセスルールで（B5。設計の 7. の「エミュレーター」・1.8）: 連携 → 版の回 → 下書き → 照合 → 話題（辞書の束が先・同じ commit）
// → 版、が本番のルール（firestore.rules）を通り、書いた記録をコネクタがクラウドから読み直せる（写しを消して取り込み直す）。書き込みの許可を
// オフにすると断る・試しの回は何も書かない・訂正だけの回の訂正がルールを通る。作り物だけ（作り物の社 FAKE_OUTLETS・作り物の出どころの data・
// example.com・fake-writer-model）。候補と資料の控えは DO の表に直に入れる（取りに行かない）。エミュレーター（127.0.0.1）のほかへは出ない
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { correctionIdOf, topicShortId } from '../../../src/domain/ids'
import { jstDateOf } from '../../../src/domain/jst'
import { checkRecord } from '../../../src/domain/validate'
import type { TableName } from '../../../src/domain/types'
import { adminDocIds, adminStringField, adminWriteConnector } from '../../../src/test/emulatorAdmin'
import { fakeRecordsOf, makeFakeEdition } from '../../../src/test/fixtures/fakeEditions'
import { FAKE_OUTLETS } from '../../../src/test/fixtures/fakeOutlets'
import { draftInput, newTerm, placeVerified, quietFetchWork, seedMaterial, WRITER } from '../support/drafts'
import {
  adminSetAppModel,
  clearFirestore,
  drainAlarms,
  emuRules,
  pairedVault,
  prodRules,
  seedRecords,
  useRules,
  type EmuVault,
} from './harness'

beforeAll(async () => {
  await useRules(prodRules)
})

beforeEach(async () => {
  await clearFirestore()
})

afterAll(async () => {
  await useRules(emuRules)
})

async function begin(v: EmuVault, kind: 'edition' | 'trial' | 'correction') {
  await drainAlarms(v)
  const r = await v.core.callTool('topic_begin_run', { kind, model: WRITER }, { grant: v.grant })
  const m = /runId: (r\d{12}-[0-9a-z]{4})/.exec(r.text)
  if (!m) throw new Error(`回を始められません: ${r.text}`)
  const runId = m[1]
  await drainAlarms(v)
  const call = (tool: string, args: Record<string, unknown> = {}) => v.core.callTool(tool, { runId, ...args }, { grant: v.grant })
  return { runId, call }
}

/** 管理者の権限で記録の json を読み、アプリと同じ確かめを通す */
async function cloudRecord(owner: string, table: TableName, id: string): Promise<Record<string, unknown>> {
  const json = await adminStringField(`users/${owner}/records/${table}:${id}`, 'json')
  expect(json, `${table}:${id}`).toBeTruthy()
  const rec = JSON.parse(json!) as Record<string, unknown>
  expect(checkRecord(table, rec, { outlets: FAKE_OUTLETS }).errors, `${table}:${id}`).toEqual([])
  return rec
}

const vault = () => pairedVault({ outlets: FAKE_OUTLETS, fetchWork: quietFetchWork() })

describe('足す道具（本番のアクセスルール）', () => {
  it('下書き → 照合 → 話題（辞書の束が先）→ 版 がルールを通り、書いた記録をクラウドから読み直せる', async () => {
    const v = await vault()
    const { runId, call } = await begin(v, 'edition')
    const ids: string[] = []
    for (let i = 1; i <= 5; i++) {
      seedMaterial(v.core, runId, i)
      ids.push(await placeVerified(call, v.clock, draftInput(i, { terms: i === 1 ? [newTerm('作り物の結合の語')] : [] })))
    }
    const added = await call('topic_add_topics', { items: ids.map((draft, i) => ({ draft, rank: i + 1 })) })
    expect(added.isError, added.text).toBeUndefined()
    const topicIds = v.core.store.drafts(runId).map((d) => d.topicId!)
    const edition = await call('topic_add_edition', { order: ids, candidateCount: 7, notChosen: [] })
    expect(edition.isError, edition.text).toBeUndefined()
    const editionId = v.core.store.getRun(runId)!.editionId!
    // クラウドの記録（アプリと同じ確かめを通る。device は claude-connector）
    const docs = await adminDocIds(v.owner, 'records')
    expect(docs.filter((d) => d.startsWith('termPacks:'))).toHaveLength(1)
    expect(docs.filter((d) => d.startsWith('topics:')).sort()).toEqual(topicIds.map((t) => `topics:${t}`).sort())
    expect(docs).toContain(`editions:${editionId}`)
    const e = await cloudRecord(v.owner, 'editions', editionId)
    expect(e.order).toEqual(topicIds)
    for (const t of topicIds) await cloudRecord(v.owner, 'topics', t)
    expect(await adminStringField(`users/${v.owner}/records/editions:${editionId}`, 'device')).toBe('claude-connector')
    // 写しを消して取り込み直しても、同じ記録が読める（コネクタが書いた形を、コネクタの読み方で読み戻せる）
    v.core.mirror.reset()
    v.core.store.putTask('mirror', v.clock.now)
    await drainAlarms(v)
    expect(v.core.mirror.has('editions', editionId)).toBe(true)
    for (const t of topicIds) expect(v.core.mirror.has('topics', t)).toBe(true)
    // 前の版の話題として見える
    const recent = await v.core.callTool('topic_list_recent', {}, { grant: v.grant })
    expect(recent.text).toContain(topicShortId(topicIds[0]))
  })

  it('書き込みの許可をオフにすると、話題も版も断る（何も書かない）。作れなかった印も書かない', async () => {
    const v = await vault()
    const { runId, call } = await begin(v, 'edition')
    const ids: string[] = []
    for (let i = 1; i <= 5; i++) {
      seedMaterial(v.core, runId, i)
      ids.push(await placeVerified(call, v.clock, draftInput(i)))
    }
    await adminWriteConnector(v.uid, { writes: false, pairedAt: new Date(v.clock.now) })
    v.clock.now += 2 * 60_000
    const r = await call('topic_add_topics', { items: ids.map((draft, i) => ({ draft, rank: i + 1 })) })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('書き込みは停止中です')
    const f = await call('topic_add_edition_fail', { reasonKind: 'other', reason: '作り物の訳' })
    expect(f.isError).toBe(true)
    expect(await adminDocIds(v.owner, 'records')).toEqual([])
  })

  it('試しの回は、話題・版・辞書の束をクラウドに書かない', async () => {
    const v = await vault()
    const { runId, call } = await begin(v, 'trial')
    const ids: string[] = []
    for (let i = 1; i <= 5; i++) {
      seedMaterial(v.core, runId, i)
      ids.push(await placeVerified(call, v.clock, draftInput(i, { terms: [newTerm(`作り物の試しの語${i}`)] })))
    }
    expect((await call('topic_add_topics', { items: ids.map((draft, i) => ({ draft, rank: i + 1 })) })).isError).toBeUndefined()
    expect((await call('topic_add_edition', { order: ids, candidateCount: 5 })).isError).toBeUndefined()
    expect(await adminDocIds(v.owner, 'records')).toEqual([])
  })

  it('訂正だけの回の訂正がルールを通る（版の order の話題だけ。答えに作った時刻を出さない）。データの形の版が違えば断る', async () => {
    const v = await vault()
    const fake = makeFakeEdition({ date: jstDateOf(v.clock.now - 24 * 3_600_000), slot: '20', seed: 'emu-corr' })
    await seedRecords(v.owner, fakeRecordsOf(fake))
    const { call } = await begin(v, 'correction')
    const topic = fake.topics[0]
    const text = '作り物の数は 3本ではなく 4本でした'
    const r = await call('topic_add_correction', { model: WRITER, topic: topicShortId(topic.id), text })
    expect(r.isError, r.text).toBeUndefined()
    const id = correctionIdOf({ topicId: topic.id, text })
    const rec = await cloudRecord(v.owner, 'corrections', id)
    expect(rec).toMatchObject({ topicId: topic.id, text })
    // アプリの版を上げた（データの形が違う）後は書かない
    await adminSetAppModel(v.owner, 99)
    v.clock.now += 2 * 60_000
    const again = await call('topic_add_correction', {
      model: WRITER,
      topic: topicShortId(topic.id),
      text: '作り物の別の訂正の文',
    })
    expect(again.isError).toBe(true)
    expect(again.text).toContain('アプリが新しい版のデータを書いています')
  })
})
