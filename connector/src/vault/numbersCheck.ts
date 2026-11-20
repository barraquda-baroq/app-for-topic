// 機械の照らし（段階3の設計の 4.7 の「機械の照らし」。点検2 feasible-F15）: 下書きの数字と日付を、出典の控えの本文で探し、見当たらない物と
// その欄の道を「確かめる所」として並べる（topic_get_draft の答えの終わり）。直しはしない。見当たる事は正しい事の証にならないので、照合の係は
// 全部を照らす決まりのまま（決まりの文 verify）。
// - そろえる形: NFKC（全角と半角）・数字の間の桁の区切り（, ，）を除く・「万」「億」「兆」と数字の組み合わせを値にする（3万2,000 = 32000・
//   1.5億 = 150000000）・和暦（令和・平成・昭和。元年も）を西暦に・時刻（10時30分・10:30）
// - 日付は、年月日・年月・年・月日の形で比べる。下書きが年月日で、控えに月日しか無い時は、月日が合えば見当たる事にする（発表の本文は
//   年を書かない事が多いため。年まで確かめるのは照合の係）
// - 1桁の数（単位の倍の語（万など）も小数も無い物）は、すぐ後が「割」「%」「倍」の時だけ見る（「3つの点」のような文の数で、確かめる所が
//   ふくれないように）
// - 見る欄: 事実の欄（見出し・要約・結論の補足・だから何？・当事者の立場の補足・主張・理由・見解・対立の軸と論点・経緯の行と日付・何が新しいか）。
//   用語の説明（辞書の文）・順位の理由・確かめられなかった点は見ない
// 純粋な関数だけ（コネクタの vault/tools/drafts.ts が控えの本文を渡す）。
import type { TopicDraftInput } from '../../../src/domain/input'

/** 確かめる所の1つ（欄の道と、下書きの中の文字のまま） */
export interface MissingNumber {
  path: string
  text: string
}

/** 1回に並べる確かめる所の上限（多い時は「ほか n か所」） */
export const MISSING_MAX = 40

const ERA_BASE: Readonly<Record<string, number>> = { 令和: 2018, 平成: 1988, 昭和: 1925 }
const UNIT: Readonly<Record<string, number>> = { 兆: 1e12, 億: 1e8, 万: 1e4 }

/**
 * 数字の間の桁の区切りを除き、NFKC にそろえる（1字ずつそろえ、そろえた文の位置 → 元の文の位置を持つ。確かめる所に元の文字を出すため）
 */
function normalize(text: string): { s: string; at: number[] } {
  const chars = Array.from(text)
  let s = ''
  const at: number[] = []
  let pos = 0
  chars.forEach((c, i) => {
    const n = c.normalize('NFKC')
    const prev = i > 0 ? chars[i - 1].normalize('NFKC') : ''
    const next = i + 1 < chars.length ? chars[i + 1].normalize('NFKC') : ''
    if ((n === ',' || c === '，') && /\d$/.test(prev) && /^\d/.test(next)) {
      pos += c.length
      return
    }
    for (let k = 0; k < n.length; k++) at.push(pos)
    s += n
    pos += c.length
  })
  at.push(pos)
  return { s, at }
}

const yearOf = (era: string | undefined, y: string): number => (era ? ERA_BASE[era] + (y === '元' ? 1 : Number(y)) : Number(y))

interface Found {
  /** 下書きの中の文字（そろえた形） */
  text: string
  /** 控えの側で探す鍵（どれか1つが当たれば見当たる） */
  need: string[]
  /** 控えの側に置く鍵 */
  keys: string[]
}

// 日付・時刻（長い形から先に当てる。当てた所は空白にしてから数を探す）
const DATE_PATTERNS: readonly { re: RegExp; make: (m: RegExpExecArray) => { need: string[]; keys: string[] } }[] = [
  {
    // 令和8年11月19日・2026年11月19日
    re: /(令和|平成|昭和)?(元|\d{1,4})年(\d{1,2})月(\d{1,2})日/g,
    make: (m) => {
      const y = yearOf(m[1], m[2])
      const md = `md:${Number(m[3])}-${Number(m[4])}`
      return {
        need: [`d:${y}-${md.slice(3)}`, md],
        keys: [`d:${y}-${md.slice(3)}`, md, `ym:${y}-${Number(m[3])}`, `y:${y}`, `mon:${Number(m[3])}`, `day:${Number(m[4])}`],
      }
    },
  },
  {
    // 2026/11/19・2026-11-19・2026.11.19（経緯の日付の形も）
    re: /(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?!\d)/g,
    make: (m) => {
      const md = `md:${Number(m[2])}-${Number(m[3])}`
      const full = `d:${Number(m[1])}-${md.slice(3)}`
      return {
        need: [full, md],
        keys: [full, md, `ym:${Number(m[1])}-${Number(m[2])}`, `y:${Number(m[1])}`, `mon:${Number(m[2])}`, `day:${Number(m[3])}`],
      }
    },
  },
  {
    // 令和8年11月・2026年11月
    re: /(令和|平成|昭和)?(元|\d{1,4})年(\d{1,2})月(?!\d)/g,
    make: (m) => {
      const y = yearOf(m[1], m[2])
      return { need: [`ym:${y}-${Number(m[3])}`], keys: [`ym:${y}-${Number(m[3])}`, `y:${y}`, `mon:${Number(m[3])}`] }
    },
  },
  {
    // 2026-11（経緯の日付の形）
    re: /(?<!\d)(\d{4})-(\d{1,2})(?![\d\-])/g,
    make: (m) => ({
      need: [`ym:${Number(m[1])}-${Number(m[2])}`],
      keys: [`ym:${Number(m[1])}-${Number(m[2])}`, `y:${Number(m[1])}`],
    }),
  },
  {
    // 11月19日
    re: /(?<!\d)(\d{1,2})月(\d{1,2})日/g,
    make: (m) => {
      const md = `md:${Number(m[1])}-${Number(m[2])}`
      return { need: [md], keys: [md, `mon:${Number(m[1])}`, `day:${Number(m[2])}`] }
    },
  },
  {
    // 15日（月の無い日）
    re: /(?<![\d月])(\d{1,2})日/g,
    make: (m) => ({ need: [`day:${Number(m[1])}`], keys: [`day:${Number(m[1])}`] }),
  },
  {
    // 3月（年・日の無い月）
    re: /(?<!\d)(\d{1,2})月(?![\d日])/g,
    make: (m) => ({ need: [`mon:${Number(m[1])}`], keys: [`mon:${Number(m[1])}`] }),
  },
  {
    // 令和8年・2026年（年度も）
    re: /(令和|平成|昭和)(元|\d{1,2})年/g,
    make: (m) => {
      const y = `y:${yearOf(m[1], m[2])}`
      return { need: [y], keys: [y] }
    },
  },
  {
    re: /(?<!\d)(\d{4})年/g,
    make: (m) => ({ need: [`y:${Number(m[1])}`], keys: [`y:${Number(m[1])}`] }),
  },
  {
    // 10時30分・10:30
    re: /(?<!\d)(\d{1,2})(?:時(\d{1,2})分|:(\d{2})(?!\d))/g,
    make: (m) => {
      const t = `t:${Number(m[1])}:${Number(m[2] ?? m[3])}`
      return { need: [t], keys: [t] }
    },
  },
]

/** 数（「万」「億」「兆」の組み合わせを値に。3万2000 → 32000） */
const NUMBER_RE = /\d+(?:\.\d+)?(?:[兆億万]\d*(?:\.\d+)?)*[兆億万]?/g

function valueOf(s: string): { value: number; scaled: boolean } {
  let total = 0
  let scaled = false
  for (const part of s.matchAll(/(\d+(?:\.\d+)?)?([兆億万])?/g)) {
    if (!part[0]) continue
    const n = part[1] ? Number(part[1]) : 1
    if (part[2]) {
      total += n * UNIT[part[2]]
      scaled = true
    } else total += n
  }
  return { value: Math.round(total * 1e6) / 1e6, scaled }
}

/** 文の中の日付・時刻・数（そろえた形の鍵つき。text は元の文の文字のまま） */
export function numberTokens(text: string): Found[] {
  const norm = normalize(text)
  let s = norm.s
  const raw = (start: number, end: number) => text.slice(norm.at[start], norm.at[end])
  const out: { found: Found; at: number }[] = []
  for (const p of DATE_PATTERNS) {
    s = s.replace(p.re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray
      const offset = args[args.length - 2] as number
      const hit = args[0] as string
      const { need, keys } = p.make(m)
      out.push({ found: { text: raw(offset, offset + hit.length), need, keys }, at: offset })
      return ' '.repeat(hit.length)
    })
  }
  for (const m of s.matchAll(NUMBER_RE)) {
    const hit = m[0]
    const start = m.index ?? 0
    const { value, scaled } = valueOf(hit)
    const key = `n:${value}`
    const next = s.slice(start + hit.length, start + hit.length + 1)
    const small = !scaled && !hit.includes('.') && value < 10 && !/[割%倍]/.test(next)
    out.push({ found: { text: raw(start, start + hit.length), need: small ? [] : [key], keys: [key] }, at: start })
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.found)
}

/** 控えの本文の鍵（日付・時刻・数） */
export function haystackKeys(texts: readonly string[]): Set<string> {
  const keys = new Set<string>()
  for (const t of texts) for (const f of numberTokens(t)) for (const k of f.keys) keys.add(k)
  return keys
}

/** 照らす欄（欄の道と文。事実の欄だけ） */
export function draftFields(input: TopicDraftInput): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  const put = (path: string, v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push({ path, text: v })
  }
  put('headline', input.headline)
  put('summary', input.summary)
  put('conclusion.note', input.conclusion?.note)
  for (const k of ['life', 'system', 'world', 'whyNews'] as const) put(`soWhat.${k}`, input.soWhat?.[k])
  ;(input.stakeholders ?? []).forEach((s, i) => {
    put(`stakeholders.${i}.stanceNote`, s.stanceNote)
    put(`stakeholders.${i}.claim`, s.claim)
    put(`stakeholders.${i}.reason`, s.reason)
  })
  if (input.view?.kind === 'opposed') {
    put('view.axis', input.view.axis)
    put('view.issue', input.view.issue)
    put('view.aiView', input.view.aiView)
    put('view.counterView', input.view.counterView)
  }
  ;(input.timeline ?? []).forEach((e, i) => {
    put(`timeline.${i}.when`, e.when)
    put(`timeline.${i}.text`, e.text)
  })
  put('followUp.whatsNew', input.followUp?.whatsNew)
  return out
}

/**
 * 下書きの数字と日付のうち、控えの本文（出典の資料の題と本文）に見当たらない物（欄の道ごと・同じ欄の同じ文字は1つ）。
 * 並びは欄の順・文の順
 */
export function missingNumbers(input: TopicDraftInput, sources: readonly string[]): MissingNumber[] {
  const hay = haystackKeys(sources)
  const out: MissingNumber[] = []
  for (const f of draftFields(input)) {
    const seen = new Set<string>()
    for (const t of numberTokens(f.text)) {
      if (!t.need.length || t.need.some((k) => hay.has(k)) || seen.has(t.text)) continue
      seen.add(t.text)
      out.push({ path: f.path, text: t.text })
    }
  }
  return out
}
