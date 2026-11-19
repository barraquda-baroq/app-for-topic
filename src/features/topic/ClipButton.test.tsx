// ［クリップ］（D10・docs/SPEC.md の 7.6・9.。作者の答え A。設計: 段階2の 1.14・4.1）: 押した処理の中で（最初の await の前に）
// navigator.clipboard.writeText を呼ぶ・書けたらお知らせ・断られた時と navigator.clipboard が無い時は文を選んだ窓（読むだけの欄に
// フォーカスし、文を全部選ぶ）・文は clipText（訂正のある話題は「訂正: …」を足した順に。だから何？は入れない）・何も保存しない
// （Dexie・localStorage に書かない）
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clipText } from '../../domain/clipText'
import { repairTopic, type ShownTopic } from '../../domain/repair'
import { useToasts } from '../../store/uiStore'
import { CHAIN_CORRECTION_TEXT, makeFakeMonth } from '../../test/fixtures/fakeEditions'
import { FAKE_OUTLETS } from '../../test/fixtures/fakeOutlets'
import { ClipButton } from './ClipButton'
import { CLIP_TEXTS } from './detailTexts'

afterEach(() => {
  cleanup()
  useToasts.setState({ toasts: [] })
  Reflect.deleteProperty(navigator, 'clipboard')
  vi.restoreAllMocks()
})

const MONTH = makeFakeMonth({ until: '2026-11-15', untilSlot: '12', days: 3, seed: 'clip-button' })
/** 続報の鎖の1本目（訂正1件・××ニュースで読んだ出典） */
const FIRST: ShownTopic = (() => {
  const id = MONTH.scenes.chain[0]
  const raw = MONTH.editions.flatMap((e) => e.topics).find((t) => t.id === id)
  const r = repairTopic(raw, { outlets: FAKE_OUTLETS })
  if (r.kind !== 'ok') throw new Error('作り物の話題を写しにできません')
  return r.value
})()
const CORRECTIONS = [{ text: CHAIN_CORRECTION_TEXT }]
const EXPECTED = clipText(FIRST, CORRECTIONS)

function setClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', { value: writeText ? { writeText } : undefined, configurable: true })
}

describe('押した処理の中で書く（iPhone の Safari。設計: 段階2の 8. の 1）', () => {
  it('押した処理の中で（最初の await の前に）writeText を呼び、書けたらお知らせ', async () => {
    const writeText = vi.fn((text: string) => {
      void text
      return Promise.resolve()
    })
    setClipboard(writeText)
    render(<ClipButton topic={FIRST} corrections={CORRECTIONS} />)
    // fireEvent は押した処理をその場で動かす。await の後で呼んでいれば、ここではまだ呼ばれていない
    fireEvent.click(screen.getByTestId('topic-clip'))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(EXPECTED)
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.message)).toEqual([CLIP_TEXTS.copied]))
    expect(screen.queryByTestId('clip-dialog')).toBeNull()
  })

  it('文は作者の答え A の形（訂正は要約の後に「訂正: …」・だから何？・強調は入れない・××ニュースで読んだ）', () => {
    expect(EXPECTED).toContain(`\n\n訂正: ${CHAIN_CORRECTION_TEXT}\n\n出典:\n`)
    expect(EXPECTED).toContain('（××ニュースで読んだ）')
    expect(EXPECTED.startsWith(`${FIRST.headline}\n2026年11月13日（金）12:00版・国内・経済\n\n`)).toBe(true)
    for (const v of Object.values(FIRST.soWhat)) if (v) expect(EXPECTED).not.toContain(v)
  })
})

describe('使えない時の窓（docs/SPEC.md の 9.）', () => {
  it('断られた（Promise が拒んだ）時は、文を選んだ窓（読むだけの欄にフォーカスし、全部を選ぶ）', async () => {
    setClipboard(vi.fn(() => Promise.reject(new DOMException('拒否', 'NotAllowedError'))))
    render(<ClipButton topic={FIRST} corrections={CORRECTIONS} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('topic-clip'))
    })
    const dialog = await screen.findByTestId('clip-dialog')
    const area = within(dialog).getByRole('textbox') as HTMLTextAreaElement
    expect(area.value).toBe(EXPECTED)
    expect(area.readOnly).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(area))
    expect([area.selectionStart, area.selectionEnd]).toEqual([0, EXPECTED.length])
    expect(dialog.textContent).toContain(CLIP_TEXTS.dialogNote)
    expect(useToasts.getState().toasts).toEqual([])
  })

  it('navigator.clipboard が無い時も窓。閉じるとクリップのボタンへフォーカスを戻す', async () => {
    setClipboard(undefined)
    render(<ClipButton topic={FIRST} corrections={[]} />)
    const button = screen.getByTestId('topic-clip')
    await act(async () => {
      fireEvent.click(button)
    })
    const dialog = await screen.findByTestId('clip-dialog')
    expect((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).toBe(clipText(FIRST, []))
    fireEvent.click(within(dialog).getByTestId('modal-close'))
    await waitFor(() => expect(screen.queryByTestId('clip-dialog')).toBeNull())
    expect(document.activeElement).toBe(button)
  })

  it('writeText が投げた時も窓', async () => {
    setClipboard(() => {
      throw new Error('使えません')
    })
    render(<ClipButton topic={FIRST} corrections={CORRECTIONS} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('topic-clip'))
    })
    expect(await screen.findByTestId('clip-dialog')).toBeTruthy()
  })
})

describe('何も記録しない（docs/SPEC.md の 7.6・D21）', () => {
  it('localStorage にも IndexedDB にも書かない', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const openDb = vi.spyOn(indexedDB, 'open')
    setClipboard(vi.fn(() => Promise.resolve()))
    render(<ClipButton topic={FIRST} corrections={CORRECTIONS} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('topic-clip'))
    })
    setClipboard(vi.fn(() => Promise.reject(new Error('拒否'))))
    await act(async () => {
      fireEvent.click(screen.getByTestId('topic-clip'))
    })
    await screen.findByTestId('clip-dialog')
    expect(setItem).not.toHaveBeenCalled()
    expect(openDb).not.toHaveBeenCalled()
  })
})
