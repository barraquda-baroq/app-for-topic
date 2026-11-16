// 段階2の画面の data-testid（トップ・詳細・版の一覧・追いつき・ヘッダー・設定）。見本（e2e/samples）・E2E・部品のテストが同じ名前で
// 探すので、1か所に置く（DS の src/features/calendar/common/testIds.ts と同じ考え。開発。設計: 段階2）。
// data-* の印（data-topic-id・data-kind など）は探すためだけの物で、CSS では選ばない（見た目はクラスで分ける。src/styles.test.ts の
// [data-kind の禁止と src/screensCss.test.ts）。段階0・1からある top-page・top-empty・top-waiting はそのまま使う
// （e2e/frame.spec.ts・e2e/smoke.spec.ts・e2e/owner-gate.sync.spec.ts）。
// 部品の中だけで名前を書いていた topic-close・sync-popup-detail・known-terms-empty も、E2E が探すので一覧に足した（段階2の通しの確かめ）

export const testIds = {
  // ----- トップ（src/features/top。段階0・1からある物） -----
  topPage: 'top-page',
  /** 版が1つも無い時（「まだ版はありません」） */
  topEmpty: 'top-empty',
  /** 出せる版が無く、話題がそろうのを待っている時（「版を受け取っています…」） */
  topWaiting: 'top-waiting',

  // ----- トップ（段階2） -----
  /** 出している版の一覧の外枠（data-edition-id・data-layout="stack|wide"） */
  topEdition: 'top-edition',
  /** S・M の上に固定の切り替えの列 */
  topSwitcher: 'top-switcher',
  /** 切り替えの列の1つ（data-section） */
  topSwitcherTab: 'top-switcher-tab',
  /** 区切り（data-section="all|politics|…|jp|world|other"） */
  topSection: 'top-section',
  /** 一覧のカード（data-topic-id・data-read・data-major・data-correction） */
  topCard: 'top-card',
  /** 「既読 n件」の畳む所 */
  topReadFold: 'top-read-fold',
  /** トップの状態の1行（data-kind="waiting|newer|failed|not-arrived|past"） */
  editionStatus: 'edition-status',
  /** 追いつきの帯 */
  catchUpBand: 'catch-up-band',
  /** この版の選び方 */
  choiceNote: 'choice-note',
  /** ヘッダーの版の表示 */
  editionLabel: 'edition-label',
  /** L の列の、詳細のパネルの差し込み口（data-side） */
  panelSlot: 'panel-slot',

  // ----- 詳細（src/features/topic） -----
  /** 詳細の中身（data-topic-id・data-mode="sheet|panel"） */
  topicDetail: 'topic-detail',
  /** L のパネルの頭の行の［×］（シート・真ん中の小さな画面の［×］は Modal の modal-close） */
  topicClose: 'topic-close',
  topicCorrection: 'topic-correction',
  /** 本文の中の用語の印（data-term-id） */
  termMark: 'term-mark',
  /** 用語の説明の箱 */
  termNote: 'term-note',
  /** ［知ってる］ */
  termKnown: 'term-known',
  /** ［クリップ］ */
  topicClip: 'topic-clip',
  /** クリップボードを使えない時の、文を選んだ窓 */
  clipDialog: 'clip-dialog',

  // ----- 版の一覧・追いつき（src/features/editions） -----
  /** 版の一覧（行を読み終えるまで aria-busy="true"） */
  editionsPage: 'editions-page',
  /**
   * 版の一覧の行（data-kind="edition|receiving|newer|failed|missing"・data-edition-id はその枠の版の id。作れなかった枠・届いていない
   * 枠にも付ける）
   */
  editionsRow: 'editions-row',
  /**
   * 追いつきの画面（data-edition-ids は決めた追いつく版の id。新しい順・空白で区切る。決める前は付けず、0版なら ''。決める間と話題を
   * 読む間は aria-busy="true"。E2E と見本が「決め終えた」を待つための印）
   */
  catchUpPage: 'catch-up-page',

  // ----- ヘッダー・設定 -----
  syncIndicator: 'sync-indicator',
  /** S の同期の表示を押した時の小窓 */
  syncPopup: 'sync-popup',
  /** S の小窓の中の詳しい言葉（src/ui/SyncIndicator.tsx） */
  syncPopupDetail: 'sync-popup-detail',
  /** 設定の文字の大きさ */
  textSize: 'text-size',
  /** 設定の「知ってる」にした語の一覧 */
  knownTerms: 'known-terms',
  /** 「知ってる」にした語が0語の時の「まだありません」（src/features/appSettings/KnownTermsSettings.tsx） */
  knownTermsEmpty: 'known-terms-empty',
} as const

export type TestId = (typeof testIds)[keyof typeof testIds]
