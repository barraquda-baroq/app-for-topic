// 文字列の指紋（外側の文書の hash・名札（id）の指紋。docs/SPEC.md の 7.7）。同じ関数を使うアプリと段階3のコネクタ
// （Cloudflare Workers）で同じ値になるように、外の物に頼らない純粋な関数にしておく。
// DS の src/domain/hash.ts の cyrb53・hashJson・recordHash をそのまま写した（NS とも同じ値）。DS の revOf（受け取り箱の指紋）は
// TS に受け取り箱が無いので写さない。名札に使う短い指紋（8字・12字）の fingerprint を足した（src/domain/ids.ts から使う）。
import { stableStringify } from './equal'

/** 53 ビットの文字列ハッシュ（cyrb53）。36進数の文字列で返す（最長 11字） */
export function cyrb53(str: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * 文字列の指紋（2つの種の cyrb53 と長さ。[0-9a-z.] だけ、最長 30 字ほど）。null は ''。
 * 外側の文書の hash（json の指紋）と同じもの（docs/SPEC.md の 7.7 の「1件の文書の形」）。
 */
export function hashJson(json: string | null): string {
  if (json === null) return ''
  return `${cyrb53(json, 1)}.${cyrb53(json, 2)}.${json.length.toString(36)}`
}

/** 外側の文書の hash（記録の stableStringify の指紋。docs/SPEC.md の 7.7） */
export function recordHash(record: unknown): string {
  return hashJson(stableStringify(record))
}

/** 短い指紋の最長（cyrb53 の 11字 × 2） */
const FINGERPRINT_MAX = 22

/**
 * 名札（id）に使う短い指紋（[0-9a-z] だけで length 字。話題・辞書の束・作れなかった印・訂正は 8字、語は 12字。docs/SPEC.md の 7.7）。
 * hashJson の2つの種の cyrb53 を 11字にそろえ（頭を 0 で埋める）、それぞれの後ろ半分ずつをつなぐ（8字なら 4字＋4字）。
 * cyrb53 の36進数の頭の字は数の大きさで偏る（2^53 は 36^10 の約2.5倍なので、11字の物の頭はほぼ 1 か 2）ので、偏りの少ない後ろの字を使う。
 * 材料の文字列（ふつうは stableStringify した物）は呼ぶ側が作る（src/domain/ids.ts）
 */
export function fingerprint(text: string, length: number): string {
  if (!Number.isInteger(length) || length < 1 || length > FINGERPRINT_MAX)
    throw new RangeError(`指紋の長さは 1〜${FINGERPRINT_MAX}`)
  const a = cyrb53(text, 1).padStart(11, '0')
  const b = cyrb53(text, 2).padStart(11, '0')
  const head = Math.ceil(length / 2)
  return a.slice(11 - head) + b.slice(11 - (length - head))
}
