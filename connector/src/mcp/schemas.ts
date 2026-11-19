// ツールの入力の形（zod）。実行時は使わず、scripts/gen-schemas.mjs が JSON Schema（{ io: 'input' }）にして
// schemas.gen.ts に書き出す（Workers で zod から作り直すと CPU を使うため。ajv は eval を使うので Workers では動かない。NS と同じ）。
// test/unit/schemas.test.ts が一致を確かめる。B0（コネクタの土台）では空。B3 が設計の 1.2 の入力の形を足す（上限は src/domain/limits.ts の
// RECORD_LIMITS から作る。入力の欄の説明は 1.4 の「入力の欄の説明」）
import type * as z from 'zod'

export const SCHEMAS = {} as const satisfies Record<string, z.ZodType>

export type ToolName = keyof typeof SCHEMAS
