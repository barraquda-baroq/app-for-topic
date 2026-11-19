// 文字の符号（段階3の設計の 1.7 の (11)。点検2 feasible-F6）: 作り物のバイト列の Shift_JIS が workerd の TextDecoder で読めるか
// （国土交通省の RSS は Shift_JIS。読めなければ「読めない」として取らない形を、S1 を待たずに今確かめる）
import { describe, expect, it } from 'vitest'
import { parseFeed } from '../../src/fetch/rss'
import { charsetOf, decodeBytes } from '../../src/fetch/urlPolicy'

/** 「〇〇省テスト」の Shift_JIS のバイト列（作り物） */
const SJIS = [0x81, 0x5a, 0x81, 0x5a, 0x8f, 0xc8, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67]

/** ASCII と Shift_JIS のバイト列をつなぐ */
function bytes(...parts: (string | number[])[]): Uint8Array {
  const out: number[] = []
  for (const p of parts) {
    if (typeof p === 'string') for (const c of p) out.push(c.charCodeAt(0))
    else out.push(...p)
  }
  return new Uint8Array(out)
}

describe('workerd の TextDecoder', () => {
  it('Shift_JIS（と別名）を読める', () => {
    const b = new Uint8Array(SJIS)
    expect(decodeBytes(b, 'shift_jis')).toBe('〇〇省テスト')
    expect(decodeBytes(b, 'Shift_JIS')).toBe('〇〇省テスト')
    expect(decodeBytes(b, 'x-sjis')).toBe('〇〇省テスト')
    expect(decodeBytes(b, 'windows-31j')).toBe('〇〇省テスト')
  })

  it('XML の宣言の encoding から符号を決めて、RSS 1.0 を読める', () => {
    const xml = bytes(
      '<?xml version="1.0" encoding="Shift_JIS"?>\n<rdf:RDF xmlns:rdf="x" xmlns:dc="y"><item rdf:about="http://example.com/fake/1.html"><title>',
      SJIS,
      '</title><link>http://example.com/fake/1.html</link><dc:date>2026-11-19T10:00:00+09:00</dc:date></item></rdf:RDF>',
    )
    const charset = charsetOf('application/rdf+xml', xml)
    expect(charset).toBe('shift_jis')
    const text = decodeBytes(xml, charset)!
    const f = parseFeed(text)
    expect(f.items[0].title).toBe('〇〇省テスト')
  })

  it('読めない符号は null（その資料・一覧は「読めない」として取らない）', () => {
    expect(decodeBytes(new Uint8Array(SJIS), 'x-no-such-charset')).toBeNull()
  })
})
