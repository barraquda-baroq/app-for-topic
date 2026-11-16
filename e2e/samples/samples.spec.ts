// 段階2の見本の画面を撮る（設計: 段階2の 5.。作者に見た目を決めてもらう docs/STAGE2-LOOKS.md の ■1〜■14）。ふつうの E2E・CI では流さない:
//   E2E_SAMPLES=1 npx playwright test --project=samples   （npm run samples。開発サーバーとテスト用のログインと作り物の版だけを使う）
// 撮る物は e2e/samples/shots.ts、案は e2e/samples/variants.json（node scripts/sample-variants.mjs が作る）、作り物と時刻は
// e2e/samples/sampleEditions.ts。DS の e2e/samples/samples.spec.ts から（DS の、画面の中身ができる前に撮る物を飛ばす notBuiltYet は写さない。
// 画面ができてから撮るので、探す所が1つでも見つからなければ落ちる）。
// 絵は SAMPLES_OUT（無ければ e2e/artifacts/samples。リポジトリに入れない。scripts/lib/samplesOut.mjs の1か所で決め、見本のページを作る
// scripts/sample-sheet.mjs も同じ所を読む）に JPEG（品質 85）で書き、見本のページを作るための控え（parts/*.json。order は SHOTS・CROPS の
// 中の順で、見本のページはこの順に並べる。now は撮った時の時刻）も残す。
// 撮るのは開発サーバーだけ。Firebase・作者のデータ・公開したサイトには触れない（作り物の版を受け取った物として端末に入れる）
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { samplesOutDir } from '../../scripts/lib/samplesOut.mjs'
import { openTop, type OpenTopOptions } from '../helpers'
import { SAMPLE_NOW, sampleEditions, sampleScenes } from './sampleEditions'
import {
  APPEARANCE_NAMES,
  APPEARANCES,
  CROPS,
  SHOTS,
  VIEWPORTS,
  cardOf,
  cropName,
  settle,
  shotName,
  shotNow,
  shotOf,
  type Appearance,
  type Crop,
  type Shot,
  type Size,
} from './shots'

const OUT = samplesOutDir()
const PARTS = `${OUT}/parts`

/** e2e/samples/variants.json の中身（使う所だけ） */
interface Variants {
  questions: Record<
    string,
    {
      title: string
      appearances: Appearance[]
      reference?: Appearance[]
      options: { letter: string; id: string; label: string }[]
    }
  >
  options: Record<string, { css: string; appearances: Appearance[]; tokens: Partial<Record<Appearance, Record<string, string>>> }>
  /** 答えた問いの切り抜きの下に敷く、答える前の値と形（scripts/sample-variants.mjs の askedCss。まだ答えが無いので空） */
  asked: { questions: number[]; tokens: Partial<Record<Appearance, Record<string, string>>>; css: string }
}
const variants = JSON.parse(readFileSync(new URL('./variants.json', import.meta.url), 'utf8')) as Variants

/** 見本のページ（scripts/sample-sheet.mjs）が読む控え（1枚に1つ） */
function record(name: string, entry: Record<string, unknown>): void {
  mkdirSync(PARTS, { recursive: true })
  writeFileSync(`${PARTS}/${name}.json`, `${JSON.stringify({ file: `${name}.jpg`, ...entry }, null, 2)}\n`)
}

/** その撮る物の openTop の渡し方（省いた所は、時刻 SAMPLE_NOW・基本の作り物・字の大きさ 中） */
function openOptions(shot: Shot, appearance: Appearance): OpenTopOptions {
  const o = shot.open?.() ?? {}
  return {
    now: o.now ?? SAMPLE_NOW,
    appearance,
    textSize: o.textSize ?? 'm',
    editions: o.editions === undefined ? sampleEditions() : o.editions,
    seen: o.seen,
    expect: o.expect,
  }
}

/** 見本の状態で開く（作り物の版・決めた時刻・外観・字の大きさ）。中身ができた印が出て、撮る前の操作を終えるまで */
async function openShot(page: Page, shot: Shot, appearance: Appearance): Promise<void> {
  const options = openOptions(shot, appearance)
  const reopen = async () => {
    await openTop(page, shot.hash, options)
  }
  await reopen()
  await expect(shot.ready(page)).toBeVisible()
  if (shot.prepare) await shot.prepare(page, { appearance, reopen })
  await settle(page)
}

async function snap(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 85, animations: 'disabled', caret: 'hide', clip })
}

/** 撮る物を幅ごとに分ける（S は指の端末として開く） */
function bySize(size: Size): void {
  test.use({
    viewport: VIEWPORTS[size],
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
    ...(size === 'S' ? { isMobile: true, hasTouch: true } : {}),
  })
}

// 撮る前の確かめ: 見本の作り物を入れると、いちばん新しい版が 11/15 12:00版になり、場面の話題が一覧にある。案の CSS を差し込むと、
// その外観の変数がその値になり、外すと戻る
test('見本の作り物を入れると、いちばん新しい版が 11/15 12:00版で、場面の話題が一覧にある', async ({ page }) => {
  const scenes = sampleScenes()
  const { newestEditionId } = await openTop(page, '/', { now: SAMPLE_NOW, editions: sampleEditions() })
  expect(newestEditionId).toBe(scenes.newestEditionId)
  for (const id of [scenes.major, scenes.world, scenes.politics, scenes.twice, scenes.chain[2], scenes.long])
    await expect(cardOf(page, id), id).toBeVisible()
})

test.describe('案の CSS が効く', () => {
  for (const appearance of APPEARANCES) {
    test(`${APPEARANCE_NAMES[appearance]}: 色の案の値がその外観の変数に入り、外すと今の値に戻る`, async ({ page }) => {
      await openTop(page, '/', { now: SAMPLE_NOW, appearance, editions: sampleEditions() })
      const read = (names: string[]) =>
        page.evaluate((ns) => {
          const cs = getComputedStyle(document.documentElement)
          return ns.map((n) => cs.getPropertyValue(n).trim())
        }, names)
      for (const [id, option] of Object.entries(variants.options)) {
        const tokens = option.tokens[appearance] ?? {}
        const names = Object.keys(tokens)
        if (!names.length) continue
        const before = await read(names)
        const tag = await page.addStyleTag({ content: option.css })
        expect(await read(names), id).toEqual(Object.values(tokens))
        await tag.evaluate((e) => (e as Element).remove())
        expect(await read(names), id).toEqual(before)
      }
      // 答えた問いの下に敷く答える前の値（asked。答えが来るまでは空）
      const askedTokens = variants.asked.tokens[appearance] ?? {}
      const askedNames = Object.keys(askedTokens)
      if (askedNames.length) {
        const current = await read(askedNames)
        const askedTag = await page.addStyleTag({ content: variants.asked.css })
        expect(await read(askedNames)).toEqual(Object.values(askedTokens))
        await askedTag.evaluate((e) => (e as Element).remove())
        expect(await read(askedNames)).toEqual(current)
      }
    })
  }

  test('形の案の CSS は、その形の印（強調・重大印のカード）に効き、外すと今の形に戻る', async ({ page }) => {
    await openTop(page, '/', { now: SAMPLE_NOW, editions: sampleEditions() })
    const major = cardOf(page, sampleScenes().major)
    const corrected = cardOf(page, sampleScenes().chain[2])
    const lineWidth = () => major.evaluate((el) => getComputedStyle(el).borderLeftWidth)
    const emphasisWeight = () =>
      corrected
        .locator('.emph')
        .first()
        .evaluate((el) => getComputedStyle(el).fontWeight)
    const line = await lineWidth()
    expect(line).not.toBe('0px')
    const tag = await page.addStyleTag({ content: variants.options['major-badge'].css })
    expect(await lineWidth()).toBe('0px')
    await tag.evaluate((e) => (e as Element).remove())
    expect(await lineWidth()).toBe(line)
    expect(await emphasisWeight()).toBe('700')
    const plain = await page.addStyleTag({ content: variants.options['correction-plain'].css })
    expect(await emphasisWeight()).not.toBe('700')
    await plain.evaluate((e) => (e as Element).remove())
    expect(await emphasisWeight()).toBe('700')
  })
})

for (const size of ['L', 'S'] as const) {
  test.describe(`見本の画面 ${size}`, () => {
    bySize(size)

    // 操作（押す・待つ）は 10秒で諦める（押す所が無い時に待ち続けないように）
    test.beforeEach(({ page }) => page.setDefaultTimeout(10_000))

    for (const shot of SHOTS.filter((s) => s.size === size)) {
      for (const appearance of APPEARANCES) {
        const name = shotName(shot, appearance)
        test(`${name}（${shot.title}・${APPEARANCE_NAMES[appearance]}）`, async ({ page }) => {
          await openShot(page, shot, appearance)
          await snap(page, name)
          record(name, {
            kind: 'shot',
            order: SHOTS.indexOf(shot),
            id: shot.id,
            size,
            part: shot.part ?? null,
            title: shot.title,
            appearance,
            now: shotNow(shot),
          })
        })
      }
    }

    // 問いごとの切り抜き: 同じ状態のまま、案の CSS を差し替えて A・B・C を撮る（今の値の案は差し込まない。その外観を変えない案は撮らない）。
    // 答えた問いは、先に答える前の値（variants.asked）を敷き、見比べてもらった時と同じ絵にする（敷かないと、「今」が選んだ案と同じ絵になる）
    for (const crop of CROPS.filter((c) => c.shot.size === size)) {
      const q = variants.questions[String(crop.question)]
      for (const appearance of [...q.appearances, ...(q.reference ?? [])]) {
        const reference = !q.appearances.includes(appearance)
        test(`q${crop.question}-${crop.id}-${appearance}（${q.title}・${crop.title}・${APPEARANCE_NAMES[appearance]}）`, async ({
          page,
        }) => {
          const shot = shotOf(crop)
          await openShot(page, shot, appearance)
          if (crop.prepare) {
            await crop.prepare(page)
            await settle(page)
          }
          const fixed = crop.fixedArea ? await crop.area(page) : null
          const options = q.options.filter(
            (o) =>
              (!crop.letters || crop.letters.includes(o.letter)) &&
              (reference ? o.id === 'now' : o.id === 'now' || variants.options[o.id]?.appearances.includes(appearance)),
          )
          if (!options.length) throw new Error(`${crop.id} の ${appearance} で撮る案がありません`)
          for (const option of options) await shootOption(page, crop, shot, option, appearance, reference, fixed)
        })
      }
    }
  })
}

async function shootOption(
  page: Page,
  crop: Crop,
  shot: Shot,
  option: { letter: string; id: string; label: string },
  appearance: Appearance,
  reference: boolean,
  fixed: { x: number; y: number; width: number; height: number } | null,
): Promise<void> {
  const css = option.id === 'now' ? null : variants.options[option.id]?.css
  if (option.id !== 'now' && !css) throw new Error(`案 ${option.id} が e2e/samples/variants.json にありません`)
  const base = variants.asked.questions.includes(crop.question) ? await page.addStyleTag({ content: variants.asked.css }) : null
  const tag = css ? await page.addStyleTag({ content: css }) : null
  await settle(page)
  const name = cropName(crop, option.letter, appearance)
  await snap(page, name, fixed ?? (await crop.area(page)))
  record(name, {
    kind: 'crop',
    order: CROPS.indexOf(crop),
    question: crop.question,
    id: crop.id,
    title: crop.title,
    letter: option.letter,
    option: option.id,
    label: option.label,
    appearance,
    reference,
    now: shotNow(shot),
  })
  await tag?.evaluate((e) => (e as Element).remove())
  await base?.evaluate((e) => (e as Element).remove())
}
