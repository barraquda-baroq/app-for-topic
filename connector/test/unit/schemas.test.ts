// ツールの入力の JSON Schema（src/mcp/schemas.gen.ts）が、zod の定義（src/mcp/schemas.ts）を { io: 'input' } で
// 変換したものと同じか。npm run gen-schemas（GEN_SCHEMAS=1）の時は書き出す（NS の connector/test/unit/schemas.test.ts の形）。
// B0（コネクタの土台）ではツールが無いので、空の形だけを確かめる。入力の形ごとの確かめは B3 がツールと一緒に足す
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as z from 'zod'
import { describe, expect, it } from 'vitest'
import { SCHEMAS } from '../../src/mcp/schemas'
import { TOOL_DEFS } from '../../src/mcp/tools'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.resolve(here, '../../src/mcp/schemas.gen.ts')

function jsonSchema(s: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(s, { io: 'input' }) as Record<string, unknown>
  delete out.$schema
  return out
}

export function renderSchemas(): string {
  const tools: Record<string, unknown> = {}
  for (const [name, s] of Object.entries(SCHEMAS as Record<string, z.ZodType>)) tools[name] = jsonSchema(s)
  const names = Object.keys(SCHEMAS)
  // ツールが無い時は never（空の合併の型は書けない）
  const union = names.length ? `\n${names.map((n) => `  | '${n}'`).join('\n')}` : ' never'
  return `// このファイルは npm --prefix connector run gen-schemas（scripts/gen-schemas.mjs）が src/mcp/schemas.ts から作る。手で直さない。
// zod の定義を JSON Schema（{ io: 'input' }）にしたもの。Workers の中で zod から作り直さないように、作った結果を置いておく。

export type ToolName =${union}

export const TOOL_SCHEMAS: Record<ToolName, Record<string, unknown>> = ${JSON.stringify(tools, null, 2)}
`
}

describe('ツールの JSON Schema', () => {
  it('schemas.gen.ts は schemas.ts から作ったものと同じ（違えば npm --prefix connector run gen-schemas）', () => {
    const text = renderSchemas()
    if (process.env.GEN_SCHEMAS === '1') fs.writeFileSync(target, text)
    // Windows で改行が CRLF で取り出されていても同じとみなす（書き出すのはいつも LF）
    expect(fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')).toBe(text)
  })

  it('すべてのツールに入力の形があり、入力の形はどれもツールの一覧にある', () => {
    for (const def of TOOL_DEFS) expect((SCHEMAS as Record<string, unknown>)[def.name], def.name).toBeTruthy()
    expect(Object.keys(SCHEMAS).sort()).toEqual(TOOL_DEFS.map((d) => d.name).sort())
  })
})
