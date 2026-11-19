// ツールの入力の形（zod）。実行時は使わず、scripts/gen-schemas.mjs が JSON Schema（{ io: 'input' }）にして
// schemas.gen.ts に書き出す（Workers で zod から作り直すと CPU を使うため。ajv は eval を使うので Workers では動かない。NS と同じ）。
// test/unit/schemas.test.ts が一致を確かめる。設計の 1.2 の 16 の道具（5 の topic_find_article は作らない）。
// - 入力の欄の説明（description）: 上限（src/domain/limits.ts の RECORD_LIMITS から作る）・決まった値・null の意味・指し方。書き方の決まりは
//   入れない（全部の係が読み込むツールの定義を重くしない。決まりの文は topic_get_guide。設計の 1.4）
// - 形（型・決まった値・並びの数・回の id などの短い欄）は MCP の層で断る（Vault を呼ばない）。話題の文の字数は、コネクタが組み立てる時に
//   欄の道つきの日本語で断る（src/domain/validate.ts の checkTopic）ので、ここでは maxLength を付けず説明に上限を書く
// - 話題の入力（topic）は src/domain/input.ts の TopicDraftInput、照合の直す所（patches）は DraftPatch の形。型が合うかを下の
//   InputMatches で確かめる（合わなければ型チェックで落ちる）
import * as z from 'zod'
import {
  INPUT_EMPHASIS_FIELDS,
  PATCH_WHY_VALUES,
  PATCHES_MAX,
  type DraftPatch,
  type TopicDraftInput,
} from '../../../src/domain/input'
import { RECORD_LIMITS } from '../../../src/domain/limits'
import {
  CONCLUSION_LABEL_VALUES,
  GENRE_VALUES,
  REASON_KIND_VALUES,
  REGION_VALUES,
  SLOT_VALUES,
  STANCE_VALUES,
} from '../../../src/domain/types'

const L = RECORD_LIMITS
const T = RECORD_LIMITS.topic

/** 回の種類・probe（vault/runs.ts の RUN_KINDS・PROBE_KINDS と同じ並び。test/unit/schemas.test.ts で確かめる） */
export const RUN_KIND_ENUM = ['edition', 'trial', 'correction'] as const
export const PROBE_ENUM = ['sources', 'hosts', 'terms'] as const
/** 決まりの文の係（topic_get_guide） */
export const GUIDE_ROLES = ['select', 'write', 'verify', 'correct'] as const

/** 1回に引ける語の数（vault/tools/read.ts の LOOKUP_MAX_WORDS と同じ） */
export const LOOKUP_WORDS_MAX = 40
/** 1回に足せる話題の数（設計の 1.6） */
export const ADD_TOPICS_MAX = 5
/** 資料を1回に読む字数（設計の 1.6。既定 6,000） */
export const READ_CHARS = { min: 1_500, max: 6_000 } as const

const runId = z.string().min(1).max(L.base.runId).describe('topic_begin_run が返した回の id（r202611191016-ab12 の形）')
const model = z.string().min(1).max(L.base.model).describe(`使っているモデルの名前（${L.base.model}字まで。記録の model に入る）`)
const cursor = z.string().min(1).max(40).describe('前の答えの最後にある「続きがあります（cursor: …）」の値をそのまま渡す')
const draftId = z
  .string()
  .min(1)
  .max(20)
  .describe('下書きの id（d:01 の形。topic_save_draft の答え・topic_list_drafts で分かる）')
const topicRef = z.string().min(1).max(60).describe('話題の指し方（p:＋8字の短い id か、話題の id そのもの）')

const chars = (max: number, what: string) => z.string().describe(`${what}（${max.toLocaleString('ja-JP')}字まで）`)
const orNone = (max: number, what: string, none = 'この話題では特になし') =>
  z
    .string()
    .nullable()
    .describe(`${what}（${max.toLocaleString('ja-JP')}字まで。null = ${none}）`)
const phrases = (what: string) =>
  z
    .array(z.string())
    .max(L.emphasis.perField)
    .describe(
      `${what}の強調の語句（その欄の文に1字も違わずに含まれる ${L.emphasis.phraseMin}〜${L.emphasis.phraseMax}字。1つの欄に${L.emphasis.perField}つまで・話題の全体で${L.emphasis.total}まで）`,
    )

// ---------- 話題の入力（src/domain/input.ts の TopicDraftInput） ----------

const stakeholder = z.object({
  name: chars(T.stakeholderName, '当事者の名前'),
  stance: z.enum(STANCE_VALUES).describe('立場（for 賛成・against 反対・conditional 条件付き・unknown 不明）'),
  stanceNote: orNone(T.stanceNote, '立場の補足', 'なし'),
  claim: orNone(
    T.claim,
    '主張',
    '今回読んだ資料では、主張を確かめられなかった（その時 stance は unknown・stanceNote と reason は null）',
  ),
  reason: orNone(T.claimReason, '主張の理由', 'なし（claim が null なら null）'),
  claimEmphasis: phrases('主張').optional(),
})

const view = z.union([
  z.object({
    kind: z.literal('opposed').describe('AI の見解と対立見解がある'),
    axis: chars(T.axis, '対立の軸'),
    issue: orNone(T.issue, '論点', 'なし'),
    aiView: chars(T.aiView, 'AI の見解'),
    counterView: chars(T.counterView, '対立見解'),
  }),
  z.object({
    kind: z.literal('none').describe('対立する見解は無い'),
    noneReason: orNone(T.noneReason, '対立する見解が無い訳', '事実の報道のため'),
  }),
])

const timeline = z.object({
  when: z.string().nullable().describe('YYYY・YYYY-MM・YYYY-MM-DD（資料に書かれた日付のまま。null = 日付が分からない）'),
  text: chars(T.timelineText, '経緯の1行'),
  emphasis: phrases('この行').optional(),
})

const followUp = z
  .object({
    prev: z.string().min(1).max(20).describe('前の版の話題の短い id（p:＋8字。topic_list_recent の一覧の中の物）'),
    whatsNew: chars(T.whatsNew, '前の話題から新しくなった事'),
  })
  .nullable()
  .describe('続報の時だけ（null = 続報でない）')

const termLimits = L.termPack
const newTerm = z.strictObject({
  key: chars(termLimits.key, '照らすための形（国などで中身の違う語は括弧の添え字を付ける。例「与党（日本）」）'),
  term: chars(termLimits.term, '見出しの表記'),
  aliases: z
    .array(z.string())
    .max(termLimits.aliases)
    .describe(`別名（${termLimits.aliases}件まで・各 ${termLimits.alias}字まで）`),
  explanation: chars(termLimits.explanation, '説明'),
  asOf: z.string().nullable().describe('説明の時点（YYYY-MM。null = 不明）'),
})
const termRef = z.union([
  z.strictObject({
    termId: z.string().min(1).max(20).describe('辞書の語の id（t＋12字）'),
    revise: z
      .strictObject({
        explanation: chars(termLimits.explanation, '新しい説明'),
        asOf: z.string().nullable().describe('説明の時点（YYYY-MM。null = 不明）'),
        aliases: z.array(z.string()).max(termLimits.aliases).optional().describe('別名を替える時だけ'),
      })
      .describe('辞書の説明を新しくする（rev はコネクタが今の rev ＋1 にする）'),
  }),
  z.strictObject({ new: newTerm.describe('辞書に無い語（話題を足す最初の呼び出しで、辞書の束にして先に足す）') }),
  z.strictObject({
    termId: z.string().min(1).max(20).describe('辞書の語の id（t＋12字。topic_lookup_terms で引いた物）'),
    term: z.string().min(1).max(T.term).optional().describe('この話題での表記（辞書の表記か別名。省くと辞書の表記）'),
  }),
  z.strictObject({
    term: z.string().min(1).max(T.term).describe('辞書にある語を表記で指す（2つ以上の語に当たれば断るので termId で指す）'),
  }),
])

const source = z.object({
  ref: z.string().min(1).max(T.url).describe('出典にする資料（候補の c0012 か、この回で topic_read_article が読んだ資料の URL）'),
  outlet: z
    .string()
    .min(1)
    .max(T.outlet)
    .optional()
    .describe('1つのホストに社が2つ以上ある時だけ、どの社か（topic_read_article の頭の行に並ぶ社）'),
})

const emphasis = z
  .object(
    Object.fromEntries(INPUT_EMPHASIS_FIELDS.map((f) => [f, phrases(`欄 ${f} `).optional()])) as Record<
      (typeof INPUT_EMPHASIS_FIELDS)[number],
      z.ZodOptional<ReturnType<typeof phrases>>
    >,
  )
  .describe('欄ごとの強調の語句（当事者の主張は claimEmphasis、経緯の行は emphasis に書く）')

export const topicDraftInput = z
  .object({
    rank: z.number().int().min(T.rankMin).max(T.rankMax).describe(`版の中の順位（${T.rankMin}〜${T.rankMax}）`),
    rankReason: chars(T.rankReason, '順位の理由'),
    region: z.enum(REGION_VALUES).describe('地域（jp 国内・world 世界）'),
    genre: z.enum(GENRE_VALUES).describe('ジャンル（politics・economy・tech・ai・incident・sports・entertainment）'),
    major: z.boolean().describe('重大印'),
    headline: chars(T.headline, '見出し'),
    summary: chars(T.summary, '要約'),
    conclusion: z.object({
      label: z.enum(CONCLUSION_LABEL_VALUES).describe('結論ラベル（settled 確定・unsettled 未確定・outlook 見通し）'),
      note: chars(T.conclusionNote, '結論の補足'),
      breaking: z.boolean().describe('速報・未確認の印（発表が自分で「第1報」「速報」と書いている時だけ）'),
    }),
    soWhat: z.object({
      life: orNone(T.soWhat, '暮らし・お金'),
      system: orNone(T.soWhat, '社会の仕組み'),
      world: orNone(T.soWhat, '世界の力関係'),
      whyNews: orNone(T.soWhat, 'なぜ話題か'),
    }),
    stakeholders: z.array(stakeholder).max(T.stakeholders).describe(`当事者（${T.stakeholders}件まで。並びに意味がある）`),
    view,
    timeline: z.array(timeline).max(T.timeline).describe(`経緯（${T.timeline}行まで。書いた順）`),
    followUp,
    terms: z
      .array(termRef)
      .max(T.terms * 2)
      .describe(`用語（話題に入るのは${T.terms}語まで。「いまの説明で知ってる」語はコネクタが外す）`),
    sources: z
      .array(source)
      .min(T.sourcesMin)
      .max(T.sources)
      .describe(`出典（${T.sourcesMin}〜${T.sources}本。url・題・日時・社・著者はコネクタが資料の控えから書く）`),
    unverified: z
      .array(z.string())
      .max(T.unverified)
      .describe(`確かめられなかった点（${T.unverified}件まで・各 ${T.unverifiedText}字まで）`),
    emphasis: emphasis.optional(),
  })
  .describe('話題の下書き（欄の名前は記録と同じ）')

// ---------- 照合の直す所（src/domain/input.ts の DraftPatch） ----------

const patchPath = z
  .string()
  .min(1)
  .max(80)
  .describe('入力の欄の道（. でつなぎ、並びは 0 から。例 summary・stakeholders.1.claim・timeline.3・terms.5.explanation）')
const why = z
  .enum(PATCH_WHY_VALUES)
  .describe(
    '直した訳（name 固有名・date 日付・number 数字・quote 引用・reason 理由・overstate 言い過ぎ・notInSource 資料に無い・rule 決まり・term 用語・subject 主体・area 区域や対象・other）',
  )
export const draftPatch = z.union([
  z.strictObject({
    path: patchPath,
    find: z.string().min(1).describe('置き換える文の一部（その欄に1回だけ出る文）'),
    to: z.string().describe('置き換えた後の文'),
    why,
  }),
  z.strictObject({
    path: patchPath,
    set: z
      .union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())])
      .describe(
        '決まった値・null にする（例 conclusion.label・soWhat.life・stakeholders.1.claim。丸ごと替えられる並びは unverified と別名だけ）',
      ),
    why,
  }),
  z.strictObject({ path: patchPath, remove: z.literal(true).describe('並びの要素を消す（timeline.3・sources.1 など）'), why }),
  z.strictObject({
    path: z.literal('unverified'),
    add: z.string().min(1).describe(`確かめられなかった点を足す（${T.unverifiedText}字まで）`),
    why,
  }),
  z.strictObject({
    path: patchPath,
    emphasis: z.array(z.string()).max(L.emphasis.perField).describe('強調を入れ替える（直した数に数えない）'),
  }),
])

// ---------- 道具ごとの入力 ----------

export const SCHEMAS = {
  topic_status: z.object({
    runId: runId
      .optional()
      .describe('版の回・試しの回の id（渡すと、その回の候補集めが終わったかと読める候補の数。試しの回は probe の表も）'),
  }),
  topic_get_guide: z.object({
    role: z.enum(GUIDE_ROLES).describe('係（select 選ぶ・write 書く・verify 照合・correct 訂正）'),
  }),
  topic_list_candidates: z.object({ runId, cursor: cursor.optional() }),
  topic_read_article: z.object({
    runId,
    ref: z.string().min(1).max(T.url).describe('読む資料（候補の c0012 か、許した出どころの https:// の URL。前の版の出典など）'),
    maxChars: z
      .number()
      .int()
      .min(READ_CHARS.min)
      .max(READ_CHARS.max)
      .default(READ_CHARS.max)
      .describe(
        `1回に返す本文の字数（${READ_CHARS.min.toLocaleString('ja-JP')}〜${READ_CHARS.max.toLocaleString('ja-JP')}。既定 ${READ_CHARS.max.toLocaleString('ja-JP')}）`,
      ),
    cursor: cursor.optional(),
  }),
  topic_list_recent: z.object({}),
  topic_lookup_terms: z.object({
    words: z
      .array(z.string().min(1).max(T.term))
      .min(1)
      .max(LOOKUP_WORDS_MAX)
      .describe(`引く語（1〜${LOOKUP_WORDS_MAX}語。各 ${T.term}字まで）`),
    runId: runId.optional().describe('渡すと、同じ回のほかの下書きで足す語も返す'),
  }),
  topic_find_topics: z.object({
    edition: z.string().min(1).max(20).optional().describe('版（e:2026-11-15-12 の形か版の id）'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('版の日付（YYYY-MM-DD。日本時間）'),
    slot: z.enum(SLOT_VALUES).optional().describe('版の枠（12 か 20）'),
    words: z.array(z.string().min(1).max(T.term)).min(1).max(5).optional().describe('見出し・要約に含む語（5語まで）'),
  }),
  topic_list_drafts: z.object({ runId }),
  topic_get_draft: z.object({ runId, draft: draftId, cursor: cursor.optional() }),
  topic_begin_run: z.object({
    kind: z
      .enum(RUN_KIND_ENUM)
      .describe('回の種類（edition 版の回＝定期実行の依頼だけ・trial 試しの回＝クラウドに書かない・correction 訂正だけの回）'),
    model,
    probe: z
      .enum(PROBE_ENUM)
      .optional()
      .describe('試しの回だけ（sources 出どころごとの数・hosts 今は取らない府省の robots.txt の番号・terms 規約のページ）'),
    skip: z.array(z.string().min(1).max(40)).max(20).optional().describe('試しの回だけ。probe から外す出どころの id'),
  }),
  topic_save_draft: z.object({
    runId,
    model,
    replace: draftId.optional().describe('照合の前の下書きを置き換える時、その下書きの id'),
    topic: topicDraftInput,
  }),
  topic_check_draft: z.object({
    runId,
    draft: draftId,
    model,
    claims: z.number().int().min(0).max(T.checkClaims).describe(`照合した主張の件数（0〜${T.checkClaims}）`),
    patches: z.array(draftPatch).max(PATCHES_MAX).describe(`直す所（${PATCHES_MAX}まで。全部当たるか、何も当てない）`),
    reject: z.string().min(1).max(200).optional().describe('元の資料で確かめられず版に入れない時の短い訳（200字まで）'),
  }),
  topic_add_topics: z.object({
    runId,
    items: z
      .array(
        z.object({
          draft: draftId,
          rank: z.number().int().min(T.rankMin).max(T.rankMax).describe(`版の中の順位（${T.rankMin}〜${T.rankMax}）`),
        }),
      )
      .min(1)
      .max(ADD_TOPICS_MAX)
      .describe(`足す照合済みの下書き（1〜${ADD_TOPICS_MAX}件）`),
  }),
  topic_add_edition: z.object({
    runId,
    order: z
      .array(z.string().min(1).max(60))
      .min(L.edition.orderMin)
      .max(L.edition.order)
      .describe(`版の話題の並び（${L.edition.orderMin}〜${L.edition.order}件。p:… か、足した下書きの d:…）`),
    candidateCount: z
      .number()
      .int()
      .min(0)
      .max(L.edition.candidateCount)
      .describe('候補の数（topic_list_candidates の読める候補の数）'),
    notChosen: z
      .array(
        z.object({
          headline: chars(L.edition.notChosenHeadline, '選ばなかった候補の見出し'),
          whyNot: chars(L.edition.whyNot, '選ばなかった訳'),
        }),
      )
      .max(L.edition.notChosen)
      .default([])
      .describe(`選ばなかった候補（${L.edition.notChosen}件まで）`),
    tokens: z.number().int().min(0).optional().describe('使用量（分かる時だけ）'),
  }),
  topic_add_edition_fail: z.object({
    runId,
    reasonKind: z
      .enum(REASON_KIND_VALUES)
      .describe(
        '作れなかった訳の種類（quota 使用量の上限・outage 障害・timeout 時間切れ・no-sources 読める資料が足りない・other）',
      ),
    reason: z.string().min(1).max(L.editionFail.reason).describe(`画面に出す短い訳（${L.editionFail.reason}字まで）`),
  }),
  topic_add_correction: z.object({
    runId,
    model,
    topic: topicRef,
    text: z
      .string()
      .min(1)
      .max(L.correction.text)
      .describe(`何がどう誤りで、正しくは何か（ふつうの文。${L.correction.text}字まで）`),
  }),
} as const

export type ToolName = keyof typeof SCHEMAS

/** 足すツールの結果（structuredContent）の形（vault/tools/common.ts の AddStructured と同じ） */
export const ADD_OUTPUT = z.object({
  created: z.array(z.object({ id: z.string(), label: z.string() })),
  skipped: z.array(z.object({ ref: z.string(), reason: z.string() })),
})

// ---------- 型の確かめ（zod の入力の形が domain の型に合うか） ----------

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T

/** 話題の入力の形が TopicDraftInput に合う（型チェックで確かめる） */
export type InputMatches = Assert<Same<z.input<typeof topicDraftInput>, TopicDraftInput>>
/** 照合の直す所が DraftPatch として渡せる */
export type PatchMatches = Assert<z.input<typeof draftPatch> extends DraftPatch ? true : false>
