// 似た題の印（段階3の設計の 1.7 の (8)「束ねない・印だけ付ける」。点検2 feasible-F16。純粋な部品）: 府省ごとに題の言い方が違うので、
// 題の中の「」の中の名前（4字以上）か「〇〇法」「〇〇法案」の語が同じ候補どうしに [似た題 c0031] の印だけを付ける。中身は作らない
// （束ねるかは選ぶ係が決める）

/** 題の中の印の元の語（「」の中の4字以上の名前と、〇〇法・〇〇法案の語。NFKC でそろえる） */
export function similarKeys(title: string): string[] {
  const t = title.normalize('NFKC')
  const out = new Set<string>()
  for (const m of t.matchAll(/[「『]([^」』]{4,60})[」』]/g)) out.add(m[1].replace(/\s+/g, ''))
  for (const m of t.matchAll(/([\p{Script=Han}\p{Script=Katakana}ー・]{2,30}?法(?:案)?)(?![\p{Script=Han}])/gu)) {
    const w = m[1].replace(/^[・]+/, '')
    if (Array.from(w).length >= 3) out.add(w)
  }
  return [...out]
}

/** 似た題の印（候補の id → ほかの候補の id の並び。印の無い候補は入らない） */
export function similarTags(items: readonly { cid: string; title: string }[], max = 3): Map<string, string[]> {
  const byKey = new Map<string, string[]>()
  for (const it of items)
    for (const k of similarKeys(it.title)) {
      const list = byKey.get(k) ?? []
      if (!list.includes(it.cid)) list.push(it.cid)
      byKey.set(k, list)
    }
  const out = new Map<string, string[]>()
  for (const list of byKey.values()) {
    if (list.length < 2) continue
    for (const cid of list) {
      const others = out.get(cid) ?? []
      for (const o of list) if (o !== cid && !others.includes(o)) others.push(o)
      out.set(cid, others)
    }
  }
  for (const [k, v] of out) out.set(k, v.sort().slice(0, max))
  return out
}

/** 候補の行の印の文字（[似た題 c0031・c0040]） */
export const similarTagText = (others: readonly string[]): string => `似た題 ${others.join('・')}`
