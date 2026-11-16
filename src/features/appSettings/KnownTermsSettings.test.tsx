// 設定の「『知ってる』にした語」（src/features/appSettings/KnownTermsSettings.tsx。docs/SPEC.md の 5.8・7.4。設計: 段階2の 1.13・4.1）:
// 知ってる（on）の語だけを語の順に並べ、［戻す］で外す（ストアの unknow。記録は消さず on を false に。asOf はそのまま）・外した語は
// 一覧から消え、フォーカスは次の語へ・0語なら「まだありません」・端末の中を読み終える前は「読み込み中…」・ほかの所（ほかの端末から届いた・
// 詳細で押した）で変わるとその場で替わる。保存先（Dexie。fake-indexeddb）は本物
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPersistence, type Persistence } from '../../db/persistence'
import { termIdOf } from '../../domain/ids'
import { flushNow, getRawUserRecords, initStore, know, resetStoreForTests, unknow, useApp } from '../../store/appStore'
import { useToasts } from '../../store/uiStore'
import { KnownTermsSettings } from './KnownTermsSettings'

let p: Persistence

/** 語を「知ってる」にする（作り物の語。asOf は説明の時点） */
function press(term: string, asOf: string | null = null) {
  const r = know({ termId: termIdOf(term), term, asOf })
  expect(r.ok).toBe(true)
}

/** 一覧に出ている語（上から） */
const shownTerms = () =>
  within(screen.getByTestId('known-terms'))
    .queryAllByRole('listitem')
    .map((li) => li.querySelector('.grow')?.textContent)

beforeEach(async () => {
  p = createPersistence(`known-terms-${Math.random().toString(36).slice(2)}`)
  await initStore(p)
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  p.close()
  useToasts.setState({ toasts: [] })
})

describe('KnownTermsSettings', () => {
  it('知ってるの語が無ければ「まだありません」（区切りの見出しは「『知ってる』にした語」）', () => {
    render(<KnownTermsSettings />)
    const section = screen.getByRole('region', { name: '「知ってる」にした語' })
    expect(section).toBe(screen.getByTestId('known-terms'))
    expect(within(section).getByTestId('known-terms-empty').textContent).toBe('まだありません')
    expect(within(section).queryByRole('list')).toBeNull()
  })

  it('端末の中を読み終える前は「読み込み中…」（「まだありません」を一瞬出さない）', () => {
    resetStoreForTests()
    useApp.setState({ status: 'loading' })
    render(<KnownTermsSettings />)
    expect(screen.getByTestId('known-terms').textContent).toContain('読み込み中…')
    expect(screen.queryByTestId('known-terms-empty')).toBeNull()
  })

  it('on の語だけを語の順に並べ、外した語（on: false）は出さない', () => {
    press('与党', '2026-11')
    press('国会')
    press('インフレ')
    press('衆議院')
    expect(unknow(termIdOf('国会')).ok).toBe(true)
    render(<KnownTermsSettings />)
    const expected = ['与党', 'インフレ', '衆議院'].sort((a, b) => a.localeCompare(b, 'ja'))
    expect(shownTerms()).toEqual(expected)
    const item = within(screen.getByTestId('known-terms')).getAllByRole('listitem')[0]
    expect(item.getAttribute('data-term-id')).toBe(termIdOf(expected[0]))
    expect(within(item).getByRole('button').getAttribute('aria-label')).toBe(`「${expected[0]}」を戻す`)
  })

  it('［戻す］を押すと unknow で外し（記録は消さず on: false・asOf はそのまま）、一覧から消えて次の語へフォーカスを移す', async () => {
    const user = userEvent.setup()
    press('与党', '2026-11')
    press('野党')
    press('法案')
    render(<KnownTermsSettings />)
    const order = shownTerms() as string[]
    // 時期で変わる語（説明の時点 asOf がある）を戻す。フォーカスは次の語（いちばん下なら前の語）へ
    const target = '与党'
    const at = order.indexOf(target)
    const next = order[at + 1] ?? order[at - 1]
    await user.click(screen.getByRole('button', { name: `「${target}」を戻す` }))
    expect(shownTerms()).toEqual(order.filter((t) => t !== target))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `「${next}」を戻す` }))
    await flushNow()
    expect(getRawUserRecords().knownTerms[termIdOf(target)]).toMatchObject({
      id: termIdOf(target),
      term: target,
      asOf: '2026-11',
      on: false,
    })
    expect(await p.outboxKeys()).toContain(`knownTerms/${termIdOf(target)}`)
  })

  it('いちばん下の語を戻すと前の語へ、最後の1語を戻すと「まだありません」と区切りの見出しへフォーカスを移す', async () => {
    const user = userEvent.setup()
    press('野党')
    press('法案')
    render(<KnownTermsSettings />)
    const order = shownTerms() as string[]
    await user.click(screen.getByRole('button', { name: `「${order[1]}」を戻す` }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `「${order[0]}」を戻す` }))
    await user.click(screen.getByRole('button', { name: `「${order[0]}」を戻す` }))
    expect(screen.getByTestId('known-terms-empty').textContent).toBe('まだありません')
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '「知ってる」にした語' }))
  })

  it('ほかの所で「知ってる」が変わると（詳細で押した・ほかの端末から届いた）、その場で一覧も替わる（フォーカスは動かさない）', () => {
    render(<KnownTermsSettings />)
    expect(screen.getByTestId('known-terms-empty')).toBeTruthy()
    const before = document.activeElement
    act(() => press('金利'))
    expect(shownTerms()).toEqual(['金利'])
    act(() => {
      unknow(termIdOf('金利'))
    })
    expect(screen.getByTestId('known-terms-empty')).toBeTruthy()
    expect(document.activeElement).toBe(before)
  })

  it('戻せなかった時（端末の中を読めなくなった等）は知らせ、一覧は変えない', async () => {
    const user = userEvent.setup()
    press('野党')
    render(<KnownTermsSettings />)
    // ストアを読み終える前の状態に戻す（unknow は not-ready で断る）。表示用の写しは残したまま
    const shown = useApp.getState().user
    resetStoreForTests()
    useApp.setState({ status: 'ready', user: shown })
    await user.click(screen.getByRole('button', { name: '「野党」を戻す' }))
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual([
      '「知ってる」を戻せませんでした。少し待ってからもう一度押してください。',
    ])
    expect(shownTerms()).toEqual(['野党'])
  })
})
