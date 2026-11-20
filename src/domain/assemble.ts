// 入力から話題の記録を組み立てる（段階3。段階3の設計の 1.5。docs/SPEC.md の 7.1・7.8 の「コネクタの足す順」の 3.）。
// 書く係の下書きの入力（src/domain/input.ts の TopicDraftInput）を、その回の資料の控え・辞書の今の形・「知ってる」・前の版の話題と合わせて、
// 記録（Topic）にする。純粋な関数で、コネクタ（Workers）とアプリの作り物の版のテスト（src/test/fixtures/fakeInputs.test.ts）で同じ物を使う。
// - 用語: termId・表記を辞書（と同じ回のほかの下書きで足す語）で解き、term 以外を写す。「いまの説明で知ってる」語は外す（外した語を返す）。
//   辞書に無い語・説明を新しくする語は、辞書に足す語として返す（rev は新しい語なら 1、新しい説明なら今の辞書の rev ＋1）。表記の重なりは断る
// - 強調: 要素ごとの入力を、記録の鍵（'stakeholders.2.claim'・'timeline.1.text' など）に組み立てる
// - 出典: 控えから書く（URL・題・掲載日時（publishedAtOf）・著者（値がある時だけ））。この回で読んでいない資料と、本文が200字未満の資料は
//   出典にできない。社は控えのホストから（ホストの社が2つ以上なら書く係の outlet で決め、そのホストの社かを確かめる）。outletNames は出典の
//   社だけから、出典の順に重なりを除いて作る（読んでいない社を数えない）
// - 続報: prev（'p:'＋8字）を前の版の話題の一覧で解き、followUp.prevTopicId と threadId を写す（続報でなければ自分の id）
// - 文: 前後の空白を除き、共通の注記（アプリが出す決まった文。docs/SPEC.md の 5.7）を外す
// 最後に validate.ts の checkTopic（強調の checkEmphasis を含む）を当て、断る物・知らせる物を合わせて返す。欄の道は入力の道
// （'stakeholders.2.claim'・'terms.5'・'sources.1.ref'・強調は 'stakeholders.2.claimEmphasis'・'emphasis.summary'）。
import { FIXED_TEXTS } from './fixedTexts'
import { resolveTopicRef, termIdOf, topicIdOf } from './ids'
import { INPUT_EMPHASIS_FIELDS, type TermRefInput, type TopicDraftInput } from './input'
import { PUBLISHED_UNKNOWN_NOTE, publishedAtOf } from './jst'
import { isKnownTerm } from './known'
import { RECORD_LIMITS, SOURCE_BODY_MIN_CHARS } from './limits'
import {
  canonicalOutletName,
  canonicalViaName,
  DEFAULT_OUTLETS,
  httpsHostOf,
  outletEntryOf,
  outletsOfHost,
  viasOfHost,
  type OutletDirectory,
} from './outlets'
import { applyPack, resolveTermRef, termOverlapProblems, type TermDictionary } from './terms'
import type { Emphasis, KnownTerm, Source, TermEntry, Topic, TopicCheck, TopicTerm } from './types'
import { checkTermEntry, checkTopic, type Problem } from './validate'

/** その回の資料の控え（コネクタが資料を読んだ時に置く物。出典はここから書く） */
export interface SourceMaterial {
  /** 本文を取った URL（https:。転送の後の物） */
  url: string
  /** 資料の題 */
  title: string
  /** 資料の頭の時刻か、ページ・一覧の日付（そのままの文字。publishedAtOf で直す）。無ければ null */
  published: string | null
  /** 日時の補足（控えが持つ時だけ。無ければ、日時が読めない時に「掲載日時は不明」） */
  publishedNote?: string | null
  /** 本文の字数（SOURCE_BODY_MIN_CHARS 未満は出典にできない） */
  bodyChars: number
  /** この回で topic_read_article が読んだか（読んでいない資料は出典にできない） */
  read: boolean
  /** 著者（出どころの credit が著者を求める形の時だけ。RSS の dc:creator） */
  author?: string | null
  /** 読んだ所（その資料が、社の一覧の読んだ所のホストの物の時だけ。段階3の data には無い） */
  via?: string | null
}

/** 組み立てに要る、その回の物 */
export interface AssembleContext {
  /** 回の枠の版の id */
  editionId: string
  runId: string
  /** 記録の model（topic_save_draft の model。書いた係） */
  model: string
  /** 記録の createdAt（ミリ秒） */
  createdAt: number
  /** 照合した件数（照合の前の下書きは null） */
  check?: TopicCheck | null
  /** 辞書の今の形（src/domain/terms.ts） */
  dict: TermDictionary
  /** 同じ回のほかの下書きで足す語（新しい語・新しい説明。辞書に重ねて解く。同じ版の話題どうしで説明がぶれない） */
  runEntries?: readonly TermEntry[]
  /** 「知ってる」（termId → 記録。いまの説明で知ってる語を外す） */
  known?: ReadonlyMap<string, Pick<KnownTerm, 'on' | 'asOf'>>
  /** 前の版の話題（直近3日・6版の、版の記録がある版の order の話題。続報の prev を解く） */
  recentTopics?: readonly { id: string; threadId: string }[]
  /** 資料の控えを ref（'c0012' か URL）で引く（無ければ null） */
  material: (ref: string) => SourceMaterial | null
  /** 社の一覧（作り物の版では作り物の一覧） */
  outlets?: OutletDirectory
}

/** 組み立てた結果 */
export interface AssembleResult {
  /** 組み立てた記録（断る物が1つでもあれば null） */
  topic: Topic | null
  /** 断る物（欄の道は入力の道） */
  errors: Problem[]
  /** 知らせる物（断らない。定期実行の報告に書く） */
  warnings: Problem[]
  /** 「いまの説明で知ってる」ので外した語（入力の順） */
  droppedKnown: { termId: string; term: string }[]
  /** この話題が辞書に足す語（新しい語・新しい説明。話題を足す最初の呼び出しが束にして先に足す） */
  termEntries: TermEntry[]
}

const NOTE = FIXED_TEXTS.commonNote

/** 文を整える（共通の注記を外し、前後の空白を除く）。文字でない値は、そのまま（checkTopic が型で断る） */
function clean<T>(v: T): T {
  return (typeof v === 'string' ? v.split(NOTE).join('').trim() : v) as T
}

/** 字数（コードポイント）で切る（控えの題・著者。書く係が直せない欄なので、上限で切る） */
function cut(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length <= max ? s : chars.slice(0, max).join('').trim()
}

const sameEntry = (a: TermEntry, b: TermEntry): boolean => a.rev === b.rev && sameContent(a, b)

/** 語の中身が同じか（rev を除く） */
const sameContent = (a: TermEntry, b: TermEntry): boolean =>
  a.termId === b.termId &&
  a.key === b.key &&
  a.term === b.term &&
  a.explanation === b.explanation &&
  a.asOf === b.asOf &&
  a.aliases.length === b.aliases.length &&
  a.aliases.every((x, i) => x === b.aliases[i])

/** checkTopic の欄の道（'stakeholders[2].claim'・'emphasis["timeline.1.text"]'）を入力の道にする（用語は外した語の分だけ番号がずれる） */
function inputPathOf(path: string, termIndex: readonly number[]): string {
  const em = /^emphasis\["(.*)"\]$/.exec(path)
  if (em) {
    const key = em[1]
    const s = /^stakeholders\.(\d+)\.claim$/.exec(key)
    if (s) return `stakeholders.${s[1]}.claimEmphasis`
    const t = /^timeline\.(\d+)\.text$/.exec(key)
    if (t) return `timeline.${t[1]}.emphasis`
    return `emphasis.${key}`
  }
  return path.replace(/\[(\d+)\]/g, '.$1').replace(/^terms\.(\d+)/, (_, i: string) => `terms.${termIndex[Number(i)] ?? i}`)
}

/** 話題を組み立てる（入力は変えない） */
export function assembleTopic(input: TopicDraftInput, ctx: AssembleContext): AssembleResult {
  const errors: Problem[] = []
  const warnings: Problem[] = []
  const err = (path: string, code: string, message: string) => errors.push({ path, code, message })
  const dir = ctx.outlets ?? DEFAULT_OUTLETS

  // ---------- 用語 ----------
  const effective = applyPack(ctx.dict, ctx.runEntries ?? [])
  const termEntries: TermEntry[] = []
  const terms: TopicTerm[] = []
  const termIndex: number[] = []
  const droppedKnown: AssembleResult['droppedKnown'] = []
  const termPathOf = new Map<string, string>()
  ;(input.terms ?? []).forEach((ref: TermRefInput, i) => {
    const path = `terms.${i}`
    let entry: TermEntry | null = null
    let surface: string | null = null
    if ('new' in ref) {
      const n = ref.new
      const key = clean(n.key)
      const termId = typeof key === 'string' ? termIdOf(key) : ''
      const candidate: TermEntry = {
        termId,
        key,
        term: clean(n.term),
        aliases: Array.isArray(n.aliases) ? n.aliases.map((a) => clean(a)) : n.aliases,
        explanation: clean(n.explanation),
        asOf: n.asOf,
        rev: 1,
      }
      const committed = ctx.dict.get(termId)
      const pending = effective.get(termId)
      const checked = checkTermEntry(candidate, `${path}.new`)
      for (const e of checked.errors) err(inputPathOf(e.path, []), `term:${e.code}`, e.message)
      if (checked.errors.length) return
      if (committed?.retired === true || pending?.retired === true)
        err(path, 'term-retired', `語「${key}」は辞書から外した語です（使えません）`)
      else if (committed)
        err(
          path,
          'term-exists',
          `語「${key}」は辞書にあります（${termId}）。{ termId } で指すか、revise で説明を新しくしてください`,
        )
      else if (pending && !sameEntry(pending, candidate))
        err(
          path,
          'term-conflict',
          `語「${key}」は、同じ回のほかの下書きで別の説明で足しています（${termId}）。topic_lookup_terms で引いて termId で指してください`,
        )
      else {
        entry = candidate
        surface = candidate.term
        termEntries.push(candidate)
      }
    } else if ('revise' in ref) {
      const base = ctx.dict.get(ref.termId)
      if (!base) {
        const reason = effective.has(ref.termId)
          ? '同じ回で足す語です（その語を足した下書きで直してください）'
          : '辞書にありません'
        err(path, 'term-not-found', `語 ${ref.termId} は${reason}`)
        return
      }
      if (base.retired === true) {
        err(path, 'term-retired', `語「${base.key}」は辞書から外した語です（使えません）`)
        return
      }
      const candidate: TermEntry = {
        termId: base.termId,
        key: base.key,
        term: base.term,
        aliases: ref.revise.aliases !== undefined ? ref.revise.aliases.map((a) => clean(a)) : [...base.aliases],
        explanation: clean(ref.revise.explanation),
        asOf: ref.revise.asOf,
        rev: base.rev + 1,
      }
      const checked = checkTermEntry(candidate, `${path}.revise`)
      for (const e of checked.errors) err(inputPathOf(e.path, []), `term:${e.code}`, e.message)
      if (checked.errors.length) return
      // 同じ回のほかの下書きが新しくした語（束に書いて辞書に入った後も、同じ回の語として残る）は、rev に関わらず中身が違えば断る
      // （先に置いた方が勝つ。束の後に別の説明で置いた下書きの説明が、照合の時に黙って元の説明へ戻らないように）
      const fromRun = (ctx.runEntries ?? []).find((e) => e.termId === base.termId)
      const pending = effective.get(base.termId)
      const conflict = fromRun
        ? !sameContent(fromRun, candidate)
        : pending !== undefined && pending.rev >= candidate.rev && !sameEntry(pending, candidate)
      if (conflict)
        err(
          path,
          'term-conflict',
          `語「${base.key}」の説明は、同じ回のほかの下書きで別の説明に新しくしています。topic_lookup_terms で引いて termId で指してください`,
        )
      else {
        entry = candidate
        surface = candidate.term
        termEntries.push(candidate)
      }
    } else {
      const r = resolveTermRef(ref, effective)
      if (!r.ok) {
        const what = 'termId' in ref ? ref.termId : `「${ref.term}」`
        const message =
          r.reason === 'ambiguous'
            ? `表記${what}が2つ以上の語に当たります（${r.matches.join('・')}）。topic_lookup_terms で引いた termId で指してください`
            : r.reason === 'retired'
              ? `語 ${what} は辞書から外した語です（使えません）`
              : r.reason === 'not-a-form'
                ? `「${'term' in ref ? ref.term : ''}」は語 ${what} の表記（表記か別名）ではありません`
                : `語 ${what} は辞書にありません（辞書に無い語は { new: … } で書いてください）`
        err(path, `term-${r.reason}`, message)
        return
      }
      entry = r.entry
      surface = typeof ref.term === 'string' ? clean(ref.term) : r.entry.term
    }
    if (!entry || surface === null) return
    termPathOf.set(entry.termId, path)
    if (isKnownTerm(ctx.known?.get(entry.termId), entry.asOf)) {
      droppedKnown.push({ termId: entry.termId, term: surface })
      return
    }
    terms.push({
      termId: entry.termId,
      term: surface,
      aliases: [...entry.aliases],
      explanation: entry.explanation,
      asOf: entry.asOf,
    })
    termIndex.push(i)
  })
  for (const o of termOverlapProblems(termEntries, effective)) err(termPathOf.get(o.termId) ?? 'terms', 'term-overlap', o.message)

  // ---------- 出典 ----------
  const T = RECORD_LIMITS.topic
  const sources: Source[] = []
  let sourceErrors = 0
  const seenUrls = new Set<string>()
  ;(input.sources ?? []).forEach((s, i) => {
    const path = `sources.${i}`
    const before = errors.length
    const fail = (code: string, message: string, at = `${path}.ref`) => err(at, code, message)
    const ref = typeof s.ref === 'string' ? s.ref.trim() : ''
    const m = ref ? ctx.material(ref) : null
    if (!m) {
      fail(
        'source-unknown',
        `「${s.ref}」はこの回の資料にありません（候補の番号 c… か、この回で読んだ資料の URL にしてください）`,
      )
    } else if (!m.read) {
      fail('source-unread', `「${ref}」はこの回で読んでいない資料です（topic_read_article で読んだ資料だけを出典にできます）`)
    } else if (m.bodyChars < SOURCE_BODY_MIN_CHARS) {
      fail(
        'source-short',
        `「${ref}」は本文が${SOURCE_BODY_MIN_CHARS}字未満の資料です（PDF の資料だけの発表など。出典にできません）`,
      )
    } else {
      const host = httpsHostOf(m.url)
      const title = typeof m.title === 'string' ? cut(clean(m.title), T.sourceTitle) : ''
      let outlet: string | null = null
      let via: string | null = null
      const named = typeof s.outlet === 'string' && s.outlet.trim() ? canonicalOutletName(s.outlet, dir) : null
      const hostOutlets = host ? outletsOfHost(host, dir) : []
      if (!host) fail('source-url', `「${ref}」の URL は出典にできません（https: の URL だけ）`)
      else if (seenUrls.has(m.url)) fail('source-dup', `「${ref}」は、ほかの出典と同じ資料です`)
      else if (!title) fail('source-title', `「${ref}」には題がありません（出典にできません）`)
      else if (typeof m.via === 'string' && m.via.trim()) {
        // 読んだ所の資料（段階3の data には無い）。読んだ所は控えから、元の社は書く係が書く
        const v = canonicalViaName(m.via, dir)
        if (!viasOfHost(host, dir).includes(v)) fail('source-via', `「${ref}」は読んだ所（${v}）のホストの資料ではありません`)
        else if (!named)
          fail(
            'source-outlet',
            `「${ref}」は読んだ所（${v}）の資料です。${path}.outlet で元の社を書いてください`,
            `${path}.outlet`,
          )
        else {
          outlet = named
          via = v
        }
      } else if (named !== null) {
        if (hostOutlets.includes(named)) outlet = named
        else
          fail(
            'source-outlet',
            `社「${s.outlet}」は、この資料のホストの社ではありません（このホストの社: ${hostOutlets.join('・') || 'なし'}）`,
            `${path}.outlet`,
          )
      } else if (hostOutlets.length === 1) outlet = hostOutlets[0]
      else if (hostOutlets.length === 0)
        fail('source-outlet', `「${ref}」のホスト（${host}）は社の一覧にありません（出典にできません）`)
      else
        fail(
          'source-outlet',
          `「${ref}」のホストには社が2つ以上あります（${hostOutlets.join('・')}）。${path}.outlet でどの社かを書いてください`,
          `${path}.outlet`,
        )
      if (outlet !== null) {
        const author = typeof m.author === 'string' && m.author.trim() ? cut(m.author.trim(), T.author) : null
        if (outletEntryOf(outlet, dir)?.credit?.form === 'cc-by' && author === null)
          fail('source-author', `「${ref}」には著者の名前がありません（この出どころは、著者の名前の無い記事を出典にできません）`)
        else {
          const publishedAt = publishedAtOf(m.published)
          const note =
            typeof m.publishedNote === 'string' && m.publishedNote.trim() ? cut(m.publishedNote.trim(), T.publishedNote) : null
          seenUrls.add(m.url)
          sources.push({
            outlet,
            title,
            url: m.url,
            publishedAt,
            publishedNote: note ?? (publishedAt === null ? PUBLISHED_UNKNOWN_NOTE : null),
            via,
            ...(author !== null ? { author } : {}),
          })
        }
      }
    }
    if (errors.length > before) sourceErrors += 1
  })
  const outletNames = [...new Set(sources.map((s) => s.outlet))]

  // ---------- 続報 ----------
  let followUp: Topic['followUp'] = null
  let threadId: string | null = null
  let followUpFailed = false
  if (input.followUp) {
    const recent = ctx.recentTopics ?? []
    const r = resolveTopicRef(
      String(input.followUp.prev ?? ''),
      recent.map((t) => t.id),
    )
    if (!r.ok) {
      followUpFailed = true
      err(
        'followUp.prev',
        r.reason === 'ambiguous' ? 'followUp-ambiguous' : 'followUp-not-found',
        r.reason === 'ambiguous'
          ? `「${input.followUp.prev}」が前の版の話題の2つ以上に当たります（${r.matches.join('・')}）。話題の id で指してください`
          : `「${input.followUp.prev}」は前の版の話題（直近3日・6版）にありません（topic_list_recent の p:… で指してください）`,
      )
    } else {
      followUp = { prevTopicId: r.id, whatsNew: clean(input.followUp.whatsNew) }
      threadId = recent.find((t) => t.id === r.id)?.threadId ?? r.id
    }
  }

  // ---------- 強調 ----------
  const emphasis: Emphasis = {}
  const put = (key: string, v: unknown) => {
    if (v === undefined || (Array.isArray(v) && v.length === 0)) return
    emphasis[key] = v as string[]
  }
  for (const [k, v] of Object.entries(input.emphasis ?? {})) {
    if ((INPUT_EMPHASIS_FIELDS as readonly string[]).includes(k)) put(k, v)
    else
      err(
        `emphasis.${k}`,
        'emphasis:unknown-key',
        `「${k}」は欄ごとの強調を付けられる欄ではありません（当事者の主張は claimEmphasis、経緯の行は emphasis に書いてください）`,
      )
  }
  ;(input.stakeholders ?? []).forEach((s, i) => put(`stakeholders.${i}.claim`, s.claimEmphasis))
  ;(input.timeline ?? []).forEach((e, i) => put(`timeline.${i}.text`, e.emphasis))

  // ---------- 記録 ----------
  const v = input.view
  const topic: Topic = {
    id: '',
    v: 1,
    createdAt: ctx.createdAt,
    by: 'connector',
    ai: 'claude',
    model: ctx.model,
    runId: ctx.runId,
    editionId: ctx.editionId,
    threadId: '',
    rank: input.rank,
    rankReason: clean(input.rankReason),
    region: input.region,
    genre: input.genre,
    major: input.major,
    headline: clean(input.headline),
    summary: clean(input.summary),
    conclusion: {
      label: input.conclusion?.label,
      note: clean(input.conclusion?.note),
      breaking: input.conclusion?.breaking,
    } as Topic['conclusion'],
    soWhat: {
      life: clean(input.soWhat?.life),
      system: clean(input.soWhat?.system),
      world: clean(input.soWhat?.world),
      whyNews: clean(input.soWhat?.whyNews),
    } as Topic['soWhat'],
    stakeholders: (input.stakeholders ?? []).map((s) => ({
      name: clean(s.name),
      stance: s.stance,
      stanceNote: clean(s.stanceNote),
      claim: clean(s.claim),
      reason: clean(s.reason),
    })),
    view:
      v?.kind === 'opposed'
        ? {
            kind: 'opposed',
            axis: clean(v.axis),
            issue: clean(v.issue),
            aiView: clean(v.aiView),
            counterView: clean(v.counterView),
          }
        : v?.kind === 'none'
          ? { kind: 'none', noneReason: clean(v.noneReason) }
          : (v as Topic['view']),
    timeline: (input.timeline ?? []).map((e) => ({ when: e.when, text: clean(e.text) })),
    followUp,
    terms,
    sources,
    outletNames,
    unverified: (input.unverified ?? []).map((u) => clean(u)),
    check: ctx.check ?? null,
    emphasis,
  }
  topic.id = topicIdOf(topic)
  topic.threadId = threadId ?? topic.id

  const checked = checkTopic(topic, { outlets: dir })
  for (const e of checked.errors) {
    // 出典・続報を解けなかった時の、出典の数・社の並び・続報の強調の誤りは、解けなかった訳で足りる
    if (sourceErrors > 0 && (e.path === 'sources' || e.path.startsWith('outletNames'))) continue
    if (followUpFailed && e.path === 'emphasis["followUp.whatsNew"]') continue
    err(inputPathOf(e.path, termIndex), e.code, e.message)
  }
  for (const w of checked.warnings) warnings.push({ ...w, path: inputPathOf(w.path, termIndex) })
  return { topic: errors.length ? null : topic, errors, warnings, droppedKnown, termEntries }
}
