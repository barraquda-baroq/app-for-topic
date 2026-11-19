// 入力から記録を組み立てる（段階3の設計の 1.5・7. の「単体（ルート）」）: 用語の写し・「知ってる」の語を外す・新しい語の rev・強調の要素ごと → 鍵・
// 社の名前と並び（outletNames は出典の社だけ）・続報の threadId・出典は控えだけ（読んでいない・本文の短い控えは断る）・author は値がある時だけ
// 欄を書く・掲載日時を直す・共通の注記を外す。作り物の版との往復は src/test/fixtures/fakeInputs.test.ts。
// 中身は作り物（社は作り物の一覧、URL は https://example.com/…、モデルは fake-writer-model）
import { describe, expect, it } from 'vitest'
import { fakeAssembleContextOf, fakeDictOfTopic, fakeInputOf } from '../test/fixtures/fakeInputs'
import { FAKE_CREDIT_OUTLETS } from '../test/fixtures/fakeOutlets'
import { makeSampleTopic } from '../test/fixtures/sampleTopic'
import { assembleTopic, type AssembleContext, type SourceMaterial } from './assemble'
import { FIXED_TEXTS } from './fixedTexts'
import { termIdOf, topicIdOf, topicShortId } from './ids'
import type { TopicDraftInput } from './input'
import { PUBLISHED_UNKNOWN_NOTE } from './jst'
import { SOURCE_BODY_MIN_CHARS } from './limits'
import { createOutletDirectory } from './outlets'
import { applyPack } from './terms'
import type { TermEntry } from './types'

/** 作り物の話題（段階3の形: outletNames は出典の社だけ） */
const sample = makeSampleTopic((t) => (t.outletNames = ['〇〇通信', '◇◇日報']))
const dict = fakeDictOfTopic(sample)

/** 作り物の話題の入力と手がかり（edit で入力・控え・手がかりを変える） */
function setup(
  edit: (x: { input: TopicDraftInput; materials: Map<string, SourceMaterial>; ctx: AssembleContext }) => void = () => {},
) {
  const { input, materials } = fakeInputOf(sample, dict)
  const ctx = fakeAssembleContextOf(sample, materials, { dict })
  const x = { input, materials, ctx }
  edit(x)
  return assembleTopic(x.input, x.ctx)
}
const codes = (r: { errors: { path: string; code: string }[] }) => r.errors.map((e) => [e.path, e.code])

describe('組み立て: そのまま', () => {
  it('作り物の話題の入力は、作り物と同じ記録になる（入力は変えない）', () => {
    const { input, materials } = fakeInputOf(sample, dict)
    const before = JSON.stringify(input)
    const r = assembleTopic(input, fakeAssembleContextOf(sample, materials, { dict }))
    expect(r.errors).toEqual([])
    expect(r.topic).toEqual(sample)
    expect(r.topic?.id).toBe(topicIdOf(sample))
    expect(JSON.stringify(input)).toBe(before)
    expect(r.termEntries).toEqual([])
  })
})

describe('組み立て: 用語', () => {
  it('termId で指した語は、term 以外を辞書から写す（入力に説明を書かない）', () => {
    const r = setup()
    expect(r.topic?.terms).toEqual(sample.terms)
  })

  it('表記で指す（辞書の表記か別名）。2つ以上に当たれば断る', () => {
    const t0 = sample.terms[0]
    const r = setup((x) => (x.input.terms[0] = { term: t0.term }))
    expect(r.topic?.terms[0]).toEqual(t0)
    const twin: TermEntry = { ...dict.get(t0.termId)!, termId: termIdOf(`${t0.term}（米国）`), key: `${t0.term}（米国）` }
    const amb = setup((x) => {
      x.ctx.dict = applyPack(dict, [twin])
      x.input.terms[0] = { term: t0.term }
    })
    expect(codes(amb)).toEqual([['terms.0', 'term-ambiguous']])
    expect(amb.topic).toBeNull()
  })

  it('辞書に無い語・外した語は断る', () => {
    expect(codes(setup((x) => (x.input.terms[1] = { termId: 'tzzzzzzzzzzzz' })))).toEqual([['terms.1', 'term-not-found']])
    const t0 = sample.terms[0]
    const r = setup((x) => (x.ctx.dict = applyPack(dict, [{ ...dict.get(t0.termId)!, rev: 2, retired: true }])))
    expect(codes(r)).toEqual([['terms.0', 'term-retired']])
  })

  it('新しい語は rev 1 で辞書に足す語として返し、記録には辞書の写しの形で入る', () => {
    const r = setup((x) =>
      x.input.terms.push({
        new: { key: '橋の点検', term: '点検', aliases: [], explanation: '橋の傷みを調べる作業です。', asOf: null },
      }),
    )
    expect(r.errors).toEqual([])
    const termId = termIdOf('橋の点検')
    expect(r.termEntries).toEqual([
      { termId, key: '橋の点検', term: '点検', aliases: [], explanation: '橋の傷みを調べる作業です。', asOf: null, rev: 1 },
    ])
    expect(r.topic?.terms.at(-1)).toEqual({
      termId,
      term: '点検',
      aliases: [],
      explanation: '橋の傷みを調べる作業です。',
      asOf: null,
    })
  })

  it('辞書にある語を new で書くと断る（termId で指すか revise）。新しい語の文に URL・改行があれば断る', () => {
    const t0 = sample.terms[0]
    const exists = setup((x) =>
      x.input.terms.push({ new: { key: t0.term, term: t0.term, aliases: [], explanation: '別の説明です。', asOf: null } }),
    )
    expect(codes(exists)).toEqual([[`terms.${sample.terms.length}`, 'term-exists']])
    const plain = setup((x) =>
      x.input.terms.push({
        new: { key: '新語', term: '新語', aliases: [], explanation: 'https://example.com/ を見てください', asOf: null },
      }),
    )
    expect(codes(plain)).toEqual([[`terms.${sample.terms.length}.new.explanation`, 'term:plain']])
  })

  it('説明を新しくすると rev は今の辞書の rev ＋1。同じ回のほかの下書きの新しい説明が違えば断る', () => {
    const t0 = sample.terms[0]
    const r = setup(
      (x) => (x.input.terms[0] = { termId: t0.termId, revise: { explanation: '新しい説明です。', asOf: '2026-11' } }),
    )
    expect(r.errors).toEqual([])
    expect(r.termEntries).toEqual([{ ...dict.get(t0.termId), explanation: '新しい説明です。', asOf: '2026-11', rev: 2 }])
    expect(r.topic?.terms[0]).toMatchObject({ termId: t0.termId, explanation: '新しい説明です。', asOf: '2026-11' })
    const pending: TermEntry = { ...dict.get(t0.termId)!, explanation: 'ほかの下書きの説明です。', rev: 2 }
    const conflict = setup((x) => {
      x.ctx.runEntries = [pending]
      x.input.terms[0] = { termId: t0.termId, revise: { explanation: '新しい説明です。', asOf: '2026-11' } }
    })
    expect(codes(conflict)).toEqual([['terms.0', 'term-conflict']])
  })

  it('同じ回のほかの下書きで新しくした説明は、termId で指した語にも写る（同じ版の話題どうしでぶれない）', () => {
    const t0 = sample.terms[0]
    const pending: TermEntry = { ...dict.get(t0.termId)!, explanation: 'ほかの下書きの説明です。', rev: 2 }
    const r = setup((x) => (x.ctx.runEntries = [pending]))
    expect(r.topic?.terms[0].explanation).toBe('ほかの下書きの説明です。')
    expect(r.termEntries).toEqual([])
  })

  it('「いまの説明で知ってる」語は外して返す（説明が新しくなった語は外さない）', () => {
    const [t0, t1] = sample.terms
    const r = setup(
      (x) =>
        (x.ctx.known = new Map([
          [t0.termId, { on: true, asOf: null }],
          [t1.termId, { on: false, asOf: null }],
        ])),
    )
    expect(r.droppedKnown).toEqual([{ termId: t0.termId, term: t0.term }])
    expect(r.topic?.terms.map((t) => t.termId)).toEqual(sample.terms.slice(1).map((t) => t.termId))
    const revised = setup((x) => {
      x.ctx.known = new Map([[t0.termId, { on: true, asOf: '2026-10' }]])
      x.input.terms[0] = { termId: t0.termId, revise: { explanation: '新しい説明です。', asOf: '2026-11' } }
    })
    expect(revised.droppedKnown).toEqual([])
  })

  it('表記の重なり（別名がほかの語の表記に当たる）は断り、外した語の後ろの番号は入力の番号で返す', () => {
    const t0 = sample.terms[0]
    const r = setup((x) =>
      x.input.terms.push({
        new: { key: '新しい語', term: '新しい語', aliases: [t0.term], explanation: '作り物の説明です。', asOf: null },
      }),
    )
    expect(codes(r)).toContainEqual([`terms.${sample.terms.length}`, 'term-overlap'])
    // 1つ目を知ってるで外すと、記録の番号は1つずれるが、断る物の道は入力の番号
    const dup = setup((x) => {
      x.ctx.known = new Map([[t0.termId, { on: true, asOf: null }]])
      x.input.terms[2] = { termId: sample.terms[1].termId }
    })
    expect(codes(dup)).toEqual([['terms.2.termId', 'rule']])
  })
})

describe('組み立て: 強調', () => {
  it('要素ごとの入力を記録の鍵にする（空の並びは鍵を書かない）', () => {
    const r = setup((x) => {
      x.input.timeline[0].emphasis = []
      x.input.stakeholders[1].claimEmphasis = undefined
    })
    expect(r.errors).toEqual([])
    expect(r.topic?.emphasis['stakeholders.1.claim']).toBeUndefined()
    expect(r.topic?.emphasis['stakeholders.0.claim']).toEqual(sample.emphasis['stakeholders.0.claim'])
    expect(r.topic?.emphasis['timeline.1.text']).toEqual(sample.emphasis['timeline.1.text'])
  })

  it('欄に無い語句の断る物は、入力の道（claimEmphasis・emphasis.…）で返す', () => {
    const r = setup((x) => {
      x.input.stakeholders[0].claimEmphasis = ['欄に無い語句']
      x.input.emphasis = { ...x.input.emphasis, summary: ['これも無い'] }
    })
    expect(codes(r)).toEqual([
      ['emphasis.summary', 'emphasis:not-found'],
      ['stakeholders.0.claimEmphasis', 'emphasis:not-found'],
    ])
  })

  it('欄ごとの強調に、要素ごとの欄の鍵は書けない', () => {
    const r = setup((x) => ((x.input.emphasis as Record<string, string[]>)['stakeholders.0.claim'] = ['通行料は無料にすべき']))
    expect(codes(r)).toEqual([['emphasis.stakeholders.0.claim', 'emphasis:unknown-key']])
  })
})

describe('組み立て: 出典', () => {
  it('社は控えのホストから。1つのホストに社が2つ以上ある時は outlet で決め、そのホストの社かを確かめる', () => {
    expect(codes(setup((x) => delete x.input.sources[0].outlet))).toEqual([['sources.0.outlet', 'source-outlet']])
    const wrong = setup((x) => (x.input.sources[0].outlet = '◎◎社'))
    expect(codes(wrong)).toEqual([['sources.0.outlet', 'source-outlet']])
    // 別名で書いても決まった書き方にそろえる
    const alias = setup((x) => (x.input.sources[0].outlet = '〇〇'))
    expect(alias.topic?.sources[0].outlet).toBe('〇〇通信')
  })

  it('ホストの社が1つなら outlet は要らない。一覧に無いホストは断る', () => {
    const one = createOutletDirectory({
      outlets: [{ name: '〇〇省', hosts: ['example.com'], credit: { form: 'site', siteName: '〇〇省ホームページ' } }],
      vias: [],
    })
    const r = setup((x) => {
      x.ctx.outlets = one
      x.input.sources = [{ ref: x.input.sources[0].ref }]
    })
    expect(r.errors).toEqual([])
    expect(r.topic?.sources.map((s) => s.outlet)).toEqual(['〇〇省'])
    expect(r.topic?.outletNames).toEqual(['〇〇省'])
    const unknownHost = setup((x) => (x.materials.get(x.input.sources[0].ref)!.url = 'https://example.org/a'))
    expect(codes(unknownHost)).toEqual([['sources.0.outlet', 'source-outlet']])
    const noOutlet = setup((x) => {
      x.materials.get(x.input.sources[0].ref)!.url = 'https://example.org/a'
      delete x.input.sources[0].outlet
    })
    expect(codes(noOutlet)).toEqual([['sources.0.ref', 'source-outlet']])
  })

  it('outletNames は出典の社だけから、出典の順に重なりを除いて作る。出典を消すと組み立て直る', () => {
    const r = setup((x) => x.input.sources.push({ ref: x.input.sources[0].ref.replace(/..$/, '09'), outlet: '△△新聞' }))
    // 控えの無い ref は断る
    expect(codes(r)).toEqual([['sources.2.ref', 'source-unknown']])
    const two = setup((x) => {
      const ref = 'c0109'
      x.materials.set(ref, { ...x.materials.get(x.input.sources[0].ref)!, url: 'https://example.com/news/3' })
      x.input.sources.push({ ref, outlet: '〇〇通信' })
    })
    expect(two.topic?.outletNames).toEqual(['〇〇通信', '◇◇日報'])
    const one = setup((x) => x.input.sources.splice(1, 1))
    expect(one.topic?.outletNames).toEqual(['〇〇通信'])
    // 段階2までの記録のように出典でない社（△△新聞）を並べた話題も、組み立てると出典の社だけになる
    const stage2 = makeSampleTopic()
    expect(stage2.outletNames).toContain('△△新聞')
    const { input, materials } = fakeInputOf(stage2, dict)
    expect(assembleTopic(input, fakeAssembleContextOf(stage2, materials, { dict })).topic?.outletNames).toEqual([
      '〇〇通信',
      '◇◇日報',
    ])
  })

  it('この回で読んでいない資料・本文が200字未満の資料・同じ資料の2回目は出典にできない', () => {
    expect(codes(setup((x) => (x.materials.get(x.input.sources[0].ref)!.read = false)))).toEqual([
      ['sources.0.ref', 'source-unread'],
    ])
    expect(SOURCE_BODY_MIN_CHARS).toBe(200)
    expect(codes(setup((x) => (x.materials.get(x.input.sources[0].ref)!.bodyChars = SOURCE_BODY_MIN_CHARS - 1)))).toEqual([
      ['sources.0.ref', 'source-short'],
    ])
    expect(setup((x) => (x.materials.get(x.input.sources[0].ref)!.bodyChars = SOURCE_BODY_MIN_CHARS)).errors).toEqual([])
    expect(codes(setup((x) => x.input.sources.push({ ...x.input.sources[0] })))).toEqual([['sources.2.ref', 'source-dup']])
  })

  it('掲載日時は日本時間に直し、読めない時は「掲載日時は不明」。題は控えの物を上限で切る', () => {
    const r = setup((x) => {
      const m = x.materials.get(x.input.sources[0].ref)!
      m.published = '2026-11-15T01:00:00Z'
      m.publishedNote = null
      m.title = `${'題'.repeat(210)}`
      const m2 = x.materials.get(x.input.sources[1].ref)!
      m2.published = '読めない日時'
      m2.publishedNote = undefined
    })
    expect(r.errors).toEqual([])
    expect(r.topic?.sources[0]).toMatchObject({ publishedAt: '2026-11-15T10:00:00+09:00', publishedNote: null })
    expect(Array.from(r.topic?.sources[0].title ?? '')).toHaveLength(200)
    expect(r.topic?.sources[1]).toMatchObject({ publishedAt: null, publishedNote: PUBLISHED_UNKNOWN_NOTE })
  })

  it('著者は控えに値がある時だけ欄を書く。cc-by の社は著者の無い資料を出典にできない', () => {
    const cc = FAKE_CREDIT_OUTLETS.ccBy
    const withAuthor = setup((x) => {
      x.input.sources[0].outlet = cc
      x.materials.get(x.input.sources[0].ref)!.author = ' FAKE_作り物の著者 '
    })
    expect(withAuthor.errors).toEqual([])
    expect(withAuthor.topic?.sources[0]).toMatchObject({ outlet: cc, author: 'FAKE_作り物の著者' })
    expect('author' in (withAuthor.topic?.sources[1] ?? {})).toBe(false)
    const noAuthor = setup((x) => (x.input.sources[0].outlet = cc))
    expect(codes(noAuthor)).toEqual([['sources.0.ref', 'source-author']])
    // 著者の欄のある出典は指紋が変わる（無い出典は変わらない）
    expect(withAuthor.topic?.id).not.toBe(setup((x) => (x.input.sources[0].outlet = FAKE_CREDIT_OUTLETS.site)).topic?.id)
  })

  it('読んだ所の資料は、元の社を outlet で書く（読んだ所は控えから）', () => {
    expect(codes(setup((x) => delete x.input.sources[1].outlet))).toEqual([['sources.1.outlet', 'source-outlet']])
    expect(setup().topic?.sources[1]).toMatchObject({ outlet: '◇◇日報', via: '××ニュース' })
  })
})

describe('組み立て: 続報・文', () => {
  const prev = makeSampleTopic((t) => ((t.editionId = '2026-11-14-20'), (t.headline = '前の版の話題')))
  const followUp = (x: { input: TopicDraftInput; ctx: AssembleContext }) => {
    x.input.followUp = { prev: topicShortId(prev.id), whatsNew: '市が開通の日を決めた' }
    x.ctx.recentTopics = [{ id: prev.id, threadId: prev.id }]
  }

  it('prev（p:＋8字）を前の版の話題の一覧で解き、prevTopicId と threadId を写す', () => {
    const r = setup(followUp)
    expect(r.errors).toEqual([])
    expect(r.topic?.followUp).toEqual({ prevTopicId: prev.id, whatsNew: '市が開通の日を決めた' })
    expect(r.topic?.threadId).toBe(prev.id)
  })

  it('前の話題の threadId を写す（鎖の頭の id）', () => {
    const head = makeSampleTopic((t) => ((t.editionId = '2026-11-13-12'), (t.headline = '鎖の頭')))
    const r = setup((x) => {
      followUp(x)
      x.ctx.recentTopics = [{ id: prev.id, threadId: head.id }]
    })
    expect(r.topic?.threadId).toBe(head.id)
  })

  it('続報でない話題の threadId は自分の id', () => {
    const r = setup()
    expect(r.topic?.threadId).toBe(r.topic?.id)
  })

  it('前後の空白を除き、共通の注記を外す（アプリが出す決まった文）', () => {
    const r = setup((x) => {
      x.input.headline = `  ${sample.headline} `
      if (x.input.view.kind === 'opposed') x.input.view.counterView = `${x.input.view.counterView}${FIXED_TEXTS.commonNote}`
      x.input.unverified = [` ${sample.unverified[0]}\n`]
    })
    expect(r.errors).toEqual([])
    expect(r.topic).toEqual(sample)
  })

  it('記録の共通の欄は手がかりから（モデル・回・作った時刻・照合の件数）', () => {
    const r = setup((x) => {
      x.ctx.model = 'fake-writer-model'
      x.ctx.runId = 'r202611151016-abcd'
      x.ctx.createdAt = 1
    })
    expect(r.topic).toMatchObject({ model: 'fake-writer-model', runId: 'r202611151016-abcd', createdAt: 1 })
    // 指紋の外の欄なので、id は同じ
    expect(r.topic?.id).toBe(sample.id)
    // 照合の前の下書きは check が null（指紋に入るので id は変わる）
    const unchecked = setup((x) => (x.ctx.check = null))
    expect(unchecked.topic?.check).toBeNull()
    expect(unchecked.topic?.id).not.toBe(sample.id)
  })

  it('checkTopic の断る物も入力の道で返す（主張が null なのに立場が残る）', () => {
    const r = setup((x) => (x.input.stakeholders[0].claim = null))
    expect(codes(r)).toContainEqual(['stakeholders.0', 'rule'])
    expect(r.topic).toBeNull()
  })
})
