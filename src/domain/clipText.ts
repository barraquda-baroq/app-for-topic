// ［クリップ］の文（D10・docs/SPEC.md の 7.6・9.。作者の答え A: 訂正のある話題は要約の後に「訂正: …」を足した順に添え、だから何？は
// 入れない。2026-11-15）。詳細を開いた時に読んだ話題と訂正の表示用の写し（repair の後）だけから作る（押した処理の中で待たずに
// navigator.clipboard.writeText を呼ぶため。iPhone の Safari は、待った後の書き込みを断る。7.6）。形（開発。設計: 段階2の 1.14）:
//
//   {見出し}
//   {2026年11月15日（日）}{12:00版}・{国内}・{経済}
//
//   {要約}
//
//   訂正: {1件目}
//   訂正: {2件目}
//
//   元記事:
//   {社}「{題}」（{読んだ所}で読んだ）
//   {URL}
//
// - 訂正が無い時は訂正の段を書かない。地域・ジャンルが知らない値の時はその語を書かない。読んだ所の無い出典は括弧を書かない
// - URL は記録のまま（https: の物だけ。社の一覧に無いホストで、リンクにしない URL も入れる）。出典の日時は入れない（9. の案のとおり）
// - 強調・用語の印は付けない（ふつうの文）。だから何？・当事者・見解などは入れない。行の終わりは \n（最後の行の後には付けない）
// 何も記録しない（印・回数・時刻を残さない。7.6）。ここは文を作るだけ
import { editionLongDateText, editionSlotText, FIXED_TEXTS, genreLabel, regionLabel } from './fixedTexts'
import { parseEditionId } from './ids'

/** https: の URL か（読めない URL・ほかの方式の URL は入れない。リンクにするかの決まり sourceLinkUrl とは別で、社のホストは見ない） */
function isHttpsUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/** クリップに使う話題の欄（ShownTopic の一部） */
export interface ClipTopic {
  editionId: string
  region: string
  genre: string
  headline: string
  summary: string
  sources: readonly { outlet: string; title: string; url: string; via: string | null }[]
}

/** 「元記事:」の段の頭 */
export const CLIP_SOURCES_HEAD = '元記事:'

/** 版の行（「2026年11月15日（日）12:00版・国内・経済」。分からない所は書かない） */
export function clipEditionLine(topic: Pick<ClipTopic, 'editionId' | 'region' | 'genre'>): string {
  const p = parseEditionId(topic.editionId)
  const date = p ? editionLongDateText(p.date) : null
  const slot = p ? editionSlotText(p.slot) : null
  const head = date !== null && slot !== null ? `${date}${slot}` : null
  return [head, regionLabel(topic.region), genreLabel(topic.genre)].filter((s): s is string => s !== null).join('・')
}

/**
 * クリップの文。corrections はその話題の訂正の表示用の写し（足した順。src/domain/editionShow.ts の correctionsByTopic の順）。
 * 渡した順のまま並べる
 */
export function clipText(topic: ClipTopic, corrections: readonly { text: string }[] = []): string {
  const blocks: string[][] = []
  const head = [topic.headline]
  const edition = clipEditionLine(topic)
  if (edition) head.push(edition)
  blocks.push(head)
  if (topic.summary) blocks.push([topic.summary])
  const fixes = corrections.map((c) => c.text).filter((t) => typeof t === 'string' && t !== '')
  if (fixes.length) blocks.push(fixes.map((t) => `${FIXED_TEXTS.correctionPrefix} ${t}`))
  const sources = topic.sources.flatMap((s) => {
    const line = `${s.outlet}「${s.title}」${s.via ? `（${s.via}で読んだ）` : ''}`
    return isHttpsUrl(s.url) ? [line, s.url] : [line]
  })
  if (sources.length) blocks.push([CLIP_SOURCES_HEAD, ...sources])
  return blocks.map((b) => b.join('\n')).join('\n\n')
}
