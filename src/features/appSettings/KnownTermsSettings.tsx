// 設定の「『知ってる』にした語」（docs/SPEC.md の 5.8・7.4・14.5。設計: 段階2の 1.13・1.23）: 知ってる（knownTerms）のうち on の語を
// 語の順に並べ、［戻す］で外す（ストアの unknow。記録は消さず on を false にする。次に開いた詳細から、また用語の一覧と本文の印に出る）。
// 0語なら「まだありません」。この端末だけでなく同期する記録なので、ほかの端末にも届く（7.4）。
// 外した語は一覧から消えるので、フォーカスは次の語の［戻す］（無ければ前の語、それも無ければ区切りの見出し）へ移す（読み上げ・キーで続けて
// 操作できるように。開発）。押した後に取り消す操作は作らない（詳細で［知ってる］を押せば戻る。シンプル。D22）
import { useId, useLayoutEffect, useMemo, useRef } from 'react'
import { unknow, useApp } from '../../store/appStore'
import { notifyError } from '../../store/uiStore'

/** 一覧の1語（termId と押した時の表記） */
interface KnownRow {
  termId: string
  term: string
}

/** 語の順（日本語の並び。同じ表記は termId の順） */
function byTerm(a: KnownRow, b: KnownRow): number {
  return a.term.localeCompare(b.term, 'ja') || (a.termId < b.termId ? -1 : a.termId > b.termId ? 1 : 0)
}

export function KnownTermsSettings() {
  const id = useId()
  const ready = useApp((s) => s.status === 'ready')
  const knownTerms = useApp((s) => s.user.knownTerms)
  const rows = useMemo(
    () =>
      Object.entries(knownTerms)
        .filter(([, k]) => k.on)
        // 表記が壊れていた記録（repair で空になった物）は termId で出す（無くさずに戻せるように）
        .map(([termId, k]): KnownRow => ({ termId, term: k.term || termId }))
        .sort(byTerm),
    [knownTerms],
  )
  const sectionRef = useRef<HTMLElement>(null)
  // 外した後にフォーカスを移す先（termId。null は見出し。undefined は移さない）
  const focusNext = useRef<string | null | undefined>(undefined)

  useLayoutEffect(() => {
    const target = focusNext.current
    if (target === undefined) return
    focusNext.current = undefined
    const section = sectionRef.current
    if (!section) return
    const button = target === null ? null : section.querySelector<HTMLButtonElement>(`[data-term-id="${target}"] button`)
    ;(button ?? section.querySelector<HTMLElement>('h2'))?.focus()
  }, [rows])

  const undo = (row: KnownRow, index: number) => {
    const r = unknow(row.termId)
    if (!r.ok) {
      notifyError('「知ってる」を戻せませんでした。少し待ってからもう一度押してください。')
      return
    }
    if (!r.changed) return
    focusNext.current = (rows[index + 1] ?? rows[index - 1])?.termId ?? null
  }

  return (
    <section className="card aset-card" aria-labelledby={`${id}-title`} data-testid="known-terms" ref={sectionRef}>
      <div className="aset-card-head">
        <h2 id={`${id}-title`} tabIndex={-1}>
          「知ってる」にした語
        </h2>
        <p className="aset-card-lead">
          ［知ってる］を押した語は、詳細の用語の一覧と本文の印に出なくなります。［戻す］を押すと、次に開いた詳細からまた出ます。説明が新しくなった語は、新しい説明の話題でもう一度出ます。
        </p>
      </div>
      {!ready ? (
        <div className="aset-row">
          <span className="aset-row-desc">読み込み中…</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="aset-row">
          <span className="aset-row-desc" data-testid="known-terms-empty">
            まだありません
          </span>
        </div>
      ) : (
        <ul className="list">
          {rows.map((row, i) => (
            <li key={row.termId} className="aset-row" data-term-id={row.termId}>
              <span className="grow">{row.term}</span>
              <button type="button" className="btn btn-sm" aria-label={`「${row.term}」を戻す`} onClick={() => undo(row, i)}>
                戻す
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
