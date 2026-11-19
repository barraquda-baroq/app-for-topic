// 表の並び（docs/SPEC.md の 7.7 の「表の一覧」）: Claude（コネクタ）に読ませる表（CLAUDE_READ_TABLES）が、アクセスルールの records の
// read の `table in [...]` と同じ並びで、Claude が読める置き場（records）の表と同じ物である事。後から表を足した時に、片方だけ直すのを止める
// （段階3の設計の 2.1。ルールの文は firestore.rules をそのまま読む）。
import { describe, expect, it } from 'vitest'
import rules from '../../firestore.rules?raw'
import { CLAUDE_READ_TABLES, TABLE_NAMES, TABLE_PLACE } from './types'

/** ルールの records の read の式の `table in [...]` の並び（無ければ null） */
function claudeReadTablesInRules(text: string): string[] | null {
  const block = /match \/users\/\{uid\}\/records\/\{docId\}\s*\{([\s\S]*?)\n\s*\}/.exec(text)?.[1]
  if (!block) return null
  const read = /allow read:([\s\S]*?);/.exec(block)?.[1]
  const list = read && /table in \[([^\]]*)\]/.exec(read)?.[1]
  if (!list) return null
  return list
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
}

describe('Claude に読ませる表', () => {
  it('Claude が読める置き場（records）の表だけ。既読（private）は入らない', () => {
    expect([...CLAUDE_READ_TABLES].sort()).toEqual(TABLE_NAMES.filter((t) => TABLE_PLACE[t] === 'records').sort())
    expect(CLAUDE_READ_TABLES).not.toContain('reads')
  })

  it('アクセスルールの records の read の並びと同じ（firestore.rules の文を読む）', () => {
    expect(claudeReadTablesInRules(rules)).toEqual([...CLAUDE_READ_TABLES])
  })

  it('並びを取り出す関数: 並びが無いルールは null', () => {
    expect(claudeReadTablesInRules('match /users/{uid}/records/{docId} {\n  allow read: if isOwner(uid);\n}')).toBeNull()
    expect(
      claudeReadTablesInRules(
        "match /users/{uid}/records/{docId} {\n  allow read: if isOwner(uid) || (x && resource.data.table in ['a', 'b']);\n}",
      ),
    ).toEqual(['a', 'b'])
  })
})
