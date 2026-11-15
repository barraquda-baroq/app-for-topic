// 版を出す条件（src/domain/editionShow.ts。docs/SPEC.md の 7.8 の「版を出す条件」）
import { describe, expect, it } from 'vitest'
import { correctionsByTopic, editionShowState, newestEditionId } from './editionShow'
import { editionIdOf } from './ids'
import { addDaysToDate, jstStartOfDayMs } from './jst'

const TODAY = '2026-11-15'
const id = editionIdOf(TODAY, '12')
const order = [`${id}-aaaaaaaa`, `${id}-bbbbbbbb`, `${id}-cccccccc`]
const topic = (tid: string) => ({ id: tid })
const NOW = jstStartOfDayMs(TODAY) + 13 * 60 * 60 * 1000

describe('版を出すか', () => {
  it('order の話題が端末に全部ある時だけ出す（order の順）。欠けていれば出さない', () => {
    expect(editionShowState({ id, order }, order.map(topic), NOW)).toEqual({
      kind: 'ready',
      topics: order.map(topic),
      missing: [],
    })
    expect(editionShowState({ id, order }, [topic(order[0]), null, undefined], NOW)).toEqual({
      kind: 'waiting',
      missing: [order[1], order[2]],
    })
  })

  it('クラウドにも無いと分かった話題だけが欠けている時は、そろっている話題だけで出す', () => {
    const gone = new Set([order[1]])
    expect(editionShowState({ id, order }, [topic(order[0]), null, topic(order[2])], NOW, gone)).toEqual({
      kind: 'ready',
      topics: [topic(order[0]), topic(order[2])],
      missing: [order[1]],
    })
    // ほかにも欠けた話題があれば、まだ出さない
    expect(editionShowState({ id, order }, [topic(order[0]), null, null], NOW, gone).kind).toBe('waiting')
    // 全部が無い版は出さない
    expect(editionShowState({ id, order }, [null, null, null], NOW, new Set(order)).kind).toBe('broken')
  })

  it('30日の外の版は出さない（端末の時計・日本時間の D＋30日の 0時から）', () => {
    const old = editionIdOf(addDaysToDate(TODAY, -29), '20')
    const o = [`${old}-aaaaaaaa`]
    const midnight = jstStartOfDayMs(addDaysToDate(old.slice(0, 10), 30))
    expect(editionShowState({ id: old, order: o }, o.map(topic), midnight - 1).kind).toBe('ready')
    expect(editionShowState({ id: old, order: o }, o.map(topic), midnight).kind).toBe('expired')
  })

  it('版の id の形が違う・order が空の版は出さない', () => {
    expect(editionShowState({ id: '2026-11-15-13', order }, order.map(topic), NOW).kind).toBe('broken')
    expect(editionShowState({ id, order: [] }, [], NOW).kind).toBe('broken')
  })

  it('いちばん新しい版は id の並びで最後', () => {
    expect(newestEditionId(['2026-11-15-20', '2026-11-16-12', '2026-11-15-12'])).toBe('2026-11-16-12')
    expect(newestEditionId(['2026-11-15-20', 'x'])).toBe('2026-11-15-20')
    expect(newestEditionId([])).toBeNull()
  })
})

describe('訂正を話題に付ける', () => {
  it('端末にある話題の分だけ、足された順にまとめる。話題の無い訂正は出さない', () => {
    const c = (cid: string, topicId: string, createdAt: number) => ({ id: cid, topicId, createdAt })
    const list = [
      c(`${order[0]}-22222222`, order[0], 20),
      c(`${order[0]}-11111111`, order[0], 10),
      c(`${order[0]}-00000000`, order[0], 20),
      c(`${id}-zzzzzzzz-33333333`, `${id}-zzzzzzzz`, 5),
    ]
    const by = correctionsByTopic(list, [order[0], order[1]])
    expect(by.get(order[0])?.map((x) => x.id)).toEqual([`${order[0]}-11111111`, `${order[0]}-00000000`, `${order[0]}-22222222`])
    expect(by.get(order[1])).toEqual([])
    expect(by.has(`${id}-zzzzzzzz`)).toBe(false)
  })
})
