// 規約の印と許しの範囲（段階3の設計の 1.7 の (2) の 3・(1) の permit・(10)）。純粋な部品と、DO の表を読むだけの決まり。
// - 出どころごとに、開発が規約を読んで確かめた印（terms）と、規約のページの指紋（termsPages の fingerprint）を data に持つ。
//   'trial-only' の出どころと、指紋の無いページのある出どころは試しの回だけで取る（見張りの alarm も置かない）
// - 規約のページの指紋は、ページの scopes の文字（行をそろえてつないだ物）の src/domain/hash.ts の fingerprint。毎回変わる所で誤って
//   止まらないよう scopes で本文を絞る。規約の文は写さない（指紋は文ではない）
// - 許しの社（'permitted'）は permit を部品で守る: 1つの回の本文の数（maxBodiesPerRun）・間（minIntervalSec。pace.ts）・期限（until）
// - 会見の記録の道（qaPages）は、S1 で記者の質問の段を落とせると確かめる（verified）まで、試しの回だけで取る
// 状態の決め方（試しの回だけ・許しの期限・規約・規約のページが変わった・AI への意思表示・robots.txt・読めない）は vault/tools/read.ts の
// sourceStateOf（topic_status・候補の一覧と同じ関数）
import { fingerprint } from '../../../src/domain/hash'
import type { MirrorStore, RunRow } from '../vault/store'
import { SOURCE_STATE_TEXTS, sourceStateOf, type SourceStateKind } from '../vault/tools/read'
import { readBody, type HtmlEvent } from './htmlTokens'
import { pathDenied } from './urlPolicy'
import type { SourceConfig, TermsPage } from './sources'

/** 規約のページの文字の上限（probe 'terms' が返す字数） */
export const TERMS_TEXT_MAX = 20_000

/** 指紋の長さ */
export const TERMS_FINGERPRINT_LENGTH = 16

/** 規約のページの文字（scopes の要素の行。無ければページ全体） */
export function termsPageText(events: readonly HtmlEvent[], page: Pick<TermsPage, 'scopes'>): string {
  return readBody(events, { scopes: page.scopes }).lines.join('\n')
}

/** 規約のページの指紋 */
export const termsFingerprint = (text: string): string => fingerprint(text, TERMS_FINGERPRINT_LENGTH)

/** 取ってよいかの答え（取らない時は状態と言葉） */
export type SourceGate = { ok: true } | { ok: false; state: SourceStateKind; text: string }

/**
 * 出どころを、この回で取ってよいか（試しの回だけ・許しの期限・規約・規約のページが変わった・AI への意思表示・robots.txt・読めない）。
 * 'pending'（今日の決まりをまだ読んでいない）は ok として返し、取る前に読む（呼ぶ側）
 */
export function sourceGate(src: SourceConfig, store: MirrorStore, now: number, run: Pick<RunRow, 'kind'> | null): SourceGate {
  const st = sourceStateOf(src, store, now, { trial: run?.kind === 'trial' })
  if (st.state === 'ok' || st.state === 'pending') return { ok: true }
  return { ok: false, state: st.state, text: SOURCE_STATE_TEXTS[st.state] }
}

/** 会見の記録の道か（qaPages。verified になるまで試しの回だけ） */
export function qaBlocked(src: SourceConfig, path: string, run: Pick<RunRow, 'kind'> | null): boolean {
  if (src.body.kind !== 'html' || !src.body.qaPages || src.body.qaPages.verified) return false
  if (run?.kind === 'trial') return false
  // 大文字・小文字と %xx の書き方を替えた道でもすり抜けないよう、取らない道と同じにそろえて比べる
  return pathDenied(path, src.body.qaPages.paths)
}

/** 許しの社の、この回で取ってよい本文の残り（許しの社でなければ null = 数えない） */
export function permitBodiesLeft(store: MirrorStore, runId: string, src: SourceConfig): number | null {
  if (!src.permit) return null
  return Math.max(0, src.permit.maxBodiesPerRun - store.runCount(runId, `bodies:${src.id}`))
}

/** 許しの社の本文を1本数える */
export function countPermitBody(store: MirrorStore, runId: string, src: SourceConfig): void {
  if (src.permit) store.addRunCount(runId, `bodies:${src.id}`)
}
