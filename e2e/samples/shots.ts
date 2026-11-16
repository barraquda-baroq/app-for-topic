// 段階2の見本の画面で撮る物の一覧（設計: 段階2の 5.2。作者に見た目を決めてもらう問いは docs/STAGE2-LOOKS.md の ■1〜■14）。
// 撮るのは e2e/samples/samples.spec.ts（E2E_SAMPLES=1 の時だけの samples の端末。npm run samples）。作り物の版は e2e/samples/sampleEditions.ts
// だけを使い、今は 2026年11月15日（日）14:10（20:00版の場面は 20:40）。どれも本物の行き先を開いて撮る（DS の e2e/samples/shots.ts を、
// TS の画面で書き直した）。
// - SHOTS: 3つの外観（ホワイト・ダーク・ディープダーク）で撮る画面。L は 1400×900、S は 390×844（どちらも倍率 2）
// - CROPS: 問いごとに、案（e2e/samples/variants.json）を差し込んで撮り直す所の切り抜き（A・B・C を並べて見比べる）
// 探す所は data-testid（src/features/top/testIds.ts）とその data-* の印、e2e/helpers.ts と同じ形の行き先（#/e/{id}・#/editions・#/catch-up・
// #/settings）と開発用のフック（window.__ts の markRead・know・openTopic）だけを使い、画面の CSS のクラスには頼らない（ほかの塊の部品の
// 中身が変わっても、撮る物の一覧は変えずに済むように）。カードの見出しのボタン（<h3><button>）と詳細の小見出し（<h4>）は、
// 設計: 段階2の 1.5・1.10 の決まった形。小見出しで送る所は、見つからなければ割合で送る（絵は撮れる）
import type { Locator, Page } from '@playwright/test'
import type { TestEditionsOptions } from '../../src/features/login/testAuth'
import { testIds } from '../../src/features/top/testIds'
import type { TextSize } from '../../src/store/uiStore'
import { syncLabel, syncShortLabel, type SyncView } from '../../src/sync/syncView'
import { SAMPLE_LATE, SAMPLE_NOW, sampleEditions, sampleScenes } from './sampleEditions'

export type Appearance = 'white' | 'dark' | 'deep-dark'
export const APPEARANCES: readonly Appearance[] = ['white', 'dark', 'deep-dark']
export const APPEARANCE_NAMES: Record<Appearance, string> = { white: 'ホワイト', dark: 'ダーク', 'deep-dark': 'ディープダーク' }

/** 幅（L = PC、S = スマホ。iPhone の大きさ） */
export type Size = 'L' | 'S'
export const VIEWPORTS: Record<Size, { width: number; height: number }> = {
  L: { width: 1400, height: 900 },
  S: { width: 390, height: 844 },
}

/** 撮る画面の開き方（e2e/helpers.ts の openTop に渡す物。省いた所は、時刻 SAMPLE_NOW・基本の作り物・字の大きさ 中） */
export interface ShotOpen {
  /** 時刻（'…+09:00'） */
  now?: string
  /** 作り物の版の作り方（null は版を入れない） */
  editions?: TestEditionsOptions | null
  /** 見たにしておく版 */
  seen?: readonly string[]
  /** 何が出るまで待つか（openTop の expect。省くと、版を入れる時はいちばん新しい版） */
  expect?: 'newest' | 'shown' | 'empty' | 'waiting' | { testId: string }
  /** 記事の字の大きさ */
  textSize?: TextSize
}

/** 撮る前の操作に渡す物 */
export interface ShotContext {
  appearance: Appearance
  /** 同じ開き方で読み込み直す（既読を付けた後に沈めるため） */
  reopen: () => Promise<void>
}

export interface Shot {
  /** 画面の名前（ファイルの名前にもする） */
  id: string
  size: Size
  /** 同じ画面の写し分け（S の詳細の上・中・下など） */
  part?: string
  /** 見本のページの見出し */
  title: string
  /** 開く行き先（# の後ろ） */
  hash: string
  /** 開き方（作り物・時刻・見た版。呼んだ時に作る。場面の話題の id は作り物から引くので） */
  open?: () => ShotOpen
  /** その画面の中身ができた印（これが出てから撮る） */
  ready: (page: Page) => Locator
  /** 撮る前の操作（詳細を開く・スクロールなど） */
  prepare?: (page: Page, ctx: ShotContext) => Promise<void>
}

/** その開き方の時刻（見本のページの「今は…」） */
export const shotNow = (s: Pick<Shot, 'open'>): string => s.open?.().now ?? SAMPLE_NOW

// ---------- 探す所（testid だけ） ----------

const tid = (id: string) => `[data-testid="${id}"]`
const topEdition = (p: Page) => p.getByTestId(testIds.topEdition)
/** 詳細の中身（話題の id で） */
export const detailOf = (p: Page, topicId: string) => p.locator(`${tid(testIds.topicDetail)}[data-topic-id="${topicId}"]`)
/**
 * 一覧のカード（e2e/helpers.ts の cardOf と同じ形。S・M は同じ話題が総合とジャンルの区切りに2回出るので総合の中、L は国内・世界の列と
 * 「そのほか」の中。helpers.ts は Playwright の test を読み込むので、node で読む scripts/sample-shots.test.mjs のために同じ物をここに置く）
 */
export function cardOf(page: Page, topicId: string): Locator {
  const sections = ['all', 'jp', 'world', 'other'].map((s) => `${tid(testIds.topSection)}[data-section="${s}"]`).join(', ')
  return page.locator(`:is(${sections}) ${tid(testIds.topCard)}[data-topic-id="${topicId}"]`)
}
/** 区切り（data-section） */
const sectionOf = (p: Page, section: string) => p.locator(`${tid(testIds.topSection)}[data-section="${section}"]`)

// ---------- 撮る前の操作 ----------

/** 書体を読み終え、描き終わるまで待つ */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
}

/**
 * 要素を、そのスクロールの中の at（0 = 上の端・0.5 = 真ん中）の高さに出す（いちばん近い、縦にスクロールする祖先。無ければページ）。
 * S のページは上に固定のヘッダーと切り替えの列があるので、上の端に出す時も少し下げる（offset）
 */
async function reveal(target: Locator, at = 0, offset = 0): Promise<void> {
  await target.first().evaluate(
    (el, { at, offset }) => {
      let box: Element | null = el.parentElement
      while (
        box &&
        box !== document.documentElement &&
        !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))
      )
        box = box.parentElement
      const page = !box || box === document.documentElement || box === document.body
      const r = el.getBoundingClientRect()
      if (page) {
        const y = r.top + window.scrollY - window.innerHeight * at - offset
        window.scrollTo(0, Math.max(0, y))
      } else {
        const b = box!.getBoundingClientRect()
        box!.scrollTop += r.top - b.top - box!.clientHeight * at - offset
      }
    },
    { at, offset },
  )
}

/**
 * 詳細の中の送り先。heading は小見出し（<h4>）を上の端に、text は中の字（リンクなど）を下の方（6割の高さ）に出す（その上の続報・経緯も
 * 見えるように）。どちらも見つからなければ fraction の割合（0 = 上の端、1 = 下の端）
 */
interface DetailSpot {
  heading?: RegExp
  text?: RegExp
  fraction: number
}

/** 詳細（シート・パネル）を、その送り先まで中だけスクロールする */
async function scrollDetail(page: Page, topicId: string, spot: DetailSpot): Promise<void> {
  await detailOf(page, topicId).evaluate(
    (el, { heading, text, fraction }) => {
      let box: HTMLElement | null = el as HTMLElement
      while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY)))
        box = box.parentElement
      const scroller = box ?? (document.scrollingElement as HTMLElement)
      const find = (selector: string, source: string | null) => {
        if (!source) return null
        const re = new RegExp(source)
        return [...el.querySelectorAll<HTMLElement>(selector)].find((e) => re.test((e.textContent ?? '').trim())) ?? null
      }
      const target = find('h4', heading) ?? find('a, button, p, li, h4', text)
      if (target) {
        const top =
          scroller === document.scrollingElement
            ? target.getBoundingClientRect().top + window.scrollY
            : target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
        scroller.scrollTop = Math.max(0, top - (text && !heading ? scroller.clientHeight * 0.62 : 12))
      } else scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * fraction
    },
    { heading: spot.heading?.source ?? null, text: spot.text?.source ?? null, fraction: spot.fraction },
  )
}

/**
 * カードを押して詳細を開く（L は TopWide が決める列に重なるパネル、S はシート。設計: 段階2の 1.4・1.9）。中身が出るまで待つ。
 * 押した後はマウスを画面の左上の端（ヘッダーの余白）へ外す（PC はカードの見出しの上に残ると、乗せた時の下線が絵に写る）
 */
async function openCard(page: Page, topicId: string): Promise<void> {
  await cardOf(page, topicId).locator('h3 button').click()
  await page.mouse.move(0, 0)
  await detailOf(page, topicId).waitFor()
}

/** カードから詳細を開き、送り先まで送る */
const detail =
  (topicId: () => string, spot: DetailSpot = { fraction: 0 }) =>
  async (page: Page) => {
    await openCard(page, topicId())
    await scrollDetail(page, topicId(), spot)
  }

/** 本文の中の用語の印のうち初めの1つを押し、説明の箱を開く */
async function openTerm(page: Page, topicId: string): Promise<void> {
  await openCard(page, topicId)
  const mark = detailOf(page, topicId).getByTestId(testIds.termMark).first()
  await mark.click()
  await detailOf(page, topicId).getByTestId(testIds.termNote).waitFor()
  await reveal(detailOf(page, topicId).getByTestId(testIds.termNote), 0.4)
}

/** 開発用のフックで既読を付ける（付かなければ止める） */
async function markReadAll(page: Page, topicIds: readonly string[]): Promise<void> {
  for (const id of topicIds) {
    const r = await page.evaluate((topicId) => window.__ts.markRead(topicId), id)
    if (!r.ok) throw new Error(`既読にできません: ${id}（${r.reason}）`)
  }
  // 端末（Dexie）に書き終えてから開き直す（書く前に読み込み直すと、既読が消える。e2e/top.spec.ts と同じ）
  const flushed = await page.evaluate(
    async (file) => ((await import(/* @vite-ignore */ file)) as typeof import('../../src/store/appStore')).flushNow(),
    '/src/store/appStore.ts',
  )
  if (!flushed) throw new Error('既読を端末に書けませんでした')
}

/** クリップボードを使えないようにする（押すと文を選んだ窓が出る。docs/SPEC.md の 9.） */
async function refuseClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('見本: 使えない', 'NotAllowedError')) },
    })
  })
}

const scenes = () => sampleScenes()
const late =
  (editions: TestEditionsOptions, expect: ShotOpen['expect'] = 'newest') =>
  () => ({ now: SAMPLE_LATE, editions, expect })

/** 字の大きさの3段（■9） */
const TEXT_SIZES: readonly { size: TextSize; name: string }[] = [
  { size: 's', name: '小' },
  { size: 'm', name: '中' },
  { size: 'l', name: '大' },
]

export const SHOTS: readonly Shot[] = [
  // ----- トップ -----
  { id: 'top', size: 'L', title: 'トップ（11/15 12:00版。国内｜世界）', hash: '/', ready: topEdition },
  { id: 'top', size: 'S', title: 'トップ（11/15 12:00版。総合の頭）', hash: '/', ready: topEdition },
  {
    id: 'top-genre',
    size: 'S',
    title: 'トップ（切り替えの列の「経済」を押した所）',
    hash: '/',
    ready: (p) => p.getByTestId(testIds.topSwitcher),
    prepare: async (page) => {
      const tab = page.locator(`${tid(testIds.topSwitcherTab)}[data-section="economy"]`)
      await tab.click()
      await tab.and(page.locator('[aria-current="true"]')).waitFor()
    },
  },
  ...(['L', 'S'] as const).map(
    (size): Shot => ({
      id: 'top-read',
      size,
      title: 'トップ（5本を読んだ後に開き直し、「既読 5件」を開いた所）',
      hash: '/',
      ready: topEdition,
      prepare: async (page, ctx) => {
        await markReadAll(page, scenes().readTopicIds)
        await ctx.reopen()
        const fold = sectionOf(page, size === 'L' ? 'jp' : 'all').getByTestId(testIds.topReadFold)
        await fold.getByRole('button').first().click()
        await reveal(fold, 0, size === 'S' ? 140 : 24)
      },
    }),
  ),
  {
    id: 'top-bottom',
    size: 'S',
    title: 'トップのいちばん下（エンタメの区切り・この版の選び方を開いた所）',
    hash: '/',
    ready: (p) => p.getByTestId(testIds.choiceNote),
    prepare: async (page) => {
      const note = page.getByTestId(testIds.choiceNote)
      await note.evaluate((el) => {
        if (el instanceof HTMLDetailsElement) el.open = true
      })
      await reveal(note, 0.45)
    },
  },
  {
    id: 'newer',
    size: 'S',
    title: '新しい形の記録の話題（総合の20位の所）',
    hash: '/',
    open: () => ({ editions: sampleEditions({ extras: ['newerTopic'] }) }),
    ready: topEdition,
    prepare: async (page) => {
      await reveal(cardOf(page, scenes().rank(20)), 0.5)
    },
  },

  // ----- 詳細 -----
  {
    id: 'detail-major',
    size: 'L',
    title: '詳細（1位・国内。重大印・速報・未確認）',
    hash: '/',
    ready: topEdition,
    prepare: detail(() => scenes().major),
  },
  ...(
    [
      ['top', '上', { fraction: 0 }],
      ['middle', '中', { fraction: 0.5 }],
      ['bottom', '下', { fraction: 1 }],
    ] as const
  ).map(
    ([part, name, spot]): Shot => ({
      id: 'detail-major',
      size: 'S',
      part,
      title: `詳細（1位・国内。重大印・速報・未確認）${name}`,
      hash: '/',
      ready: topEdition,
      prepare: detail(() => scenes().major, spot),
    }),
  ),
  {
    id: 'detail-world',
    size: 'L',
    title: '詳細（2位・世界・政治。国内の列に重なる）',
    hash: '/',
    ready: topEdition,
    prepare: detail(() => scenes().world),
  },
  {
    id: 'detail-politics',
    size: 'S',
    part: 'stakeholders',
    title: '詳細（3位。当事者・立場の補足・確かめられなかった当事者）',
    hash: '/',
    ready: topEdition,
    prepare: detail(() => scenes().politics, { heading: /^当事者/, fraction: 0.35 }),
  },
  {
    id: 'detail-politics',
    size: 'S',
    part: 'timeline',
    title: '詳細（3位。論点・経緯の年月と日付の無い行）',
    hash: '/',
    ready: topEdition,
    prepare: detail(() => scenes().politics, { heading: /^AI の見解/, fraction: 0.6 }),
  },
  {
    id: 'detail-ai',
    size: 'S',
    title: '詳細（6位・AI。見解の上の注記）',
    hash: '/',
    ready: topEdition,
    prepare: detail(() => scenes().ai, { heading: /^AI の見解/, fraction: 0.5 }),
  },
  {
    id: 'detail-none',
    size: 'S',
    part: 'rank8',
    title: '詳細（8位。理由つきの対立見解なし）',
    hash: '/',
    ready: topEdition,
    prepare: detail(() => scenes().none, { heading: /^AI の見解/, fraction: 0.5 }),
  },
  {
    id: 'detail-none',
    size: 'S',
    part: 'rank10',
    title: '詳細（10位・スポーツ。対立見解なし）',
    hash: '/',
    ready: topEdition,
    prepare: detail(() => scenes().sports, { heading: /^AI の見解/, fraction: 0.5 }),
  },
  {
    id: 'detail-chain',
    size: 'L',
    title: '詳細（続報の鎖の3本目。強調した語句を正す訂正・続報・経緯・前の話題）',
    hash: '/',
    ready: topEdition,
    prepare: detail(() => scenes().chain[2]),
  },
  {
    id: 'detail-chain',
    size: 'S',
    part: 'top',
    title: '詳細（続報の鎖の3本目。強調した語句を正す訂正）',
    hash: '/',
    ready: topEdition,
    prepare: detail(() => scenes().chain[2]),
  },
  {
    id: 'detail-chain',
    size: 'S',
    part: 'followup',
    title: '詳細（続報の鎖の3本目。続報・経緯・前の話題）',
    hash: '/',
    ready: topEdition,
    prepare: detail(() => scenes().chain[2], { text: /^前の話題/, fraction: 0.3 }),
  },
  {
    id: 'detail-twice',
    size: 'S',
    title: '詳細（5位。訂正2件。2件目が1件目を正す）',
    hash: '/',
    ready: topEdition,
    prepare: detail(() => scenes().twice),
  },
  {
    id: 'detail-long',
    size: 'S',
    title: '詳細（17位。上限いっぱいの長さ）',
    hash: '/',
    ready: topEdition,
    prepare: detail(() => scenes().long),
  },
  ...(['L', 'S'] as const).map(
    (size): Shot => ({
      id: 'term-open',
      size,
      title: '本文の用語の印を押して、説明の箱を開いた所',
      hash: '/',
      ready: topEdition,
      prepare: (page) => openTerm(page, scenes().major),
    }),
  ),
  {
    id: 'clip-dialog',
    size: 'S',
    title: '［クリップ］でクリップボードを使えない時の窓（前の版 11/13 12:00版の鎖の1本目）',
    hash: `/e/2026-11-13-12`,
    open: () => ({ expect: 'shown' }),
    ready: topEdition,
    prepare: async (page) => {
      await refuseClipboard(page)
      const id = scenes().chain[0]
      const opened = await page.evaluate((topicId) => window.__ts.openTopic(topicId), id)
      if (!opened) throw new Error(`詳細を開けません: ${id}`)
      await detailOf(page, id).waitFor()
      await page.getByTestId(testIds.topicClip).click()
      await page.getByTestId(testIds.clipDialog).waitFor()
    },
  },

  // ----- 追いつき・版の一覧 -----
  ...(['L', 'S'] as const).flatMap((size): Shot[] => [
    {
      id: 'catch-up',
      size,
      part: 'band',
      title: '追いつきの帯（11/13 12:00版までを見た。見ていない版が2つ）',
      hash: '/',
      open: () => ({ seen: [scenes().catchUpSeen] }),
      ready: (p) => p.getByTestId(testIds.catchUpBand),
    },
    {
      id: 'catch-up',
      size,
      part: 'page',
      title: '追いつきの画面（11/13 20:00版・11/14 20:00版。11/14 12:00版は作れなかった枠）',
      hash: '/catch-up',
      open: () => ({ seen: [scenes().catchUpSeen], expect: { testId: testIds.catchUpPage } }),
      ready: (p) => p.getByTestId(testIds.catchUpPage).getByTestId(testIds.topCard).first(),
    },
  ]),
  {
    id: 'catch-up-none',
    size: 'S',
    title: '追いつきの帯が出ない所（11/13 20:00版までを見た。見ていない版は 11/14 20:00版の1つだけ）',
    hash: '/',
    open: () => ({ seen: [scenes().catchUpNoneSeen] }),
    ready: topEdition,
    prepare: async (page) => {
      // 帯が出ないこと（出ていたら、境の見本にならないので止める）
      if (await page.getByTestId(testIds.catchUpBand).count()) throw new Error('追いつきの帯が出ています')
    },
  },
  {
    id: 'editions',
    size: 'S',
    title: '版の一覧（11/14 12:00版は作れなかった）',
    hash: '/editions',
    open: () => ({ expect: { testId: testIds.editionsPage } }),
    ready: (p) => p.getByTestId(testIds.editionsRow).first(),
  },

  // ----- トップの状態の1行・待つ間 -----
  {
    id: 'status-failed',
    size: 'S',
    title: '「20:00版は作れませんでした（使用量の上限）」',
    hash: '/',
    open: late(sampleEditions({ extras: ['failsNext'] })),
    ready: (p) => p.getByTestId(testIds.editionStatus),
  },
  {
    id: 'status-not-arrived',
    size: 'S',
    title: '「20:00版はまだ届いていません」',
    hash: '/',
    open: late(sampleEditions()),
    ready: (p) => p.getByTestId(testIds.editionStatus),
  },
  {
    id: 'status-waiting',
    size: 'S',
    title: '「11/15（日）20:00版を受け取っています…」（前の版を出して待つ）',
    hash: '/',
    open: late(sampleEditions({ untilSlot: '20', withholdNewest: 2 }), 'shown'),
    ready: (p) => p.getByTestId(testIds.editionStatus),
  },
  {
    id: 'status-receiving',
    size: 'S',
    title: '「版を受け取っています…」（出せる版が1つも無い）',
    hash: '/',
    open: () => ({ editions: sampleEditions({ onlyNewest: true, withholdNewest: 20 }), expect: 'waiting' }),
    ready: (p) => p.getByTestId(testIds.topWaiting),
  },
  {
    id: 'status-newer',
    size: 'S',
    title: '「20:00版は新しい形の記録です（アプリを更新してください）」',
    hash: '/',
    open: late(sampleEditions({ untilSlot: '20', extras: ['newerEdition'] }), 'shown'),
    ready: (p) => p.getByTestId(testIds.editionStatus),
  },
  {
    id: 'empty',
    size: 'S',
    title: '「まだ版はありません」（版が1つも無い）',
    hash: '/',
    open: () => ({ editions: null, expect: 'empty' }),
    ready: (p) => p.getByTestId(testIds.topEmpty),
  },

  // ----- 設定・文字の大きさ -----
  ...(
    [
      ['display', '表示（文字の大きさ）'],
      ['known', '「知ってる」にした語（3語）'],
    ] as const
  ).map(
    ([part, name]): Shot => ({
      id: 'settings',
      size: 'S',
      part,
      title: `設定（${name}）`,
      hash: '/',
      ready: topEdition,
      prepare: async (page) => {
        for (const termId of scenes().knownTermIds) {
          const r = await page.evaluate((id) => window.__ts.know(id), termId)
          if (!r.ok) throw new Error(`「知ってる」にできません: ${termId}（${r.reason}）`)
        }
        await page.evaluate(() => {
          window.location.hash = '#/settings'
        })
        const target = page.getByTestId(part === 'display' ? testIds.textSize : testIds.knownTerms)
        await target.waitFor()
        if (part === 'display') await page.evaluate(() => window.scrollTo(0, 0))
        else await reveal(target, 0, 64)
      },
    }),
  ),
  ...TEXT_SIZES.flatMap(({ size: textSize, name }): Shot[] => [
    {
      id: 'text-size',
      size: 'S',
      part: `top-${textSize}`,
      title: `文字の大きさ ${name}（トップ）`,
      hash: '/',
      open: () => ({ textSize }),
      ready: topEdition,
    },
    {
      id: 'text-size',
      size: 'S',
      part: `detail-${textSize}`,
      title: `文字の大きさ ${name}（詳細）`,
      hash: '/',
      open: () => ({ textSize }),
      ready: topEdition,
      prepare: detail(() => scenes().major),
    },
  ]),
]

/** 撮った絵のファイルの名前（拡張子なし） */
export const shotName = (s: Pick<Shot, 'id' | 'size' | 'part'>, appearance: Appearance) =>
  `${s.id}-${s.size}${s.part ? `-${s.part}` : ''}-${appearance}`

// ---------- 問いごとの切り抜き ----------

/** 画面の座標の四角 */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Crop {
  /** 問いの番号（docs/STAGE2-LOOKS.md の ■。e2e/samples/variants.json の questions） */
  question: 1 | 2 | 3 | 4 | 12
  id: string
  title: string
  /** どの画面の状態で切り抜くか（SHOTS の id・size・part） */
  shot: { id: string; size: Size; part?: string }
  /** 撮る案の字（省くと、その問いの案の全部。外観ごとの案の有無は variants.json の appearances で決める） */
  letters?: readonly string[]
  /** 案を差し込む前の操作（同期の表示を入れる・カードまでスクロールする） */
  prepare?: (page: Page) => Promise<void>
  /**
   * 切り抜く四角を、案を差し込む前に1回だけ決めるか（省くと、案ごとに差し込んだ後に決める。案で物が消える時に、ほかの案と同じ所を撮る）
   */
  fixedArea?: boolean
  /** 切り抜く四角（見えている要素の箱を合わせた物） */
  area: (page: Page) => Promise<Box>
}

/** 見えている要素の箱を合わせた四角（pad だけ広げ、画面の中に収める。見えない要素は飛ばす） */
export async function unionBox(page: Page, targets: Locator[], pad = 8): Promise<Box> {
  const boxes: Box[] = []
  for (const t of targets) {
    for (const el of await t.all()) {
      const b = await el.boundingBox()
      if (b && b.width > 0 && b.height > 0) boxes.push(b)
    }
  }
  if (!boxes.length) throw new Error('切り抜く所が見つかりません')
  const vp = page.viewportSize() ?? VIEWPORTS.L
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad)
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad)
  const x1 = Math.min(vp.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad)
  const y1 = Math.min(vp.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad)
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** 四角の上から height だけ（画面の中に収める） */
export function topOf(box: Box, height: number, vp: { height: number } = VIEWPORTS.L): Box {
  return { ...box, height: Math.max(1, Math.min(height, vp.height - box.y)) }
}

/** ヘッダーの同期の表示の8つ（docs/SPEC.md の 7.8。■12） */
export const SYNC_STATES: readonly { key: string; name: string; view: SyncView }[] = [
  { key: 'synced', name: '同期済み', view: { kind: 'synced' } },
  { key: 'sending', name: '送信中', view: { kind: 'sending' } },
  { key: 'pending', name: '未送信', view: { kind: 'pending', count: 2 } },
  { key: 'downloading', name: '受け取り中', view: { kind: 'downloading' } },
  { key: 'offline', name: 'オフライン', view: { kind: 'offline' } },
  { key: 'quota', name: '無料枠を使い切った', view: { kind: 'quota', resumeAt: '17:00' } },
  { key: 'outdated', name: '要更新', view: { kind: 'outdated' } },
  { key: 'error', name: '同期できません', view: { kind: 'error', reason: '不明なエラー' } },
]
/** 「同期できません（…）」の理由（src/sync/syncView.ts の shortReason の言葉。そのほかのエラーの文が無い時は「不明なエラー」） */
export const SYNC_REASONS: readonly string[] = [
  '持ち主の記録がまだありません',
  'このアカウントは持ち主ではありません',
  '前に別のアカウントで同期した端末です',
  'アクセスが拒否されました',
  'ログインし直してください',
  'クラウドの索引がまだありません',
  '不明なエラー',
]

/** 同期の表示を入れ（ページの中で useSyncView.setState。e2e/helpers.ts の setSyncView と同じ）、その字が出るまで待つ */
async function showSync(page: Page, view: SyncView, short: boolean): Promise<void> {
  await page.evaluate(
    async ({ file, view }) => {
      const m = (await import(/* @vite-ignore */ file)) as typeof import('../../src/sync/syncView')
      m.useSyncView.setState({ view })
    },
    { file: '/src/sync/syncView.ts', view },
  )
  const indicator = page.getByTestId(testIds.syncIndicator)
  await indicator.and(page.locator(`[title="${syncLabel(view)}"]`)).waitFor()
  // ■12 の B（字だけ。スマホは短い字）の案が出す字（e2e/samples/variants.json の sync-text が content: attr(data-sample-short) で出す）
  if (short) await indicator.evaluate((el, text) => el.setAttribute('data-sample-short', text), syncShortLabel(view))
}

/** ヘッダーの右の同期の表示の辺り（L はヘッダーの右の 560px、S はヘッダーの全部。開いた小窓も入れる） */
async function syncArea(page: Page, size: Size): Promise<Box> {
  const header = await unionBox(page, [page.getByTestId('app-header')], 0)
  const popup = page.getByTestId(testIds.syncPopup)
  const base = size === 'L' ? { ...header, x: header.x + header.width - 560, width: 560 } : header
  if (!(await popup.count())) return base
  const p = await unionBox(page, [popup], 12)
  const x0 = Math.min(base.x, p.x)
  const y0 = Math.min(base.y, p.y)
  return {
    x: x0,
    y: y0,
    width: Math.max(base.x + base.width, p.x + p.width) - x0,
    height: Math.max(base.y + base.height, p.y + p.height) - y0,
  }
}

const syncCrops: Crop[] = [
  ...SYNC_STATES.flatMap(({ key, name, view }): Crop[] => [
    {
      question: 12,
      id: `sync-${key}-L`,
      title: `${name}（PC）`,
      shot: { id: 'top', size: 'L' },
      letters: ['A'],
      prepare: (page) => showSync(page, view, false),
      area: (page) => syncArea(page, 'L'),
    },
    {
      question: 12,
      id: `sync-${key}-S`,
      title: `${name}（スマホ）`,
      shot: { id: 'top', size: 'S' },
      letters: ['A', 'B'],
      prepare: (page) => showSync(page, view, true),
      area: (page) => syncArea(page, 'S'),
    },
    {
      question: 12,
      id: `sync-${key}-S-popup`,
      title: `${name}（スマホ。押して小窓を開いた所）`,
      shot: { id: 'top', size: 'S' },
      letters: ['A'],
      prepare: async (page) => {
        await showSync(page, view, false)
        await page.getByTestId(testIds.syncIndicator).click()
        await page.getByTestId(testIds.syncPopup).waitFor()
      },
      area: (page) => syncArea(page, 'S'),
    },
  ]),
  ...SYNC_REASONS.map(
    (reason, i): Crop => ({
      question: 12,
      id: `sync-reason-${i + 1}-L`,
      title: `同期できません（${reason}）（PC）`,
      shot: { id: 'top', size: 'L' },
      letters: ['A'],
      prepare: (page) => showSync(page, { kind: 'error', reason }, false),
      area: (page) => syncArea(page, 'L'),
    }),
  ),
]

export const CROPS: readonly Crop[] = [
  // ■1 強調の色: 一覧のカードの要約（地は --bg）と、詳細の本文（シートの地 --surface）
  {
    question: 1,
    id: 'emphasis-card',
    title: '一覧のカードの要約（1位）',
    shot: { id: 'top', size: 'S' },
    area: (page) => unionBox(page, [cardOf(page, scenes().major)]),
  },
  {
    question: 1,
    id: 'emphasis-detail',
    title: '詳細の本文（1位の上）',
    shot: { id: 'detail-major', size: 'S', part: 'top' },
    area: async (page) => topOf(await unionBox(page, [detailOf(page, scenes().major)]), 460, VIEWPORTS.S),
  },
  // ■2 本文の中の用語の印: 印を押して説明の箱を開いた所（C は印も箱も無い形。同じ所を撮る）。上の端は詳細の見出し（<h3>）のすぐ下
  // （結論の行から。見出しの途中の行から切り抜かない）か、印がそれより上ならその 8px 上
  {
    question: 2,
    id: 'term',
    title: '本文の用語の印と、押した時の説明の箱',
    shot: { id: 'term-open', size: 'S' },
    fixedArea: true,
    area: async (page) => {
      const d = detailOf(page, scenes().major)
      const around = await unionBox(
        page,
        [d.locator(`${tid(testIds.termMark)}[aria-expanded="true"]`), d.getByTestId(testIds.termNote)],
        0,
      )
      const body = await unionBox(page, [d], 12)
      const head = await unionBox(page, [d.locator('h3')], 0)
      const y = Math.max(body.y, Math.min(around.y - 8, head.y + head.height + 4))
      return { x: body.x, y, width: body.width, height: Math.min(VIEWPORTS.S.height - y, around.y + around.height + 16 - y) }
    },
  },
  // ■3 重大印: PC の国内の列のいちばん上のカードと、スマホの詳細の頭
  {
    question: 3,
    id: 'major-card',
    title: '1位のカード（PC の国内の列）',
    shot: { id: 'top', size: 'L' },
    area: (page) => unionBox(page, [cardOf(page, scenes().major)], 12),
  },
  {
    question: 3,
    id: 'major-detail',
    title: '1位の詳細の頭（スマホ）',
    shot: { id: 'detail-major', size: 'S', part: 'top' },
    area: async (page) => topOf(await unionBox(page, [detailOf(page, scenes().major)]), 240, VIEWPORTS.S),
  },
  // ■4 訂正: 強調した語句そのものを正す訂正のある話題（続報の鎖の3本目）のカードと、詳細の上
  {
    question: 4,
    id: 'correction-card',
    title: '訂正のある話題のカード（14位）',
    shot: { id: 'top', size: 'S' },
    prepare: (page) => reveal(cardOf(page, scenes().chain[2]), 0.5),
    area: (page) => unionBox(page, [cardOf(page, scenes().chain[2])]),
  },
  {
    question: 4,
    id: 'correction-detail',
    title: '訂正のある話題の詳細の上（訂正・見出し・要約）',
    shot: { id: 'detail-chain', size: 'S', part: 'top' },
    area: async (page) => topOf(await unionBox(page, [detailOf(page, scenes().chain[2])]), 420, VIEWPORTS.S),
  },
  // ■12 ヘッダーの同期の表示（8つの状態 × PC とスマホ・スマホの小窓、「同期できません」の理由ごと。ホワイトだけ）
  ...syncCrops,
]

/** 切り抜いた絵のファイルの名前（拡張子なし。letter は案の A・B・C） */
export const cropName = (c: Pick<Crop, 'question' | 'id'>, letter: string, appearance: Appearance) =>
  `q${c.question}-${c.id}-${letter}-${appearance}`

/** 切り抜きの状態を作る撮る物 */
export function shotOf(c: Crop): Shot {
  const s = SHOTS.find((x) => x.id === c.shot.id && x.size === c.shot.size && x.part === c.shot.part)
  if (!s) throw new Error(`撮る物 ${c.shot.id} ${c.shot.size} ${c.shot.part ?? ''} がありません`)
  return s
}
