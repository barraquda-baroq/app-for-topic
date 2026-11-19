// 足す道具と訂正する話題を探す道具の中身（B5 が作る: topic_add_topics・topic_add_edition・topic_add_edition_fail・
// topic_add_correction・topic_find_topics）。B3 は形だけを置く（設計の 6.1）。いまは「まだ使えません」を返す。
// B5 が使う物: 書き込みは ctx.add（書き込みの順番・許可とデータの形の版・写しを最後まで読む・「もうある」の時は読み直して組み立て直す）、
// 回の物を消すのは vault/runs.ts の finishRun、写しは core.mirror（版・話題・訂正の軽い行）、
// 足す道具の structuredContent は src/mcp/schemas.ts の ADD_OUTPUT の形（created・skipped）
import type { ToolHandler } from '../core'
import { fail } from './common'

const notYet =
  (name: string): ToolHandler =>
  async () =>
    fail(`この道具（${name}）はまだ使えません（準備中）。`)

/** 訂正する話題を探す（topic_find_topics） */
export const topicFindTopics: ToolHandler = notYet('topic_find_topics')
/** 話題を足す（topic_add_topics） */
export const topicAddTopics: ToolHandler = notYet('topic_add_topics')
/** 版を出す（topic_add_edition） */
export const topicAddEdition: ToolHandler = notYet('topic_add_edition')
/** 作れなかった印を足す（topic_add_edition_fail） */
export const topicAddEditionFail: ToolHandler = notYet('topic_add_edition_fail')
/** 訂正を足す（topic_add_correction） */
export const topicAddCorrection: ToolHandler = notYet('topic_add_correction')
