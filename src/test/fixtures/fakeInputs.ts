// 作り物の記録 → 書く係の入力（段階3。段階3の設計の 1.5 の「組み立てる所と置き場」・map-ts 6.2）。作り物の版（src/test/fixtures/fakeEditions.ts）は
// 「コネクタの出力の形」で作ってあるので、記録から入力（src/domain/input.ts の TopicDraftInput）と、その回の資料の控え（出典の元）・辞書の今の形・
// 前の版の話題を作り、組み立て（src/domain/assemble.ts）に通すと、作り物と同じ id・同じ記録に戻る事を確かめる
// （src/test/fixtures/fakeInputs.test.ts。コネクタ・作り物・アプリの3つの形が1つの所で合う）。
// - 用語は termId で指す（記録の表記が辞書の表記と違う時だけ表記も添える）。辞書はその版までの束を重ねた今の形
// - 強調は記録の鍵（'stakeholders.2.claim' など）を要素ごとの入力に戻す
// - 出典は控えの ref（'c'＋順位2桁＋出典の番号2桁）と社（作り物の社はどれも example.com なので、いつも outlet を書く）。控えは記録の出典から
//   （本文の字数は作り物の 1,000字・この回で読んだ物）。読んだ所（××ニュース）の出典は、控えに読んだ所を持たせる
// - 続報は前の話題の短い id（'p:'＋8字）
// 中身はすべて作り物（社は作り物の一覧、URL は https://example.com/… だけ）。
import type { AssembleContext, SourceMaterial } from '../../domain/assemble'
import { parseEmphasisKey } from '../../domain/emphasis'
import type { InputEmphasisField, StakeholderInput, TermRefInput, TimelineInput, TopicDraftInput } from '../../domain/input'
import { INPUT_EMPHASIS_FIELDS } from '../../domain/input'
import { termIdOf, topicShortId } from '../../domain/ids'
import { dictionaryOf, type TermDictionary } from '../../domain/terms'
import type { TermEntry, Topic } from '../../domain/types'
import type { FakeEdition, FakeMonth } from './fakeEditions'
import { FAKE_OUTLETS } from './fakeOutlets'

/** 作り物の資料の本文の字数（出典にできる 200字以上） */
export const FAKE_BODY_CHARS = 1000

/** 記録から作った入力と、その回の資料の控え（ref → 控え） */
export interface FakeInput {
  input: TopicDraftInput
  materials: Map<string, SourceMaterial>
}

/** 出典の控えの ref（'c'＋順位2桁＋出典の番号2桁） */
export const fakeSourceRefOf = (rank: number, index: number): string =>
  `c${String(rank).padStart(2, '0')}${String(index + 1).padStart(2, '0')}`

/**
 * 作り物の記録を、書く係の入力と資料の控えにする（知らない強調の鍵がある記録は投げる。作り物の版の 19位・20位は、コネクタなら断る物と
 * 後の版の記録の見本なので、入力にしない）。dict を渡すと、記録の表記が辞書の表記と同じ用語は termId だけで指す
 */
export function fakeInputOf(topic: Topic, dict?: TermDictionary): FakeInput {
  const emphasisOf = new Map<string, string[]>()
  for (const [key, phrases] of Object.entries(topic.emphasis)) {
    if (!parseEmphasisKey(key)) throw new Error(`作り物の記録 ${topic.id} に知らない強調の鍵「${key}」があります`)
    emphasisOf.set(key, [...phrases])
  }
  const fieldEmphasis: Partial<Record<InputEmphasisField, string[]>> = {}
  for (const f of INPUT_EMPHASIS_FIELDS) {
    const v = emphasisOf.get(f)
    if (v) fieldEmphasis[f] = v
  }
  const stakeholders = topic.stakeholders.map((s, i): StakeholderInput => {
    const e = emphasisOf.get(`stakeholders.${i}.claim`)
    return {
      name: s.name,
      stance: s.stance,
      stanceNote: s.stanceNote,
      claim: s.claim,
      reason: s.reason,
      ...(e ? { claimEmphasis: e } : {}),
    }
  })
  const timeline = topic.timeline.map((t, i): TimelineInput => {
    const e = emphasisOf.get(`timeline.${i}.text`)
    return { when: t.when, text: t.text, ...(e ? { emphasis: e } : {}) }
  })
  const terms = topic.terms.map(
    (t): TermRefInput => (dict?.get(t.termId)?.term === t.term ? { termId: t.termId } : { termId: t.termId, term: t.term }),
  )
  const materials = new Map<string, SourceMaterial>()
  const sources = topic.sources.map((s, i) => {
    const ref = fakeSourceRefOf(topic.rank, i)
    materials.set(ref, {
      url: s.url,
      title: s.title,
      published: s.publishedAt,
      publishedNote: s.publishedNote,
      bodyChars: FAKE_BODY_CHARS,
      read: true,
      ...(s.author !== undefined ? { author: s.author } : {}),
      ...(s.via !== null ? { via: s.via } : {}),
    })
    return { ref, outlet: s.outlet }
  })
  const input: TopicDraftInput = {
    rank: topic.rank,
    rankReason: topic.rankReason,
    region: topic.region,
    genre: topic.genre,
    major: topic.major,
    headline: topic.headline,
    summary: topic.summary,
    conclusion: { ...topic.conclusion },
    soWhat: { ...topic.soWhat },
    stakeholders,
    view: { ...topic.view },
    timeline,
    followUp: topic.followUp ? { prev: topicShortId(topic.followUp.prevTopicId), whatsNew: topic.followUp.whatsNew } : null,
    terms,
    sources,
    unverified: [...topic.unverified],
    ...(Object.keys(fieldEmphasis).length ? { emphasis: fieldEmphasis } : {}),
  }
  return { input, materials }
}

/** 組み立ての手がかり（記録の共通の欄・照合の件数は、比べるために作り物の記録から写す） */
export function fakeAssembleContextOf(
  topic: Topic,
  materials: ReadonlyMap<string, SourceMaterial>,
  opts: { dict: TermDictionary; recentTopics?: readonly { id: string; threadId: string }[] },
): AssembleContext {
  return {
    editionId: topic.editionId,
    runId: topic.runId,
    model: topic.model,
    createdAt: topic.createdAt,
    check: topic.check,
    dict: opts.dict,
    recentTopics: opts.recentTopics ?? [],
    material: (ref) => materials.get(ref) ?? null,
    outlets: FAKE_OUTLETS,
  }
}

/** 作り物の記録1本の、入力と組み立ての手がかり */
export interface FakeInputCase {
  topic: Topic
  input: TopicDraftInput
  ctx: AssembleContext
}

/** 前の版の話題を見る版の数（topic_list_recent の直近3日・6版） */
export const FAKE_RECENT_EDITIONS = 6

/**
 * 作り物の版（1つの版か、何日分か）の話題の、入力と組み立ての手がかり（版の順）。辞書はその版までの束を重ねた今の形、前の版の話題は
 * その版の前の6版の話題。19位（コネクタなら断る物）・20位（後の版の記録の見本）は入れない
 */
export function fakeInputCasesOf(src: FakeEdition | FakeMonth): FakeInputCase[] {
  const editions = 'editions' in src ? src.editions : [src]
  const out: FakeInputCase[] = []
  const packs: { entries: readonly TermEntry[] }[] = []
  editions.forEach((ed, n) => {
    packs.push(ed.termPack)
    const dict = dictionaryOf(packs)
    const recentTopics = editions
      .slice(Math.max(0, n - FAKE_RECENT_EDITIONS), n)
      .flatMap((e) => e.topics.map((t) => ({ id: t.id, threadId: t.threadId })))
    const skip = new Set([ed.scenes.connectorRejects, ed.scenes.newerValues])
    for (const topic of ed.topics) {
      if (skip.has(topic.id)) continue
      const { input, materials } = fakeInputOf(topic, dict)
      out.push({ topic, input, ctx: fakeAssembleContextOf(topic, materials, { dict, recentTopics }) })
    }
  })
  return out
}

/** 記録の用語から辞書を作る（key = 表記。単体テストの作り物の話題（src/test/fixtures/sampleTopic.ts）のように、表記が key の物だけ） */
export function fakeDictOfTopic(topic: Topic): Map<string, TermEntry> {
  const entries = topic.terms.map((t): TermEntry => {
    if (termIdOf(t.term) !== t.termId) throw new Error(`用語「${t.term}」の key は表記ではありません`)
    return {
      termId: t.termId,
      key: t.term,
      term: t.term,
      aliases: [...t.aliases],
      explanation: t.explanation,
      asOf: t.asOf,
      rev: 1,
    }
  })
  return dictionaryOf([{ entries }])
}
