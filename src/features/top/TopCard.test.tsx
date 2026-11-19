// 一覧のカード（docs/SPEC.md の 9. の「一覧のカード」・5.10。設計: 段階2の 1.5・1.15・1.16・1.17）: 頭の行（重大印・地域とジャンル・
// 続報・続報あり・訂正あり・版の名前）・見出しのボタン・要約（強調あり・用語の印なし）・下の行（結論ラベル・速報・未確認・出典にした所・
// 照合済み。出典は段階3で「報道: …（n社）」から「出典: …（nか所）」に替えた）。
// 知らない地域・ジャンル・結論ラベルは書かない。既読は data-read と淡い見出しのクラス。カードのどこを押しても1回だけ開く
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { repairTopic, type ShownTopic } from '../../domain/repair'
import { FAKE_TOPIC_SCENES, makeFakeEdition } from '../../test/fixtures/fakeEditions'
import { FAKE_OUTLETS } from '../../test/fixtures/fakeOutlets'
import { placeText, NewerTopicCard, TopCard } from './TopCard'
import { CARD_TEXTS, SECTION_TEXTS } from './texts'

afterEach(cleanup)

const FAKE = makeFakeEdition({ date: '2026-11-15', slot: '12', seed: 'top-card' })

function shownOf(rank: number): ShownTopic {
  const r = repairTopic(FAKE.topics[rank - 1], { outlets: FAKE_OUTLETS })
  if (r.kind !== 'ok') throw new Error('作り物の話題を写しにできません')
  return r.value
}

function renderCard(topic: ShownTopic, props: Partial<Parameters<typeof TopCard>[0]> = {}) {
  const onOpen = vi.fn()
  render(<TopCard topic={topic} corrected={false} read={false} onOpen={onOpen} {...props} />)
  const card = screen.getByTestId('top-card')
  return {
    card,
    onOpen,
    meta: card.querySelector('.top-card-meta')!,
    foot: card.querySelector('.top-card-foot')!,
  }
}

describe('一覧のカード', () => {
  it('重大印の話題: 頭の行の頭に「重大」の札と地域・ジャンル、下の行に結論ラベル・速報・未確認・出典にした所・照合済み', () => {
    const topic = shownOf(FAKE_TOPIC_SCENES.major)
    expect(topic.major).toBe(true)
    const { card, meta, foot } = renderCard(topic)
    expect(card.getAttribute('data-topic-id')).toBe(topic.id)
    expect(card.getAttribute('data-major')).toBe('true')
    expect(card.classList.contains('is-major')).toBe(true)
    expect(meta.firstElementChild?.textContent).toBe(CARD_TEXTS.major)
    expect(meta.textContent).toContain(placeText(topic)!)
    expect(placeText(topic)).toBe('国内・テクノロジー')
    expect([...foot.children].map((c) => c.textContent)).toEqual([
      '未確定',
      '速報・未確認',
      `出典: ${topic.outletNames.slice(0, 2).join('・')} ほか（${topic.outletNames.length}か所）`,
      CARD_TEXTS.checked,
    ])
    // 見出しは <h3><button>（入れ子のボタンは作らない）
    const heading = within(card).getByRole('heading', { level: 3 })
    expect(heading.textContent).toBe(topic.headline)
    expect(within(card).getAllByRole('button')).toHaveLength(1)
    expect(within(heading).getByRole('button').textContent).toBe(topic.headline)
  })

  it('要約は強調だけ（<strong class="emph">）を付け、用語の印は付けない', () => {
    const topic = shownOf(FAKE_TOPIC_SCENES.major)
    const { card } = renderCard(topic)
    const summary = card.querySelector('.top-card-summary')!
    expect(summary.textContent).toBe(topic.summary)
    expect([...summary.querySelectorAll('strong.emph')].map((s) => s.textContent)).toEqual(topic.emphasis.summary)
    expect(summary.querySelector('[data-testid="term-mark"]')).toBeNull()
    expect(topic.terms.length).toBeGreaterThan(0)
  })

  it('ふつうの話題: 重大印・速報が無く、出典にした所が2つなら「ほか」を付けない', () => {
    const topic = shownOf(4)
    expect(topic.major).toBe(false)
    expect(topic.outletNames).toHaveLength(2)
    const { card, meta, foot } = renderCard(topic)
    expect(card.getAttribute('data-major')).toBeNull()
    expect(card.classList.contains('is-major')).toBe(false)
    expect(meta.textContent).toBe('国内・経済')
    expect(foot.textContent).not.toContain('速報・未確認')
    expect(foot.textContent).toContain(`出典: ${topic.outletNames.join('・')}（2か所）`)
  })

  it('照合しなかった話題には「照合済み」を出さない', () => {
    const { foot } = renderCard(shownOf(FAKE_TOPIC_SCENES.noCheck))
    expect(foot.textContent).not.toContain(CARD_TEXTS.checked)
  })

  it('続報・続報あり・訂正あり・版の名前を頭の行に出す（訂正は data-correction）', () => {
    const topic = { ...shownOf(4), followUp: { prevTopicId: FAKE.topics[0].id, whatsNew: '新しい事' } } as ShownTopic
    const { card, meta } = renderCard(topic, { corrected: true, hasNewer: true, editionName: '11/14（土）20:00版' })
    expect(card.getAttribute('data-correction')).toBe('true')
    expect([...meta.children].map((c) => c.textContent)).toEqual([
      '11/14（土）20:00版',
      '国内・経済',
      CARD_TEXTS.followUp,
      CARD_TEXTS.hasNewer,
      CARD_TEXTS.corrected,
    ])
    expect(meta.querySelector('.top-card-corrected')?.textContent).toBe(CARD_TEXTS.corrected)
  })

  it('訂正が無い・続報が無い時は出さない', () => {
    const { card, meta } = renderCard(shownOf(4))
    expect(card.getAttribute('data-correction')).toBeNull()
    expect(meta.textContent).not.toContain(CARD_TEXTS.followUp)
    expect(meta.textContent).not.toContain(CARD_TEXTS.corrected)
    expect(meta.textContent).not.toContain(CARD_TEXTS.hasNewer)
  })

  it('知らない地域・ジャンル・結論ラベルは書かない（両方知らない時は地域とジャンルの所ごと書かない）', () => {
    const base = shownOf(FAKE_TOPIC_SCENES.newerValues)
    expect(base.genre).toBe('novel')
    expect(renderCard(base).meta.textContent).toBe('国内')
    cleanup()
    const unknown = { ...base, region: 'mars', conclusion: { ...base.conclusion, label: 'maybe' } } as ShownTopic
    const { meta, foot } = renderCard(unknown)
    expect(placeText(unknown)).toBeNull()
    expect(meta.textContent).toBe('')
    expect(foot.querySelector('.top-card-label')).toBeNull()
  })

  it('既読は data-read と淡い見出しのクラス（読んでいない時は付けない）', () => {
    const topic = shownOf(4)
    const { card } = renderCard(topic, { read: true })
    expect(card.getAttribute('data-read')).toBe('true')
    expect(card.classList.contains('is-read')).toBe(true)
    cleanup()
    const other = renderCard(topic).card
    expect(other.getAttribute('data-read')).toBeNull()
    expect(other.classList.contains('is-read')).toBe(false)
  })

  it('見出しのボタンを押すと onOpen(話題の id) を1回。カードのほかの所を押しても同じく1回で、ボタンへフォーカスを移す', () => {
    const topic = shownOf(4)
    const { card, onOpen } = renderCard(topic)
    const button = within(card).getByRole('button')
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenLastCalledWith(topic.id)
    fireEvent.click(card.querySelector('.top-card-summary')!)
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(onOpen).toHaveBeenLastCalledWith(topic.id)
    expect(document.activeElement).toBe(button)
  })

  // Safari（iPhone・Mac）は押したボタンへフォーカスを移さない（jsdom の click も移さない）。開く前に自分で移しておかないと、シートと
  // パネルが覚える開いた所が body になり、閉じた時に開いたカードへ戻せない（設計: 段階2の 2.）
  it('見出しのボタンを直に押した時も、onOpen の前にそのボタンへフォーカスを移す（押してもフォーカスが移らないブラウザのため）', () => {
    const topic = shownOf(4)
    const onOpen = vi.fn(() => {
      expect(document.activeElement).toBe(button)
    })
    const { card } = renderCard(topic, { onOpen })
    const button = within(card).getByRole('button')
    expect(document.activeElement).toBe(document.body)
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(button)
  })

  it('字を選んでいる時は、カードを押しても開かない', () => {
    const topic = shownOf(4)
    const { card, onOpen } = renderCard(topic)
    const sel = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '選んだ字' } as Selection)
    fireEvent.click(card.querySelector('.top-card-summary')!)
    expect(onOpen).not.toHaveBeenCalled()
    sel.mockRestore()
  })

  it('記録の文は HTML として読まない', () => {
    const topic = { ...shownOf(4), headline: '<b>見出し</b>', summary: '<img src=x>要約', emphasis: {} } as ShownTopic
    const { card } = renderCard(topic)
    expect(card.querySelector('b')).toBeNull()
    expect(card.querySelector('img')).toBeNull()
    expect(within(card).getByRole('button').textContent).toBe('<b>見出し</b>')
  })
})

describe('新しい形の記録の話題のカード', () => {
  it('押せない淡いカードに「新しい形の記録（アプリを更新してください）」', () => {
    render(<NewerTopicCard topicId="2026-11-15-12-abcdefgh" />)
    const card = screen.getByTestId('top-card')
    expect(card.getAttribute('data-topic-id')).toBe('2026-11-15-12-abcdefgh')
    expect(card.textContent).toBe(SECTION_TEXTS.newerTopic)
    expect(within(card).queryAllByRole('button')).toHaveLength(0)
  })
})
