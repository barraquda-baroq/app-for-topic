// 下書きと決まりの文の道具の中身（B5 が作る: topic_get_guide・topic_list_drafts・topic_get_draft・topic_save_draft・topic_check_draft）。
// B3 は形だけを置く（設計の 6.1）。いまは「まだ使えません」を返す。
// B5 が使う物: 回は ctx.useRun（形・期限・種類・締め切り）、組み立ては assembleTopic(input, ctx)（辞書は core.dictionary.forInput、
// 知ってるは core.mirror.known()、前の版の話題は vault/tools/read.ts の recentTopics）、照合は applyPatches(input, patches, { termEntry })、
// DO の表は vault/store.ts の drafts・run_terms・run_counts・materials・candidates、資料の印は tools/common.ts の fenced・hasMark
import type { ToolHandler } from '../core'
import { fail } from './common'

const notYet =
  (name: string): ToolHandler =>
  async () =>
    fail(`この道具（${name}）はまだ使えません（準備中）。`)

/** 決まりを読む（topic_get_guide。B5 の connector/src/guide） */
export const topicGetGuide: ToolHandler = notYet('topic_get_guide')
/** 下書きの一覧を見る（topic_list_drafts） */
export const topicListDrafts: ToolHandler = notYet('topic_list_drafts')
/** 下書きを読む（topic_get_draft） */
export const topicGetDraft: ToolHandler = notYet('topic_get_draft')
/** 下書きを置く（topic_save_draft） */
export const topicSaveDraft: ToolHandler = notYet('topic_save_draft')
/** 照合の結果を当てる（topic_check_draft） */
export const topicCheckDraft: ToolHandler = notYet('topic_check_draft')
