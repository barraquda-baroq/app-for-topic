// 気象庁の Atom と電文から、版に入れてよい種類を絞る決まり（段階3の設計の 1.7 の (5)・(6) の jma-xml。純粋な部品）。
// - 種類の表（JMA_KINDS）: Atom の題（種類の名前）で行に当て、見出しの文（content）に要る語（needWords）がある物だけを残す。
//   残った物を優先の順（津波 ＞ 震度 ＞ 噴火警報 ＞ 特別警報 ＞ 南海トラフ・後発地震 ＞ 遠地地震 ＞ 大雨 ＞ 全般気象情報）・新しい順に並べ、
//   1つの回に電文20本まで読む。電文の値（最大震度・特別警報か など）で最後に決める
// - まとめ方: （EventID・種類の系統）の組ごとに、いちばん新しい電文だけ（同じ地震の津波と震度は系統が違うので別々に1本ずつ）。
//   EventID の無い電文はまとめない
// - 訓練・取消: Status が「通常」でない電文は入れない。InfoType が「取消」の電文は、それ自身と同じ組の候補を外す
// - 電文の文字: 題・発表の時刻・発表した官署・見出しの文・本文の文（Text・Comment）を先に、次に電文の段の順で、地域と値を電文の名前と
//   値のまま1行ずつ（区域をまとめない・値を丸めない）。市町村・観測点が多い時は、段ごとの数を添えて上限まで並べ、超えた分は
//   「ほか n 地点（電文のとおり）」（数えるのはコネクタ。Claude にまとめさせない）
// 種類の名前・要る語は Atom の題・電文の種類のとおりに書き、S1 の probe の種類ごとの件数で合わせる
import { jstParts } from '../../../src/domain/jst'
import { decodeEntities } from './htmlTokens'

/** 種類の系統（まとめる組の片方） */
export type JmaFamily = 'quake' | 'tsunami' | 'volcano' | 'weather' | 'nankai' | 'distant' | 'rain' | 'general'

/** 種類の表の1行 */
export interface JmaKind {
  /** ASCII の印（probe の鍵・控えの kind） */
  id: string
  /** Atom の題（NFKC でそろえて比べる。（Ｒ０６）（Ｈ２７）の名前の物も当てる） */
  titles: readonly string[]
  family: JmaFamily
  /** 優先の順（小さいほど先） */
  priority: number
  region: 'jp' | 'world'
  /** 見出しの文（content）に要る語（どれか1つ。空ならいつも残す） */
  needWords: readonly string[]
  /** 候補の行の印（電文の値で決まらない時） */
  label: string
}

/** 版に入れてよい種類（表に無い種類は入れない: 注意報・特別警報でない警報・天気予報・海上・竜巻・生物季節・降灰・火山の解説など） */
export const JMA_KINDS: readonly JmaKind[] = [
  {
    id: 'tsunami',
    titles: ['津波警報・注意報・予報a', '津波警報・注意報・予報', '津波情報a', '津波情報'],
    family: 'tsunami',
    priority: 1,
    region: 'jp',
    needWords: ['大津波警報', '津波警報', '津波注意報'],
    label: '津波',
  },
  {
    id: 'quake',
    titles: ['震度速報', '震源・震度に関する情報', '震源・震度情報'],
    family: 'quake',
    priority: 2,
    region: 'jp',
    needWords: ['震度5弱', '震度5強', '震度6弱', '震度6強', '震度7'],
    label: '地震',
  },
  {
    id: 'volcano',
    titles: ['噴火警報・予報'],
    family: 'volcano',
    priority: 3,
    region: 'jp',
    needWords: ['噴火警報'],
    label: '噴火警報',
  },
  {
    id: 'special',
    titles: ['気象特別警報・警報・注意報', '気象警報・注意報'],
    family: 'weather',
    priority: 4,
    region: 'jp',
    needWords: ['特別警報'],
    label: '特別警報',
  },
  {
    id: 'nankai',
    titles: [
      '南海トラフ地震に関連する情報',
      '南海トラフ地震臨時情報',
      '南海トラフ地震関連解説情報',
      '北海道・三陸沖後発地震注意情報',
    ],
    family: 'nankai',
    priority: 5,
    region: 'jp',
    needWords: [],
    label: '南海トラフ・後発地震',
  },
  {
    id: 'distant',
    titles: ['遠地地震に関する情報'],
    family: 'distant',
    priority: 6,
    region: 'world',
    needWords: ['津波'],
    label: '遠地地震',
  },
  {
    id: 'rain',
    titles: ['記録的短時間大雨情報', '顕著な大雨に関する気象情報', '顕著な大雨に関する情報'],
    family: 'rain',
    priority: 7,
    region: 'jp',
    needWords: [],
    label: '大雨',
  },
  {
    id: 'general',
    titles: ['全般気象情報', '全般台風情報'],
    family: 'general',
    priority: 8,
    region: 'jp',
    needWords: [],
    label: '全般気象情報',
  },
]

/** 1つの回に読む電文の上限 */
export const JMA_TELEGRAMS_PER_RUN = 20

const nfkc = (s: string) => s.normalize('NFKC').replace(/\s+/g, '')
/** 題の終わりの（R06）（H27）などの版の名前を落とす */
const bareTitle = (s: string) => nfkc(s).replace(/\((?:R|H)\d{2}\)$/i, '')

/** Atom の題の種類の行（表に無ければ null） */
export function kindOfTitle(title: string): JmaKind | null {
  const t = bareTitle(title)
  return JMA_KINDS.find((k) => k.titles.some((x) => bareTitle(x) === t)) ?? null
}

/** Atom の見出しの文に要る語があるか（要る語の無い行はいつも true） */
export function hasNeedWord(kind: JmaKind, content: string): boolean {
  if (!kind.needWords.length) return true
  const c = nfkc(content)
  return kind.needWords.some((w) => c.includes(nfkc(w)))
}

/** Atom の項目（候補の元。電文はまだ読んでいない） */
export interface JmaEntry {
  link: string
  title: string
  kind: JmaKind
  /** 発表の時刻（ms） */
  at: number
}

/** 読む順（優先の順・新しい順） */
export function sortForRead<T extends { kind: JmaKind; at: number }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => a.kind.priority - b.kind.priority || b.at - a.at)
}

// ---------- 電文 ----------

/** 電文の要素（名前空間の頭は落とした名前） */
export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

/** 小さな XML の読み（電文用。読めなければ null） */
export function parseXml(xml: string): XmlNode | null {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  const re =
    /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g
  let count = 0
  for (const m of xml.matchAll(re)) {
    if (++count > 400_000) break
    const top = stack[stack.length - 1]
    if (m[1] !== undefined) {
      top.text += m[1]
      continue
    }
    if (m[6] !== undefined) {
      top.text += decodeEntities(m[6])
      continue
    }
    if (m[3] === undefined) continue
    const name = m[3].includes(':') ? m[3].slice(m[3].indexOf(':') + 1) : m[3]
    if (m[2] === '/') {
      for (let i = stack.length - 1; i > 0; i--)
        if (stack[i].name === name) {
          stack.length = i
          break
        }
      continue
    }
    const attrs: Record<string, string> = {}
    for (const a of (m[4] ?? '').matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const k = a[1].includes(':') ? a[1].slice(a[1].indexOf(':') + 1) : a[1]
      attrs[k] = decodeEntities(a[2] ?? a[3] ?? '')
    }
    const node: XmlNode = { name, attrs, children: [], text: '' }
    top.children.push(node)
    if (m[5] !== '/') stack.push(node)
  }
  return root.children.find((c) => c.name === 'Report') ?? null
}

const child = (n: XmlNode | null | undefined, name: string): XmlNode | null =>
  n ? (n.children.find((c) => c.name === name) ?? null) : null
const kids = (n: XmlNode | null | undefined, name: string): XmlNode[] => (n ? n.children.filter((c) => c.name === name) : [])
const txt = (n: XmlNode | null | undefined): string => (n ? n.text.replace(/\s+/g, ' ').trim() : '')
const path = (n: XmlNode | null, ...names: string[]): XmlNode | null => names.reduce<XmlNode | null>((a, k) => child(a, k), n)

/** 要素を深さ優先で（文書の順） */
function* walk(n: XmlNode, depth = 0): Generator<{ node: XmlNode; depth: number; parent: XmlNode | null }> {
  for (const c of n.children) {
    yield { node: c, depth, parent: n }
    yield* walk(c, depth + 1)
  }
}

/** 震度の値（電文の 5- 5+ 6- 6+ を「5弱」などに。並べる順の数も） */
const INT_RANK: Readonly<Record<string, number>> = { '1': 1, '2': 2, '3': 3, '4': 4, '5-': 5, '5+': 6, '6-': 7, '6+': 8, '7': 9 }
export const intText = (v: string): string => v.replace('-', '弱').replace('+', '強')
export const intRank = (v: string | null): number => (v ? (INT_RANK[v.trim()] ?? 0) : 0)

/** 読んだ電文 */
export interface Telegram {
  title: string
  /** Control/Status（「通常」・「訓練」・「試験」） */
  status: string
  /** Head/InfoType（「発表」・「訂正」・「取消」など） */
  infoType: string
  eventId: string | null
  /** 発表の時刻の文字（Head/ReportDateTime。そのまま） */
  reported: string | null
  office: string
  headline: string
  /** 国内の最大震度（Body/Intensity/Observation/MaxInt。無ければ null） */
  maxInt: string | null
  /** 項目の種類の名前（津波・噴火・警報の Kind/Name と Status。電文のとおり） */
  itemKinds: { name: string; status: string }[]
  /** 本文の文（Text・Comment） */
  comments: string[]
  /** 文字にした行（1.7 の (6) の jma-xml） */
  lines: string[]
}

/** 1つの段に並べる上限（市町村・観測点・区域） */
export const JMA_PLACE_CAP = 150

const PLACE_LABELS: Readonly<Record<string, string>> = {
  Pref: '府県',
  Area: '地域',
  City: '市町村',
  IntensityStation: '観測点',
  Station: '観測点',
}

/** 「2026-11-19T10:00:00+09:00」→「2026-11-19 10:00」（日本時間。読めなければそのまま） */
function jstText(v: string | null): string {
  if (!v) return '不明'
  const ms = Date.parse(v)
  if (!Number.isFinite(ms)) return v
  const p = jstParts(ms)
  return `${p.date} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

/** 電文を読む（Report でなければ null） */
export function parseTelegram(xml: string): Telegram | null {
  const report = parseXml(xml)
  if (!report) return null
  const control = child(report, 'Control')
  const head = child(report, 'Head')
  const body = child(report, 'Body')
  const title = txt(child(head, 'Title')) || txt(child(control, 'Title'))
  const status = txt(child(control, 'Status'))
  const infoType = txt(child(head, 'InfoType'))
  const eventId = txt(child(head, 'EventID')) || null
  const reported = txt(child(head, 'ReportDateTime')) || null
  const office = txt(child(control, 'PublishingOffice')) || txt(child(control, 'EditorialOffice'))
  const headline = txt(path(head, 'Headline', 'Text'))
  const maxInt = txt(path(body, 'Intensity', 'Observation', 'MaxInt')) || null
  const itemKinds: { name: string; status: string }[] = []
  const comments: string[] = []
  if (body)
    for (const { node, parent } of walk(body)) {
      if (node.name === 'Kind' && parent && (parent.name === 'Item' || parent.name === 'Category')) {
        const name = txt(child(node, 'Name'))
        if (name) itemKinds.push({ name, status: txt(child(node, 'Status')) })
      }
      if ((node.name === 'Text' || node.name === 'Comment' || node.name === 'Appendix') && !node.children.length) {
        const t = txt(node)
        if (t && !comments.includes(t)) comments.push(t)
      }
    }
  const lines: string[] = []
  lines.push(`題: ${title || '不明'}`)
  lines.push(`発表: ${jstText(reported)}（${office || '気象庁'}）${infoType && infoType !== '発表' ? `・${infoType}` : ''}`)
  if (headline) lines.push(`見出し: ${headline}`)
  for (const c of comments) lines.push(c)
  if (body) lines.push(...placeLines(body))
  return { title, status, infoType, eventId, reported, office, headline, maxInt, itemKinds, comments, lines }
}

/** 地域と値の行（電文の段の順。区域をまとめない・値を丸めない。多い段は上限まで） */
function placeLines(body: XmlNode): string[] {
  const out: string[] = []
  const shown: Record<string, number> = {}
  const total: Record<string, number> = {}
  /** 段の上限の中なら true（数は数える） */
  const take = (label: string) => {
    total[label] = (total[label] ?? 0) + 1
    if ((shown[label] ?? 0) >= JMA_PLACE_CAP) return false
    shown[label] = (shown[label] ?? 0) + 1
    return true
  }
  const hypo = path(body, 'Earthquake', 'Hypocenter', 'Area')
  if (hypo) out.push(`震源: ${txt(child(hypo, 'Name')) || '不明'}`)
  const mag = path(body, 'Earthquake', 'Magnitude')
  if (mag) out.push(`マグニチュード: ${mag.attrs.description || txt(mag) || '不明'}`)
  const obsMax = txt(path(body, 'Intensity', 'Observation', 'MaxInt'))
  if (obsMax) out.push(`最大震度: ${intText(obsMax)}`)
  const pad = (depth: number) => '  '.repeat(Math.min(3, depth))
  const item = (node: XmlNode, depth: number) => {
    const kinds = [...kids(node, 'Kind'), ...kids(child(node, 'Category'), 'Kind')]
      .map((k) => [txt(child(k, 'Name')), txt(child(k, 'Status'))].filter(Boolean).join('・'))
      .filter(Boolean)
    const height = path(node, 'MaxHeight', 'TsunamiHeight')
    const arrival = txt(path(node, 'FirstHeight', 'ArrivalTime'))
    const extra = [
      txt(path(node, 'FirstHeight', 'Condition')),
      arrival ? `到達 ${jstText(arrival)}` : '',
      height ? `高さ ${height.attrs.description || txt(height)}` : '',
    ].filter(Boolean)
    const value = [...kinds, ...extra].join('・')
    const areas = [...kids(node, 'Area'), ...kids(child(node, 'Areas'), 'Area')]
    if (!areas.length && value) out.push(`${pad(depth)}${value}`)
    for (const a of areas) if (take('Area')) out.push(`${pad(depth)}${txt(child(a, 'Name')) || '不明'}: ${value || '―'}`)
    // 観測点など、Item の中のほかの段
    for (const c of node.children) if (!['Area', 'Areas', 'Kind', 'Category'].includes(c.name)) visit(c, depth + 1)
  }
  const visit = (node: XmlNode, depth: number) => {
    if (node.name === 'Item') return item(node, depth)
    if (node.name === 'Hypocenter') return
    const label = PLACE_LABELS[node.name]
    const name = label ? txt(child(node, 'Name')) : ''
    if (label && name) {
      if (take(node.name)) {
        const v = txt(child(node, 'MaxInt')) || txt(child(node, 'Int'))
        const h = path(node, 'MaxHeight', 'TsunamiHeight')
        const value = v ? `震度${intText(v)}` : h ? `高さ ${h.attrs.description || txt(h)}` : ''
        out.push(`${pad(depth)}${name}${value ? `: ${value}` : ''}`)
      }
      for (const c of node.children) visit(c, depth + 1)
      return
    }
    for (const c of node.children) visit(c, depth)
  }
  for (const c of body.children) visit(c, 0)
  const counts = Object.entries(total)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${PLACE_LABELS[k] ?? '地域'} ${n}`)
  if (counts.length) out.unshift(`（電文の段の数: ${counts.join('・')}）`)
  for (const [k, n] of Object.entries(total)) {
    const left = n - (shown[k] ?? 0)
    if (left > 0) out.push(`ほか ${left} 地点（電文のとおり。${PLACE_LABELS[k] ?? '地域'}）`)
  }
  return out
}

/** 電文で最後に決める（入れる・入れない と、候補の行の印） */
export function telegramVerdict(kind: JmaKind, t: Telegram): { include: boolean; tag: string | null } {
  const names = t.itemKinds.map((k) => k.name.normalize('NFKC'))
  switch (kind.family) {
    case 'quake': {
      if (intRank(t.maxInt) < intRank('5-')) return { include: false, tag: null }
      return { include: true, tag: `最大震度${intText(t.maxInt!)}` }
    }
    case 'tsunami': {
      const live = names.filter((n) => !n.includes('解除') && !n.includes('予報'))
      const top = ['大津波警報', '津波警報', '津波注意報'].find((w) => live.some((n) => n.includes(w)))
      return top ? { include: true, tag: top } : { include: false, tag: null }
    }
    case 'volcano': {
      const hit = names.filter((n) => n.includes('噴火警報'))
      const levels = names
        .map((n) => /レベル\s*([1-5])/.exec(n)?.[1])
        .filter((x): x is string => Boolean(x))
        .map(Number)
      const level = levels.length ? Math.max(...levels) : null
      const resident = hit.some((n) => n.includes('居住地域'))
      if (!hit.length || !(resident || (level !== null && level >= 3))) return { include: false, tag: null }
      return { include: true, tag: level !== null ? `噴火警報 レベル${level}` : '噴火警報' }
    }
    case 'weather': {
      const special = t.itemKinds.filter((k) => k.name.includes('特別警報'))
      const issued = special.some((k) => k.status.includes('発表'))
      const lifted = t.itemKinds.some((k) => k.status.includes('特別警報から')) || special.some((k) => k.status.includes('解除'))
      if (issued) return { include: true, tag: '特別警報' }
      if (lifted) return { include: true, tag: '特別警報の解除' }
      return { include: false, tag: null }
    }
    case 'distant': {
      const c = [t.headline, ...t.comments].join(' ')
      return c.includes('津波') && c.includes('日本') ? { include: true, tag: '遠地地震' } : { include: false, tag: null }
    }
    default:
      return { include: true, tag: kind.label }
  }
}

/** 訓練・試験の電文か（Status が「通常」でない） */
export const isDrill = (t: Telegram): boolean => t.status !== '通常'
/** 取消の電文か */
export const isCancel = (t: Telegram): boolean => t.infoType === '取消'

/** まとめる組の鍵（EventID の無い電文は null = まとめない） */
export const groupKey = (kind: JmaKind, t: Telegram): string | null => (t.eventId ? `${t.eventId}|${kind.family}` : null)
