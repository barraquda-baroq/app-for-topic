// URL の決まり・応答の読み方（段階3の設計の 1.7 の (11)。取りに行く時の決まりは robots.ts・terms.ts。純粋な部品）。
// - 本文は https: だけ。一覧も https: だけで、例外は data で http: true を付けた一覧（許しの社で、https の一覧が無い時だけ）。
//   項目のリンクは同じ社の本文のホストの https: に直し、直せない物は取らない
// - ホストは出どころの hosts.list（一覧）と hosts.body（本文）だけ（規約のページは probe と見張りの時だけ）。その上で allowPaths の中・
//   denyPaths の外。PDF は読まない。転送は同じホストの中だけで3回まで（取る側で）。denyPaths は、大文字・小文字と %xx の書き方を
//   替えた道（/Churoi/・/%63huroi/）でもすり抜けないよう、そろえてから比べる。続いたスラッシュ（//churoi/）の道は取らない（一重と同じに
//   読むサーバーで、denyPaths・qaPages・robots.txt の道の前方一致をすり抜けないように）
// - 1つの応答は 1MB で読むのを止める。文字の符号は Content-Type・XML の宣言・<meta charset> の順に見る（国土交通省の RSS は Shift_JIS）
// - RSS の断りのある出どころでは、RSS・Atom の応答（Content-Type か中身の頭）を本文として受けず、配信の形の道（.rdf・.rss・.xml・.atom）は
//   本文としても一覧としても取りに行かない
import type { ListConfig, SourceConfig } from './sources'

/** 1つの応答を読む上限（バイト） */
export const MAX_RESPONSE_BYTES = 1_000_000
/** 転送をたどる上限（同じホストの中だけ） */
export const MAX_REDIRECTS = 3

/** URL の決まりで断る訳 */
export type UrlRefusal = 'url' | 'scheme' | 'host' | 'path' | 'deny' | 'pdf'

export type UrlCheck = { ok: true; url: URL } | { ok: false; why: UrlRefusal }

/** URL を読む（利用者の名前・パスワード・決まりでない番号のポートは断る） */
function parseUrl(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.username || u.password || u.port) return null
  return u
}

/** 道が前方一致の並びのどれかに当たるか */
export const pathIn = (path: string, prefixes: readonly string[]): boolean => prefixes.some((p) => path.startsWith(p))

/** 取らない道と比べる形（%xx を字に戻せる物は戻し、小文字に。サーバーが大文字・小文字を区別しない時も、すり抜けないように） */
function denyForm(path: string): string {
  let t = path
  try {
    t = decodeURIComponent(path)
  } catch {
    t = path.replace(/%([0-9a-f]{2})/gi, (m, h: string) => {
      const c = parseInt(h, 16)
      return c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : m
    })
  }
  return t.toLowerCase()
}

/** 取らない道に当たるか（大文字・小文字と %xx の書き方をそろえて比べる） */
export const pathDenied = (path: string, denyPaths: readonly string[]): boolean => {
  const p = denyForm(path)
  return denyPaths.some((d) => p.startsWith(denyForm(d)))
}

/** 続いたスラッシュのある道か（//churoi/・/jp//rss/。取らない） */
export const hasDoubleSlash = (path: string): boolean => path.includes('//')

/** 配信（RSS・Atom）の形の道か（RSS の断りのある出どころで取りに行かない） */
export const isFeedPath = (path: string): boolean => /\.(?:rdf|rss|xml|atom)$/i.test(path)

/** PDF の道か（.pdf で終わる。問い合わせ部分の前で見る） */
export const isPdfPath = (path: string): boolean => /\.pdf$/i.test(path)

/** 本文を取ってよい URL か（https:・本文のホスト・allowPaths の中・denyPaths の外・PDF でない） */
export function checkBodyUrl(src: SourceConfig, raw: string): UrlCheck {
  const u = parseUrl(raw)
  if (!u) return { ok: false, why: 'url' }
  if (u.protocol !== 'https:') return { ok: false, why: 'scheme' }
  const host = u.hostname.toLowerCase()
  if (!src.hosts.body.includes(host)) return { ok: false, why: 'host' }
  if (hasDoubleSlash(u.pathname) || pathDenied(u.pathname, src.denyPaths)) return { ok: false, why: 'deny' }
  if (src.terms.rssRefused && isFeedPath(u.pathname)) return { ok: false, why: 'deny' }
  if (!pathIn(u.pathname, src.allowPaths)) return { ok: false, why: 'path' }
  if (isPdfPath(u.pathname)) return { ok: false, why: 'pdf' }
  return { ok: true, url: u }
}

/** 一覧を取ってよい URL か（一覧のホスト・https:。http: は data で http: true を付けた許しの社の一覧だけ。denyPaths の外） */
export function checkListUrl(src: SourceConfig, list: ListConfig, raw: string): UrlCheck {
  const u = parseUrl(raw)
  if (!u) return { ok: false, why: 'url' }
  const httpOk = list.kind === 'rss' && list.http === true && src.permit?.rssAllowed === true
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && httpOk)) return { ok: false, why: 'scheme' }
  if (!src.hosts.list.includes(u.hostname.toLowerCase())) return { ok: false, why: 'host' }
  if (hasDoubleSlash(u.pathname) || pathDenied(u.pathname, src.denyPaths)) return { ok: false, why: 'deny' }
  if (src.terms.rssRefused && (list.kind !== 'html' || isFeedPath(u.pathname))) return { ok: false, why: 'deny' }
  return { ok: true, url: u }
}

/**
 * 一覧の転送の行き先として取ってよいか（一覧の URL の決まりに合い、本文のホストの中なら allowPaths の中。気象庁の /developer/xml/ や
 * Global Voices の /feed/ の外へ転送されてもたどらない）
 */
export function listHopOk(src: SourceConfig, list: ListConfig, u: URL): boolean {
  if (!checkListUrl(src, list, u.href).ok) return false
  return !src.hosts.body.includes(u.hostname.toLowerCase()) || pathIn(u.pathname, src.allowPaths)
}

/**
 * 一覧の項目のリンクを、本文を取る URL に直す（相対は一覧の URL から。http: は同じ社の本文のホストの時だけ https: に直す。
 * 消防庁の #番号 は残し、ほかは # の後を落とす）。直せない物は null
 */
export function itemUrl(src: SourceConfig, href: string, base: string, keepHash = false): string | null {
  let u: URL
  try {
    u = new URL(href.trim(), base)
  } catch {
    return null
  }
  if (u.protocol === 'http:') {
    if (!src.hosts.body.includes(u.hostname.toLowerCase())) return null
    u.protocol = 'https:'
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null
  if (u.port === '443' || u.port === '80') u.port = ''
  if (u.port) return null
  if (!keepHash) u.hash = ''
  return u.href
}

/** 項目のリンクを候補にしない訳（無ければ null）: ほかのホスト・取らない道・PDF・許していない道 */
export function itemRefusal(src: SourceConfig, url: string): 'other-host' | 'deny' | 'pdf' | 'path' | null {
  const c = checkBodyUrl(src, url)
  if (c.ok) return null
  if (c.why === 'host' || c.why === 'scheme' || c.why === 'url') return 'other-host'
  if (c.why === 'deny') return 'deny'
  if (c.why === 'pdf') return 'pdf'
  return 'path'
}

/** Content-Type の型（小文字・引数なし） */
export const mimeOf = (contentType: string | null): string => (contentType ?? '').split(';')[0].trim().toLowerCase()

/** PDF の応答か */
export const isPdfResponse = (contentType: string | null): boolean => mimeOf(contentType) === 'application/pdf'

const FEED_TYPES = new Set(['application/rss+xml', 'application/atom+xml', 'application/rdf+xml'])

/** 頭の処理命令（<?xml?>・<?xml-stylesheet?>）・<!DOCTYPE>・注・空白 */
const XML_PROLOG = /^(?:\s+|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->)/i

/**
 * RSS・Atom の応答か（Content-Type か、中身の頭が <rss・<rdf:RDF・<feed。頭の <?xml-stylesheet?>・<!DOCTYPE>・注は飛ばす）。
 * Content-Type が text/xml・application/xml の時は、頭の中に <channel・<item・<entry があれば配信と見る（断る側に寄せる）
 */
export function isFeedResponse(contentType: string | null, head: string): boolean {
  const mime = mimeOf(contentType)
  if (FEED_TYPES.has(mime)) return true
  let t = head.replace(/^\uFEFF/, '')
  for (let i = 0; i < 50; i++) {
    const m = XML_PROLOG.exec(t)
    if (!m || !m[0]) break
    t = t.slice(m[0].length)
  }
  if (/^<(?:rss|rdf:RDF|feed)[\s>]/i.test(t)) return true
  return (mime === 'text/xml' || mime === 'application/xml') && /<(?:channel|item|entry)[\s>]/i.test(head)
}

/** 確認画面か（Cloudflare などの cf-mitigated: challenge・「Just a moment...」の頁） */
export function isChallenge(headers: Headers, status: number, head = ''): boolean {
  if ((headers.get('cf-mitigated') ?? '').toLowerCase().includes('challenge')) return true
  if (status !== 403 && status !== 503 && status !== 429 && status !== 200) return false
  return /<title>\s*(?:Just a moment|Attention Required|Access denied)|challenge-platform|cf-chl-/i.test(head.slice(0, 4_000))
}

/** 応答の本文を上限まで読む（超えた分は読まずに止める） */
export async function readCapped(res: Response, max = MAX_RESPONSE_BYTES): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size))
      size = max
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
    size += value.byteLength
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return { bytes: out, truncated }
}

/** 文字の符号の名前（Content-Type の charset・XML の宣言の encoding・<meta charset> の順。無ければ utf-8） */
export function charsetOf(contentType: string | null, bytes: Uint8Array): string {
  const fromType = /charset\s*=\s*"?([A-Za-z0-9_.:-]+)/i.exec(contentType ?? '')
  if (fromType) return fromType[1].toLowerCase()
  // 頭の 2KB だけを ASCII として読んで、宣言を探す
  let head = ''
  for (let i = 0; i < Math.min(bytes.length, 2_048); i++) head += String.fromCharCode(bytes[i] < 128 ? bytes[i] : 32)
  const xml = /<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9_.:-]+)["']/i.exec(head)
  if (xml) return xml[1].toLowerCase()
  const meta = /<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9_.:-]+)/i.exec(head)
  if (meta) return meta[1].toLowerCase()
  return 'utf-8'
}

/** 符号の名前のそろえ（TextDecoder の名前に） */
const CHARSET_ALIASES: Readonly<Record<string, string>> = {
  'x-sjis': 'shift_jis',
  sjis: 'shift_jis',
  'shift-jis': 'shift_jis',
  'windows-31j': 'shift_jis',
  cp932: 'shift_jis',
  ms932: 'shift_jis',
  'x-euc-jp': 'euc-jp',
}

/** バイト列を文字にする（読めない符号は null。読めない字は置き換え字になる） */
export function decodeBytes(bytes: Uint8Array, charset: string): string | null {
  const label = CHARSET_ALIASES[charset.toLowerCase()] ?? charset.toLowerCase()
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return null
  }
}

/** 英語の題の slug の形（語を - でつないだ物。3語以上。vault/tools/read.ts の probe の表と同じ形） */
const SLUG_RUN = /[A-Za-z]{2,}(?:-[A-Za-z0-9]+){2,}/g

/**
 * 道の形（数字を N に、英語の題の slug に見える所を SLUG にした物。題・リンクの文字は出さない。probe の「道の形の数」）。
 * probe の値に slug を入れない（topic_status も長さだけにするが、そもそも控えに残さない）
 */
export function pathShape(path: string): string {
  return path.replace(/\d+/g, 'N').replace(SLUG_RUN, 'SLUG').slice(0, 64)
}
