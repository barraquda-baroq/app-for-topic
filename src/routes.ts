// 画面の行き先（HashRouter を使うので静的ホスティングでもそのまま動く。docs/SPEC.md の 3.・14.5）。DS の段階0の src/routes.ts から、
// DS の MIM・カレンダーの行き先を外した物。段階0はトップ・ログイン・設定の3つ。段階2で、前の版・版の一覧・追いつきの3つを足した
// （docs/SPEC.md の 9.）。話題の詳細は行き先にせず、開いている画面の履歴の state に積む（src/features/topic/sheets.ts。
// 行き先にすると、移るたびに一覧が先頭へ戻り作り直されるため。DS と同じ。開発。設計: 段階2）

export const paths = {
  /** トップ（いちばん新しい出せる版に付いていく。docs/SPEC.md の 9.） */
  top: () => '/',
  /** 前の版（その版の一覧。トップと同じ画面で開く。id は版の id そのまま。docs/SPEC.md の 9.・7.7） */
  edition: (editionId: string) => `/e/${encodeURIComponent(editionId)}`,
  /** 版の一覧（前の版・作れなかった版。ヘッダーの版の表示から開く。docs/SPEC.md の 9.・4.7） */
  editions: () => '/editions',
  /** 追いつき（見ていない版の話題をまとめて読む。docs/SPEC.md の 9.） */
  catchUp: () => '/catch-up',
  /** ログインの画面（ログインしていない時・持ち主だと確かめていない時。docs/SPEC.md の 14.4） */
  login: () => '/login',
  /** 設定（別のページ。docs/SPEC.md の 14.5） */
  settings: () => '/settings',
}

/** 前の版の行き先の形（src/App.tsx の routes。:editionId を useParams で読む） */
export const EDITION_ROUTE = '/e/:editionId'
