// ツールの一覧（名前・日本語の題・説明・ヒント）。並びは固定（tools/list でいつも同じ順）。NS の connector/src/mcp/tools.ts の書き方を写した物。
// B0（コネクタの土台）では空。B3 が設計の 1.2 の表のツールを足す（中身は vault/core.ts の TOOL_HANDLERS）。
// - 名前は ASCII の topic_*（64字以内）、題（title）は日本語の「〜する」形（承認の画面・スマホの狭い画面に出る）
// - 説明は「何をするか・いつ使うか・何を返すか・何をしないか」。Claude への手順は書かない（手順は定期実行の依頼文 docs/SCHEDULE.md と、
//   係ごとの決まりの文 topic_get_guide。設計の 1.4・4.8）
// - 読むツール: readOnlyHint true・idempotentHint true。取りに行くツール（候補を見る・資料を読む）だけ openWorldHint true
// - 足すツール: 記録を足すだけで書き換え・削除はしないので destructiveHint false、内容から作る id なので idempotentHint true
//   （回を始めるだけ false）。destructiveHint true のツールは無い（定期実行は人がいないので、claude.ai の許可は全部「常に許可」にする）
import type { ToolName } from './schemas.gen'

export interface ToolAnnotations {
  title: string
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export interface ToolDef {
  name: ToolName
  title: string
  description: string
  kind: 'read' | 'add'
  annotations: ToolAnnotations
}

/** 読むツール（openWorld = 外のサイトの資料を取りに行く） */
export const readTool = (name: ToolName, title: string, description: string, opts: { openWorld?: boolean } = {}): ToolDef => ({
  name,
  title,
  description,
  kind: 'read',
  annotations: {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: opts.openWorld ?? false,
  },
})

/** 足すツール（idempotent = false は回を始めるツールだけ） */
export const addTool = (name: ToolName, title: string, description: string, opts: { idempotent?: boolean } = {}): ToolDef => ({
  name,
  title,
  description,
  kind: 'add',
  annotations: {
    title,
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: opts.idempotent ?? true,
    openWorldHint: false,
  },
})

/** ツールの一覧（B3 が足す） */
export const TOOL_DEFS: readonly ToolDef[] = []

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name)
export const READ_TOOLS = new Set(TOOL_DEFS.filter((t) => t.kind === 'read').map((t) => t.name))
