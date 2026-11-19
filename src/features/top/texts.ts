// 段階2の画面だけの言葉（トップ・前の版・追いつき・版の一覧・一覧のカード。docs/SPEC.md の 9.・4.7・7.2）。トップ（src/features/top）と
// 版の一覧・追いつき（src/features/editions）が同じ言葉を使うので、1か所に置く（開発。設計: 段階2の 1.20）。記録の決まった値の言葉と
// 決まった文（7.1）は src/domain/fixedTexts.ts、トップの状態の1行の文は src/domain/editionStatus.ts（domain の選び方が文も返すため）に
// あり、ここから読み直す。どの言葉も見本の ■11 などで作者に確かめる（言葉の直しは、ここの文だけを替える）。
// 知らせ方は D9 のとおり静か（数字のアイコン・通知を出さない。版の数は字で出す）。
// 段階3で、空の時の文（EMPTY_NOTE。Q8 の A）・カードの出典の言葉（outletsText。Q19 のあわせての A。言葉は fixedTexts.ts の SOURCE_WORDS）・
// L の空の列の1行（SECTION_TEXTS.columnEmpty。Q18 の A）を替えた・足した（段階3の設計の 3.2・3.4）
import { editionNameText, FIXED_TEXTS, reasonKindLabel, SOURCE_WORDS } from '../../domain/fixedTexts'
import { parseEditionId } from '../../domain/ids'

export { newerEditionText, notArrivedText, waitingEditionText } from '../../domain/editionStatus'

/** 版の id の名前（「11/15（日）12:00版」。読めない id は null） */
export function editionNameOfId(editionId: string): string | null {
  const p = parseEditionId(editionId)
  return p ? editionNameText(p.date, p.slot) : null
}

// ---------- トップ（空・待つ間。段階0・1の文のまま。設計: 段階2の 1.7・1.21） ----------

/** 版が1つも無い時（top-empty。最初の版が届く前の日も、届く時刻の案内で足りる。docs/SPEC.md の 17.6 の 7・8） */
export const EMPTY_TITLE = 'まだ版はありません'
/** 版が1つも無い時の添え書き（作者に伺っている Q8 の今の決め方 A。答えで替わるのはこの文だけ） */
export const EMPTY_NOTE = '12:00版と20:00版が、ここに届きます。'
/** 出せる版が無く、届いた版の話題が端末にそろうのを待っている時（top-waiting。docs/SPEC.md の 7.8 の「版を出す条件」） */
export const WAITING_TEXT = '版を受け取っています…'

// ---------- トップの区切り（設計: 段階2の 1.3・1.4） ----------

export const SECTION_TEXTS = {
  /** S・M のいちばん上の区切り（版の order の順） */
  all: '総合',
  allNote: '今日知るべき順',
  /** L の国内・世界の列の添え書き */
  columnNote: '知るべき順',
  /** L の国内の列のいちばん下の、地域の分からない話題（後の版の値）の区切り */
  other: 'そのほか',
  /** 話題が新しい形の記録の時の、押せない淡いカード（docs/SPEC.md の 7.1） */
  newerTopic: FIXED_TEXTS.newerRecord,
  /**
   * L の国内・世界の列に話題が1本も無い版の、見出しの下の1行（作者に伺っている Q18 の今の決め方 A。答えで替わるのはこの文だけ。
   * 段階3の設計の 3.4。今の出どころでは世界の話題がほとんど入らない）
   */
  columnEmpty: { jp: 'この版には国内の話題がありません', world: 'この版には世界の話題がありません' },
} as const

/** 既読を沈めた所（「既読 5件」。docs/SPEC.md の 9.） */
export function readFoldText(count: number): string {
  return `既読 ${count}件`
}

// ---------- 一覧のカード（設計: 段階2の 1.5・1.15・1.16・1.17） ----------

export const CARD_TEXTS = {
  /** 重大印の札（色に頼らない。docs/SPEC.md の 6.3・10.） */
  major: '重大',
  /** 続報の話題（followUp がある） */
  followUp: '続報',
  /** もっと新しい続報が端末にある（前の版・追いつきだけ） */
  hasNewer: '続報あり',
  /** 訂正のある話題（■4 の A） */
  corrected: '訂正あり',
  /** 照合した話題（check がある） */
  checked: '照合済み',
} as const

/** 出典の社を頭から何社出すか（360px で1行に収める。開発。設計: 段階2の 1.5） */
export const OUTLETS_SHOWN = 2

/**
 * 出典にした所（「出典: 〇〇省・△△庁 ほか（3か所）」。outletNames の頭から2つ、3つ以上なら「ほか」、括弧に nか所 = 長さ。
 * docs/SPEC.md の 5.10。段階3で outletNames は出典の社だけから作る（読んでいない所は数えない。段階3の設計の 1.5）。
 * 言葉は src/domain/fixedTexts.ts の SOURCE_WORDS（Q19 のあわせて）。0 は null
 */
export function outletsText(outletNames: readonly string[]): string | null {
  if (!outletNames.length) return null
  const head = outletNames.slice(0, OUTLETS_SHOWN).join('・')
  const more = outletNames.length > OUTLETS_SHOWN ? ' ほか' : ''
  return `${SOURCE_WORDS.card}: ${head}${more}（${outletNames.length}${SOURCE_WORDS.cardUnit}）`
}

// ---------- この版の選び方（docs/SPEC.md の 6.5・7.2。■14 の A。設計: 段階2の 1.22） ----------

export const CHOICE_TEXTS = {
  title: 'この版の選び方',
  notChosen: '選ばなかった見出し',
} as const

/** 「候補 312 件から20本を選びました」（候補の数が分からない時は書かない） */
export function choiceCountText(candidateCount: number, chosen: number): string {
  return `候補 ${candidateCount} 件から${chosen}本を選びました`
}

// ---------- 前の版（#/e/{id}。設計: 段階2の 1.8・2.） ----------

export const PAST_TEXTS = {
  /** 状態の1行の所（testid edition-status の data-kind="past"） */
  viewing: '前の版を見ています',
  /** いちばん新しい版へ戻る */
  toNewest: 'いちばん新しい版へ',
  /** 30日の外・端末に無い版 */
  notOnDevice: 'この版は端末にありません',
  /** 版の記録が新しい形（docs/SPEC.md の 7.1） */
  newer: 'この版は新しい形の記録です（アプリを更新してください）',
} as const

// ---------- 追いつき（■8 の A。設計: 段階2の 1.8） ----------

export const CATCH_UP_TEXTS = {
  /** 帯の［追いつく］ */
  go: '追いつく',
  /** 帯の［×］の読み上げ（読まずに閉じる。帯に出した版を見たにする） */
  dismiss: '追いつきの知らせを閉じる',
  /** 追いつきの画面の題 */
  title: '追いつき',
  /** 追いつきの画面の下の添え書き */
  note: '見た版は、ここに出なくなります',
  /** 追いつく話題が0本 */
  empty: '追いつく版はありません',
} as const

/** 帯の文（「見ていない版が 2つあります（11/13（金）20:00版から）」。oldestId は追いつく版のいちばん古い版） */
export function catchUpBandText(count: number, oldestId: string | null): string {
  const from = oldestId === null ? null : editionNameOfId(oldestId)
  return `見ていない版が ${count}つあります${from ? `（${from}から）` : ''}`
}

// ---------- 版の一覧（#/editions。設計: 段階2の 1.8） ----------

export const EDITIONS_TEXTS = {
  title: '版の一覧',
  /** いちばん上の、トップへ戻る所 */
  toNewest: 'いちばん新しい版を見る',
  /** 版の記録が1つも無い（作れなかった印も無い） */
  empty: EMPTY_TITLE,
  /** 話題がまだそろわない版（押せる。開くと「版を受け取っています…」） */
  receiving: '受け取り中',
  /** 新しい形の記録の版（押せない） */
  newer: FIXED_TEXTS.newerRecord,
  /** 版も作れなかった印も無い枠（定期実行が動かなかった時など。押せない） */
  missing: '届いていません',
} as const

/** 作れなかった枠の行の言葉（「作れませんでした（使用量の上限）」。知らない理由は「そのほか」。枠の名前は行の頭に別に出す） */
export function editionRowFailedText(reasonKind: unknown): string {
  return `作れませんでした（${reasonKindLabel(reasonKind)}）`
}
