// ツールの入力の JSON Schema（src/mcp/schemas.gen.ts）が、zod の定義（src/mcp/schemas.ts）を { io: 'input' } で
// 変換したものと同じか。npm run gen-schemas（GEN_SCHEMAS=1）の時は書き出す（NS の connector/test/unit/schemas.test.ts の形）。
// 入力の形の要点（設計の 1.2・1.4・1.5）: 既定値のある欄は必須にならない・回の種類と probe の決まった値・話題の入力の形・照合の直す所の形・
// 上限の数が RECORD_LIMITS と同じ・入力の欄の説明に上限と null の意味がある
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as z from 'zod'
import { describe, expect, it } from 'vitest'
import { PATCHES_MAX } from '../../../src/domain/input'
import { RECORD_LIMITS } from '../../../src/domain/limits'
import { REASON_KIND_VALUES } from '../../../src/domain/types'
import { ADD_OUTPUT, PROBE_ENUM, RUN_KIND_ENUM, SCHEMAS } from '../../src/mcp/schemas'
import { TOOL_DEFS } from '../../src/mcp/tools'
import { PROBE_KINDS, RUN_KINDS } from '../../src/vault/runs'
import { LOOKUP_MAX_WORDS } from '../../src/vault/tools/read'

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

export const ADD_OUTPUT_SCHEMA: Record<string, unknown> = ${JSON.stringify(jsonSchema(ADD_OUTPUT), null, 2)}
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

  type Prop = {
    type?: unknown
    maxLength?: number
    maxItems?: number
    minItems?: number
    minimum?: number
    maximum?: number
    default?: unknown
    enum?: unknown[]
    description?: string
    required?: string[]
    properties?: Record<string, Prop>
    items?: Prop
    anyOf?: Prop[]
  }
  const schema = (name: keyof typeof SCHEMAS) => jsonSchema(SCHEMAS[name]) as Prop

  it('入力の形（io: input）: 既定値のある欄は必須にならない。回の種類・probe・作れなかった訳は決まった値', () => {
    const read = schema('topic_read_article')
    expect(read.required).toEqual(['runId', 'ref'])
    expect(read.properties!.maxChars).toMatchObject({ default: 6_000, minimum: 1_500, maximum: 6_000 })
    const begin = schema('topic_begin_run')
    expect(begin.required).toEqual(['kind', 'model'])
    expect(begin.properties!.kind.enum).toEqual([...RUN_KINDS])
    expect(begin.properties!.probe.enum).toEqual([...PROBE_KINDS])
    expect([...RUN_KIND_ENUM]).toEqual([...RUN_KINDS])
    expect([...PROBE_ENUM]).toEqual([...PROBE_KINDS])
    expect(begin.properties!.model.maxLength).toBe(RECORD_LIMITS.base.model)
    expect(schema('topic_add_edition_fail').properties!.reasonKind.enum).toEqual([...REASON_KIND_VALUES])
    expect(schema('topic_add_edition').required).toEqual(['runId', 'order', 'candidateCount'])
    expect(schema('topic_status').required).toBeUndefined()
    expect(schema('topic_list_recent').properties).toEqual({})
  })

  it('並びの数の上限は RECORD_LIMITS・設計の 1.6 と同じ', () => {
    const L = RECORD_LIMITS
    const topic = schema('topic_save_draft').properties!.topic.properties!
    expect(topic.sources).toMatchObject({ minItems: L.topic.sourcesMin, maxItems: L.topic.sources })
    expect(topic.stakeholders.maxItems).toBe(L.topic.stakeholders)
    expect(topic.timeline.maxItems).toBe(L.topic.timeline)
    expect(topic.unverified.maxItems).toBe(L.topic.unverified)
    expect(topic.rank).toMatchObject({ minimum: L.topic.rankMin, maximum: L.topic.rankMax })
    expect(schema('topic_lookup_terms').properties!.words.maxItems).toBe(LOOKUP_MAX_WORDS)
    expect(schema('topic_check_draft').properties!.patches.maxItems).toBe(PATCHES_MAX)
    expect(schema('topic_add_topics').properties!.items).toMatchObject({ minItems: 1, maxItems: 5 })
    expect(schema('topic_add_edition').properties!.order).toMatchObject({ minItems: 1, maxItems: L.edition.order })
    expect(schema('topic_add_edition').properties!.notChosen.maxItems).toBe(L.edition.notChosen)
    expect(schema('topic_add_correction').properties!.text.maxLength).toBe(L.correction.text)
  })

  it('話題の文の字数は組み立てで断るので maxLength を付けず、説明に上限と null の意味を書く', () => {
    const topic = schema('topic_save_draft').properties!.topic
    expect(topic.required).toEqual([
      'rank',
      'rankReason',
      'region',
      'genre',
      'major',
      'headline',
      'summary',
      'conclusion',
      'soWhat',
      'stakeholders',
      'view',
      'timeline',
      'followUp',
      'terms',
      'sources',
      'unverified',
    ])
    const p = topic.properties!
    expect(p.headline.maxLength).toBeUndefined()
    expect(p.headline.description).toContain(`${RECORD_LIMITS.topic.headline}字まで`)
    expect(p.soWhat.properties!.life.description).toContain('null = この話題では特になし')
    expect(p.stakeholders.items!.properties!.claim.description).toContain('null = 今回読んだ資料では、主張を確かめられなかった')
    // 出典は ref だけ（url・題・社の名前は入力に無い。outletNames も無い）
    expect(Object.keys(p.sources.items!.properties!)).toEqual(['ref', 'outlet'])
    expect(p.outletNames).toBeUndefined()
    // 用語の指し方は4つ（説明を新しくする・新しい語・termId・表記）。余分な欄は断る
    expect(p.terms.items!.anyOf).toHaveLength(4)
    for (const v of p.terms.items!.anyOf!) expect((v as { additionalProperties?: boolean }).additionalProperties).toBe(false)
  })

  it('照合の直す所は5つの形（置き換え・決まった値・消す・確かめられなかった点を足す・強調の入れ替え）', () => {
    const items = schema('topic_check_draft').properties!.patches.items!
    expect(items.anyOf).toHaveLength(5)
    const req = items.anyOf!.map((v) => v.required)
    expect(req).toEqual([
      ['path', 'find', 'to', 'why'],
      ['path', 'set', 'why'],
      ['path', 'remove', 'why'],
      ['path', 'add', 'why'],
      ['path', 'emphasis'],
    ])
    expect(items.anyOf![0].properties!.why.enum).toContain('subject')
    expect(items.anyOf![0].properties!.why.enum).toContain('area')
  })

  it('足す道具の結果の形（created・skipped）', () => {
    expect(jsonSchema(ADD_OUTPUT)).toMatchObject({ required: ['created', 'skipped'] })
  })
})
