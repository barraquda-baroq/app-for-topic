// 上限と決まりの範囲（docs/SPEC.md の 7.1 の「上限の一覧と決まりの範囲」・7.2〜7.4・16.3）: 境目の字数で通り、1字多いと断る。
// 決まりの範囲の外は断らずに知らせる。名札・形・表どうしの決まりに合わない物は断る（コネクタが送る直前の確かめ）
import { describe, expect, it } from 'vitest'
import { FAKE_OUTLETS } from '../test/fixtures/fakeOutlets'
import { makeSampleTopic } from '../test/fixtures/sampleTopic'
import { correctionIdOf, editionFailIdOf, termIdOf, termPackIdOf, topicIdOf } from './ids'
import { countChars, countNonSpace, RECORD_LIMITS, RECORD_NORMS, withinChars } from './limits'
import type { CorrectionRecord, Edition, EditionFail, KnownTerm, ReadMark, TermEntry, TermPack, Topic } from './types'
import {
  checkCorrection,
  checkEdition,
  checkEditionFail,
  checkEditionNorms,
  checkKnownTerm,
  checkMajorsPerDay,
  checkReadMark,
  checkRecord,
  checkTermPack,
  checkTopic,
  isPlainText,
  type CheckResult,
} from './validate'

const opts = { outlets: FAKE_OUTLETS }
const topicCheck = (edit: (t: Topic) => void) => checkTopic(makeSampleTopic(edit), opts)
const paths = (r: CheckResult) => r.errors.map((e) => e.path)
const codes = (r: CheckResult) => r.errors.map((e) => e.code)
const chars = (n: number, c = 'あ') => c.repeat(n)

const connector = {
  v: 1 as const,
  createdAt: Date.UTC(2026, 10, 15, 2),
  by: 'connector' as const,
  ai: 'claude' as const,
  model: 'm',
  runId: 'r1',
}
const user = { v: 1 as const, createdAt: 1, updatedAt: 2, by: 'user' as const, ai: null }

describe('字数の数え方', () => {
  it('コードポイントで、前後の空白を除いて数える', () => {
    expect(countChars('𠮷野家')).toBe(3)
    expect(countChars('  橋 \n')).toBe(1)
    expect(countChars('A 党')).toBe(3)
    expect(countNonSpace('A 党　と B 党\n')).toBe(5)
    expect(withinChars('あいう', 1, 3)).toBe(true)
    expect(withinChars('あいうえ', 1, 3)).toBe(false)
    expect(withinChars(null, 0, 3)).toBe(false)
  })
})

describe('話題（checkTopic）', () => {
  it('作り物の話題は断る物も知らせる物も無い', () => {
    expect(checkTopic(makeSampleTopic(), opts)).toEqual({ errors: [], warnings: [] })
    expect(checkRecord('topics', makeSampleTopic(), opts).errors).toEqual([])
  })

  it('上限: 境目の字数で通り、1字多いと断る', () => {
    const T = RECORD_LIMITS.topic
    const cases: [string, (t: Topic, n: number) => void, number][] = [
      ['headline', (t, n) => (t.headline = chars(n)), T.headline],
      ['summary', (t, n) => (t.summary = `15日に開通、通行料はまだ決まっていない。${chars(n - 21)}`), T.summary],
      ['rankReason', (t, n) => (t.rankReason = chars(n)), T.rankReason],
      ['conclusion.note', (t, n) => (t.conclusion.note = chars(n)), T.conclusionNote],
      ['soWhat.life', (t, n) => (t.soWhat.life = `時間が短くなる見込み${chars(n - 10)}`), T.soWhat],
      ['stakeholders[0].name', (t, n) => (t.stakeholders[0].name = chars(n)), T.stakeholderName],
      ['stakeholders[0].claim', (t, n) => (t.stakeholders[0].claim = `通行料は無料にすべき${chars(n - 10)}`), T.claim],
      ['stakeholders[0].reason', (t, n) => (t.stakeholders[0].reason = chars(n)), T.claimReason],
      ['view.axis', (t, n) => t.view.kind === 'opposed' && (t.view.axis = chars(n)), T.axis],
      ['timeline[0].text', (t, n) => (t.timeline[0].text = chars(n)), T.timelineText],
      ['terms[0].explanation', (t, n) => (t.terms[0].explanation = chars(n)), T.termExplanation],
      ['sources[0].title', (t, n) => (t.sources[0].title = chars(n)), T.sourceTitle],
      ['unverified[0]', (t, n) => (t.unverified[0] = chars(n)), T.unverifiedText],
      ['model', (t, n) => (t.model = chars(n, 'm')), RECORD_LIMITS.base.model],
    ]
    for (const [path, set, max] of cases) {
      expect(paths(topicCheck((t) => set(t, max))), `${path} ${max}字`).toEqual([])
      expect(paths(topicCheck((t) => set(t, max + 1))), `${path} ${max + 1}字`).toEqual([path])
    }
  })

  it('AI の見解と対立見解は各 800字（同じ長さなら知らせない）', () => {
    const set = (n: number) => (t: Topic) => {
      t.view = {
        kind: 'opposed',
        axis: '軸',
        issue: null,
        aiView: `人が戻る効果${chars(n - 6)}`,
        counterView: `住宅地へ移る${chars(n - 6)}`,
      }
      t.emphasis = { ...t.emphasis, 'view.aiView': ['人が戻る効果'], 'view.counterView': ['住宅地へ移る'] }
    }
    expect(topicCheck(set(800))).toEqual({ errors: [], warnings: [] })
    expect(paths(topicCheck(set(801)))).toEqual(['view.aiView', 'view.counterView'])
  })

  it('数の上限（当事者 15・経緯 12・用語 20・出典 1〜8・社 30・確かめられなかった点 15）', () => {
    const person = { name: 'D 党', stance: 'for' as const, stanceNote: null, claim: null, reason: null }
    const many = (n: number) => (t: Topic) => {
      t.stakeholders = Array.from({ length: n }, () => ({ ...person, stance: 'unknown' as const }))
      t.emphasis = { summary: t.emphasis.summary, 'view.aiView': ['人が戻る効果'], 'view.counterView': ['住宅地へ移るだけ'] }
    }
    expect(codes(topicCheck(many(15)))).toEqual([])
    expect(codes(topicCheck(many(16)))).toEqual(['count'])
    expect(
      codes(topicCheck((t) => (t.timeline = Array.from({ length: 12 }, (_, i) => ({ when: null, text: `行${i}` }))))),
    ).toEqual(['emphasis:not-found'])
    expect(
      paths(
        topicCheck((t) => (t.timeline = Array.from({ length: 13 }, (_, i) => ({ when: null, text: `新しい橋が開通した${i}` })))),
      ),
    ).toEqual(['timeline'])
    const terms = (n: number) => (t: Topic) =>
      (t.terms = Array.from({ length: n }, (_, i) => ({
        termId: termIdOf(`語${i}`),
        term: `語${i}`,
        aliases: [],
        explanation: '説明',
        asOf: null,
      })))
    expect(checkTopic(makeSampleTopic(terms(20)), opts).errors).toEqual([])
    expect(paths(checkTopic(makeSampleTopic(terms(21)), opts))).toEqual(['terms'])
    const src = {
      outlet: '〇〇通信',
      title: '題',
      url: 'https://example.com/a',
      publishedAt: null,
      publishedNote: null,
      via: null,
    }
    expect(paths(topicCheck((t) => ((t.sources = []), (t.outletNames = ['〇〇通信']))))).toEqual(['sources'])
    expect(paths(topicCheck((t) => ((t.sources = Array(8).fill(src)), (t.outletNames = ['〇〇通信']))))).toEqual([])
    expect(paths(topicCheck((t) => ((t.sources = Array(9).fill(src)), (t.outletNames = ['〇〇通信']))))).toEqual(['sources'])
    const names = (n: number) => (t: Topic) =>
      (t.outletNames = ['〇〇通信', '◇◇日報', ...Array.from({ length: n - 2 }, (_, i) => `社${i}`)])
    expect(paths(topicCheck(names(30)))).toEqual([])
    expect(paths(topicCheck(names(31)))).toEqual(['outletNames'])
    expect(paths(topicCheck((t) => (t.unverified = Array(15).fill('点'))))).toEqual([])
    expect(paths(topicCheck((t) => (t.unverified = Array(16).fill('点'))))).toEqual(['unverified'])
  })

  it('決まった値・形・名札', () => {
    expect(paths(topicCheck((t) => (t.genre = 'novel' as Topic['genre'])))).toEqual(['genre'])
    expect(paths(topicCheck((t) => (t.region = 'asia' as Topic['region'])))).toEqual(['region'])
    expect(paths(topicCheck((t) => (t.rank = 31)))).toEqual(['rank'])
    expect(paths(topicCheck((t) => (t.rank = 1.5)))).toEqual(['rank'])
    expect(paths(topicCheck((t) => (t.timeline[0].when = '2023年4月')))).toEqual(['timeline[0].when'])
    expect(paths(topicCheck((t) => (t.terms[0].asOf = '2026-11-01')))).toEqual(['terms[0].asOf'])
    expect(paths(topicCheck((t) => (t.sources[0].publishedAt = '2026-11-15 10:00')))).toEqual(['sources[0].publishedAt'])
    expect(paths(topicCheck((t) => (t.view = { kind: 'maybe' } as unknown as Topic['view'])))).toEqual([
      'view.kind',
      'emphasis["view.aiView"]',
      'emphasis["view.counterView"]',
    ])
    // 中身を変えた後に id を作り直さないと、指紋が合わない
    const t = makeSampleTopic()
    expect(paths(checkTopic({ ...t, summary: `${t.summary}。` }, opts))).toEqual(['id'])
    expect(paths(checkTopic({ ...t, id: '2026-11-15-12-ABCDEFGH' }, opts))).toEqual(['id', 'threadId'])
    expect(paths(checkTopic({ ...t, threadId: '2026-11-14-12-aaaaaaaa' }, opts))).toEqual(['threadId'])
    expect(paths(checkTopic({ ...t, by: 'user' }, opts))).toEqual(['by'])
    expect(paths(checkTopic(null, opts))).toEqual([''])
  })

  it('主張を確かめられなかった当事者は stance unknown・stanceNote と reason は null', () => {
    expect(paths(topicCheck((t) => (t.stakeholders[2].reason = '確かめられなかった訳')))).toEqual(['stakeholders[2]'])
    expect(paths(topicCheck((t) => (t.stakeholders[2].stance = 'against')))).toEqual(['stakeholders[2]'])
  })

  it('続報は経緯と何が新しいかを持つ。threadId は前の話題から', () => {
    const follow = (edit?: (t: Topic) => void) =>
      makeSampleTopic((t) => {
        t.followUp = { prevTopicId: '2026-11-14-12-aaaaaaaa', whatsNew: '市が開通後1日の交通量を発表した' }
        t.threadId = '2026-11-14-12-aaaaaaaa'
        edit?.(t)
      })
    expect(checkTopic(follow(), opts).errors).toEqual([])
    const noTimeline = follow((t) => {
      t.timeline = []
      delete t.emphasis['timeline.1.text']
    })
    expect(paths(checkTopic(noTimeline, opts))).toEqual(['timeline'])
    // 続報でない話題の threadId は自分の id
    const t = makeSampleTopic()
    expect(t.threadId).toBe(t.id)
    // 続報の threadId は前の話題から写す（7.8 の「続報のつなぎ」の 2.）。前の話題は前の版の物なので、
    // threadId は自分の id にならず、自分の版より前の版の id で始まる。makeSampleTopic は id を作った後なので、ここで直す
    const ownThread = follow()
    ownThread.threadId = ownThread.id
    expect(paths(checkTopic(ownThread, opts))).toEqual(['threadId'])
    for (const later of ['2026-11-16-12-aaaaaaaa', '2026-11-15-12-aaaaaaaa', '2026-11-15-20-aaaaaaaa']) {
      const r = checkTopic(
        follow((x) => (x.threadId = later)),
        opts,
      )
      expect([later, paths(r)]).toEqual([later, ['threadId']])
    }
    // 1つ前の版（同じ日の 12:00版から 20:00版）の threadId は通る
    const sameDay = follow((x) => {
      x.editionId = '2026-11-15-20'
      x.threadId = '2026-11-15-12-aaaaaaaa'
    })
    expect(checkTopic(sameDay, opts).errors).toEqual([])
  })

  it('記録の emphasis は強調が無い時も {}（7.1）。欄の無い記録は断る', () => {
    // 欄が無い記録と {} の記録は stableStringify では同じ中身なのに指紋が別になり、7.7 の「同じ中身なら1件」が崩れる
    const none = makeSampleTopic() as unknown as Record<string, unknown>
    delete none.emphasis
    none.id = topicIdOf(none as unknown as Topic)
    none.threadId = none.id
    const r = checkTopic(none, opts)
    expect(paths(r)).toEqual(['emphasis'])
    expect(codes(r)).toEqual(['type'])
    const empty = checkTopic(
      makeSampleTopic((t) => (t.emphasis = {})),
      opts,
    )
    expect(empty.errors).toEqual([])
    expect(empty.warnings.map((w) => w.code)).toEqual(['emphasis:summary-missing'])
  })

  it('1つの話題の中で、1つの表記は1つの語にだけ属する', () => {
    expect(paths(topicCheck((t) => (t.terms[1].aliases = ['通行料'])))).toEqual(['terms[1].term'])
    expect(paths(topicCheck((t) => (t.terms[1] = { ...t.terms[0] })))).toEqual(['terms[1].termId'])
  })

  it('出典の URL: https: で、ホストが社か読んだ所の決まったホストの物だけ', () => {
    expect(paths(topicCheck((t) => (t.sources[0].url = 'http://example.com/news/bridge-1')))).toEqual(['sources[0].url'])
    expect(paths(topicCheck((t) => (t.sources[0].url = 'https://example.com:8443/news')))).toEqual(['sources[0].url'])
    // 一覧に無い社（◇◇日報）は、読んだ所の URL でだけ
    expect(paths(topicCheck((t) => (t.sources[1].via = null)))).toEqual(['sources[1].url'])
    expect(paths(topicCheck((t) => (t.sources[0].url = 'URL ではない')))).toEqual(['sources[0].url'])
    // ふだんの一覧には作り物の社が無いので、作り物の URL は断る
    expect(paths(checkTopic(makeSampleTopic()))).toEqual(['sources[0].url', 'sources[1].url'])
  })

  it('出典の著者（段階3）: 無い・null・1〜80字の文字だけ', () => {
    expect(paths(topicCheck((t) => (t.sources[0].author = 'FAKE_著者')))).toEqual([])
    expect(paths(topicCheck((t) => (t.sources[0].author = null)))).toEqual([])
    expect(paths(topicCheck((t) => (t.sources[0].author = chars(RECORD_LIMITS.topic.author))))).toEqual([])
    expect(RECORD_LIMITS.topic.author).toBe(80)
    expect(paths(topicCheck((t) => (t.sources[0].author = chars(81))))).toEqual(['sources[0].author'])
    expect(paths(topicCheck((t) => (t.sources[0].author = '')))).toEqual(['sources[0].author'])
    expect(paths(topicCheck((t) => ((t.sources[0] as unknown as Record<string, unknown>).author = 3)))).toEqual([
      'sources[0].author',
    ])
  })

  it('outletNames の頭は出典の社（出典の順・重なりを除く）', () => {
    expect(paths(topicCheck((t) => (t.outletNames = ['◇◇日報', '〇〇通信'])))).toEqual(['outletNames'])
    expect(paths(topicCheck((t) => (t.outletNames = ['〇〇通信', '△△新聞'])))).toEqual(['outletNames'])
    expect(paths(topicCheck((t) => (t.outletNames = ['〇〇通信', '◇◇日報', '〇〇通信'])))).toEqual(['outletNames'])
  })

  it('照合の数: 直した件数は照合した件数まで', () => {
    expect(paths(topicCheck((t) => (t.check = { claims: 3, fixed: 4, model: null })))).toEqual(['check.fixed'])
    expect(paths(topicCheck((t) => (t.check = { claims: 501, fixed: 0, model: null })))).toEqual(['check.claims'])
    expect(paths(topicCheck((t) => (t.check = null)))).toEqual([])
  })

  it('json の長さ（話題は 100,000字まで）', () => {
    const t = { ...makeSampleTopic(), extra: 'x'.repeat(100_000) }
    expect(codes(checkTopic(t, opts))).toContain('json')
  })

  it('決まりの範囲の外は、断らずに知らせる（見出し 30字台・要約 120〜200字・用語 11〜13語・見解の分量の差1割）', () => {
    const w = (edit: (t: Topic) => void) => {
      const r = topicCheck(edit)
      expect(r.errors).toEqual([])
      return r.warnings.map((x) => x.path)
    }
    expect(w((t) => (t.headline = '〇〇市の新しい橋が開通、渋滞は2割ほど減る見通しを市が示した'))).toEqual([])
    expect(w((t) => (t.headline = '〇〇市の新しい橋が開通'))).toEqual(['headline'])
    expect(w((t) => (t.headline = chars(40)))).toEqual(['headline'])
    expect(w((t) => (t.summary = `${t.summary.slice(0, 113)}、通行料はまだ決まっていない`))).toEqual([])
    expect(w((t) => (t.summary = `15日に開通、通行料はまだ決まっていない。${chars(98)}`))).toEqual(['summary'])
    expect(w((t) => (t.summary = `15日に開通、通行料はまだ決まっていない。${chars(181)}`))).toEqual(['summary'])
    expect(w((t) => (t.terms = t.terms.slice(0, 10)))).toEqual(['terms'])
    expect(
      w((t) => {
        if (t.view.kind === 'opposed') t.view.counterView = `${t.view.counterView}${chars(10)}`
      }),
    ).toEqual(['view'])
  })
})

describe('版（checkEdition）', () => {
  const topicIds = Array.from({ length: 20 }, (_, i) => `2026-11-15-12-${String(i).padStart(8, 'a')}`)
  const edition = (edit?: (e: Edition) => void): Edition => {
    const e: Edition = {
      ...connector,
      id: '2026-11-15-12',
      date: '2026-11-15',
      slot: '12',
      order: [...topicIds],
      candidateCount: 120,
      notChosen: [{ headline: '△△県で大雨', whyNot: 'すでに前の版で伝えたため' }],
      window: { since: '2026-11-14T20:00+09:00', until: '2026-11-15T10:30+09:00' },
      usage: { tokens: 2_000_000, minutes: 80 },
    }
    edit?.(e)
    return e
  }

  it('作り物の版は断る物が無い', () => {
    expect(checkEdition(edition())).toEqual({ errors: [], warnings: [] })
  })

  it('id は date と slot から。order はこの版の話題を 1〜30件・重なり無し', () => {
    expect(paths(checkEdition(edition((e) => (e.date = '2026-11-16'))))).toEqual(['id'])
    expect(paths(checkEdition(edition((e) => (e.order = []))))).toEqual(['order'])
    expect(
      paths(
        checkEdition(
          edition((e) => (e.order = Array.from({ length: 30 }, (_, i) => `2026-11-15-12-${String(i).padStart(8, 'b')}`))),
        ),
      ),
    ).toEqual([])
    expect(
      paths(
        checkEdition(
          edition((e) => (e.order = Array.from({ length: 31 }, (_, i) => `2026-11-15-12-${String(i).padStart(8, 'b')}`))),
        ),
      ),
    ).toEqual(['order'])
    expect(paths(checkEdition(edition((e) => (e.order[1] = e.order[0]))))).toEqual(['order[1]'])
    expect(paths(checkEdition(edition((e) => (e.order[0] = '2026-11-14-20-aaaaaaaa'))))).toEqual(['order[0]'])
    expect(paths(checkEdition(edition((e) => (e.slot = '08' as Edition['slot']))))).toEqual(['slot'])
  })

  it('選ばなかった見出し 120字・理由 150字・20件、候補の数 0〜10,000、窓は日本時間', () => {
    expect(paths(checkEdition(edition((e) => (e.notChosen[0].headline = chars(120)))))).toEqual([])
    expect(paths(checkEdition(edition((e) => (e.notChosen[0].headline = chars(121)))))).toEqual(['notChosen[0].headline'])
    expect(paths(checkEdition(edition((e) => (e.notChosen[0].whyNot = chars(151)))))).toEqual(['notChosen[0].whyNot'])
    expect(paths(checkEdition(edition((e) => (e.notChosen = Array(21).fill({ headline: 'a', whyNot: 'b' })))))).toEqual([
      'notChosen',
    ])
    expect(paths(checkEdition(edition((e) => (e.candidateCount = 10_001))))).toEqual(['candidateCount'])
    expect(paths(checkEdition(edition((e) => (e.candidateCount = null))))).toEqual([])
    expect(
      paths(checkEdition(edition((e) => (e.window = { since: '2026-11-15T10:30+09:00', until: '2026-11-14T20:00+09:00' })))),
    ).toEqual(['window'])
    expect(
      paths(checkEdition(edition((e) => (e.window = { since: '2026-11-14T11:00Z', until: '2026-11-15T10:30+09:00' })))),
    ).toEqual(['window.since'])
    expect(paths(checkEdition(edition((e) => (e.usage = { tokens: -1 }))))).toEqual(['usage.tokens'])
  })

  it('決まりの範囲（目安10本・ジャンルは最大5本で最低は知らせない・重大印はいちばん上）は知らせるだけ（段階3の設計の 4.13）', () => {
    expect(RECORD_NORMS.editionTopics).toBe(10)
    expect(RECORD_NORMS.editionGate).toBe(5)
    expect(RECORD_NORMS.editionSpares).toBe(3)
    expect(RECORD_NORMS.genrePerEdition).toEqual({ min: 0, max: 5 })
    const genres = ['politics', 'economy', 'tech', 'ai', 'incident', 'sports', 'entertainment'] as const
    const ten = (e: Edition) => (e.order = e.order.slice(0, 10))
    const topics = topicIds.map((id, i) => ({ id, genre: genres[i % 5] as Topic['genre'], major: i === 0 }))
    // 10本で、スポーツ・エンタメが0本でも知らせない（候補に無いジャンル）
    expect(checkEditionNorms(edition(ten), topics)).toEqual([])
    expect(
      checkEditionNorms(
        edition((e) => (e.order = e.order.slice(0, 9))),
        topics,
      ).map((p) => p.message),
    ).toEqual(['話題が 9本です（目安は 10本）'])
    expect(checkEditionNorms(edition(), topics).map((p) => p.message)).toEqual(['話題が 20本です（目安は 10本）'])
    // 1つのジャンルが5本を超えると知らせる
    const lopsided = topics.map((t, i) => ({ ...t, genre: (i < 6 ? 'politics' : genres[1 + (i % 4)]) as Topic['genre'] }))
    expect(checkEditionNorms(edition(ten), lopsided).map((p) => p.message)).toEqual(['ジャンル politics が 6本です（0〜5本）'])
    const majorLate = topics.map((t, i) => ({ ...t, major: i === 3 }))
    expect(checkEditionNorms(edition(ten), majorLate).map((p) => p.message)).toEqual([
      '重大印の話題が、いちばん上にそろっていません',
    ])
    expect(checkMajorsPerDay([{ major: true }, { major: true }, { major: true }])).toEqual([])
    expect(checkMajorsPerDay(Array(4).fill({ major: true }))).toHaveLength(1)
  })
})

describe('作れなかった印・辞書の束・訂正', () => {
  it('作れなかった印: id は runId・reasonKind・reason の指紋。理由 200字', () => {
    const f = (edit?: (x: EditionFail) => void): EditionFail => {
      const x: EditionFail = {
        ...connector,
        id: '',
        editionId: '2026-11-15-20',
        reasonKind: 'quota',
        reason: '使用量の上限に届いた',
      }
      edit?.(x)
      x.id = editionFailIdOf(x)
      return x
    }
    expect(checkEditionFail(f())).toEqual({ errors: [], warnings: [] })
    expect(paths(checkEditionFail(f((x) => (x.reason = chars(200)))))).toEqual([])
    expect(paths(checkEditionFail(f((x) => (x.reason = chars(201)))))).toEqual(['reason'])
    expect(paths(checkEditionFail({ ...f(), reason: '別の理由' }))).toEqual(['id'])
    expect(paths(checkEditionFail(f((x) => (x.reasonKind = 'bug' as EditionFail['reasonKind']))))).toEqual(['reasonKind'])
  })

  it('辞書の束: 語の id は key の指紋。説明 200字・200語まで・改行や URL や記法は断る', () => {
    const entry = (key: string, edit?: (e: TermEntry) => void): TermEntry => {
      const e: TermEntry = {
        termId: termIdOf(key),
        key,
        term: key.replace(/（.*）/, ''),
        aliases: [],
        explanation: '説明です。',
        asOf: null,
        rev: 1,
      }
      edit?.(e)
      return e
    }
    const pack = (entries: TermEntry[]): TermPack => ({
      ...connector,
      id: termPackIdOf('2026-11-15-12', entries),
      editionId: '2026-11-15-12',
      entries,
    })
    expect(checkTermPack(pack([entry('与党（日本）'), entry('与党（米国）')]))).toEqual({ errors: [], warnings: [] })
    expect(paths(checkTermPack(pack([entry('通行料', (e) => (e.explanation = chars(200)))])))).toEqual([])
    expect(paths(checkTermPack(pack([entry('通行料', (e) => (e.explanation = chars(201)))])))).toEqual(['entries[0].explanation'])
    expect(paths(checkTermPack(pack([entry('通行料', (e) => (e.explanation = '説明です。\n次の行'))])))).toEqual([
      'entries[0].explanation',
    ])
    expect(paths(checkTermPack(pack([entry('通行料', (e) => (e.explanation = 'くわしくは https://example.com/a'))])))).toEqual([
      'entries[0].explanation',
    ])
    expect(paths(checkTermPack(pack([entry('通行料', (e) => (e.aliases = ['**通行料**']))])))).toEqual(['entries[0].aliases[0]'])
    expect(paths(checkTermPack(pack([entry('通行料', (e) => (e.termId = termIdOf('別の語')))])))).toEqual(['entries[0].termId'])
    expect(paths(checkTermPack(pack([entry('通行料'), entry('通行料')])))).toEqual(['entries[1].termId'])
    expect(paths(checkTermPack(pack([entry('通行料', (e) => (e.retired = false as unknown as true))])))).toEqual([
      'entries[0].retired',
    ])
    expect(paths(checkTermPack(pack(Array.from({ length: 200 }, (_, i) => entry(`語${i}`)))))).toEqual([])
    expect(paths(checkTermPack(pack(Array.from({ length: 201 }, (_, i) => entry(`語${i}`)))))).toEqual(['entries'])
    expect(paths(checkTermPack({ ...pack([entry('通行料')]), id: '2026-11-15-12-aaaaaaaa' }))).toEqual(['id'])
  })

  it('訂正: id は話題の id ＋ text の指紋。text 300字・ふつうの文・1つの話題に10件まで', () => {
    const topicId = '2026-11-15-12-k3f9a2bq'
    const c = (text: string): CorrectionRecord => ({
      ...connector,
      id: correctionIdOf({ topicId, text }),
      topicId,
      editionId: '2026-11-15-12',
      text,
    })
    expect(checkCorrection(c('新しい橋の歩道の幅は 2メートルではなく 3メートルでした'))).toEqual({ errors: [], warnings: [] })
    expect(paths(checkCorrection(c(chars(300))))).toEqual([])
    expect(paths(checkCorrection(c(chars(301))))).toEqual(['text'])
    expect(paths(checkCorrection(c('一行目\n二行目')))).toEqual(['text'])
    expect(paths(checkCorrection({ ...c('訂正の文'), editionId: '2026-11-15-20' }))).toEqual(['editionId'])
    expect(paths(checkCorrection({ ...c('訂正の文'), text: '別の文' }))).toEqual(['id'])
    expect(paths(checkCorrection(c('訂正の文'), { existingForTopic: 9 }))).toEqual([])
    expect(paths(checkCorrection(c('訂正の文'), { existingForTopic: 10 }))).toEqual(['topicId'])
  })

  it('ふつうの文か（改行・URL・記法の記号）', () => {
    expect(isPlainText('A 党と B 党の主張（2026年11月時点）')).toBe(true)
    expect(isPlainText('3<5 の時')).toBe(true)
    for (const ng of [
      '一\n二',
      'www.example.com',
      'https://example.com',
      '`code`',
      '**太字**',
      '__太字__',
      '[リンク](x)',
      '<b>太字</b>',
      '# 見出し',
      '> 引用',
    ])
      expect(isPlainText(ng)).toBe(false)
  })
})

describe('アプリの記録（知ってる・既読）', () => {
  it('知ってる: 表記 40字・時点は YYYY-MM か null', () => {
    const k: KnownTerm = { ...user, id: termIdOf('与党（日本）'), term: '与党', asOf: '2026-11', on: true }
    expect(checkKnownTerm(k)).toEqual({ errors: [], warnings: [] })
    expect(paths(checkKnownTerm({ ...k, term: chars(40) }))).toEqual([])
    expect(paths(checkKnownTerm({ ...k, term: chars(41) }))).toEqual(['term'])
    expect(paths(checkKnownTerm({ ...k, asOf: '2026-11-15' }))).toEqual(['asOf'])
    expect(paths(checkKnownTerm({ ...k, id: 'yotou' }))).toEqual(['id'])
    expect(paths(checkKnownTerm({ ...k, by: 'connector' }))).toEqual(['by'])
  })

  it('既読: この版の話題を 30件まで・重なり無し', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `2026-11-15-12-${String(i).padStart(8, 'c')}`)
    const r: ReadMark = { ...user, id: '2026-11-15-12', editionId: '2026-11-15-12', topicIds: ids(30), seen: true }
    expect(checkReadMark(r)).toEqual({ errors: [], warnings: [] })
    expect(paths(checkReadMark({ ...r, topicIds: ids(31) }))).toEqual(['topicIds'])
    expect(paths(checkReadMark({ ...r, topicIds: [ids(1)[0], ids(1)[0]] }))).toEqual(['topicIds[1]'])
    expect(paths(checkReadMark({ ...r, topicIds: ['2026-11-15-20-aaaaaaaa'] }))).toEqual(['topicIds[0]'])
    expect(paths(checkReadMark({ ...r, editionId: '2026-11-15-20' }))).toEqual(['editionId'])
    // json は 5,000字まで
    expect(codes(checkReadMark({ ...r, extra: 'x'.repeat(5_000) }))).toEqual(['json'])
  })
})
