// 写しを本番のアクセスルールで（B3。設計の 1.9・2.1・7. の「エミュレーター」）: 記録されたコネクタは、読ませる6つの表を table in の
// 差分で読み（updated・__name__ の順と位置の続き）、既読（private）は読めない・表で絞らない問い合わせは断られる・消えないはずの表の数
// （table == の count）と名前で読み直す（table == と __name__ の順）が通る・30日を過ぎた記録は写しに入れない・連携を解除すると 401。
// 作り物の版（src/test/fixtures/fakeEditions.ts）だけを使い、エミュレーター（127.0.0.1）のほかへは出ない（test/support/netGuard.ts）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { jstDateOf } from '../../../src/domain/jst'
import { dictionaryOf, liveTerms } from '../../../src/domain/terms'
import { adminDeleteConnector, emulatorRequest } from '../../../src/test/emulatorAdmin'
import { fakeRecordsOf, makeFakeMonth } from '../../../src/test/fixtures/fakeEditions'
import { FirestoreError } from '../../src/vault/firestore'
import { mirrorQueries } from '../../src/vault/mirror'
import { clearFirestore, drainAlarms, emuRules, EMU_PROJECT, pairedVault, prodRules, seedRecords, useRules } from './harness'

beforeAll(async () => {
  await useRules(prodRules)
})

beforeEach(async () => {
  await clearFirestore()
})

afterAll(async () => {
  await useRules(emuRules)
})

const today = () => jstDateOf(Date.now())

describe('写し（本番のアクセスルール）', () => {
  it('読ませる6つの表を table in の差分で読み、既読（private）は届かない。辞書の束は辞書の今の形に当てる', async () => {
    const v = await pairedVault()
    const m = makeFakeMonth({ until: today(), days: 4 })
    const records = fakeRecordsOf(m)
    await seedRecords(v.owner, records)
    await seedRecords(
      v.owner,
      [
        {
          table: 'reads',
          record: {
            id: m.editions[0].edition.id,
            v: 1,
            createdAt: 1,
            updatedAt: 1,
            by: 'user',
            ai: null,
            editionId: m.editions[0].edition.id,
            topicIds: [],
            seen: true,
          } as never,
        },
      ],
      { place: 'private', device: 'device-a' },
    )
    await drainAlarms(v)
    expect(v.core.mirror.warm().done).toBe(true)
    const counts = v.core.mirror.counts()
    expect(counts.topics).toBe(m.editions.reduce((n, e) => n + e.topics.length, 0))
    expect(counts.editions).toBe(m.editions.length)
    expect(counts.termPacks).toBe(m.editions.length)
    expect(counts.corrections ?? 0).toBe(m.corrections.length)
    expect(counts.editionFails ?? 0).toBe(m.editionFails.length)
    expect(counts.reads).toBeUndefined()
    const want = liveTerms(dictionaryOf(m.editions.map((e) => e.termPack)))
    expect(v.core.store.allTerms().filter((e) => e.retired !== true).length).toBe(want.length)
    // 状態の道具も読める
    const st = await v.core.callTool('topic_status', {}, { grant: v.grant })
    expect(st.text).toContain('連携: 済み')
    expect(st.text).toContain(`いちばん新しい版: e:${m.editions[m.editions.length - 1].edition.id}`)
  })

  it('小さなページで位置を続けて読んでも、取りこぼし・読み直しが無い（作業の字数で区切り、alarm で続ける）', async () => {
    const v = await pairedVault({ config: { workBudgetChars: 20_000 } })
    const m = makeFakeMonth({ until: today(), days: 3 })
    await seedRecords(v.owner, fakeRecordsOf(m))
    await drainAlarms(v)
    expect(v.core.mirror.warm().done).toBe(true)
    expect(v.core.mirror.counts().topics).toBe(m.editions.reduce((n, e) => n + e.topics.length, 0))
  })

  it('表で絞らない問い合わせは、ルールが断る（コネクタは読ませる表を必ず絞る）', async () => {
    const v = await pairedVault()
    await seedRecords(v.owner, fakeRecordsOf(makeFakeMonth({ until: today(), days: 3 })))
    const err = await v.core.fs
      .runQuery(`users/${v.owner}`, {
        from: [{ collectionId: 'records' }],
        orderBy: [{ field: { fieldPath: '__name__' } }],
        limit: 5,
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FirestoreError)
    expect((err as FirestoreError).status).toBe(403)
    // 既読の表を table == で頼んでも断る
    const reads = await v.core.fs.runQuery(`users/${v.owner}`, mirrorQueries.byName('reads', null, 5)).catch((e: unknown) => e)
    expect(reads).toBeInstanceOf(FirestoreError)
  })

  it('消えないはずの表の数（table == の count）と、名前で読み直す（table == と __name__ の順）がルールを通る', async () => {
    const v = await pairedVault()
    const m = makeFakeMonth({ until: today(), days: 3 })
    await seedRecords(v.owner, fakeRecordsOf(m))
    await drainAlarms(v)
    expect(await v.core.mirror.recount(() => true)).toEqual([])
    // 辞書の束を1つ消す（作者が Firebase の画面で消した時と同じ）→ 数が合わない → 読み直して写しから外し、辞書を作り直す
    const gone = m.editions[0].termPack
    await emulatorRequest(
      'DELETE',
      `/v1/projects/${EMU_PROJECT}/databases/(default)/documents/users/${v.owner}/records/${encodeURIComponent(`termPacks:${gone.id}`)}`,
    )
    const tables = await v.core.mirror.recount(() => true)
    expect(tables).toEqual(['termPacks'])
    v.core.mirror.startRecheck(tables)
    v.core.store.putTask('mirror', v.clock.now)
    await drainAlarms(v)
    expect(v.core.mirror.has('termPacks', gone.id)).toBe(false)
    expect(v.core.dictionary.rebuilding()).toBe(false)
    const want = liveTerms(dictionaryOf(m.editions.slice(1).map((e) => e.termPack)))
    expect(
      v.core.store
        .allTerms()
        .filter((e) => e.retired !== true)
        .map((e) => e.termId)
        .sort(),
    ).toEqual(want.map((e) => e.termId).sort())
  })

  it('30日を過ぎた記録は写しに入れない（クラウドに残っていても、前の版の一覧に出さない）', async () => {
    const v = await pairedVault()
    const m = makeFakeMonth({ until: today(), days: 33 })
    await seedRecords(v.owner, fakeRecordsOf(m))
    await drainAlarms(v)
    const oldest = m.editions[0].edition.id
    expect(v.core.mirror.has('editions', oldest)).toBe(false)
    for (const t of m.editions[0].topics) expect(v.core.mirror.has('topics', t.id)).toBe(false)
    expect(v.core.mirror.has('editions', m.editions[m.editions.length - 1].edition.id)).toBe(true)
  })

  it('連携の記録を消すと（［連携をすべて解除］）、状態の道具は 401（auth）', async () => {
    const v = await pairedVault()
    await drainAlarms(v)
    expect((await v.core.callTool('topic_status', {}, { grant: v.grant })).isError).toBeUndefined()
    await adminDeleteConnector()
    const r = await v.core.callTool('topic_status', {}, { grant: v.grant })
    expect(r).toMatchObject({ isError: true, auth: true })
  })
})
