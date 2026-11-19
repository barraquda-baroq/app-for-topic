// 設定の「Claude との連携」（段階3の設計の 3.1。NS の src/features/claude/ClaudeSettings.tsx を写して直した物）: Claude 用のコネクタ
// （リモート MCP）の URL（…/mcp）のコピー、連携の状態（config/connector）と接続の一覧（claude.ai で接続するごとに1つ。2まで。名前・
// 許可した日時・許可した端末・［名前を変える］・［この接続を解除］）、すべての接続に効く「書き込みを許可」・［連携をすべて解除］、
// 手順書（docs/CONNECTOR.md）へのリンク、Claude ができること・できないこと、claude.ai のツールの許可の案内（全部「常に許可」にする訳）。
// NS から外した物: タイトルごとの「Claude に見せる」・手動の連携（コピーと貼り付け）・iPhone / Android のアプリの分岐（TS には無い）。
// コネクタの場所がビルドに無い時（作者がまだ用意していない・別のパソコンでビルドした）は「コネクタはまだ用意されていません」。
// 連携の記録は、ログインしていて、同期のエンジンが動き始めた後（状態がある = Firebase を読み込んだ後）だけ見張る。開発サーバーで
// テストの印でログインした時（src/features/login/testAuth.ts。Firebase を使わない E2E）は、クラウドに問い合わせない（Firebase を使わずに
// ログインした状態では同期のエンジンが動かないので、印が無くても問い合わせない）
import { useEffect, useId, useState } from 'react'
import { MAX_CONNECTIONS, type ConnectionInfo } from '../../claude/pairing'
import { notify, notifyError } from '../../store/uiStore'
import { useSync } from '../../sync/controller'
import { CopyIcon, ExternalLinkIcon } from '../../ui/icons'
import { testAuthRequested } from '../login/testAuth'
import { CLAUDE_CAN, CLAUDE_CANNOT, CLAUDE_TOOLS, TOOL_ALLOW_NOTES, TOOL_ALLOW_TITLE } from './claudeUi'
import { CONNECTOR_ORIGIN, connectorMcpUrl } from './connectLogic'
import type { ConnectorState } from './connectorDoc'
import {
  connectionCountLabel,
  ConnectionList,
  removeAllConnections,
  removeOneConnection,
  renameOneConnection,
} from './ConnectionList'
import './claude.css'

/** セットアップの手順（リポジトリの docs/CONNECTOR.md） */
export const CONNECTOR_GUIDE_URL = 'https://github.com/barraquda-baroq/app-for-topic/blob/HEAD/docs/CONNECTOR.md'

/** コネクタの場所がビルドに無い時の文 */
export const CONNECTOR_UNSET_TEXT = 'コネクタはまだ用意されていません（docs/CONNECTOR.md）'

/** 区切りの頭の説明（JSX の折り返しで日本語の間に空白が入らないように、1つの文にしておく） */
export const CLAUDE_LEAD =
  'claude.ai に Topic Studio のコネクタ（リモート MCP）を足すと、Claude の定期実行が、許した出どころの資料を読んで版を作り、ここへ届けます。連携の許可は、claude.ai でコネクタを接続した時に開く画面で行います。'

/** テストの印でログインした開発サーバー（Firebase を使わない E2E）。公開するビルドでは false に決まり、この分岐はビルドで消える */
const testAuth = () => import.meta.env.DEV && testAuthRequested()

/** コネクタの URL をコピーする（クリップボードを使えない時は、選んでコピーしてもらう） */
async function copyUrl(url: string): Promise<void> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  try {
    if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('no clipboard')
    await clipboard.writeText(url)
    notify('コネクタの URL をコピーしました')
  } catch {
    notifyError('コピーできませんでした。URL を選んでコピーしてください')
  }
}

export function ClaudeSettings() {
  const id = useId()
  const s = useSync()
  const signedIn = s.auth === 'signedIn' && s.user !== null && !s.accountMismatch
  const [noCloud] = useState(testAuth)
  // 同期のエンジンが動き始めた（同期を受け持たない画面は、受け持つ画面から状態が届いた）
  const engineReady = s.status !== null
  const [conn, setConn] = useState<ConnectorState>({ state: 'loading' })
  const [busy, setBusy] = useState(false)
  const url = CONNECTOR_ORIGIN ? connectorMcpUrl(CONNECTOR_ORIGIN) : ''

  // ログインしていて、同期のエンジンが動き始めた後だけ連携の記録を見張る
  useEffect(() => {
    if (!signedIn || noCloud || !engineReady) return
    let unsub: (() => void) | null = null
    let stopped = false
    setConn({ state: 'loading' })
    void import('./connectorDoc')
      .then((m) => {
        if (!stopped) unsub = m.watchConnector(setConn)
      })
      .catch(() => setConn({ state: 'error', message: '連携の状態を読めませんでした。' }))
    return () => {
      stopped = true
      unsub?.()
    }
  }, [signedIn, noCloud, engineReady])

  const setWrites = async (writes: boolean) => {
    setBusy(true)
    try {
      const m = await import('./connectorDoc')
      await m.setConnectorWrites(writes)
      notify(writes ? 'Claude の書き込みを許可しました' : 'Claude の書き込みを止めました（読むことはできます）')
    } catch {
      notifyError('変えられませんでした。インターネットの接続を確かめてください。')
    } finally {
      setBusy(false)
    }
  }

  /** 確かめのダイアログと書き込みの間はボタンを止める（知らせは ConnectionList.tsx の各操作が出す） */
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  const connections: readonly ConnectionInfo[] = conn.state === 'paired' ? conn.status.connections : []
  const unpairAll = () => run(() => removeAllConnections(connections.length))
  const removeOne = (c: ConnectionInfo) => run(() => removeOneConnection(c, connections))
  const rename = (c: ConnectionInfo) => run(() => renameOneConnection(c, connections))

  return (
    <section id="claude" className="card aset-card" aria-labelledby={`${id}-title`} data-testid="claude-settings">
      <div className="aset-card-head">
        <h2 id={`${id}-title`}>Claude との連携</h2>
        <p className="aset-card-lead">{CLAUDE_LEAD}</p>
      </div>

      <div className="aset-row">
        <div className="aset-row-label">
          <span>コネクタの URL（claude.ai に登録する）</span>
          {url ? (
            <code className="cl-url" data-testid="claude-connector-url">
              {url}
            </code>
          ) : (
            <span className="aset-row-desc" data-testid="claude-connector-unset">
              {CONNECTOR_UNSET_TEXT}
            </span>
          )}
        </div>
        <div className="aset-row-control">
          {url ? (
            <button type="button" className="btn" onClick={() => void copyUrl(url)} data-testid="claude-copy-url">
              <CopyIcon />
              コピー
            </button>
          ) : null}
          <a
            className="btn btn-ghost"
            href={CONNECTOR_GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="claude-guide"
          >
            <ExternalLinkIcon />
            手順を見る
          </a>
        </div>
      </div>

      <div className="aset-row" data-testid="claude-pairing">
        <div className="aset-row-label">
          <span>連携の状態</span>
          {!signedIn ? (
            <span className="aset-row-desc" data-testid="claude-pairing-signin">
              ログインすると、連携の状態を確かめて解除できます。
            </span>
          ) : import.meta.env.DEV && noCloud ? (
            // テストの印の時だけ（公開するビルドでは import.meta.env.DEV が false なので、この文はビルドに入らない）
            <span className="aset-row-desc" data-testid="claude-pairing-test">
              テスト用のログインでは、連携の状態を読みません。
            </span>
          ) : conn.state === 'loading' ? (
            <span className="aset-row-desc" data-testid="claude-pairing-loading">
              確かめています…
            </span>
          ) : conn.state === 'error' ? (
            <span className="aset-row-desc cl-error-text" data-testid="claude-pairing-error">
              {conn.message}
            </span>
          ) : conn.state === 'none' ? (
            <span className="aset-row-desc" data-testid="claude-pairing-none">
              連携していません。claude.ai でコネクタを接続すると、許可の画面が開きます。
            </span>
          ) : (
            <div className="cl-pairing" data-testid="claude-pairing-info">
              <p className="cl-conn-count" data-testid="claude-connection-count">
                {connectionCountLabel(connections.length)}
                <span className="cl-conn-count-note">
                  （同時に{MAX_CONNECTIONS}まで。同じアカウントで接続し直すと1つ増えます）
                </span>
              </p>
              <ConnectionList
                connections={connections}
                testIdPrefix="claude"
                busy={busy}
                onRename={(c) => void rename(c)}
                onRemove={(c) => void removeOne(c)}
              />
              <div className="cl-writes-row">
                <span className="cl-writes-label">
                  書き込み: <span data-testid="claude-writes-state">{conn.status.writes ? '許可' : '停止中（読むだけ）'}</span>
                </span>
                <span className="cl-writes-control">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={conn.status.writes}
                      disabled={busy}
                      onChange={(e) => void setWrites(e.target.checked)}
                      data-testid="claude-writes-toggle"
                    />
                    <span className="track" aria-hidden="true" />
                    <span>書き込みを許可</span>
                  </label>
                  <span className="cl-writes-note">（すべての接続に効きます）</span>
                </span>
              </div>
              <div className="cl-unpair-row">
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void unpairAll()}
                  disabled={busy}
                  data-testid="claude-unpair"
                >
                  連携をすべて解除
                </button>
              </div>
              <p className="aset-row-desc cl-conn-hint" data-testid="claude-connection-hint">
                どの名前が claude.ai のどのアカウントかは、アプリからは分かりません。そのアカウントの Claude に「Topic Studio
                の状態（topic_status）を見て」と頼むと、最後の行に「この接続: 接続2」と出ます。
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="cl-cando">
        <div>
          <h3 className="cl-subhead">Claude ができること</h3>
          <ul className="cl-cando-list" data-testid="claude-can">
            {CLAUDE_CAN.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="cl-subhead">できないこと</h3>
          <ul className="cl-cando-list is-cannot" data-testid="claude-cannot">
            {CLAUDE_CANNOT.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      </div>

      <ToolAllowNote testId="claude-tools" />
    </section>
  )
}

/** claude.ai のツールの許可の案内（全部「常に許可」にする訳とツールの名前。設定と連携の画面で同じ物） */
export function ToolAllowNote({ testId }: { testId: string }) {
  return (
    <div className="cl-tools" data-testid={testId}>
      <h3 className="cl-subhead">{TOOL_ALLOW_TITLE}</h3>
      <ul className="cl-cando-list">
        {TOOL_ALLOW_NOTES.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <details className="cl-tool-names">
        <summary>ツールの名前（{CLAUDE_TOOLS.length}）</summary>
        <ul className="cl-tool-list" data-testid={`${testId}-names`}>
          {CLAUDE_TOOLS.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>（{t.title}）
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}
