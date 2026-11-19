// Claude との連携の画面の言葉（src/features/claude/claudeUi.ts。段階3の設計の 3.1）: できる事・できない事はコネクタの同意の画面
// （connector/src/auth/consentPage.ts の CONSENT_CAN・CONSENT_CANNOT）と同じ文・ツールの名前の形と並び（コネクタの
// connector/src/mcp/tools.ts の TOOL_DEFS と同じ名前・題・並び）・全部「常に許可」にする訳・接続の一覧の日時（日本時間）
import { describe, expect, it } from 'vitest'
import { CLAUDE_CAN, CLAUDE_CANNOT, CLAUDE_TOOLS, connectionTimeText, TOOL_ALLOW_NOTES, WRITES_HINT } from './claudeUi'

// コネクタのファイルは Worker の型を読むので、取り込まずに文として読む（src/styles.test.ts と同じ読み方）
const NODE_FS = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ NODE_FS)) as {
  readFileSync: (path: string, encoding: 'utf8') => string
}
const fileAt = (relative: string) => decodeURIComponent(new URL(relative, import.meta.url).pathname)
const CONSENT = readFileSync(fileAt('../../../connector/src/auth/consentPage.ts'), 'utf8')
const TOOLS = readFileSync(fileAt('../../../connector/src/mcp/tools.ts'), 'utf8')

/** コネクタのツールの一覧（TOOL_DEFS の readTool(…)・addTool(…) の名前と題。並びのまま） */
function toolDefsOf(source: string): { name: string; title: string }[] {
  const start = source.indexOf('export const TOOL_DEFS')
  if (start < 0) throw new Error('TOOL_DEFS が見つかりません')
  return [...source.slice(start).matchAll(/\b(?:readTool|addTool)\(\s*'(topic_[a-z_]+)',\s*'([^']+)'/g)].map((m) => ({
    name: m[1],
    title: m[2],
  }))
}

/** `export const NAME: readonly string[] = [ '…', '…' ]` の文字の並びを読む */
function stringListOf(source: string, name: string): string[] {
  const m = new RegExp(`export const ${name}: readonly string\\[\\] = \\[([\\s\\S]*?)\\]`).exec(source)
  if (!m) throw new Error(`${name} が見つかりません`)
  return [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1])
}

describe('できる事・できない事（コネクタの同意の画面と同じ文）', () => {
  it('CLAUDE_CAN は CONSENT_CAN、CLAUDE_CANNOT は CONSENT_CANNOT と同じ', () => {
    expect(stringListOf(CONSENT, 'CONSENT_CAN')).toEqual([...CLAUDE_CAN])
    expect(stringListOf(CONSENT, 'CONSENT_CANNOT')).toEqual([...CLAUDE_CANNOT])
  })

  it('足すのは版・話題・辞書・作れなかった印・訂正、読むのは前の版の話題・辞書・「知ってる」語。消す・直す・既読・設定はできない', () => {
    expect(CLAUDE_CAN).toEqual(['版・話題・辞書・作れなかった印・訂正を足す', '前の版の話題・辞書・「知ってる」語を読む'])
    expect(CLAUDE_CANNOT).toEqual(['消す・直す', '既読など読み手の記録を読む', 'アプリの設定を変える'])
  })
})

describe('claude.ai のツールの許可の案内', () => {
  it('ツールの名前は ASCII の topic_*（重ならない）で、題は日本語', () => {
    expect(CLAUDE_TOOLS.length).toBe(16)
    for (const t of CLAUDE_TOOLS) {
      expect(t.name).toMatch(/^topic_[a-z_]+$/)
      expect(t.title.length).toBeGreaterThan(0)
    }
    expect(new Set(CLAUDE_TOOLS.map((t) => t.name)).size).toBe(CLAUDE_TOOLS.length)
    // 作らないツール（同じ記事を探す・「知ってる」の一覧）は無い（段階3の設計の 1.2）
    expect(CLAUDE_TOOLS.map((t) => t.name)).not.toContain('topic_find_article')
    expect(CLAUDE_TOOLS.map((t) => t.name)).not.toContain('topic_list_known')
  })

  it('ツールの名前と題と並びは、コネクタのツールの一覧（connector/src/mcp/tools.ts の TOOL_DEFS）と同じ', () => {
    expect(toolDefsOf(TOOLS)).toEqual(CLAUDE_TOOLS.map((t) => ({ name: t.name, title: t.title })))
  })

  it('全部「常に許可」にする訳: 人のいない定期実行・消す直すツールは無い・足した物は誰も消せない・同じアカウントのすべてのチャットに出る', () => {
    const all = TOOL_ALLOW_NOTES.join('\n')
    expect(all).toContain('定期実行')
    expect(all).toContain('消す・直すツールはありません')
    expect(all).toContain('話題と訂正は30日で消え、辞書はずっと残ります')
    expect(all).toContain('すべてのチャットとセッション')
  })

  it('書き込みの説明は、足すだけで消す・直すはできない事', () => {
    expect(WRITES_HINT).toContain('版・話題・辞書・作れなかった印・訂正を足せます')
    expect(WRITES_HINT).toContain('消す・直すはできません')
  })
})

describe('接続の一覧の日時', () => {
  it('日本時間の「2026年11月19日 10:00」。分からなければ —', () => {
    expect(connectionTimeText(Date.parse('2026-11-19T01:00:00Z'))).toBe('2026年11月19日 10:00')
    expect(connectionTimeText(Date.parse('2026-11-19T15:30:00Z'))).toBe('2026年11月20日 00:30')
    expect(connectionTimeText(null)).toBe('—')
    expect(connectionTimeText(Number.NaN)).toBe('—')
  })
})
