// 辞書の今の形（DO の SQLite の terms・term_forms。設計の 1.5・1.9）。決め方はアプリと同じ src/domain/terms.ts（newerTermEntry・
// termFormsOf・resolveTermRef・termOverlapProblems）で、ここは SQLite に置く所と、辞書全体を読み込まずに引く所だけ。
// - terms は語ごとに1行（表記・別名・説明・rev・時点・外した印）。term_forms は引く索引（そろえた表記 → termId）だけで、外していない語の
//   表記だけを持つ。どちらも主の鍵の表で、別の索引を作らない（行の書き込みを減らす。設計の 1.9 の (1)）
// - 束を当てる時は、語ごとに今の行より新しい物（newerTermEntry）だけを書く（同じ語を何度も書き直さない。1.9 の (2)）
// - 作り直し（束が減った時）は terms_next・term_forms_next に日をまたいで進め（1日の行の予算 RowBudget の中で）、終わったら入れ替える。
//   その間は今の表で引ける（1.9 の (3)）。作り直しの間に届いた束は、今の表と作り直しの表の両方に当てる
// - 引く時は、辞書の全部を読み込まない: 指した語・表記と、足す語の表記に当たる語だけの部分の辞書（subsetFor）を作り、domain の関数に渡す
//   （resolveTermRef・termOverlapProblems・assembleTopic は、その表記に当たる語しか見ないので、全部の辞書と同じ答えになる。
//   test/unit/dictionary.test.ts で確かめる）
import { normalizeIdText, termIdOf } from '../../../src/domain/ids'
import { keyBaseOf, newerTermEntry, termFormsOf } from '../../../src/domain/terms'
import type { TermEntry } from '../../../src/domain/types'
import type { MirrorStore } from './store'

/** 入力の用語の指し方（形を確かめる前の物も受ける。src/domain/input.ts の TermRefInput） */
interface TermRefLike {
  termId?: unknown
  term?: unknown
  new?: { key?: unknown; term?: unknown; aliases?: unknown }
  revise?: { aliases?: unknown }
}

/** 作り直しの様子（meta 'dictRebuild'） */
export interface RebuildState {
  /** 作り直しを始めた時刻 */
  startedAt: number
  /** 最後に読んだ束の文書の名前（projects/…/records/termPacks:…。続きはこの後から） */
  after: string | null
}

/** 外していない語の表記（索引に入れる物） */
const liveForms = (e: TermEntry): string[] => (e.retired === true ? [] : termFormsOf(e))

export class Dictionary {
  readonly #store: MirrorStore

  constructor(store: MirrorStore) {
    this.#store = store
  }

  /** 語（今の表） */
  get(termId: string): TermEntry | null {
    return this.#store.getTerm(termId)
  }

  /** そろえた表記に当たる語の id（外した語は入らない） */
  idsOfForm(form: string): string[] {
    const f = normalizeIdText(form)
    return f ? this.#store.termIdsOfForm(f) : []
  }

  /** 語の数（外した語も） */
  size(): number {
    return this.#store.termCount()
  }

  /**
   * 1つの表に束の語を当てる。今の行より新しい語だけを書く。書いた行の数を返す。budget = true なら1日の行の予算の中だけで書き、
   * 足りなければ何も書かずに null（呼ぶ側が次の日に続ける）
   */
  #applyTo(entries: readonly TermEntry[], next: boolean, budget: boolean): number | null {
    const plan: { entry: TermEntry; oldForms: string[]; newForms: string[]; rows: number }[] = []
    const pending = new Map<string, TermEntry>()
    for (const e of entries) {
      const cur = pending.get(e.termId) ?? this.#store.getTerm(e.termId, next)
      const winner = cur ? newerTermEntry(cur, e) : e
      if (cur && winner === cur) continue
      pending.set(e.termId, winner)
    }
    for (const entry of pending.values()) {
      const cur = this.#store.getTerm(entry.termId, next)
      const oldForms = cur ? liveForms(cur) : []
      const newForms = liveForms(entry)
      const changed = oldForms.filter((f) => !newForms.includes(f)).length + newForms.filter((f) => !oldForms.includes(f)).length
      plan.push({ entry, oldForms, newForms, rows: 1 + changed })
    }
    const rows = plan.reduce((n, p) => n + p.rows, 0)
    if (!rows) return 0
    if (budget) {
      if (!this.#store.takeRows(rows)) return null
    } else this.#store.countRows(rows)
    for (const p of plan) this.#store.putTerm(p.entry, p.oldForms, p.newForms, next)
    return rows
  }

  /**
   * 束の語を今の表に当てる（写しの取り込み。作り直しの間は作り直しの表にも）。budget = true（ふつう）なら1日の行の予算の中だけで書き、
   * 足りなければ何も書かずに null（写しは位置を進めずに、次の日に続ける）
   */
  apply(entries: readonly TermEntry[], budget = true): number | null {
    const mark = this.#store.markRows()
    try {
      return this.#store.transaction(() => {
        const n = this.applyInTransaction(entries, budget)
        if (n === null) throw new RowBudgetSpent()
        return n
      })
    } catch (e) {
      // 戻した行は行の予算からも外す（今の表だけ書けて作り直しの表で足りなかった時など）
      this.#store.restoreRows(mark)
      if (e instanceof RowBudgetSpent) return null
      throw e
    }
  }

  /**
   * apply と同じ（トランザクションを開かない。写しのページのトランザクションの中から呼ぶ）。予算が足りなければ null で、
   * 呼ぶ側がトランザクションごと戻す（今の表だけ書けた形を残さない）
   */
  applyInTransaction(entries: readonly TermEntry[], budget = true): number | null {
    const n = this.#applyTo(entries, false, budget)
    if (n === null) return null
    if (!this.rebuilding()) return n
    const m = this.#applyTo(entries, true, budget)
    return m === null ? null : n + m
  }

  /**
   * 指した語・表記と足す語に関わる部分の辞書（termId → 今の形。外した語も入る）。termIds・forms で指した語と、その表記に当たる語と、
   * entries（足す語・同じ回の新しい語）の表記に当たる語を入れる。domain の resolveTermRef・termOverlapProblems・assembleTopic に渡すと、
   * 全部の辞書を渡した時と同じ答えになる
   */
  subsetFor(refs: {
    termIds?: Iterable<string>
    forms?: Iterable<string>
    entries?: readonly TermEntry[]
  }): Map<string, TermEntry> {
    const out = new Map<string, TermEntry>()
    const forms = new Set<string>()
    const add = (id: string) => {
      if (out.has(id)) return
      const e = this.#store.getTerm(id)
      if (!e) return
      out.set(id, e)
      for (const f of termFormsOf(e)) forms.add(f)
    }
    for (const id of refs.termIds ?? []) add(id.trim())
    for (const f of refs.forms ?? []) {
      const n = normalizeIdText(f)
      if (n) forms.add(n)
    }
    for (const e of refs.entries ?? []) {
      add(e.termId)
      for (const f of termFormsOf(e)) forms.add(f)
    }
    // 表記に当たる語（その語の表記がさらに別の語に当たっても、domain の関数は最初の表記に当たる語しか見ないので、1段で足りる）
    for (const f of [...forms]) for (const id of this.#store.termIdsOfForm(f)) add(id)
    return out
  }

  /**
   * 下書きの入力の用語を組み立てるための部分の辞書（assembleTopic の dict に渡す）。指した termId・表記、新しい語の key の termId と表記、
   * 説明を新しくする語の別名、同じ回の新しい語（runEntries）を入れる
   */
  forInput(input: { terms?: readonly TermRefLike[] }, runEntries: readonly TermEntry[] = []): Map<string, TermEntry> {
    const termIds: string[] = []
    const forms: string[] = []
    for (const ref of input.terms ?? []) {
      if (!ref || typeof ref !== 'object') continue
      if ('new' in ref && ref.new && typeof ref.new === 'object') {
        const n = ref.new
        if (typeof n.key === 'string') {
          termIds.push(termIdOf(n.key))
          forms.push(keyBaseOf(n.key), n.key)
        }
        if (typeof n.term === 'string') forms.push(n.term)
        if (Array.isArray(n.aliases)) for (const a of n.aliases) if (typeof a === 'string') forms.push(a)
        continue
      }
      if (typeof ref.termId === 'string') termIds.push(ref.termId)
      if (typeof ref.term === 'string') forms.push(ref.term)
      const aliases = ref.revise && typeof ref.revise === 'object' ? ref.revise.aliases : undefined
      if (Array.isArray(aliases)) for (const a of aliases) if (typeof a === 'string') forms.push(a)
    }
    return this.subsetFor({ termIds, forms, entries: runEntries })
  }

  // ---------- 作り直し ----------

  rebuilding(): boolean {
    return this.#store.getMeta<RebuildState>('dictRebuild') !== null
  }

  rebuildState(): RebuildState | null {
    return this.#store.getMeta<RebuildState>('dictRebuild')
  }

  /** 作り直しを始める（作り直しの表を空にする。今の表はそのまま引ける） */
  startRebuild(now: number): void {
    this.#store.transaction(() => {
      this.#store.clearNextTerms()
      this.#store.setMeta('dictRebuild', { startedAt: now, after: null } satisfies RebuildState)
    })
  }

  /**
   * 作り直しの表に、読み直した束の語を当て、位置を進める（同じトランザクション）。予算が足りなければ何も書かずに false
   * （位置も進めない。次の日に同じ所から続ける）。束は新しい順に当てる（同じ語を何度も書き直さない）
   */
  rebuildApply(packs: readonly { name: string; entries: readonly TermEntry[] }[], after: string): boolean {
    const mark = this.#store.markRows()
    try {
      return this.#store.transaction(() => {
        // 同じページの中は新しい束（名前の大きい物。名前は版の日付で始まる）から当てる
        const ordered = [...packs].sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
        for (const p of ordered) if (this.#applyTo(p.entries, true, true) === null) throw new RowBudgetSpent()
        const st = this.rebuildState()
        this.#store.setMeta('dictRebuild', { startedAt: st?.startedAt ?? 0, after } satisfies RebuildState)
        return true
      })
    } catch (e) {
      // 戻したページの行は予算に数えない（前に当てた束の分を数えたままにすると、次の日まで同じページを読み直せない）
      this.#store.restoreRows(mark)
      if (e instanceof RowBudgetSpent) return false
      throw e
    }
  }

  /** 作り直しを終える（作り直しの表と今の表を入れ替える） */
  finishRebuild(): void {
    this.#store.swapNextTerms()
    this.#store.deleteMeta('dictRebuild')
  }

  /** 辞書を消す（持ち主が変わった時。写しと一緒に） */
  cancelRebuild(): void {
    this.#store.deleteMeta('dictRebuild')
  }
}

/** 1日の行の予算を使い切った（トランザクションを戻すための印） */
export class RowBudgetSpent extends Error {
  constructor() {
    super('row budget spent')
    this.name = 'RowBudgetSpent'
  }
}
