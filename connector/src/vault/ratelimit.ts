// 回数の上限（Vault の SQLite に数える。KV には書かない。NS の connector/src/vault/ratelimit.ts を写し、接続の要求の数を TS の物にした）。OAuth の KV（1日1,000回の書き込み）を、いたずらの接続要求で使い切らない
// ように、/authorize の受け付け（beginConsent の前）と、DCR（ENABLE_DCR の時だけ）の登録を数える。
// /authorize は送ってきたネットワークごと（IPv4 は1つのアドレス、IPv6 は /48。生の IP は残さない）と、コネクタ全体の1日の上限の
// 両方で数える: 1か所から送り続けても、持ち主がほかのネットワークから接続できる分が残る。
// ネットワークごとの数は、その日の分だけを1つの記録に持つ（日が替われば捨てる。全体の上限までしか増えない）。
// 同意の画面の［Topic Studio で確認する］（POST /authorize）は数えない代わりに、同じ同意（handle）を1回しか進めない（claimConsent）。
// 数えた GET 1回で KV に書くのは2回まで（同意の取引と、承認した後の取引）。
import type { MirrorStore } from './store'

export type RateKind = 'authorize' | 'register'

interface Limit {
  perHour?: number
  perDay: number
}

/** OAuth のアクセストークンの有効期間（秒。index.ts の accessTokenTTL）。claude.ai は切れるたびに更新する */
export const ACCESS_TOKEN_TTL_SECONDS = 3600

/**
 * OAuth の KV の書き込みの見積もり（無料枠は1日 1,000 回）: 接続の要求1回で2回（GET /authorize の同意の取引と、POST の承認の後の
 * 取引）、連携を終えるまでにあと3回（許可・コードの交換の許可とトークン。連携1回で約5回）、トークンの更新1回で2回（許可とトークン）
 */
export const KV_WRITES = { perDay: 1_000, perAuthorize: 2, perPairing: 3, perRefresh: 2 } as const

/**
 * TS は NS と同じ Cloudflare のアカウントに置き、KV の無料の書き込み（1日 1,000回）を NS と分け合う（設計の 1.11）。そのため接続の要求を
 * NS（ネットワークごと 10/時・20/日、全体 150/日）より小さくする: 全体の 20 回 ≒ KV の 40 回の書き込み。接続 2（MAX_CONNECTIONS）が
 * 1時間ごとに更新すると1日に 2 × 24 × 2 = 96 回。連携 2 × 3 = 6 回と DCR の登録 10 回（DCR はオフだが NS の式のまま数える）を
 * 合わせて最悪 152 回で、NS の最悪（820 回）と足しても 1,000 回の中（test/unit/basics.test.ts で確かめる）
 */
export const RATE_LIMITS: Record<RateKind, { source?: Limit; global: Limit }> = {
  authorize: { source: { perHour: 5, perDay: 10 }, global: { perDay: 20 } },
  register: { global: { perHour: 10, perDay: 10 } },
}

/**
 * NS のコネクタの OAuth の KV の書き込みの最悪の数（NS の connector/src/vault/ratelimit.ts の式の値: 接続 10 の更新 480・接続の要求の
 * 全体の上限 150 × 2 = 300・連携と登録 40）。同じアカウントで分け合うので、TS の最悪と足して 1,000 を超えないことを確かめるために写した
 */
export const NS_KV_WRITES_WORST = 820

/** 同意を承認したことを覚えておく時間（ライブラリの同意の取引の期限 10分より長く） */
export const CONSENT_CLAIM_MS = 20 * 60_000

/**
 * 同意（handle の指紋 key）の承認を1回だけ通す（2回目からは false）。ライブラリは承認で KV の同意の取引を消すが、KV の削除はすぐには
 * 届かず（同時に・ほかの場所から送り直すと、消える前に読めることがある）、1つの GET から承認の後の取引を何回も書けてしまうため。
 * 覚えるのは、承認できた（本物の同意の取引がある）key だけ。期限を過ぎたものは捨てる
 */
export function claimConsent(store: MirrorStore, key: string, now: number): boolean {
  const saved = store.getMeta<Record<string, number>>('consentClaims')
  const live: Record<string, number> = {}
  for (const [k, until] of Object.entries(saved && typeof saved === 'object' ? saved : {}))
    if (typeof until === 'number' && until > now) live[k] = until
  if (Object.hasOwn(live, key)) return false
  store.setMeta('consentClaims', { ...live, [key]: now + CONSENT_CLAIM_MS })
  return true
}

export type RateResult = { ok: true } | { ok: false; scope: 'source' | 'global'; window: 'hour' | 'day' }

interface Counter {
  hour: string
  hourCount: number
  day: string
  dayCount: number
}

interface SourceCounters {
  day: string
  buckets: Record<string, Counter>
}

function fresh(cur: Counter | null | undefined, hour: string, day: string): Counter {
  return {
    hour,
    hourCount: cur && cur.hour === hour ? cur.hourCount : 0,
    day,
    dayCount: cur && cur.day === day ? cur.dayCount : 0,
  }
}

function over(c: Counter, limit: Limit): 'hour' | 'day' | null {
  if (c.dayCount >= limit.perDay) return 'day'
  if (limit.perHour !== undefined && c.hourCount >= limit.perHour) return 'hour'
  return null
}

const bump = (c: Counter): Counter => ({ ...c, hourCount: c.hourCount + 1, dayCount: c.dayCount + 1 })

/**
 * 1回分を数える（ネットワークごとの上限がある種類は bucket ごとにも。bucket が無ければ 'unknown'）。どちらかが上限なら、
 * どちらも数えずに、どの上限かを返す
 */
export function takeRate(store: MirrorStore, kind: RateKind, now: number, bucket?: string): RateResult {
  const iso = new Date(now).toISOString()
  const hour = iso.slice(0, 13)
  const day = iso.slice(0, 10)
  const limits = RATE_LIMITS[kind]
  const key = `rate:${kind}`
  const srcKey = `rate:${kind}:sources`
  let sources: SourceCounters | null = null
  let src: Counter | null = null
  const name = bucket || 'unknown'
  if (limits.source) {
    const saved = store.getMeta<SourceCounters>(srcKey)
    sources = saved && saved.day === day && saved.buckets && typeof saved.buckets === 'object' ? saved : { day, buckets: {} }
    src = fresh(sources.buckets[name], hour, day)
    const hit = over(src, limits.source)
    if (hit) return { ok: false, scope: 'source', window: hit }
  }
  const global = fresh(store.getMeta<Counter>(key), hour, day)
  const hit = over(global, limits.global)
  if (hit) return { ok: false, scope: 'global', window: hit }
  store.transaction(() => {
    store.setMeta(key, bump(global) satisfies Counter)
    if (sources && src)
      store.setMeta(srcKey, { day, buckets: { ...sources.buckets, [name]: bump(src) } } satisfies SourceCounters)
  })
  return { ok: true }
}

/** 数える単位のネットワーク（IPv4 はそのアドレス、IPv6 は先頭の 48 ビット。IPv4 を埋め込んだ IPv6 は IPv4。読めなければ 'unknown'） */
export function sourceNetwork(ip: string | null | undefined): string {
  const v = (ip ?? '').trim().toLowerCase()
  if (!v) return 'unknown'
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v)
  if (v4) return v4[1]
  if (!/^[0-9a-f:]+$/.test(v) || !v.includes(':')) return 'unknown'
  const parts = v.split('::')
  if (parts.length > 2) return 'unknown'
  const head = parts[0] ? parts[0].split(':') : []
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : []
  const groups =
    parts.length === 2 ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return 'unknown'
  return `${groups
    .slice(0, 3)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/48`
}

/** ネットワークを数える時の名前（sha256 の先頭16文字。salt にコネクタの秘密を混ぜ、記録から IP を戻せないように） */
export async function sourceBucket(ip: string | null | undefined, salt = ''): Promise<string> {
  const net = sourceNetwork(ip)
  if (net === 'unknown') return net
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`rate|${salt}|${net}`)))
  return Array.from(d.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
}
