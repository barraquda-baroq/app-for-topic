// @vitest-environment node
// 段階2の見本で撮る物の一覧（e2e/samples/shots.ts）と作り物（e2e/samples/sampleEditions.ts）が、設計（段階2の 5.2・5.3）の撮る画面・場面・
// 切り抜きをすべて持ち、切り抜きの四角が見せたい所を囲むかを、ブラウザを使わずに確かめる（設計: 段階2の 5.6。DS の
// scripts/sample-shots.test.mjs から）。切り抜きの四角は、セレクタごとに箱を決めた作り物のページで計算する
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CATCH_UP_MIN, catchUpTargetIds } from '../src/domain/catchUp.ts'
import { latestSlotAt } from '../src/domain/jst.ts'
import { testIds } from '../src/features/top/testIds.ts'
import { OWNER_MISSING_REASON } from '../src/sync/syncView.ts'
import { SAMPLE_LATE, SAMPLE_NOW, sampleEditions, sampleMonth, sampleScenes } from '../e2e/samples/sampleEditions.ts'
import {
  CROPS,
  SHOTS,
  SYNC_REASONS,
  SYNC_STATES,
  VIEWPORTS,
  cropName,
  shotName,
  shotNow,
  shotOf,
  topOf,
  unionBox,
} from '../e2e/samples/shots.ts'

const variants = JSON.parse(readFileSync(new URL('../e2e/samples/variants.json', import.meta.url), 'utf8'))
const APPEARANCES = ['white', 'dark', 'deep-dark']

/**
 * セレクタの文字ごとの箱（{ x, y, width, height } の並び）を持つ作り物のページ。page.locator・getByTestId と、その先の locator・getByTestId・
 * and・first を、セレクタの文字をつないだ物にする（getByTestId(x) は [data-testid="x"]）。探したセレクタを asked に残す
 */
function fakePage(boxes, viewport = VIEWPORTS.L) {
  const asked = []
  const loc = (sel) => {
    asked.push(sel)
    return {
      sel,
      locator: (s) => loc(`${sel} ${s}`),
      getByTestId: (id) => loc(`${sel} [data-testid="${id}"]`),
      and: (other) => loc(`${sel}&${other.sel}`),
      first: () => loc(sel),
      count: async () => (boxes[sel] ?? []).length,
      all: async () => (boxes[sel] ?? []).map((b) => ({ boundingBox: async () => b })),
    }
  }
  return {
    asked,
    viewportSize: () => viewport,
    locator: (s) => loc(s),
    getByTestId: (id) => loc(`[data-testid="${id}"]`),
  }
}

const scenes = sampleScenes()
const card = (id) =>
  `:is(${['all', 'jp', 'world', 'other'].map((s) => `[data-testid="top-section"][data-section="${s}"]`).join(', ')}) [data-testid="top-card"][data-topic-id="${id}"]`
const detail = (id) => `[data-testid="topic-detail"][data-topic-id="${id}"]`

describe('撮る画面（設計: 段階2の 5.2 の表）', () => {
  it('表の画面を、表の行き先と幅で撮る（L は 1400×900、S は 390×844）', () => {
    const rows = SHOTS.map((s) => [s.id, s.size, s.part ?? null, s.hash])
    expect(rows).toEqual([
      ['top', 'L', null, '/'],
      ['top', 'S', null, '/'],
      ['top-genre', 'S', null, '/'],
      ['top-read', 'L', null, '/'],
      ['top-read', 'S', null, '/'],
      ['top-bottom', 'S', null, '/'],
      ['newer', 'S', null, '/'],
      ['detail-major', 'L', null, '/'],
      ['detail-major', 'S', 'top', '/'],
      ['detail-major', 'S', 'middle', '/'],
      ['detail-major', 'S', 'bottom', '/'],
      ['detail-world', 'L', null, '/'],
      ['detail-politics', 'S', 'stakeholders', '/'],
      ['detail-politics', 'S', 'timeline', '/'],
      ['detail-ai', 'S', null, '/'],
      ['detail-none', 'S', 'rank8', '/'],
      ['detail-none', 'S', 'rank10', '/'],
      ['detail-chain', 'L', null, '/'],
      ['detail-chain', 'S', 'top', '/'],
      ['detail-chain', 'S', 'followup', '/'],
      ['detail-twice', 'S', null, '/'],
      ['detail-long', 'S', null, '/'],
      ['term-open', 'L', null, '/'],
      ['term-open', 'S', null, '/'],
      ['clip-dialog', 'S', null, '/e/2026-11-13-12'],
      ['catch-up', 'L', 'band', '/'],
      ['catch-up', 'L', 'page', '/catch-up'],
      ['catch-up', 'S', 'band', '/'],
      ['catch-up', 'S', 'page', '/catch-up'],
      ['catch-up-none', 'S', null, '/'],
      ['editions', 'S', null, '/editions'],
      ['status-failed', 'S', null, '/'],
      ['status-not-arrived', 'S', null, '/'],
      ['status-waiting', 'S', null, '/'],
      ['status-receiving', 'S', null, '/'],
      ['status-newer', 'S', null, '/'],
      ['empty', 'S', null, '/'],
      ['settings', 'S', 'display', '/'],
      ['settings', 'S', 'known', '/'],
      ['text-size', 'S', 'top-s', '/'],
      ['text-size', 'S', 'detail-s', '/'],
      ['text-size', 'S', 'top-m', '/'],
      ['text-size', 'S', 'detail-m', '/'],
      ['text-size', 'S', 'top-l', '/'],
      ['text-size', 'S', 'detail-l', '/'],
    ])
    expect(VIEWPORTS).toEqual({ L: { width: 1400, height: 900 }, S: { width: 390, height: 844 } })
    // 3つの外観で撮る。ファイルの名前は重ならない
    const names = SHOTS.flatMap((s) => APPEARANCES.map((a) => shotName(s, a)))
    expect(names).toHaveLength(SHOTS.length * 3)
    expect(new Set(names).size).toBe(names.length)
  })

  it('時刻: いつもは 14:10、20:00版の場面（作れなかった・まだ届いていない・待っている・新しい形）は 20:40', () => {
    const late = SHOTS.filter((s) => shotNow(s) === SAMPLE_LATE).map((s) => s.id)
    expect(late).toEqual(['status-failed', 'status-not-arrived', 'status-waiting', 'status-newer'])
    expect(SHOTS.filter((s) => shotNow(s) !== SAMPLE_LATE).every((s) => shotNow(s) === SAMPLE_NOW)).toBe(true)
    expect(SAMPLE_NOW).toBe('2026-11-15T14:10:00+09:00')
    expect(latestSlotAt(new Date(SAMPLE_NOW).getTime())).toEqual({ date: '2026-11-15', slot: '12' })
    expect(latestSlotAt(new Date(SAMPLE_LATE).getTime())).toEqual({ date: '2026-11-15', slot: '20' })
  })

  it('作り物は、版なし（empty）のほかはどれも基本の作り物（種 samples・7日分・強調した語句を正す訂正）に場面を足した物', () => {
    for (const s of SHOTS) {
      const editions = s.open?.().editions
      if (s.id === 'empty') {
        expect(editions).toBeNull()
        continue
      }
      const e = editions ?? sampleEditions()
      expect(e, s.id).toMatchObject({ until: '2026-11-15', days: 7, seed: 'samples' })
      expect(e.extras, s.id).toContain('correctsEmphasis')
    }
    const open = (id) => SHOTS.find((s) => s.id === id).open()
    expect(open('status-failed').editions.extras).toContain('failsNext')
    expect(open('status-waiting').editions).toMatchObject({ untilSlot: '20', withholdNewest: 2 })
    expect(open('status-receiving').editions).toMatchObject({ onlyNewest: true, withholdNewest: 20 })
    expect(open('status-newer').editions).toMatchObject({ untilSlot: '20', extras: ['correctsEmphasis', 'newerEdition'] })
    expect(open('newer').editions.extras).toContain('newerTopic')
  })
})

describe('見本の作り物（設計: 段階2の 5.3）', () => {
  const month = sampleMonth()

  it('11/09 12:00〜11/15 12:00 の 12版で、いちばん新しい版は 11/15 12:00版、11/14 12:00 は作れなかった印だけ', () => {
    const ids = month.editions.map((e) => e.edition.id)
    expect(ids).toHaveLength(12)
    expect(ids[0]).toBe('2026-11-09-12')
    expect(ids.at(-1)).toBe('2026-11-15-12')
    expect(scenes.newestEditionId).toBe('2026-11-15-12')
    expect(month.scenes.failedEditionId).toBe('2026-11-14-12')
    expect(ids).not.toContain('2026-11-14-12')
    expect(month.editionFails.map((f) => f.editionId)).toEqual(['2026-11-14-12'])
  })

  it('場面の話題は、いちばん新しい版のその順位の話題（重大印・世界の政治・AI・スポーツ・訂正2件・上限いっぱい）', () => {
    const newest = month.editions.at(-1)
    const topic = (id) => newest.topics.find((t) => t.id === id)
    expect(topic(scenes.major)).toMatchObject({ major: true, region: 'jp' })
    expect(topic(scenes.major).conclusion.breaking).toBe(true)
    expect(topic(scenes.world)).toMatchObject({ region: 'world', genre: 'politics' })
    expect(topic(scenes.ai)).toMatchObject({ genre: 'ai' })
    expect(topic(scenes.sports)).toMatchObject({ genre: 'sports' })
    expect(topic(scenes.none).view.kind).toBe('none')
    expect(topic(scenes.long)).toBeTruthy()
    expect(newest.edition.order.indexOf(scenes.twice)).toBe(4)
    expect(month.corrections.filter((c) => c.topicId === scenes.twice)).toHaveLength(2)
  })

  it('続報の鎖: 11/13 12:00版 → 11/14 20:00版 → 11/15 12:00版の14位。3本目には強調した語句を正す訂正がある', () => {
    expect(scenes.chain.map((id) => id.slice(0, 13))).toEqual(['2026-11-13-12', '2026-11-14-20', '2026-11-15-12'])
    expect(month.editions.at(-1).edition.order.indexOf(scenes.chain[2])).toBe(13)
    expect(scenes.chainFirstEditionId).toBe('2026-11-13-12')
    expect(SHOTS.find((s) => s.id === 'clip-dialog').hash).toBe(`/e/${scenes.chainFirstEditionId}`)
    expect(month.scenes.extras.correctsEmphasis.topicId).toBe(scenes.chain[2])
    const closure = month.corrections.filter((c) => c.topicId === scenes.chain[2])
    expect(closure).toHaveLength(1)
    // 作り物の訂正は、どれも見本の時刻より前に足した物（この先の時刻の訂正を出さない）
    expect(month.corrections.every((c) => c.createdAt <= new Date(SAMPLE_NOW).getTime())).toBe(true)
  })

  it('既読にする5本は国内の話題（1位の後）、「知ってる」にする3語は1位の話題の用語', () => {
    const newest = month.editions.at(-1)
    expect(scenes.readTopicIds).toHaveLength(5)
    for (const id of scenes.readTopicIds) expect(newest.topics.find((t) => t.id === id)?.region).toBe('jp')
    expect(scenes.readTopicIds).not.toContain(scenes.major)
    const terms = newest.topics.find((t) => t.id === scenes.major).terms.map((t) => t.termId)
    expect(scenes.knownTermIds).toHaveLength(3)
    for (const id of scenes.knownTermIds) expect(terms).toContain(id)
  })

  it('追いつき: 11/13 12:00版までを見た並びは見ていない版が2つ（帯が出る）、11/13 20:00版までは1つ（出ない。■8 の境）', () => {
    const editionIds = month.editions.map((e) => e.edition.id)
    const now = new Date(SAMPLE_NOW).getTime()
    const targets = (seen) =>
      catchUpTargetIds({ now, editionIds, seen: { [seen]: { seen: true } }, shownId: scenes.newestEditionId })
    expect(targets(scenes.catchUpSeen)).toEqual(['2026-11-14-20', '2026-11-13-20'])
    expect(targets(scenes.catchUpSeen).length).toBeGreaterThanOrEqual(CATCH_UP_MIN)
    expect(targets(scenes.catchUpNoneSeen)).toEqual(['2026-11-14-20'])
    expect(targets(scenes.catchUpNoneSeen).length).toBeLessThan(CATCH_UP_MIN)
  })

  it('20:00版の場面: 作れなかった印・待っている版・新しい形の版・新しい形の話題が、作り物にある', () => {
    const failed = sampleMonth(sampleEditions({ extras: ['failsNext'] }), SAMPLE_LATE)
    expect(failed.scenes.extras.failsNext).toBe('2026-11-15-20')
    const waiting = sampleMonth(sampleEditions({ untilSlot: '20', withholdNewest: 2 }), SAMPLE_LATE)
    expect(waiting.editions.at(-1).edition.id).toBe('2026-11-15-20')
    const newer = sampleMonth(sampleEditions({ untilSlot: '20', extras: ['newerEdition'] }), SAMPLE_LATE)
    expect(newer.scenes.extras.newerEdition).toBe('2026-11-15-20')
    // 新しい形の話題は、いちばん新しい版の20位（id は基本の作り物と同じ）
    const newerTopic = sampleMonth(sampleEditions({ extras: ['newerTopic'] }))
    expect(newerTopic.scenes.extras.newerTopic).toBe(scenes.rank(20))
  })
})

describe('問いごとの切り抜き', () => {
  it('どの切り抜きにも撮る画面があり、問いは variants.json にあり、撮る案の字はその問いの物', () => {
    const byQuestion = {}
    for (const c of CROPS) {
      expect(() => shotOf(c), c.id).not.toThrow()
      const q = variants.questions[String(c.question)]
      expect(q, `■${c.question}`).toBeTruthy()
      for (const l of c.letters ?? [])
        expect(
          q.options.map((o) => o.letter),
          c.id,
        ).toContain(l)
      byQuestion[c.question] = [...(byQuestion[c.question] ?? []), c.id]
    }
    expect(byQuestion[1]).toEqual(['emphasis-card', 'emphasis-detail'])
    expect(byQuestion[2]).toEqual(['term'])
    expect(byQuestion[3]).toEqual(['major-card', 'major-detail'])
    expect(byQuestion[4]).toEqual(['correction-card', 'correction-detail'])
    // ■12: 8つの状態 × PC・スマホ・スマホの小窓、「同期できません」の理由ごとに PC
    expect(byQuestion[12]).toHaveLength(SYNC_STATES.length * 3 + SYNC_REASONS.length)
  })

  it('撮る切り抜きの数（案 × 外観。その外観を変えない案は撮らない）と、名前が重ならないこと。1回の公開（255 ファイル）に収まる', () => {
    const names = CROPS.flatMap((c) => {
      const q = variants.questions[String(c.question)]
      return q.appearances.flatMap((a) =>
        q.options
          .filter(
            (o) =>
              (!c.letters || c.letters.includes(o.letter)) && (o.id === 'now' || variants.options[o.id].appearances.includes(a)),
          )
          .map((o) => cropName(c, o.letter, a)),
      )
    })
    // ■1: 2か所 ×（ホワイト A・C ＋ ダーク A・B・C ＋ ディープダーク A・B・C）。■2: 9。■3・■4: 2か所 × 9。■12: 8 + 16 + 8 + 7
    expect(names).toHaveLength(16 + 9 + 18 + 18 + 39)
    expect(new Set(names).size).toBe(names.length)
    expect(names).not.toContain('q1-emphasis-card-B-white')
    expect(names).toContain('q12-sync-offline-S-B-white')
    expect(names).not.toContain('q12-sync-offline-L-B-white')
    // 画面の一覧（3外観）＋切り抜き＋見本のページ
    expect(SHOTS.length * 3 + names.length + 1).toBeLessThanOrEqual(255)
  })

  it('同期の表示の8つは SyncView の8つの種類、理由は src/sync/syncView.ts の言葉（持ち主の記録が無い時を含む）と「不明なエラー」', () => {
    expect(SYNC_STATES.map((s) => s.view.kind)).toEqual([
      'synced',
      'sending',
      'pending',
      'downloading',
      'offline',
      'quota',
      'outdated',
      'error',
    ])
    expect(SYNC_REASONS).toHaveLength(7)
    expect(SYNC_REASONS[0]).toBe(OWNER_MISSING_REASON)
    expect(SYNC_REASONS.at(-1)).toBe('不明なエラー')
    const src = readFileSync(new URL('../src/sync/syncView.ts', import.meta.url), 'utf8')
    for (const r of SYNC_REASONS.slice(1, -1)) expect(src, r).toContain(`'${r}'`)
  })
})

describe('切り抜きの四角', () => {
  const crop = (id) => CROPS.find((c) => c.id === id)

  it('unionBox: 見えている箱を合わせ、pad だけ広げて画面の中に収める（見えない箱は飛ばし、無ければ止める）', async () => {
    const page = fakePage({
      a: [{ x: 10, y: 20, width: 100, height: 50 }],
      b: [
        { x: 300, y: 5, width: 0, height: 0 },
        { x: 1350, y: 800, width: 100, height: 200 },
      ],
    })
    const box = await unionBox(page, [page.locator('a'), page.locator('b')], 8)
    expect(box).toEqual({ x: 2, y: 12, width: 1398, height: 888 })
    await expect(unionBox(page, [page.locator('none')])).rejects.toThrow()
    expect(topOf({ x: 0, y: 700, width: 390, height: 900 }, 460, VIEWPORTS.S)).toEqual({ x: 0, y: 700, width: 390, height: 144 })
  })

  it('■1: カードは1位のカード、詳細はシートの中の詳細の上 460px（testid だけで探す）', async () => {
    const page = fakePage(
      {
        [card(scenes.major)]: [{ x: 16, y: 150, width: 358, height: 180 }],
        [detail(scenes.major)]: [{ x: 0, y: 80, width: 390, height: 3000 }],
      },
      VIEWPORTS.S,
    )
    expect(await crop('emphasis-card').area(page)).toEqual({ x: 8, y: 142, width: 374, height: 196 })
    expect(await crop('emphasis-detail').area(page)).toEqual({ x: 0, y: 72, width: 390, height: 460 })
    expect(page.asked).toContain(card(scenes.major))
  })

  it('■2: 開いた語と説明の箱を、詳細の見出し（h3）のすぐ下から、詳細の幅（左右に 12px 広げる）で（案を差し込む前に1回だけ決める）', async () => {
    const d = detail(scenes.major)
    const page = fakePage(
      {
        [`${d} [data-testid="term-mark"][aria-expanded="true"]`]: [{ x: 120, y: 300, width: 40, height: 24 }],
        [`${d} [data-testid="term-note"]`]: [{ x: 16, y: 330, width: 358, height: 120 }],
        [`${d} h3`]: [{ x: 16, y: 120, width: 358, height: 64 }],
        [d]: [{ x: 16, y: 80, width: 358, height: 3000 }],
      },
      VIEWPORTS.S,
    )
    expect(crop('term').fixedArea).toBe(true)
    // 上の端は見出しの下の端（184）＋4。下の端は説明の箱の下（450）＋16
    expect(await crop('term').area(page)).toEqual({ x: 4, y: 188, width: 382, height: 278 })
    // 印が見出しのすぐ下の行にある時は、印の 8px 上から
    const near = fakePage(
      {
        [`${d} [data-testid="term-mark"][aria-expanded="true"]`]: [{ x: 120, y: 186, width: 40, height: 24 }],
        [`${d} [data-testid="term-note"]`]: [{ x: 16, y: 216, width: 358, height: 120 }],
        [`${d} h3`]: [{ x: 16, y: 120, width: 358, height: 64 }],
        [d]: [{ x: 16, y: 80, width: 358, height: 3000 }],
      },
      VIEWPORTS.S,
    )
    expect(await crop('term').area(near)).toEqual({ x: 4, y: 178, width: 382, height: 174 })
  })

  it('■12: PC はヘッダーの右の 560px、スマホはヘッダーの全部と開いた小窓', async () => {
    const header = { x: 0, y: 0, width: 1400, height: 52 }
    const pc = fakePage({ [`[data-testid="app-header"]`]: [header] })
    expect(await crop('sync-offline-L').area(pc)).toEqual({ x: 840, y: 0, width: 560, height: 52 })
    const phone = fakePage(
      {
        [`[data-testid="app-header"]`]: [{ x: 0, y: 0, width: 390, height: 52 }],
        [`[data-testid="${testIds.syncPopup}"]`]: [{ x: 120, y: 50, width: 260, height: 60 }],
      },
      VIEWPORTS.S,
    )
    expect(await crop('sync-offline-S-popup').area(phone)).toEqual({ x: 0, y: 0, width: 390, height: 122 })
  })
})
