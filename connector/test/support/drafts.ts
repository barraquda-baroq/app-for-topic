// テスト用（B5）: 下書き・照合・足す道具の用意。作り物だけを使う（社は作り物の一覧 FAKE_OUTLETS、URL は https://example.com/… だけ、
// モデルは fake-writer-model・fake-checker-model）。候補と資料の控えは store の表に直に入れる（取りに行かない。設計の 6.1 の B5）。
// 取りに行く中身は、作り物の出どころの data（FAKE_SOURCES）を持ち、候補集めはすぐ終わる物（idleFetchWork の歩み）にする。
import type { TopicDraftInput } from '../../../src/domain/input'
import { FAKE_CHECK_MODEL, FAKE_MODEL } from '../../../src/test/fixtures/fakeEditions'
import { FAKE_CREDIT_OUTLETS, FAKE_OUTLETS } from '../../../src/test/fixtures/fakeOutlets'
import type { VaultCore } from '../../src/vault/core'
import type { FetchWork } from '../../src/vault/runs'
import type { MaterialRow } from '../../src/vault/store'
import { FakeFirebase } from './fakeFirebase'
import { fakeFetchWork, idleFetchWork } from './fakeNews'
import { drainAlarms, pairedCore } from './harness'

export const WRITER = FAKE_MODEL
export const CHECKER = FAKE_CHECK_MODEL
export const H = 'https://example.com'

/** 日本時間の時刻（2026-11-19） */
export const jst = (h: number, m = 0, day = 19) => Date.UTC(2026, 10, day, h - 9, m, 0)

/** 作り物の出どころの data を持ち、何も取りに行かない中身 */
export function quietFetchWork(): FetchWork {
  const idle = idleFetchWork()
  return {
    ...fakeFetchWork(),
    collectStep: idle.collectStep,
    rulesStep: idle.rulesStep,
    jmaWatchEnabled: idle.jmaWatchEnabled,
    jmaWatchStep: idle.jmaWatchStep,
  }
}

/** 作り物の発表の URL */
export const pressUrl = (n: number) => `${H}/fake-ministry/press/${1000 + n}.html`

/** 作り物の発表の本文（200字を超える。数字と日付を含む） */
export function pressBody(n: number): string {
  return [
    `〇〇市は令和8年11月15日、作り物の新しい橋の長さを320メートルにすると決めた。工事の費用は3万2,000円の作り物の見積もりで、${n}番目の作り物の発表である。`,
    '市は、朝夕の渋滞が2割ほど減る見通しを示した。通行料はまだ決まっていない。市は来年3月までに決めるとしている。',
    '作り物の説明の文が続く。作り物の説明の文が続く。作り物の説明の文が続く。作り物の説明の文が続く。作り物の説明の文が続く。',
    '作り物の説明の文が続く。作り物の説明の文が続く。作り物の説明の文が続く。作り物の説明の文が続く。作り物の説明の文が続く。',
  ].join('\n')
}

/** 候補と資料の控えを、表に直に入れる（cid は c0001 から。readAt を null にすると「読んでいない」） */
export function seedMaterial(
  core: VaultCore,
  runId: string,
  n: number,
  over: Partial<MaterialRow> & { readable?: boolean } = {},
): { cid: string; url: string } {
  const cid = `c${String(n).padStart(4, '0')}`
  const url = over.url ?? pressUrl(n)
  const body = over.body ?? pressBody(n)
  const now = core.now()
  core.store.putCandidates([
    {
      runId,
      cid,
      source: 'fake-html',
      url,
      title: `作り物の発表${n}`,
      published: '令和8年11月15日',
      atMs: now - 3_600_000,
      tags: [],
      readable: over.readable ?? true,
    },
  ])
  core.store.putMaterial({
    runId,
    url,
    source: over.source ?? 'fake-html',
    title: over.title ?? `作り物の発表${n}`,
    published: over.published ?? '2026-11-15T10:00:00+09:00',
    publishedNote: null,
    author: over.author ?? null,
    via: null,
    body,
    bodyChars: over.bodyChars ?? Array.from(body).length,
    cut: false,
    fetched: now,
    readAt: over.readAt === undefined ? now : over.readAt,
  })
  return { cid, url }
}

/** 作り物の下書きの入力（断られない形。n で中身を変える） */
export function draftInput(n: number, over: Partial<TopicDraftInput> = {}): TopicDraftInput {
  return {
    rank: n,
    rankReason: `作り物の順位の理由${n}`,
    region: 'jp',
    genre: 'politics',
    major: false,
    headline: `作り物の見出し${n}　〇〇市が新しい橋の長さを320メートルに決めた`,
    summary: `〇〇市は15日、作り物の新しい橋の長さを320メートルにすると決めた（${n}番目の作り物）。市は朝夕の渋滞が2割ほど減る見通しを示した。通行料はまだ決まっていない。市は来年3月までに決めるとしている。作り物の文で長さを足す。作り物の文で長さを足す。作り物の文で長さを足す。`,
    conclusion: { label: 'settled', note: '橋の長さは決まり、通行料はまだ決まっていない', breaking: false },
    soWhat: { life: null, system: '市の作り物の仕組みの説明', world: null, whyNews: null },
    stakeholders: [],
    view: { kind: 'none', noneReason: '発表された数の事実だけの話題のため' },
    timeline: [{ when: '2026-11-15', text: '〇〇市が橋の長さを決めた' }],
    followUp: null,
    terms: [],
    sources: [{ ref: `c${String(n).padStart(4, '0')}`, outlet: FAKE_CREDIT_OUTLETS.site }],
    unverified: [],
    emphasis: { summary: ['320メートル'] },
    ...over,
  }
}

/** 作り物の辞書に無い語 */
export const newTerm = (key: string, explanation = `作り物の語「${key}」の説明`) => ({
  new: { key, term: key, aliases: [] as string[], explanation, asOf: '2026-11' },
})

/** 連携した Vault（作り物の社と作り物の出どころの data）と、始めた回 */
export async function draftSetup(
  opts: {
    now?: number
    kind?: 'edition' | 'trial' | 'correction'
    fake?: FakeFirebase
    config?: Parameters<typeof pairedCore>[1]
  } = {},
) {
  const fake = opts.fake ?? new FakeFirebase()
  const now = opts.now ?? jst(10, 16)
  const made = await pairedCore(fake, { clock: { now }, outlets: FAKE_OUTLETS, fetchWork: quietFetchWork(), ...opts.config })
  await drainAlarms(made.core, made.clock)
  made.clock.now = now
  const begun = await made.core.callTool(
    'topic_begin_run',
    { kind: opts.kind ?? 'edition', model: WRITER },
    { grant: made.grant },
  )
  const m = /runId: (r\d{12}-[0-9a-z]{4})/.exec(begun.text)
  if (!m) throw new Error(`回を始められません: ${begun.text}`)
  const runId = m[1]
  await drainAlarms(made.core, made.clock)
  made.clock.now = now
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    made.core.callTool(tool, { runId, ...args }, { grant: made.grant })
  return { fake, ...made, runId, call }
}

/** 下書きの id（答えの頭の行の後の「d:01」） */
export const draftIdIn = (text: string): string => {
  const m = /(d:\d{2})/.exec(text)
  if (!m) throw new Error(`下書きの id がありません: ${text}`)
  return m[1]
}

type Call = (tool: string, args?: Record<string, unknown>) => ReturnType<VaultCore['callTool']>

/** 下書きを置いて、読んで、照合済みにする（直す所なし。時計を3分進めてから当てる） */
export async function placeVerified(
  call: Call,
  clock: { now: number },
  input: TopicDraftInput,
  opts: { patches?: unknown[]; claims?: number } = {},
): Promise<string> {
  const saved = await call('topic_save_draft', { model: WRITER, topic: input })
  if (saved.isError) throw new Error(`置けません: ${saved.text}`)
  const id = draftIdIn(saved.text)
  await call('topic_get_draft', { draft: id })
  clock.now += 3 * 60_000
  const checked = await call('topic_check_draft', {
    draft: id,
    model: CHECKER,
    claims: opts.claims ?? 4,
    patches: opts.patches ?? [],
  })
  if (checked.isError) throw new Error(`照合できません: ${checked.text}`)
  return id
}
