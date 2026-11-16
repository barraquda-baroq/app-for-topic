// 段階2の見本で使う作り物の版と時刻（設計: 段階2の 5.3）。撮る物の一覧（e2e/samples/shots.ts）と、その確かめ（scripts/sample-shots.test.mjs）が
// ここの1か所から作り方と場面の話題を引く（DS の e2e/fixtures/demoData.ts に当たる。TS は作り物の版 src/test/fixtures/fakeEditions.ts を
// そのまま使い、話題の id を決め打ちしない。種・作り方が同じなら、何度作っても同じ id になる）。
// 今は 2026-11-15（日）14:10（日本時間）。いちばん新しい版は 11/15 12:00版で、その作り物の訂正（版の 40分後・90分後の 12:35・13:25）より後
// （12:40 だと2つ目の訂正が「この先の時刻」になる）。docs/SPEC.md の 9. のクリップの例の「2026年11月15日（日）12:00版」とも合う。
// 20:00版の場面（作れなかった・まだ届いていない・待っている・新しい形）は 20:40 に撮る。
// 基本の作り物: 11/09 12:00〜11/15 12:00 の 12版（11/14 12:00 は作れなかった印だけ）。続報の鎖は 11/13 12:00（開通）→ 11/14 20:00
// （渋滞が2割減）→ 11/15 12:00（点検で通行止め）の14位で、3本目の要約の強調した語句そのものを正す訂正（extras の correctsEmphasis）を足す。
// 中身はすべて作り物（〇〇市・A 党・〇〇通信・https://example.com/…。docs/SPEC.md の 16.3）
import type { TestEditionsOptions } from '../../src/features/login/testAuth'
import { editionIdOf } from '../../src/domain/ids'
import { addDaysToDate, latestSlotAt } from '../../src/domain/jst'
import {
  FAKE_TOPIC_SCENES,
  makeFakeMonth,
  type FakeMonth,
  type FakeMonthExtra,
  type FakeTopicScene,
} from '../../src/test/fixtures/fakeEditions'

/** 見本の今の時刻（日曜の 14:10。page.clock.setFixedTime で goto の前に止める） */
export const SAMPLE_NOW = '2026-11-15T14:10:00+09:00'
/** 20:00版の場面を撮る時刻（20:00 の30分後より後） */
export const SAMPLE_LATE = '2026-11-15T20:40:00+09:00'

/** 基本の作り物に、いつも足す場面（強調した語句そのものを正す訂正。docs/SPEC.md の 12.） */
const BASE_EXTRAS: readonly FakeMonthExtra[] = ['correctsEmphasis']

/**
 * 基本の作り物の作り方（openTop の editions にそのまま渡す。src/features/login/testAuth.ts の TestEditionsOptions）。more で場面を足す
 * （extras は基本の物に足す。untilSlot・withholdNewest・onlyNewest はそのまま渡す）
 */
export function sampleEditions(more: TestEditionsOptions = {}): TestEditionsOptions {
  return {
    until: '2026-11-15',
    untilSlot: '12',
    days: 7,
    seed: 'samples',
    ...more,
    extras: [...new Set([...BASE_EXTRAS, ...(more.extras ?? [])])],
  }
}

const months = new Map<string, FakeMonth>()

/**
 * 作り方から、端末に入れるのと同じ作り物の版を作る（src/features/login/testAuth.ts の putFakeEditions と同じ既定。同じ作り方は1回だけ作る）。
 * now は until を省いた時のいちばん新しい枠を決める時刻
 */
export function sampleMonth(opts: TestEditionsOptions = sampleEditions(), now: string = SAMPLE_NOW): FakeMonth {
  const latest = latestSlotAt(new Date(now).getTime())
  const args = {
    until: opts.until ?? latest.date,
    untilSlot: opts.untilSlot ?? (opts.until ? ('20' as const) : latest.slot),
    days: opts.days ?? 3,
    seed: opts.seed,
    extras: opts.extras,
  }
  const key = JSON.stringify(args)
  let month = months.get(key)
  if (!month) {
    month = makeFakeMonth(args)
    months.set(key, month)
  }
  return month
}

/** 見本で開く場面の話題・版（基本の作り物から引く。設計: 段階2の 5.2） */
export interface SampleScenes {
  /** いちばん新しい版（11/15 12:00版） */
  newestEditionId: string
  /** いちばん新しい版の、その順位（1〜20）の話題の id */
  rank: (n: number) => string
  /** 場面（FAKE_TOPIC_SCENES）の話題の id（いちばん新しい版の中） */
  scene: (s: FakeTopicScene) => string
  /** 1位（国内。重大印・速報・未確認） */
  major: string
  /** 2位（世界・政治） */
  world: string
  /** 3位（当事者・立場の補足・確かめられなかった当事者・論点・経緯の年月と null） */
  politics: string
  /** 5位（訂正2件。2件目が1件目を正す） */
  twice: string
  /** 6位（AI のジャンルの注記） */
  ai: string
  /** 8位（理由つきの対立見解なし） */
  none: string
  /** 10位（スポーツ・対立見解なし） */
  sports: string
  /** 17位（上限いっぱい） */
  long: string
  /** 続報の鎖（1本目は 11/13 12:00版・2本目は 11/14 20:00版・3本目は 11/15 12:00版の14位） */
  chain: [string, string, string]
  /** 鎖の1本目の版（前の版を開く所。11/13 12:00版） */
  chainFirstEditionId: string
  /** 「既読 5件」にする話題（国内の話題のうち、重大印の1位の後の5本。L は国内の列、S は総合の区切りに「既読 5件」） */
  readTopicIds: string[]
  /** 設定の「知ってる」にした語の一覧に出す3語（1位の話題の用語の頭から） */
  knownTermIds: string[]
  /** 追いつきの帯が出る並び: この版までを見た（11/13 12:00版。後の 11/13 20:00版・11/14 20:00版の2つが見ていない版） */
  catchUpSeen: string
  /** 追いつきの帯が出ない並び: この版までを見た（11/13 20:00版。後は 11/14 20:00版の1つだけ。■8 の境の見本） */
  catchUpNoneSeen: string
}

let scenes: SampleScenes | null = null

/** 基本の作り物の場面（1回だけ作る） */
export function sampleScenes(): SampleScenes {
  if (scenes) return scenes
  const month = sampleMonth()
  const newest = month.editions[month.editions.length - 1]
  const rank = (n: number) => {
    const id = newest.edition.order[n - 1]
    if (!id) throw new Error(`いちばん新しい版に ${n}位の話題がありません`)
    return id
  }
  const major = rank(FAKE_TOPIC_SCENES.major)
  const majorTopic = newest.topics.find((t) => t.id === major)
  if (!majorTopic) throw new Error('1位の話題がありません')
  const until = newest.edition.date
  scenes = {
    newestEditionId: newest.edition.id,
    rank,
    scene: (s) => rank(FAKE_TOPIC_SCENES[s]),
    major,
    world: rank(FAKE_TOPIC_SCENES.usRulingParty),
    politics: rank(FAKE_TOPIC_SCENES.jpRulingParty),
    twice: month.scenes.corrections.twice,
    ai: rank(FAKE_TOPIC_SCENES.aiGenre),
    none: rank(FAKE_TOPIC_SCENES.noneWithReason),
    sports: rank(FAKE_TOPIC_SCENES.sportsNone),
    long: rank(FAKE_TOPIC_SCENES.maxLength),
    chain: month.scenes.chain,
    chainFirstEditionId: editionIdOf(addDaysToDate(until, -2), '12'),
    readTopicIds: newest.edition.order
      .map((id) => newest.topics.find((t) => t.id === id))
      .filter((t) => t && t.region === 'jp' && t.id !== major)
      .slice(0, 5)
      .map((t) => t!.id),
    knownTermIds: [...new Set(majorTopic.terms.map((t) => t.termId))].slice(0, 3),
    catchUpSeen: editionIdOf(addDaysToDate(until, -2), '12'),
    catchUpNoneSeen: editionIdOf(addDaysToDate(until, -2), '20'),
  }
  return scenes
}
