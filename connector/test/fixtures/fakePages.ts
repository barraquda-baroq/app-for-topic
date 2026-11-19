// 作り物の資料（段階3の設計の 7.「作り物だけを使う」）: HTML の一覧・発表のページ・RSS・Atom・電文・robots.txt・規約のページの形だけを
// 府省・庁に似せた作り物。文はどれも作り物で、本物の発表・見出し・人の名前は無い。URL は https://example.com/… だけ。
// 府省・庁の本物の発表の HTML を写した物ではない（行の区切り・日付の置き方の形だけ）。Node の単体テストと workerd のテストの両方で読む

/** 作り物の本文の段（200字を超える長さにするための作り物の文） */
export const FAKE_PARAGRAPH =
  '〇〇省は、作り物の制度の見直しについて、作り物の検討会での議論をまとめたと発表しました。見直しの対象は作り物の手続きで、作り物の窓口での受け付けの時間を延ばす案などが示されています。'

/** 作り物の本文（n 段） */
export const fakeParagraphs = (n: number, head = ''): string =>
  Array.from({ length: n }, (_, i) => `<p>${head}${FAKE_PARAGRAPH}（作り物の段 ${i + 1}）</p>`).join('\n')

/** 日付の見出しの下にリンクが並ぶ形の一覧 */
export const LIST_HEADINGS = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>作り物の報道発表</title></head>
<body>
<header><nav><a href="/fake-ministry/index.html">トップ</a><a href="/fake-ministry/press/index.html">報道発表</a></nav></header>
<main id="main">
<h2>2026年11月19日</h2>
<ul>
<li><a href="/fake-ministry/press/1001.html">作り物の制度の見直しについて</a></li>
<li><a href="/fake-ministry/press/1002.html">「作り物推進計画」の公表について</a></li>
<li><a href="/fake-ministry/press/1003.pdf">作り物の統計（PDF）</a></li>
</ul>
<h2>2026年11月18日</h2>
<ul>
<li><a href="https://other.example.org/fake/press/1004.html">ほかのホストの作り物の発表</a></li>
<li><a href="/fake-ministry/press/1005.html">作り物の会議の開催について</a></li>
</ul>
</main>
<footer><a href="/fake-ministry/policy.html">サイトの決まり</a></footer>
</body></html>`

/** 表の中にリンクと日付がある形の一覧 */
export const LIST_TABLE = `<html><body><div id="contents">
<table>
<tr><th>日付</th><th>件名</th></tr>
<tr><td>令和8年11月19日</td><td><a href="/fake-ministry/press/2001.html">作り物の手引きの改定について</a></td></tr>
<tr><td>2026/11/18</td><td><a href="/fake-ministry/press/2002.html">作り物法案の概要について</a></td></tr>
<tr><td></td><td><a href="/fake-ministry/press/2003.html">日付の無い作り物の項目</a></td></tr>
</table>
</div></body></html>`

/** li の中で日付が題の後ろにある形の一覧と、横の新着の欄（同じリンクが日付なしで出る） */
export const LIST_LI_AFTER = `<html><body>
<aside><h3>新着</h3><ul><li><a href="/fake-ministry/press/3001.html">作り物の新しい取り組み</a></li></ul></aside>
<div class="list"><ul>
<li><a href="/fake-ministry/press/3001.html">作り物の新しい取り組み</a><span>（2026年11月19日）</span></li>
<li><a href="./3002.html">作り物の相談の受け付け</a> <span class="date">11月17日</span></li>
</ul></div>
</body></html>`

/** 年の無い日付だけの一覧（12月の項目を1月に読む） */
export const LIST_YEARLESS = `<html><body><ul>
<li><span>12月28日</span><a href="/fake-ministry/press/4001.html">作り物の年末の発表</a></li>
<li><span>1月5日</span><a href="/fake-ministry/press/4002.html">作り物の年始の発表</a></li>
</ul></body></html>`

/** 作りが変わった一覧（道の形に合うリンクが無い） */
export const LIST_CHANGED = `<html><body><ul>
<li><a href="/fake-ministry/news/item_1001.html">作り物の項目1</a>（2026年11月19日）</li>
<li><a href="/fake-ministry/news/item_1002.html">作り物の項目2</a>（2026年11月19日）</li>
<li><a href="/fake-ministry/news/item_1003.html">作り物の項目3</a>（2026年11月18日）</li>
</ul></body></html>`

/** 作り物の発表のページ（本文・案内の行・記者の質問の段・meta） */
export const fakePressPage = (
  opts: { title?: string; paragraphs?: number; qa?: boolean; meta?: string; date?: string } = {},
): string => `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta property="og:title" content="${opts.title ?? '作り物の制度の見直しについて'}">
${opts.meta ?? ''}
<title>${opts.title ?? '作り物の制度の見直しについて'}｜作り物のサイト</title>
<script>var fake = "スクリプトの文は本文にしない";</script>
<style>.x{color:red}</style>
</head><body>
<header><p>作り物のサイトの頭</p></header>
<nav><ul><li><a href="/">トップ</a></li></ul></nav>
<main>
<h1>${opts.title ?? '作り物の制度の見直しについて'}</h1>
<p class="date">${opts.date ?? '令和8年11月19日'}</p>
${fakeParagraphs(opts.paragraphs ?? 3)}
${opts.qa ? '<p>（記者）作り物の質問の文です。作り物の記者が作り物の点を聞きました。</p>\n<p>（長官）作り物の答えの文です。</p>\n<p>【記者】もう1つの作り物の質問です。</p>' : ''}
<p>このページの先頭へ</p>
<p>印刷</p>
</main>
<footer><p>作り物のサイトの足</p></footer>
</body></html>`

/** 短い本文のページ（PDF への案内だけ） */
export const FAKE_SHORT_PAGE = `<html><body><main><h1>作り物の被害の報</h1><p><a href="/fake/report.pdf">作り物の報（PDF）</a></p></main></body></html>`

/** 消防庁の形の一覧のページ（#番号 の項目） */
export const FAKE_ANCHOR_PAGE = `<html><body><main>
<div class="item" id="n101"><h3>作り物の火災の情報（第1報）</h3>${fakeParagraphs(2)}</div>
<div class="item" id="n102"><h3>作り物の訓練のお知らせ</h3><p><a href="/fake/n102.pdf">資料（PDF）</a></p></div>
<div class="item" id="n103"><h3>作り物の三番目の項目</h3><p>短い作り物の文</p></div>
</main></body></html>`

/** 作り物の RSS 2.0 */
export const fakeRss = (
  items: readonly { title: string; link: string; date?: string; category?: string; creator?: string; content?: string }[],
): string => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>作り物の一覧</title><link>https://example.com/</link>
${items
  .map(
    (i) =>
      `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link>${i.date ? `<pubDate>${i.date}</pubDate>` : ''}${
        i.category ? `<category>${i.category}</category>` : ''
      }${i.creator ? `<dc:creator><![CDATA[${i.creator}]]></dc:creator>` : ''}${
        i.content ? `<content:encoded><![CDATA[${i.content}]]></content:encoded>` : ''
      }</item>`,
  )
  .join('\n')}
</channel></rss>`

/** 作り物の RSS 1.0（RDF。dc:date） */
export const fakeRdf = (
  items: readonly { title: string; link: string; date: string }[],
): string => `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="https://example.com/"><title>作り物</title></channel>
${items.map((i) => `<item rdf:about="${i.link}"><title>${i.title}</title><link>${i.link}</link><dc:date>${i.date}</dc:date></item>`).join('\n')}
</rdf:RDF>`

/** 作り物の気象の Atom */
export const fakeAtom = (
  entries: readonly { title: string; link: string; updated: string; content: string }[],
): string => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" lang="ja"><title>作り物の随時の情報</title>
${entries
  .map(
    (e, i) =>
      `<entry><title>${e.title}</title><id>urn:uuid:fake-${i}</id><updated>${e.updated}</updated><author><name>▲▲台</name></author><link type="application/xml" href="${e.link}"/><content type="text">${e.content}</content></entry>`,
  )
  .join('\n')}
</feed>`

/** 作り物の地震の電文（形だけ気象の電文に似せた物。地名・値は作り物） */
export const fakeQuakeTelegram = (
  o: { maxInt: string; eventId?: string; status?: string; infoType?: string; cities?: number; title?: string } = {
    maxInt: '5-',
  },
): string => `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>${o.title ?? '震度速報'}</Title><DateTime>2026-11-19T01:00:00Z</DateTime><Status>${o.status ?? '通常'}</Status><EditorialOffice>▲▲台</EditorialOffice><PublishingOffice>▲▲台</PublishingOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>${o.title ?? '震度速報'}</Title><ReportDateTime>2026-11-19T10:00:00+09:00</ReportDateTime><TargetDateTime>2026-11-19T09:58:00+09:00</TargetDateTime>${o.eventId === undefined ? '<EventID>20261119095800</EventID>' : o.eventId ? `<EventID>${o.eventId}</EventID>` : ''}<InfoType>${o.infoType ?? '発表'}</InfoType><Headline><Text>作り物の地震の見出しの文です。</Text></Headline></Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">
<Earthquake><Hypocenter><Area><Name>作り物の沖</Name></Area></Hypocenter><Magnitude description="Ｍ５．８">5.8</Magnitude></Earthquake>
<Intensity><Observation><MaxInt>${o.maxInt}</MaxInt>
<Pref><Name>作り物県</Name><MaxInt>${o.maxInt}</MaxInt>
<Area><Name>作り物地方北部</Name><MaxInt>${o.maxInt}</MaxInt>
${Array.from({ length: o.cities ?? 6 }, (_, i) => `<City><Name>作り物市${i + 1}</Name><MaxInt>4</MaxInt></City>`).join('\n')}
</Area></Pref></Observation></Intensity>
<Comments><ForecastComment><Text>この地震による作り物の海の変動の心配はありません。</Text></ForecastComment></Comments>
</Body></Report>`

/** 作り物の津波の電文 */
export const fakeTsunamiTelegram = (
  o: { kind: string; eventId?: string } = { kind: '津波注意報' },
): string => `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>津波警報・注意報・予報a</Title><Status>通常</Status><PublishingOffice>▲▲台</PublishingOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>津波警報・注意報・予報</Title><ReportDateTime>2026-11-19T10:03:00+09:00</ReportDateTime><EventID>${o.eventId ?? '20261119095800'}</EventID><InfoType>発表</InfoType><Headline><Text>作り物の津波の見出しの文です。</Text></Headline></Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/"><Tsunami><Forecast>
<Item><Area><Name>作り物の海岸</Name></Area><Category><Kind><Name>${o.kind}</Name></Kind></Category><MaxHeight><TsunamiHeight description="１ｍ">1</TsunamiHeight></MaxHeight></Item>
<Item><Area><Name>作り物の湾</Name></Area><Category><Kind><Name>津波予報（若干の海面変動）</Name></Kind></Category></Item>
</Forecast></Tsunami></Body></Report>`

/** 作り物の気象の警報の電文（特別警報の発表・解除・ふつうの警報） */
export const fakeWarningTelegram = (o: { name: string; status: string }): string => `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>気象特別警報・警報・注意報</Title><Status>通常</Status><PublishingOffice>▲▲台</PublishingOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>作り物県気象警報・注意報</Title><ReportDateTime>2026-11-19T10:05:00+09:00</ReportDateTime><InfoType>発表</InfoType><Headline><Text>作り物の警報の見出しの文です。</Text></Headline></Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/"><Warning type="気象警報・注意報（市町村等）">
<Item><Kind><Name>${o.name}</Name><Status>${o.status}</Status></Kind><Area><Name>作り物市</Name></Area></Item>
</Warning></Body></Report>`

/** 作り物の規約のページ（scopes の main の中だけを指紋にする。更新日は main の外） */
export const fakeTermsPage = (
  body = '作り物の利用規約の文です。作り物の決まりを守って使ってください。',
  updated = '2026年11月19日',
): string =>
  `<html><body><div class="updated">更新日: ${updated}</div><main><h1>作り物の利用規約</h1><p>${body}</p></main></body></html>`

/** 作り物の Global Voices の形の全文の段（本文・図の説明・末尾） */
export const fakeVoicesContent = (o: { tail?: string; caption?: string; paragraphs?: number } = {}): string =>
  `<p>This is a fake article paragraph written for tests only. It describes a fake event in a fake place.</p>
<figure><img src="https://example.com/fake.jpg"><figcaption>${o.caption ?? 'A fake photo caption.'}</figcaption></figure>
${Array.from({ length: o.paragraphs ?? 4 }, (_, i) => `<p>Fake paragraph ${i + 1}. The fake writer explains the fake situation in some detail so that the body is long enough.</p>`).join('\n')}
<p>${o.tail ?? 'The fake story ends here.'}</p>`
