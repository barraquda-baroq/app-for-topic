// 同意の画面（GET /authorize）。claude.ai で「接続」を押した直後にだけ出る（NS の connector/src/auth/consentPage.ts を写し、名前と
// 「できる事・できない事」の文を TS の物にした）。
// クライアントの名前・確かめた公開元・戻り先は、クライアントが決めた文字なので必ずエスケープする。
// できる事・できない事の文（CONSENT_CAN・CONSENT_CANNOT）は、アプリの連携の画面（src/features/claude/claudeUi.ts の CLAUDE_CAN・
// CLAUDE_CANNOT）と同じ文にする（設計の 3.1。テストで比べる）
import type { ConsentDescription } from '@cloudflare/workers-oauth-provider'
import { escapeHtml, page } from '../http'

/** Claude ができる事（足すだけ。読むのは版の記録の一部） */
export const CONSENT_CAN: readonly string[] = [
  '版・話題・辞書・作れなかった印・訂正を足す',
  '前の版の話題・辞書・「知ってる」語を読む',
]

/** Claude ができない事 */
export const CONSENT_CANNOT: readonly string[] = ['消す・直す', '既読など読み手の記録を読む', 'アプリの設定を変える']

export function consentPage(details: ConsentDescription, handle: string, appOrigin: string, headers: Headers): Response {
  const name = escapeHtml(details.clientName || 'Claude')
  const domain = details.clientDomain
    ? `公開元（確かめ済み）: <strong>${escapeHtml(details.clientDomain)}</strong>`
    : '<span class="warn">公開元を確かめられないクライアントです（自分で登録したもの）。</span>'
  const app = escapeHtml(new URL(appOrigin).host)
  const items = (list: readonly string[]) => list.map((t) => escapeHtml(t)).join('・')
  const body = `
<h1>Topic Studio コネクタ</h1>
<div class="card">
  <p><strong>${name}</strong>（claude.ai）が Topic Studio への接続を求めています。</p>
  <p class="muted">${domain}<br>許可した後の戻り先: <strong>${escapeHtml(details.redirectHost)}</strong></p>
  ${details.redirectIsLoopback ? '<p class="warn">この接続はこのパソコンのアプリ（Claude Code など）に渡されます。いま自分で接続を始めた時だけ続けてください。</p>' : ''}
</div>
<div class="card">
  <p>次の画面（Topic Studio: ${app}）で、書き込みを許可するかと接続の名前を選んで許可します。</p>
  <ul>
    <li data-testid="consent-can">Claude ができること: ${items(CONSENT_CAN)}</li>
    <li data-testid="consent-cannot">Claude ができないこと: ${items(CONSENT_CANNOT)}</li>
  </ul>
  <p class="muted">資料は、作者が許した出どころ（府省・庁の発表と Global Voices）だけを、コネクタが取りに行きます。</p>
  <p class="warn">この画面は claude.ai で「接続」を押した直後にだけ出ます。心当たりがなければ［やめる］を押してください。</p>
</div>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <div class="buttons">
    <button class="primary" type="submit" name="decision" value="approve" data-testid="consent-approve">Topic Studio で確認する</button>
    <button type="submit" name="decision" value="deny" data-testid="consent-deny">やめる</button>
  </div>
</form>`
  // ［Topic Studio で確認する］はアプリへ、［やめる］は claude.ai へ転送される
  return page('Topic Studio への接続', body, {}, headers, [new URL(appOrigin).origin, 'https://claude.ai', 'https://claude.com'])
}
