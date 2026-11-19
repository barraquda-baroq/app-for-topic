// 作り物の社の一覧（docs/SPEC.md の 16.3 の「作り物の版」）。公開のリポジトリ・CI のログに本物を入れないよう、テストと作り物の版では
// src/domain/outlets.ts の一覧をこれに差し替える。URL はどれも https://example.com/… だけにするので、ホストは example.com だけ
// （1つのホストに社が2つ以上ある形。段階3の組み立てでは、出典の outlet でどの社かを決める）。
// 一覧に無い作り物の社（◇◇日報）は、読んだ所（××ニュース）の URL だけがリンクになる（知らない社で、読んだ所の無い出典は文として出る）。
// 段階3で、出典の書き方（credit。src/domain/credit.ts）の5つの形の作り物の社と、リンクにしない社（linkOpen: 'no-link'）を足した。
// 段階2までの作り物の社（〇〇通信・△△新聞・□□放送）は credit を持たない（出典の表示の無い社。作り物の版の中身と id は変わらない）。
import { CC_BY_3_NAME, CC_BY_3_URL } from '../../domain/credit'
import { createOutletDirectory, type OutletList } from '../../domain/outlets'

/** 出典の書き方の形ごとの作り物の社（段階3。noLink はリンクにしない社） */
export const FAKE_CREDIT_OUTLETS = {
  site: '〇〇省',
  title: '△△庁',
  pdl: '▽▽府',
  jma: '▲▲台',
  ccBy: '□□ボイス',
  noLink: '〇〇協会',
} as const

export const FAKE_OUTLET_LIST: OutletList = {
  outlets: [
    { name: '〇〇通信', aliases: ['〇〇'], hosts: ['example.com'] },
    { name: '△△新聞', aliases: ['△△'], hosts: ['example.com'] },
    { name: '□□放送', aliases: [], hosts: ['example.com'] },
    {
      name: FAKE_CREDIT_OUTLETS.site,
      aliases: ['〇〇省ホームページ'],
      hosts: ['example.com'],
      credit: { form: 'site', siteName: '〇〇省ホームページ' },
      linkOpen: 'new-window',
    },
    {
      name: FAKE_CREDIT_OUTLETS.title,
      aliases: [],
      hosts: ['example.com'],
      credit: { form: 'title', org: '△△庁' },
      linkOpen: 'new-window',
    },
    {
      name: FAKE_CREDIT_OUTLETS.pdl,
      aliases: [],
      hosts: ['example.com'],
      credit: { form: 'pdl', siteName: '▽▽府ホームページ' },
      linkOpen: 'new-window',
    },
    { name: FAKE_CREDIT_OUTLETS.jma, aliases: [], hosts: ['example.com'], credit: { form: 'jma' }, linkOpen: 'new-window' },
    {
      name: FAKE_CREDIT_OUTLETS.ccBy,
      aliases: [],
      hosts: ['example.com'],
      credit: { form: 'cc-by', license: CC_BY_3_NAME, licenseUrl: CC_BY_3_URL },
      linkOpen: 'new-window',
    },
    {
      name: FAKE_CREDIT_OUTLETS.noLink,
      aliases: [],
      hosts: ['example.com'],
      credit: { form: 'site', siteName: '〇〇協会のサイト' },
      linkOpen: 'no-link',
    },
  ],
  vias: [{ name: '××ニュース', aliases: [], hosts: ['example.com'] }],
}

/** 一覧に無い作り物の社（読んだ所の URL でだけ出典にできる） */
export const FAKE_UNLISTED_OUTLET = '◇◇日報'

export const FAKE_OUTLETS = createOutletDirectory(FAKE_OUTLET_LIST)

/** 作り物の社の名前（作り物の版の社の名前がこれだけである事を確かめる。CI のビルドの grep にも同じ名前を入れる） */
export const FAKE_OUTLET_NAMES: readonly string[] = [...FAKE_OUTLET_LIST.outlets.map((o) => o.name), FAKE_UNLISTED_OUTLET]
