// Claude との連携の画面（設定の「Claude との連携」・連携の画面 #/claude/connect）で使う言葉と、表示用の純粋な計算（データは変えない）。
// NS の src/features/claude/claudeUi.ts から、TS で要る物だけを写して文を TS の物にした（段階3の設計の 3.1）。React・Firebase を
// 読み込まない（コネクタのテストからも読めるように）。
// できる事・できない事（CLAUDE_CAN・CLAUDE_CANNOT）は、コネクタの同意の画面（connector/src/auth/consentPage.ts の CONSENT_CAN・
// CONSENT_CANNOT）と同じ文にする（src/features/claude/claudeUi.test.ts が比べる）
import { jstDateTimeOf } from '../../domain/jst'
import { publishedAtText } from '../../domain/fixedTexts'

/** Claude（コネクタ）ができること（足すだけ。読むのは版の記録の一部） */
export const CLAUDE_CAN: readonly string[] = [
  '版・話題・辞書・作れなかった印・訂正を足す',
  '前の版の話題・辞書・「知ってる」語を読む',
]

/** Claude（コネクタ）ができないこと */
export const CLAUDE_CANNOT: readonly string[] = ['消す・直す', '既読など読み手の記録を読む', 'アプリの設定を変える']

/**
 * コネクタのツール（名前と題。コネクタの connector/src/mcp/tools.ts の TOOL_DEFS と同じ並び。段階3の設計の 1.2。同じかは
 * src/features/claude/claudeUi.test.ts が文として読んで比べる）。連携の画面と設定で、claude.ai のツールの許可を「常に許可」にする時に
 * 見比べるために出す
 */
export const CLAUDE_TOOLS: readonly { name: string; title: string }[] = [
  { name: 'topic_status', title: '状態を見る' },
  { name: 'topic_get_guide', title: '決まりを読む' },
  { name: 'topic_list_candidates', title: '候補を見る' },
  { name: 'topic_read_article', title: '資料を読む' },
  { name: 'topic_list_recent', title: '前の版の話題を見る' },
  { name: 'topic_lookup_terms', title: '用語を辞書で引く' },
  { name: 'topic_find_topics', title: '訂正する話題を探す' },
  { name: 'topic_list_drafts', title: '下書きの一覧を見る' },
  { name: 'topic_get_draft', title: '下書きを読む' },
  { name: 'topic_begin_run', title: '回を始める' },
  { name: 'topic_save_draft', title: '下書きを置く' },
  { name: 'topic_check_draft', title: '照合の結果を当てる' },
  { name: 'topic_add_topics', title: '話題を足す' },
  { name: 'topic_add_edition', title: '版を出す' },
  { name: 'topic_add_edition_fail', title: '作れなかった印を足す' },
  { name: 'topic_add_correction', title: '訂正を足す' },
]

/** claude.ai のツールの許可の案内の見出し */
export const TOOL_ALLOW_TITLE = 'claude.ai のツールの許可は、全部「常に許可」にします'

/**
 * 全部「常に許可」にする訳（DS の 19.6 にならう。段階3の設計の 3.1・点検 guard-G1・G5）。連携の画面の［許可する］の前と、設定に出す
 */
export const TOOL_ALLOW_NOTES: readonly string[] = [
  '定期実行は人のいない間に動くので、ツールごとの確かめで止まらないようにします。',
  '消す・直すツールはありません（足すツールと読むツールだけです）。',
  'ただし、足した物は誰も消せません（話題と訂正は30日で消え、辞書はずっと残ります）。',
  'つないだ後は、同じ claude.ai のアカウントのすべてのチャットとセッションに Topic Studio のツールが出ます。',
]

/** 「書き込みを許可」の説明（連携の画面。すべての接続に効く1つ） */
export const WRITES_HINT =
  '（Claude が版・話題・辞書・作れなかった印・訂正を足せます。消す・直すはできません。後から 設定 → Claude との連携 で止められます）'

/** 接続の一覧の日時（「2026年11月19日 10:00」。日本時間） */
export function connectionTimeText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  return publishedAtText(jstDateTimeOf(ms)) ?? '—'
}
