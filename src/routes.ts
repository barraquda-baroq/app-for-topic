// 画面の行き先（HashRouter を使うので静的ホスティングでもそのまま動く。docs/SPEC.md の 3.・14.5）。DS の段階0の src/routes.ts から、
// DS の MIM・カレンダーの行き先を外した物。段階0はトップ・ログイン・設定の3つ。版・話題の詳細などは段階2で足す

export const paths = {
  /** トップ（段階0は「まだ版はありません」。段階2で版の一覧） */
  top: () => '/',
  /** ログインの画面（ログインしていない時・持ち主だと確かめていない時。docs/SPEC.md の 14.4） */
  login: () => '/login',
  /** 設定（別のページ。docs/SPEC.md の 14.5） */
  settings: () => '/settings',
}
