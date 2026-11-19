// MCP のサーバー（リクエストごとに作る。状態を持たない）。ツールの定義は JSON Schema（schemas.gen.ts）と
// Workers で使える検証（cf-worker。ajv は eval を使うので Workers では動かない）。NS の connector/src/mcp/server.ts を写し、名前を替えた。
// initialize・tools/list は Vault を呼ばない。tools/call だけが Vault（Durable Object）を RPC で呼ぶ。
// 足すツール（kind 'add'）は結果の形（outputSchema。src/mcp/schemas.ts の ADD_OUTPUT: created・skipped）を持ち、structuredContent を返す
// （NS の WRITE_OUTPUT の形）。中身が structured を返さなかった時は空の形を入れる（outputSchema のあるツールが structuredContent を
// 返さないと、MCP の層が失敗にするため）。失敗の答えには入れない
import { CLIENT_INFO_META_KEY, McpServer, fromJsonSchema, type StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker'
import type { ToolResult } from '../vault/tools/common'
import { CONNECTOR_VERSION } from '../version'
import { SERVER_INSTRUCTIONS } from './instructions'
import { ADD_OUTPUT_SCHEMA, TOOL_SCHEMAS, type ToolName } from './schemas.gen'
import { TOOL_DEFS } from './tools'

export type CallTool = (name: ToolName, args: Record<string, unknown>, opts: { client?: string }) => Promise<ToolResult>

const validator = new CfWorkerJsonSchemaValidator()
let compiled: Map<ToolName, StandardSchemaWithJSON> | null = null
let addOutput: StandardSchemaWithJSON | null = null

/** JSON Schema をツールの入力の形にする（Worker の中で1回だけ） */
function schemaOf(name: ToolName): StandardSchemaWithJSON {
  if (!compiled) compiled = new Map<ToolName, StandardSchemaWithJSON>()
  let s = compiled.get(name)
  if (!s) {
    s = fromJsonSchema(TOOL_SCHEMAS[name] as never, validator) as StandardSchemaWithJSON
    compiled.set(name, s)
  }
  return s
}

/** 足すツールの結果（structuredContent）の形（Worker の中で1回だけ） */
function addOutputSchema(): StandardSchemaWithJSON {
  if (!addOutput) addOutput = fromJsonSchema(ADD_OUTPUT_SCHEMA as never, validator) as StandardSchemaWithJSON
  return addOutput
}

/** 呼び出したクライアントの名前（2026-07-28 の呼び出しは _meta の clientInfo、古い呼び出しは HTTP の User-Agent） */
function clientName(ctx: unknown, fallback?: string): string | undefined {
  const env = (ctx as { mcpReq?: { envelope?: Record<string, unknown> } })?.mcpReq?.envelope
  const info = env?.[CLIENT_INFO_META_KEY] as { name?: unknown } | undefined
  return typeof info?.name === 'string' ? info.name : fallback
}

export function createServer(call: CallTool, info: { userAgent?: string } = {}): McpServer {
  const server = new McpServer(
    { name: 'topic-studio', title: 'Topic Studio', version: CONNECTOR_VERSION },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } },
  )
  for (const def of TOOL_DEFS) {
    const structured = def.kind === 'add'
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: schemaOf(def.name),
        ...(structured ? { outputSchema: addOutputSchema() } : {}),
        annotations: def.annotations,
      },
      async (args: unknown, ctx: unknown) => {
        const r = await call(def.name, (args ?? {}) as Record<string, unknown>, { client: clientName(ctx, info.userAgent) })
        return {
          content: [{ type: 'text' as const, text: r.text }],
          ...(r.isError ? { isError: true } : {}),
          ...(structured && !r.isError ? { structuredContent: r.structured ?? { created: [], skipped: [] } } : {}),
        }
      },
    )
  }
  return server
}
