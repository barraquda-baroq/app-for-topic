// 照合の直す所を下書きの入力に当てる（段階3。段階3の設計の 1.5 の「照合の直す所の形」。15.3 の減らす案 3）。照合の係は全文を書き直さず、
// 直す所（src/domain/input.ts の DraftPatch）だけを返し、コネクタがここで入力（組み立ての前）に当ててから組み立て直す（src/domain/assemble.ts）。
// - 全部当たらなければ何も当てない（1つでも当たらない・形が違う物があれば、入力はそのままで、訳を返す）
// - find は、その欄の文に1回だけ出る物（0回・2回以上は断る）
// - 並びの番号は、当てる前の入力の番号（消す物は最後にまとめて消すので、前の要素を消しても後ろの番号はずれない）。消す要素を直す物は断る
// - stakeholders.n.claim を null にすると、決まり（docs/SPEC.md の 7.1）どおり stance を 'unknown'、stanceNote・reason を null にし、
//   その主張の強調も外す
// - 文を直した欄で、文に無くなった強調の語句は外して返す。外した結果、AI の見解と対立見解の強調の数が違えば、何も当てずに断る
// - 用語の説明（terms.n.explanation・asOf・aliases）を直すと、辞書の語なら「新しい説明（rev ＋1）」の指し方に替わる（下書きの中の新しい語・
//   新しい説明なら、その文を直す）
// fixed = 中身を変えた直す所の数（強調の入れ替えは数えない）。why は直した訳の種類ごとの数（回の中で数え、版の答えと報告に出す）。
import {
  INPUT_EMPHASIS_FIELDS,
  PATCH_WHY_VALUES,
  PATCHES_MAX,
  type DraftPatch,
  type PatchWhy,
  type TermRefInput,
  type TopicDraftInput,
} from './input'
import type { TermEntry } from './types'
import type { Problem } from './validate'

export interface PatchOptions {
  /** 辞書の語を引く（terms.n が termId か表記で指す辞書の語の説明を直す時に、今の説明を写すため） */
  termEntry?: (ref: TermRefInput) => TermEntry | null
}

export interface PatchResult {
  /** 全部当たったか（false の時、input は当てる前のまま） */
  ok: boolean
  input: TopicDraftInput
  errors: Problem[]
  /** 中身を変えた直す所の数（強調の入れ替えは数えない） */
  fixed: number
  /** 直した訳の種類ごとの数 */
  why: Partial<Record<PatchWhy, number>>
  /** 文を直したので外した強調の語句（入力の欄の道と語句） */
  droppedEmphasis: { path: string; phrase: string }[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** 直してよい入力の欄の頭（出典は消すだけ。資料の控えから書くので、ref・社を替えない） */
const TOP_KEYS = new Set([
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

/** set で文字の並びを丸ごと替えられる欄（確かめられなかった点と、下書きの中の語・新しい説明の別名） */
const STRING_LIST_PATH = /^(unverified|terms\.(0|[1-9][0-9]*)\.(new|revise)\.aliases)$/
/** set で足してよい、入力に無くてよい欄（辞書の語の、この話題での表記） */
const TERM_SURFACE_PATH = /^terms\.(0|[1-9][0-9]*)\.term$/

/** 欄の文に、語句が何回出るか（重ならずに数える） */
function occurrences(text: string, find: string): number {
  let n = 0
  for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + find.length)) n += 1
  return n
}

/** 道を区切る（数は並びの番号） */
const segmentsOf = (path: string): (string | number)[] =>
  path.split('.').map((s) => (/^(0|[1-9][0-9]*)$/.test(s) ? Number(s) : s))

/** 道の親と最後の区切り（親が無い・形が違えば null） */
function locate(root: Obj, segs: readonly (string | number)[]): { parent: Obj | unknown[]; key: string | number } | null {
  let cur: unknown = root
  for (const s of segs.slice(0, -1)) {
    if (typeof s === 'number') {
      if (!Array.isArray(cur) || s >= cur.length) return null
      cur = cur[s]
    } else {
      if (!isObj(cur) || !(s in cur)) return null
      cur = cur[s]
    }
  }
  const key = segs[segs.length - 1]
  if (typeof key === 'number') return Array.isArray(cur) && key < cur.length ? { parent: cur, key } : null
  return isObj(cur) ? { parent: cur, key } : null
}

const getAt = (p: { parent: Obj | unknown[]; key: string | number }): unknown =>
  Array.isArray(p.parent) ? p.parent[p.key as number] : (p.parent as Obj)[p.key as string]

function setAt(p: { parent: Obj | unknown[]; key: string | number }, v: unknown): void {
  if (Array.isArray(p.parent)) p.parent[p.key as number] = v
  else (p.parent as Obj)[p.key as string] = v
}

/** set で入れてよい値（決まった値・文・数・真偽・null・文字の並び（別名）） */
const isSettable = (v: unknown): boolean =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v)) ||
  (Array.isArray(v) && v.every((x) => typeof x === 'string'))

/** 強調の欄（入力の欄の道 → 強調の語句の並びと、その欄の文） */
interface EmphasisSlot {
  get(): string[] | undefined
  set(v: string[] | undefined): void
  text(): string | null
}

/** 強調の欄を、記録の鍵（'summary'・'stakeholders.2.claim'）か入力の道（'stakeholders.2.claimEmphasis'・'emphasis.summary'）で引く */
function emphasisSlot(draft: TopicDraftInput, path: string): { key: string; slot: EmphasisSlot } | null {
  const p = path.replace(/^emphasis\./, '')
  const s = /^stakeholders\.(0|[1-9][0-9]*)\.(?:claim|claimEmphasis)$/.exec(p)
  if (s) {
    const el = draft.stakeholders[Number(s[1])]
    if (!el) return null
    return {
      key: `stakeholders.${s[1]}.claimEmphasis`,
      slot: {
        get: () => el.claimEmphasis,
        set: (v) => (v === undefined ? delete el.claimEmphasis : (el.claimEmphasis = v)),
        text: () => (typeof el.claim === 'string' ? el.claim : null),
      },
    }
  }
  const t = /^timeline\.(0|[1-9][0-9]*)\.(?:text|emphasis)$/.exec(p)
  if (t) {
    const el = draft.timeline[Number(t[1])]
    if (!el) return null
    return {
      key: `timeline.${t[1]}.emphasis`,
      slot: {
        get: () => el.emphasis,
        set: (v) => (v === undefined ? delete el.emphasis : (el.emphasis = v)),
        text: () => (typeof el.text === 'string' ? el.text : null),
      },
    }
  }
  if (!(INPUT_EMPHASIS_FIELDS as readonly string[]).includes(p)) return null
  const field = p as (typeof INPUT_EMPHASIS_FIELDS)[number]
  const text = (): string | null => {
    const [head, tail] = field.split('.') as [string, string | undefined]
    if (head === 'summary') return draft.summary
    if (head === 'conclusion') return draft.conclusion.note
    if (head === 'soWhat') return draft.soWhat[tail as keyof TopicDraftInput['soWhat']]
    if (head === 'view') return draft.view.kind === 'opposed' ? ((draft.view as Obj)[tail as string] as string) : null
    return draft.followUp ? draft.followUp.whatsNew : null
  }
  return {
    key: `emphasis.${field}`,
    slot: {
      get: () => draft.emphasis?.[field],
      set: (v) => {
        if (v === undefined) {
          if (draft.emphasis) delete draft.emphasis[field]
        } else (draft.emphasis ??= {})[field] = v
      },
      text: () => {
        const v = text()
        return typeof v === 'string' ? v : null
      },
    },
  }
}

/** 強調の欄の全部（記録の欄の道の順） */
function allEmphasisSlots(draft: TopicDraftInput): { key: string; slot: EmphasisSlot }[] {
  const paths = [
    ...INPUT_EMPHASIS_FIELDS.slice(0, 6),
    ...draft.stakeholders.map((_, i) => `stakeholders.${i}.claim`),
    ...INPUT_EMPHASIS_FIELDS.slice(6, 8),
    ...draft.timeline.map((_, i) => `timeline.${i}.text`),
    INPUT_EMPHASIS_FIELDS[8],
  ]
  return paths.flatMap((p) => emphasisSlot(draft, p) ?? [])
}

/** 文を直した欄の、強調の欄の鍵（直した欄の道から） */
function emphasisKeyOfTextPath(path: string): string | null {
  if ((INPUT_EMPHASIS_FIELDS as readonly string[]).includes(path)) return `emphasis.${path}`
  const s = /^stakeholders\.(\d+)\.claim$/.exec(path)
  if (s) return `stakeholders.${s[1]}.claimEmphasis`
  const t = /^timeline\.(\d+)\.text$/.exec(path)
  if (t) return `timeline.${t[1]}.emphasis`
  return null
}

/** 照合の直す所を入力に当てる（入力は変えない。全部当たらなければ何も当てない） */
export function applyPatches(input: TopicDraftInput, patches: readonly DraftPatch[], opts: PatchOptions = {}): PatchResult {
  const errors: Problem[] = []
  const draft = clone(input)
  const root = draft as unknown as Obj
  const removes = new Map<string, Set<number>>()
  const adds: string[] = []
  const touched = new Set<string>()
  const emphasisSet = new Set<string>()
  const why: Partial<Record<PatchWhy, number>> = {}
  let fixed = 0
  const fail = (j: number, path: string, code: string, message: string) =>
    errors.push({ path: `patches.${j}`, code: `patch:${code}`, message: `直す所 ${j}（${path}）: ${message}` })

  if (patches.length > PATCHES_MAX)
    errors.push({ path: 'patches', code: 'patch:count', message: `直す所は1回に${PATCHES_MAX}までです（${patches.length}）` })

  /** 消す要素の中か（消す要素そのもの・その中の欄） */
  const insideRemoved = (segs: readonly (string | number)[]): boolean => {
    for (let k = 1; k < segs.length; k++) {
      const idx = segs[k]
      if (typeof idx === 'number' && removes.get(segs.slice(0, k).join('.'))?.has(idx)) return true
    }
    return false
  }

  /** 用語の欄を直す道を、下書きの中の新しい語・新しい説明の欄の道にする（辞書の語は新しい説明の指し方に替える） */
  const termPath = (j: number, path: string, segs: (string | number)[]): (string | number)[] | null => {
    if (segs[0] !== 'terms' || typeof segs[1] !== 'number' || segs.length !== 3) return segs
    const i = segs[1]
    const field = segs[2]
    const ref = draft.terms[i] as TermRefInput | undefined
    if (!ref || typeof field !== 'string') return segs
    if ('new' in ref) return ['terms', i, 'new', field]
    if ('revise' in ref) {
      if (field === 'explanation' || field === 'asOf' || field === 'aliases') {
        if (field === 'aliases' && ref.revise.aliases === undefined) {
          const e = opts.termEntry?.({ termId: ref.termId })
          if (!e) return (fail(j, path, 'term', '辞書の語を引けません（別名を直せません）'), null)
          ref.revise.aliases = [...e.aliases]
        }
        return ['terms', i, 'revise', field]
      }
      return segs
    }
    if (field === 'explanation' || field === 'asOf' || field === 'aliases') {
      const e = opts.termEntry?.(ref)
      if (!e) return (fail(j, path, 'term', '辞書の語を引けません（説明を直せません）'), null)
      draft.terms[i] = {
        termId: e.termId,
        revise: { explanation: e.explanation, asOf: e.asOf, ...(field === 'aliases' ? { aliases: [...e.aliases] } : {}) },
      }
      return ['terms', i, 'revise', field]
    }
    return segs
  }

  const count = (w: PatchWhy) => {
    fixed += 1
    why[w] = (why[w] ?? 0) + 1
  }
  /** 直す所の欄の道と、訳（emphasis 以外は要る） */
  const head = (patch: DraftPatch, j: number): { p: Obj; path: string } | null => {
    const p = patch as Obj
    const path = typeof p.path === 'string' ? p.path.trim() : ''
    if (!path) return (fail(j, String(p.path), 'path', '欄の道がありません'), null)
    if (!('emphasis' in p) && !(PATCH_WHY_VALUES as readonly string[]).includes(p.why as string))
      return (fail(j, path, 'why', `直した訳（why）は ${PATCH_WHY_VALUES.join('・')} のどれかにしてください`), null)
    return { p, path }
  }

  // 1回目: 消す物を先に集める（並びの番号は当てる前の入力の番号。消す要素を直す物は、直す所の順に関わらず断る）
  patches.forEach((patch, j) => {
    if (!('remove' in (patch as Obj))) return
    const h = head(patch, j)
    if (!h) return
    const { p, path } = h
    const segs = segmentsOf(path)
    if (p.remove !== true) return fail(j, path, 'value', 'remove は true にしてください')
    if (!TOP_KEYS.has(String(segs[0]))) return fail(j, path, 'path', '直せる欄ではありません')
    const idx = segs[segs.length - 1]
    const at = locate(root, segs)
    if (typeof idx !== 'number' || !at || !Array.isArray(at.parent))
      return fail(j, path, 'path', '消せるのは並びの要素だけです（例 timeline.3・stakeholders.2・terms.5・sources.1）')
    if (insideRemoved(segs.slice(0, -1))) return fail(j, path, 'conflict', '消す要素の中は消せません')
    const listPath = segs.slice(0, -1).join('.')
    const set = removes.get(listPath) ?? new Set<number>()
    if (set.has(idx)) return fail(j, path, 'conflict', '同じ要素を2回消しています')
    set.add(idx)
    removes.set(listPath, set)
    count(p.why as PatchWhy)
  })

  // 2回目: ほかの直す所を、並びの順に当てる
  patches.forEach((patch, j) => {
    if ('remove' in (patch as Obj)) return
    const h = head(patch, j)
    if (!h) return
    const { p, path } = h
    if ('emphasis' in p) {
      if (!Array.isArray(p.emphasis) || p.emphasis.some((x) => typeof x !== 'string'))
        return fail(j, path, 'value', '強調は語句の並びにしてください')
      if (insideRemoved(segmentsOf(path))) return fail(j, path, 'conflict', '消す要素の強調は直せません')
      const found = emphasisSlot(draft, path)
      if (!found) return fail(j, path, 'path', '強調を付けられる欄ではありません')
      found.slot.set(p.emphasis.length ? [...(p.emphasis as string[])] : undefined)
      emphasisSet.add(found.key)
      return
    }
    let segs = segmentsOf(path)
    if (!TOP_KEYS.has(String(segs[0]))) return fail(j, path, 'path', '直せる欄ではありません')
    if (segs[0] === 'sources')
      return fail(j, path, 'path', '出典は消すだけにしてください（資料の控えから書くので、ref・社は替えません）')
    if (insideRemoved(segs)) return fail(j, path, 'conflict', '消す要素の中は直せません')

    if ('add' in p) {
      if (path !== 'unverified') return fail(j, path, 'path', "足せるのは 'unverified'（確かめられなかった点）だけです")
      if (typeof p.add !== 'string' || !p.add.trim()) return fail(j, path, 'value', '足す文がありません')
      adds.push(p.add)
    } else if ('find' in p || 'set' in p) {
      const mapped = termPath(j, path, segs)
      if (!mapped) return
      segs = mapped
      const at = locate(root, segs)
      if (!at) return fail(j, path, 'path', '欄がありません')
      const cur = getAt(at)
      if ('find' in p) {
        if (typeof cur !== 'string') return fail(j, path, 'path', 'find/to で直せるのは文の欄だけです')
        if (typeof p.find !== 'string' || !p.find) return fail(j, path, 'value', 'find が空です')
        if (typeof p.to !== 'string') return fail(j, path, 'value', 'to は文にしてください')
        const n = occurrences(cur, p.find)
        if (n !== 1)
          return fail(
            j,
            path,
            n === 0 ? 'not-found' : 'ambiguous',
            n === 0
              ? `「${p.find}」が欄の文にありません`
              : `「${p.find}」が欄の文に${n}回出ます（1回だけ出る長さにしてください）`,
          )
        setAt(
          at,
          cur.replace(p.find, () => p.to as string),
        )
      } else {
        if (!isSettable(p.set))
          return fail(j, path, 'value', 'set で入れられるのは決まった値・文・数・真偽・null・文字の並びだけです')
        // 並びの要素は文だけを文に替えられる。まとまりは followUp を null にするだけ（中の欄は欄ごとに直す）。文字の並びで丸ごと
        // 替えられるのは確かめられなかった点と別名だけ（用語・当事者・経緯の並びは要素ごとに直す）。無い欄は足さない（語の表記を除く）
        const target = segs.join('.')
        const listOk = STRING_LIST_PATH.test(target)
        if (
          Array.isArray(at.parent)
            ? typeof cur !== 'string' || typeof p.set !== 'string'
            : isObj(cur)
              ? !(target === 'followUp' && p.set === null)
              : Array.isArray(cur) !== Array.isArray(p.set) ||
                (Array.isArray(p.set) && !listOk) ||
                (!(at.key in at.parent) && !TERM_SURFACE_PATH.test(target))
        )
          return fail(j, path, 'path', 'set で入れ替えられるのは欄の値だけです（並びの要素は remove で消してください）')
        setAt(at, Array.isArray(p.set) ? [...(p.set as string[])] : p.set)
        // 主張を null にしたら、立場・補足・理由もそろえ、主張の強調も外す（docs/SPEC.md の 7.1）
        const claim = /^stakeholders\.(\d+)\.claim$/.exec(path)
        if (claim && p.set === null) {
          const el = draft.stakeholders[Number(claim[1])]
          el.stance = 'unknown'
          el.stanceNote = null
          el.reason = null
        }
      }
      touched.add(segs.join('.'))
    } else return fail(j, path, 'kind', 'find/to・set・remove・add・emphasis のどれかにしてください')
    count(p.why as PatchWhy)
  })

  if (errors.length) return { ok: false, input, errors, fixed: 0, why: {}, droppedEmphasis: [] }

  // 文を直した欄で、文に無くなった強調の語句を外す（照合の係が入れ替えた強調はそのまま。組み立てで確かめる）。消す前に、当てる前の
  // 入力の番号で見る（直した欄の道も当てる前の番号なので。消す要素は見ない）
  const droppedEmphasis: PatchResult['droppedEmphasis'] = []
  const touchedKeys = new Set([...touched].flatMap((t) => emphasisKeyOfTextPath(t) ?? []))
  if (draft.followUp === null && input.followUp !== null) touchedKeys.add('emphasis.followUp.whatsNew')
  if (draft.view.kind !== 'opposed' && input.view.kind === 'opposed')
    for (const k of ['emphasis.view.aiView', 'emphasis.view.counterView']) touchedKeys.add(k)
  for (const { key, slot } of allEmphasisSlots(draft)) {
    if (emphasisSet.has(key) || insideRemoved(segmentsOf(key))) continue
    const phrases = slot.get()
    if (!phrases?.length) continue
    const text = slot.text()
    const mustCheck = touchedKeys.has(key) || text === null
    if (!mustCheck) continue
    const kept = phrases.filter((ph) => text !== null && text.includes(ph))
    for (const ph of phrases) if (!kept.includes(ph)) droppedEmphasis.push({ path: key, phrase: ph })
    slot.set(kept.length ? kept : undefined)
  }

  // 消す物（後ろの番号から）と足す物
  for (const [listPath, set] of removes) {
    const at = locate(root, [...segmentsOf(listPath), 0])
    const list = at && Array.isArray(at.parent) ? at.parent : null
    if (!list) continue
    for (const idx of [...set].sort((a, b) => b - a)) list.splice(idx, 1)
  }
  draft.unverified.push(...adds)

  // 外した結果、AI の見解と対立見解の強調の数が違えば、何も当てない（話題ごと断られるので、照合の係に直してもらう）
  if (draft.view.kind === 'opposed') {
    const a = draft.emphasis?.['view.aiView']?.length ?? 0
    const b = draft.emphasis?.['view.counterView']?.length ?? 0
    if (a !== b && droppedEmphasis.some((d) => d.path.startsWith('emphasis.view.')))
      return {
        ok: false,
        input,
        errors: [
          {
            path: 'emphasis.view',
            code: 'patch:view-count',
            message: `強調も直してください（view.aiView と view.counterView の数をそろえる。外れた語句: ${droppedEmphasis
              .filter((d) => d.path.startsWith('emphasis.view.'))
              .map((d) => `「${d.phrase}」`)
              .join('・')}）`,
          },
        ],
        fixed: 0,
        why: {},
        droppedEmphasis: [],
      }
  }
  return { ok: true, input: draft, errors: [], fixed, why, droppedEmphasis }
}
