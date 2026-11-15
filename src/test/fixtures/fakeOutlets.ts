// 作り物の社の一覧（docs/SPEC.md の 16.3 の「作り物の版」）。公開のリポジトリ・CI のログに本物を入れないよう、テストと作り物の版では
// src/domain/outlets.ts の一覧をこれに差し替える。URL はどれも https://example.com/… だけにするので、ホストは example.com だけ。
// 一覧に無い作り物の社（◇◇日報）は、読んだ所（××ニュース）の URL だけがリンクになる（知らない社で、読んだ所の無い出典は文として出る）。
import { createOutletDirectory, type OutletList } from '../../domain/outlets'

export const FAKE_OUTLET_LIST: OutletList = {
  outlets: [
    { name: '〇〇通信', aliases: ['〇〇'], hosts: ['example.com'] },
    { name: '△△新聞', aliases: ['△△'], hosts: ['example.com'] },
    { name: '□□放送', aliases: [], hosts: ['example.com'] },
  ],
  vias: [{ name: '××ニュース', aliases: [], hosts: ['example.com'] }],
}

/** 一覧に無い作り物の社（読んだ所の URL でだけ出典にできる） */
export const FAKE_UNLISTED_OUTLET = '◇◇日報'

export const FAKE_OUTLETS = createOutletDirectory(FAKE_OUTLET_LIST)

/** 作り物の社の名前（作り物の版の社の名前がこれだけである事を確かめる） */
export const FAKE_OUTLET_NAMES: readonly string[] = [...FAKE_OUTLET_LIST.outlets.map((o) => o.name), FAKE_UNLISTED_OUTLET]
