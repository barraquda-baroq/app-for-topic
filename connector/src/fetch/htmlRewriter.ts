// HTMLRewriter から HTML の並びを渡すだけの薄い部品（段階3の設計の 1.7 の (3)。点検2 feasible-F6）。行の区切り・日付・itemPath・
// dropBlocks・scopes の決まりは htmlTokens.ts（純粋な部品）にあり、ここは要素の始まり・終わり・文字を出てきた順に並べるだけ。
// HTMLRewriter は Workers にしか無い（Node の単体テストは test/support/fakeNews.ts の小さな読み取りで同じ並びを作る）。
// 文字の符号は取る側（article.ts）がバイト列から文字に直してから渡す（Shift_JIS の一覧・ページも同じ道で読めるように）。
// DOM は作らない（流しながら並びだけを作る。1つの応答は 1MB で止めてあるので、並びも 1MB の HTML の分まで）
import type { HtmlEvent } from './htmlTokens'

/** 終わりの無い要素（onEndTag を付けない） */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

// HTMLRewriter の使う所だけの型（Workers の型の無い所（エミュレーターのテストの型の確かめ）でも読めるように、globalThis から引く）
interface RewriterElement {
  tagName: string
  readonly attributes: Iterable<string[]>
  onEndTag(handler: (tag: { name: string }) => void): void
}
interface RewriterText {
  readonly text: string
}
interface Rewriter {
  on(selector: string, handlers: { element?(el: RewriterElement): void }): Rewriter
  onDocument(handlers: { text?(t: RewriterText): void }): Rewriter
  transform(res: Response): Response
}

/** HTML の文字から並びを作る（HTMLRewriter。Workers の中だけ） */
export async function rewriterEvents(html: string): Promise<HtmlEvent[]> {
  const Ctor = (globalThis as { HTMLRewriter?: new () => Rewriter }).HTMLRewriter
  if (!Ctor) throw new Error('HTMLRewriter is not available')
  const events: HtmlEvent[] = []
  const rewriter = new Ctor()
    .on('*', {
      element(el) {
        const attrs: Record<string, string> = {}
        for (const [k, v] of el.attributes) attrs[k] = v
        const name = el.tagName.toLowerCase()
        events.push({ t: 'open', name, attrs })
        if (VOID.has(name)) return
        try {
          el.onEndTag((end) => {
            events.push({ t: 'close', name: end.name.toLowerCase() })
          })
        } catch {
          // 終わりの無い要素（自分で閉じた要素）。閉じ忘れは htmlTokens.ts の normalizeEvents が補う
        }
      },
    })
    .onDocument({
      text(t) {
        if (t.text) events.push({ t: 'text', text: t.text })
      },
    })
  await rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })).arrayBuffer()
  return events
}
