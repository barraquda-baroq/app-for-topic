// テスト用（B8）: 今の時刻に合わせた作り物の出どころの中身。test/support/fakeNews.ts の seedFakeNews（2026-11-19 の日に決めた中身）を
// 置いてから、日付で窓に入るかが決まる一覧（〇〇省の HTML の一覧・△△庁と▽▽府の RSS・▲▲台の Atom・□□ボイスの全文の RSS）だけを、
// 呼ばれた時の時刻から数えた日付で作り直す（本物の時計で動かす結合のテスト・E2E で、いつ流しても窓の中に候補がそろうように）。
// エミュレーターの結合テスト（test/emu/connector.emu.test.ts）と E2E のテストの入口（test/e2e/worker.ts。workerd）の両方で使うので、
// Node だけの部品を読み込まない。作り物だけ（社は src/test/fixtures/fakeOutlets.ts の作り物の社、URL は https://example.com/… だけ）
import { jstDateOf } from '../../../src/domain/jst'
import { fakeAtom, fakeRss, fakeVoicesContent, LIST_HEADINGS } from '../fixtures/fakePages'
import { seedFakeNews, type FakeNews } from '../support/fakeNews'

const H = 'https://example.com'
const MIN = 60_000

/** 'YYYY-MM-DD' → 'YYYY年M月D日'（〇〇省の一覧の日付の見出しの形） */
function headingDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return `${y}年${m}月${d}日`
}

/** RSS の pubDate の形（RFC 822。UTC の GMT） */
const rfc822 = (ms: number) => new Date(ms).toUTCString()

/** XML の答え */
const xml = (body: string, type: string) =>
  new Response(body, { status: 200, headers: { 'content-type': `${type}; charset=utf-8` } })

/**
 * 作り物の出どころの中身を置く（seedFakeNews の中身に、日付を now() から数えた一覧を重ねる）。一覧は呼ばれるたびに作るので、時計が
 * 進んでも窓の中に残る（どの項目も now() の10分〜1時間前。〇〇省の一覧は今日（日本時間）の見出しの下）
 */
export function seedFreshNews(news: FakeNews, now: () => number): FakeNews {
  seedFakeNews(news)
  news.set(`${H}/fake-ministry/press/index.html`, () => {
    const t = now()
    const html = LIST_HEADINGS.replace('2026年11月19日', headingDate(jstDateOf(t))).replace(
      '2026年11月18日',
      headingDate(jstDateOf(t - 24 * 60 * MIN)),
    )
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  })
  news.set(`${H}/fake-agency/rss.xml`, () => {
    const t = now()
    return xml(
      fakeRss([
        { title: '作り物の手続きの案内', link: `${H}/fake-agency/news/1.html`, date: rfc822(t - 40 * MIN) },
        { title: '「作り物推進計画」の説明会', link: `${H}/fake-agency/news/2.html`, date: rfc822(t - 50 * MIN) },
        {
          title: '作り物の物品の調達',
          link: `${H}/fake-agency/news/3.html`,
          date: rfc822(t - 45 * MIN),
          category: '調達情報',
        },
      ]),
      'application/rss+xml',
    )
  })
  news.set(`${H}/fake-office/index.xml`, () => {
    const t = now()
    return xml(
      fakeRss([
        { title: '作り物の火災の情報（第1報）', link: '/fake-office/index.html#n101', date: rfc822(t - 30 * MIN) },
        { title: '作り物の訓練のお知らせ', link: '/fake-office/index.html#n102', date: rfc822(t - 35 * MIN) },
      ]),
      'application/rss+xml',
    )
  })
  news.set(`${H}/fake-met/xml/feed/extra.xml`, () => {
    const t = now()
    return xml(
      fakeAtom([
        {
          title: '震度速報',
          link: `${H}/fake-met/xml/data/q1.xml`,
          updated: new Date(t - 20 * MIN).toISOString(),
          content: '作り物県で最大震度５弱を観測',
        },
        {
          title: '府県天気予報',
          link: `${H}/fake-met/xml/data/w1.xml`,
          updated: new Date(t - 25 * MIN).toISOString(),
          content: '作り物の予報',
        },
      ]),
      'application/atom+xml',
    )
  })
  news.set(`${H}/fake-voices/feed/`, () => {
    const t = now()
    return xml(
      fakeRss([
        {
          title: 'A fake voices article',
          link: `${H}/fake-voices/2026/11/19/fake-article-one/`,
          date: rfc822(t - 60 * MIN),
          creator: 'Fake Writer',
          content: fakeVoicesContent({ caption: 'Photo © fake photographer' }),
        },
        {
          title: 'A fake article without author',
          link: `${H}/fake-voices/2026/11/19/fake-article-two/`,
          date: rfc822(t - 55 * MIN),
          content: fakeVoicesContent(),
        },
      ]),
      'application/rss+xml',
    )
  })
  return news
}
