// 話題の詳細の中身（docs/SPEC.md の 9. の「詳細」。設計: 段階2の 1.10〜1.17・4.1）: 1.10 の並び・null の欄の決まった文・claim null・
// 見解なし（理由つき・理由なし）と知らない kind・AI のジャンルの注記・共通の注記は見解と対立見解がある時だけ・訂正は見出しの上に足した順・
// 確かめられなかった点はたたむ・開いた時に知ってる語を出さない・元記事のリンクと文・照合の件数・順位の理由・書いた AI・強調と用語の印・
// 説明の箱（段落のすぐ下・1度に1つ・Esc は箱だけ閉じてシートの onClose を呼ばない・フォーカスは語へ戻る）・前の話題と続報あり。
// 話題は作り物の版（src/test/fixtures/fakeEditions.ts）を表示用の写しにした物（中身はすべて作り物）
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIXED_TEXTS } from '../../domain/fixedTexts'
import { repairTopic, type ShownCorrection, type ShownTopic } from '../../domain/repair'
import { detailTextFields, findTermHits } from '../../domain/termMarks'
import type { ThreadTopic } from '../../store/appStore'
import { FAKE_TOPIC_SCENES, makeFakeEdition, makeFakeMonth } from '../../test/fixtures/fakeEditions'
import { FAKE_OUTLETS } from '../../test/fixtures/fakeOutlets'
import { Modal } from '../../ui/Modal'
import { DETAIL_HEADS, KNOWN_TEXTS, unverifiedText } from './detailTexts'
import { TopicDetail, type TopicDetailProps } from './TopicDetail'
import { useKnownPresses } from './useKnownPresses'

afterEach(() => cleanup())

const EDITION = makeFakeEdition({ date: '2026-11-15', slot: '12', seed: 'topic-detail' })

function shownTopic(raw: unknown): ShownTopic {
  const r = repairTopic(raw, { outlets: FAKE_OUTLETS })
  if (r.kind !== 'ok') throw new Error('作り物の話題を写しにできません')
  return r.value
}

/** 作り物の版の、その順位の話題 */
const topicAt = (rank: number) => shownTopic(EDITION.topics[rank - 1])

function correction(topic: ShownTopic, text: string, at: number): ShownCorrection {
  return {
    id: `${topic.id}-c${at}`,
    v: 1,
    createdAt: at,
    by: 'connector',
    ai: 'claude',
    model: 'fake',
    runId: 'r',
    topicId: topic.id,
    editionId: topic.editionId,
    text,
  }
}

const NO_HIDDEN: ReadonlySet<string> = new Set()

/** 押した［知ってる］も本物の hook で持つ（書くのは閉じた時なので、ここでは書かれない） */
function Detail(props: Partial<TopicDetailProps> & { topic: ShownTopic }): JSX.Element {
  const presses = useKnownPresses()
  return (
    <TopicDetail
      corrections={[]}
      mode="sheet"
      hiddenTermIds={NO_HIDDEN}
      pressed={presses.pressed}
      onPressKnown={presses.press}
      onUndoKnown={presses.undo}
      thread={null}
      onOpenTopic={() => {}}
      {...props}
    />
  )
}

/** 根の中で、文がこの順に出る所（前の文の後ろから探す。どれかが見つからない・順が違えば落ちる） */
function orderOf(root: HTMLElement, texts: string[]): number[] {
  const all = root.textContent ?? ''
  let from = 0
  return texts.map((t) => {
    const i = all.indexOf(t, from)
    expect(i, `${t}（${from} より後）`).toBeGreaterThanOrEqual(from)
    from = i + t.length
    return i
  })
}

describe('並び（設計: 段階2の 1.10）', () => {
  it('訂正 → 見出し → 結論 → 要約 → だから何？ → 当事者 → 見解・共通の注記 → 経緯 → 確かめられなかった点 → 用語 → 元記事 → 下の細い字', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.jpRulingParty)
    render(<Detail topic={topic} corrections={[correction(topic, '一つ目の訂正の文', 1)]} />)
    const root = screen.getByTestId('topic-detail')
    expect(root.getAttribute('data-topic-id')).toBe(topic.id)
    expect(root.getAttribute('data-mode')).toBe('sheet')
    const order = orderOf(root, [
      `${FIXED_TEXTS.correctionPrefix} 一つ目の訂正の文`,
      topic.headline,
      '未確定',
      topic.conclusion.note.slice(0, 8),
      topic.summary.slice(0, 8),
      DETAIL_HEADS.soWhat,
      DETAIL_HEADS.stakeholders,
      FIXED_TEXTS.stakeholdersNote,
      DETAIL_HEADS.view,
      '対立の軸',
      '論点',
      FIXED_TEXTS.commonNote,
      DETAIL_HEADS.timeline,
      unverifiedText(topic.unverified.length),
      DETAIL_HEADS.terms,
      DETAIL_HEADS.sources,
      '照合: ',
      'この版で3位にした理由: ',
      '書いた AI: Claude',
    ])
    expect(order).toHaveLength(19)
    // 見出しは本文の頭の h3（強調なし）。訂正は見出しの上の箱
    const h3 = within(root).getByRole('heading', { level: 3 })
    expect(h3.textContent).toBe(topic.headline)
    expect(h3.querySelector('.emph')).toBeNull()
    const fix = within(root).getByTestId('topic-correction')
    expect(fix.compareDocumentPosition(h3) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('訂正は足した順に「訂正: …」を並べる（2件目が1件目を正す時もそのまま。強調なし）', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.soWhatLifeNull)
    render(<Detail topic={topic} corrections={[correction(topic, '先の文', 1), correction(topic, '先の訂正は誤りでした', 2)]} />)
    const lines = screen.getAllByTestId('topic-correction').map((e) => e.textContent)
    expect(lines).toEqual(['訂正: 先の文', '訂正: 先の訂正は誤りでした'])
    expect(document.querySelector('.topic-corrections .emph')).toBeNull()
  })

  it('訂正が無ければ箱を出さない。重大印と速報・未確認・結論ラベル', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.major)
    render(<Detail topic={topic} />)
    expect(screen.queryByTestId('topic-correction')).toBeNull()
    expect(document.querySelector('.topic-major')?.textContent).toBe('重大')
    expect(document.querySelector('.topic-breaking')?.textContent).toBe('速報・未確認')
    expect(document.querySelector('.topic-conclusion-labels .topic-label')?.textContent).toBe('未確定')
  })
})

describe('決まった文と、出さない区切り（docs/SPEC.md の 7.1 の決まった文）', () => {
  it('だから何？の null は「この話題では特になし」（強調なし）。4つの観点はいつも出す', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.sportsNone)
    render(<Detail topic={topic} />)
    const nones = [...document.querySelectorAll('.topic-so-what .topic-none')].map((e) => e.textContent)
    expect(nones).toEqual([FIXED_TEXTS.soWhatNone, FIXED_TEXTS.soWhatNone, FIXED_TEXTS.soWhatNone])
    expect([...document.querySelectorAll('.topic-so-what .topic-sub')].map((e) => e.textContent)).toEqual([
      '暮らし・お金',
      '社会の仕組み',
      '世界の力関係',
      'なぜ話題か',
    ])
    // 結論の補足が空なら書かない。当事者が0件なら区切りごと出さない
    expect(document.querySelector('.topic-conclusion-note')).toBeNull()
    expect(screen.queryByText(DETAIL_HEADS.stakeholders)).toBeNull()
  })

  it('当事者: 名前・立場・立場の補足・主張・理由。claim が null は決まった文。知らない立場は「不明」', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.unverifiedStakeholder)
    render(<Detail topic={topic} />)
    const rows = [...document.querySelectorAll('.topic-stakeholder')]
    expect(rows).toHaveLength(topic.stakeholders.length)
    expect(rows[1].textContent).toContain('条件付き')
    expect(rows[1].textContent).toContain('財源が示されれば賛成')
    expect(rows[2].textContent).toContain('不明')
    expect(rows[2].textContent).toContain(FIXED_TEXTS.claimUnverified)
    cleanup()
    render(<Detail topic={topicAt(FAKE_TOPIC_SCENES.newerValues)} />)
    expect(document.querySelector('.topic-stakeholder .topic-label')?.textContent).toBe('不明')
  })

  it('見解なし: 理由があれば理由、無ければ決まった文。どちらも共通の注記・AI の見解の見出しを出さない', () => {
    render(<Detail topic={topicAt(FAKE_TOPIC_SCENES.noneWithReason)} />)
    expect(screen.getByText('捜査の段階の事実を伝える報道で、評価が分かれる論点がまだ無いため')).toBeTruthy()
    expect(screen.queryByText(FIXED_TEXTS.commonNote)).toBeNull()
    expect(screen.queryByText('AI の見解')).toBeNull()
    cleanup()
    render(<Detail topic={topicAt(FAKE_TOPIC_SCENES.sportsNone)} />)
    expect(screen.getByText(FIXED_TEXTS.viewNone)).toBeTruthy()
    expect(screen.queryByText(FIXED_TEXTS.commonNote)).toBeNull()
  })

  it('知らない kind の見解（view が null）は区切りごと出さない', () => {
    const topic = { ...topicAt(FAKE_TOPIC_SCENES.major), view: null }
    render(<Detail topic={topic} />)
    expect(screen.queryByText(DETAIL_HEADS.view)).toBeNull()
    expect(screen.queryByText(FIXED_TEXTS.commonNote)).toBeNull()
  })

  it('論点は軸の下に1行。文が「論点」から始まる時は「論点:」を重ねず、そうでない時だけ「論点:」を添える', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.jpRulingParty)
    if (topic.view?.kind !== 'opposed') throw new Error('対立見解のある話題ではありません')
    // 作り物の論点は docs/SPEC.md の 5.6 の例のとおり「論点は『…』か『…』か」
    expect(topic.view.issue?.startsWith('論点は')).toBe(true)
    render(<Detail topic={topic} />)
    const axisRows = () => [...document.querySelectorAll('.topic-axis')].map((e) => e.textContent)
    expect(axisRows()).toEqual([`対立の軸: ${topic.view.axis}`, topic.view.issue])
    expect(screen.getByTestId('topic-detail').textContent).not.toContain('論点: 論点')
    cleanup()
    render(<Detail topic={{ ...topic, view: { ...topic.view, issue: '「家計」か「財政」か' } }} />)
    expect(axisRows()).toEqual([`対立の軸: ${topic.view.axis}`, '論点: 「家計」か「財政」か'])
  })

  it('AI のジャンルは、見解の上に注記を出す（ほかのジャンルは出さない）', () => {
    render(<Detail topic={topicAt(FAKE_TOPIC_SCENES.aiGenre)} />)
    const root = screen.getByTestId('topic-detail')
    // 区切りの見出し → 軸 → 注記 → AI の見解 → 対立見解 → 共通の注記
    orderOf(root, [DETAIL_HEADS.view, '対立の軸', FIXED_TEXTS.aiGenreNote, 'AI の見解', '対立見解', FIXED_TEXTS.commonNote])
    cleanup()
    render(<Detail topic={topicAt(FAKE_TOPIC_SCENES.jpRulingParty)} />)
    expect(screen.queryByText(FIXED_TEXTS.aiGenreNote)).toBeNull()
  })

  it('確かめられなかった点は件数つきでたたむ（0件なら出さない）', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.major)
    render(<Detail topic={topic} />)
    const details = document.querySelector('details.topic-unverified') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('確かめられなかった点（2）')
    expect(details.querySelectorAll('li')).toHaveLength(2)
    cleanup()
    render(<Detail topic={topicAt(FAKE_TOPIC_SCENES.aiGenre)} />)
    expect(document.querySelector('details.topic-unverified')).toBeNull()
  })

  it('経緯: 年月・年・null（日付を書かず文だけ）を書いた順に', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.timelineYearMonth)
    render(<Detail topic={topic} />)
    const rows = [...document.querySelectorAll('.topic-timeline li')]
    expect(rows.map((r) => r.querySelector('.topic-when')?.textContent ?? null)).toEqual(['2026年10月', '2026年11月15日', null])
    expect(rows[2].textContent).toBe('その後、委員会で採決する予定')
  })
})

describe('元記事と下の細い字', () => {
  it('リンクにする出典だけ <a>（新しいタブ・noopener noreferrer）。一覧に無い社の URL は文で出す', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.newerValues)
    render(<Detail topic={topic} />)
    const sources = document.querySelector('.topic-sources') as HTMLElement
    const links = [...sources.querySelectorAll('a')]
    expect(links.length).toBe(topic.sources.filter((s) => s.link).length)
    expect(links.length).toBeGreaterThan(0)
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    }
    const unlinked = topic.sources.find((s) => !s.link)!
    expect(unlinked.outlet).toBe('◇◇日報')
    expect(within(sources).getByText(unlinked.url)).toBeTruthy()
    expect(sources.textContent).toContain(`${unlinked.outlet}「${unlinked.title}」`)
  })

  it('読んだ所と日時（日付だけ・掲載日時の補足）', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.viaSource)
    render(<Detail topic={topic} />)
    const text = document.querySelector('.topic-sources')?.textContent ?? ''
    expect(text).toContain('（××ニュースで読んだ）')
    cleanup()
    const t5 = topicAt(FAKE_TOPIC_SCENES.publishedAtNull)
    render(<Detail topic={t5} />)
    const withNote = t5.sources.find((s) => s.publishedAt === null)!
    expect(document.querySelector('.topic-sources')?.textContent).toContain(withNote.publishedNote ?? '掲載日時は不明')
  })

  it('照合は件数（モデルの名前は出さない）・照合しなかった話題は出さない・順位の理由・書いた AI', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.major)
    render(<Detail topic={topic} />)
    const foot = document.querySelector('.topic-foot')?.textContent ?? ''
    expect(foot).toContain(`照合: ${topic.check!.claims}件を元記事と照らし、${topic.check!.fixed}件を直しました`)
    expect(foot).not.toContain('fake-checker-model')
    expect(foot).toContain(`この版で1位にした理由: ${topic.rankReason}`)
    expect(foot).toContain('書いた AI: Claude')
    cleanup()
    render(<Detail topic={topicAt(FAKE_TOPIC_SCENES.noCheck)} />)
    expect(document.querySelector('.topic-foot')?.textContent).not.toContain('照合')
  })
})

describe('強調と用語の印（作者の答え A・■2 の A）', () => {
  it('強調は <strong class="emph">。見出し・用語の説明・出典には付けない。記録の文を HTML として読まない', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.major)
    render(<Detail topic={topic} />)
    const root = screen.getByTestId('topic-detail')
    const strong = [...root.querySelectorAll('strong.emph')]
    expect(strong.length).toBeGreaterThan(0)
    expect(root.querySelector('.topic-title .emph, .topic-terms .emph, .topic-sources .emph')).toBeNull()
    // 強調の語句は、どれかの <strong> の並びの中にある（用語の印の境で分かれていてもよい）
    const joined = strong.map((e) => e.textContent).join('')
    for (const phrases of Object.values(topic.emphasis)) for (const p of phrases) expect(root.textContent).toContain(p)
    expect(joined.length).toBeGreaterThan(0)
    cleanup()
    const html = { ...topic, summary: '<b>太字</b>と<img src=x>の文', emphasis: {} }
    render(<Detail topic={html} />)
    expect(document.querySelector('.topic-summary')?.textContent).toBe('<b>太字</b>と<img src=x>の文')
    expect(document.querySelector('.topic-summary b, .topic-summary img')).toBeNull()
  })

  it('用語の印は語ごとに最初の1か所だけ・開いた時に知ってる語には付けず、一覧にも出さない', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.jpRulingParty)
    const hits = findTermHits(detailTextFields(topic), topic.terms)
    expect(hits.length).toBeGreaterThan(1)
    render(<Detail topic={topic} />)
    const marks = screen.getAllByTestId('term-mark')
    expect(marks.map((m) => m.getAttribute('data-term-id'))).toEqual(hits.map((h) => h.termId))
    expect(new Set(marks.map((m) => m.getAttribute('data-term-id'))).size).toBe(marks.length)
    expect(screen.getAllByTestId('term-known')).toHaveLength(topic.terms.length)
    cleanup()
    const hidden = new Set([hits[0].termId])
    render(<Detail topic={topic} hiddenTermIds={hidden} />)
    expect(document.querySelector(`[data-testid="term-mark"][data-term-id="${hits[0].termId}"]`)).toBeNull()
    expect(document.querySelector(`.topic-term[data-term-id="${hits[0].termId}"]`)).toBeNull()
    expect(screen.getAllByTestId('term-known')).toHaveLength(topic.terms.length - 1)
  })

  it('印を押すと段落のすぐ下に説明の箱（1度に1つ）。もう一度押すか［×］で閉じ、フォーカスは語へ戻る', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.jpRulingParty)
    render(<Detail topic={topic} />)
    const [first, second] = screen.getAllByTestId('term-mark')
    fireEvent.click(first)
    const box = screen.getByTestId('term-note')
    expect(box.getAttribute('data-term-id')).toBe(first.getAttribute('data-term-id'))
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(first.getAttribute('aria-controls')).toBe(box.id)
    // 語のある段落のすぐ後
    expect(first.closest('p')?.nextElementSibling).toBe(box)
    const term = topic.terms.find((t) => t.termId === first.getAttribute('data-term-id'))!
    expect(box.textContent).toContain(term.explanation)
    fireEvent.click(second)
    expect(screen.getAllByTestId('term-note')).toHaveLength(1)
    expect(screen.getByTestId('term-note').getAttribute('data-term-id')).toBe(second.getAttribute('data-term-id'))
    fireEvent.click(second)
    expect(screen.queryByTestId('term-note')).toBeNull()
    fireEvent.click(first)
    fireEvent.click(within(screen.getByTestId('term-note')).getByRole('button', { name: '説明を閉じる' }))
    expect(screen.queryByTestId('term-note')).toBeNull()
    expect(document.activeElement).toBe(first)
  })

  it('時期で変わる語の説明には時点を添える（「2026年11月時点」）', () => {
    const month = makeFakeMonth({ until: '2026-11-15', untilSlot: '12', days: 3, seed: 'topic-detail' })
    const newest = month.editions[month.editions.length - 1]
    const topic = shownTopic(newest.topics[FAKE_TOPIC_SCENES.jpRulingParty - 1])
    const ruling = topic.terms.find((t) => t.termId === month.scenes.changingTerm.termId)!
    render(<Detail topic={topic} />)
    const row = document.querySelector(`.topic-term[data-term-id="${ruling.termId}"]`)
    const [y, m] = month.scenes.changingTerm.asOfAfter.split('-').map(Number)
    expect(row?.textContent).toContain(`${y}年${m}月時点`)
  })
})

describe('説明の箱の Esc（設計: 段階2の 1.12・2.）', () => {
  function InSheet({ topic, onClose }: { topic: ShownTopic; onClose: () => void }) {
    const [open, setOpen] = useState(true)
    return open ? (
      <Modal
        title="版の行"
        onClose={() => {
          onClose()
          setOpen(false)
        }}
      >
        <Detail topic={topic} />
      </Modal>
    ) : null
  }

  it('箱が開いている時の Esc は箱だけ閉じ（シートの onClose を呼ばない）、フォーカスは語へ。次の Esc でシートが閉じる', () => {
    const onClose = vi.fn()
    render(<InSheet topic={topicAt(FAKE_TOPIC_SCENES.jpRulingParty)} onClose={onClose} />)
    const mark = screen.getAllByTestId('term-mark')[0]
    fireEvent.click(mark)
    const known = within(screen.getByTestId('term-note')).getByTestId('term-known')
    known.focus()
    fireEvent.keyDown(known, { key: 'Escape' })
    expect(screen.queryByTestId('term-note')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(mark)
    fireEvent.keyDown(mark, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('変換中の Esc では箱を閉じない', () => {
    render(<InSheet topic={topicAt(FAKE_TOPIC_SCENES.jpRulingParty)} onClose={() => {}} />)
    const mark = screen.getAllByTestId('term-mark')[0]
    fireEvent.click(mark)
    fireEvent.keyDown(mark, { key: 'Escape', keyCode: 229 })
    expect(screen.getByTestId('term-note')).toBeTruthy()
  })
})

describe('［知ってる］（押した後。書くのは閉じた時。設計: 段階2の 1.13）', () => {
  it('押すと語を消さずに「知ってるにしました ［取り消す］」、取り消すと元に戻る（一覧と説明の箱で同じ）', () => {
    const topic = topicAt(FAKE_TOPIC_SCENES.jpRulingParty)
    render(<Detail topic={topic} />)
    const mark = screen.getAllByTestId('term-mark')[0]
    const termId = mark.getAttribute('data-term-id')!
    const row = document.querySelector(`.topic-term[data-term-id="${termId}"]`) as HTMLElement
    fireEvent.click(within(row).getByTestId('term-known'))
    expect(row.textContent).toContain(KNOWN_TEXTS.pressed)
    const undo = within(row).getByRole('button', { name: KNOWN_TEXTS.undo })
    expect(document.activeElement).toBe(undo)
    // 本文の印は閉じるまで残す。説明の箱も同じ状態
    fireEvent.click(mark)
    expect(screen.getByTestId('term-note').textContent).toContain(KNOWN_TEXTS.pressed)
    act(() => undo.click())
    expect(within(row).getByTestId('term-known')).toBeTruthy()
    expect(within(screen.getByTestId('term-note')).getByTestId('term-known')).toBeTruthy()
  })
})

describe('続報（設計: 段階2の 1.16）', () => {
  const month = makeFakeMonth({ until: '2026-11-15', untilSlot: '12', days: 3, seed: 'topic-detail' })
  const chain = month.scenes.chain.map((id) => {
    const ed = month.editions.find((e) => id.startsWith(e.edition.id))!
    return shownTopic(ed.topics.find((t) => t.id === id))
  })
  const thread: ThreadTopic[] = chain.map((t) => ({ id: t.id, editionId: t.editionId, headline: t.headline }))

  it('続報の話題: 頭の行に「続報」、「続報: 何が新しいか」と経緯（続報の所）・前の話題へのリンク', () => {
    const onOpenTopic = vi.fn()
    render(<Detail topic={chain[1]} thread={thread} onOpenTopic={onOpenTopic} />)
    const root = screen.getByTestId('topic-detail')
    expect(root.querySelector('.topic-head')?.textContent).toContain('続報')
    const follow = root.querySelector('.topic-follow-up') as HTMLElement
    expect(follow.textContent).toContain(`続報: ${chain[1].followUp!.whatsNew}`)
    expect(follow.querySelectorAll('.topic-timeline li')).toHaveLength(chain[1].timeline.length)
    // 続報の時は、経緯の区切りを下に別に出さない
    expect(screen.queryByText(DETAIL_HEADS.timeline)).toBeNull()
    const prev = within(follow).getByRole('button', { name: /^前の話題:/ })
    expect(prev.textContent).toBe(`前の話題: ${chain[0].headline}（11/13（金）12:00版）`)
    fireEvent.click(prev)
    expect(onOpenTopic).toHaveBeenCalledWith(chain[0].id)
    // もっと新しい続報が端末にあれば「この話題には続報があります」
    const newer = screen.getByRole('button', { name: /^この話題には続報があります:/ })
    expect(newer.textContent).toContain(chain[2].headline)
    fireEvent.click(newer)
    expect(onOpenTopic).toHaveBeenLastCalledWith(chain[2].id)
  })

  it('いちばん新しい話題には「続報があります」を出さない。つながりを読む前・前の話題が端末に無い時はリンクを出さない', () => {
    render(<Detail topic={chain[2]} thread={thread} />)
    expect(screen.queryByRole('button', { name: /^この話題には続報があります:/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^前の話題:/ }).textContent).toContain(chain[1].headline)
    cleanup()
    render(<Detail topic={chain[2]} thread={null} />)
    expect(screen.queryByRole('button', { name: /^前の話題:/ })).toBeNull()
    cleanup()
    render(<Detail topic={chain[2]} thread={[thread[2]]} />)
    expect(screen.queryByRole('button', { name: /^前の話題:/ })).toBeNull()
  })
})
