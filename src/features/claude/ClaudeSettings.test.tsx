// 設定の「Claude との連携」（src/features/claude/ClaudeSettings.tsx。NS の src/features/claude/ClaudeSettings.test.tsx を写して直した物）:
// コネクタの URL（…/mcp）のコピーと「まだ用意されていません」・手順書へのリンク・連携の状態（ログインしていない時は読まない・テストの印
// では読まない）・接続の一覧（名前・許可した日時・許可した端末・名前を変える（同じ名前は断る）・1つ解除・最後の1つ）・書き込みの許可の
// 切り替え・すべて解除・できる事とできない事・ツールの許可の案内。連携の記録を読み書きする所（connectorDoc.ts）は差し替える
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { ConnectionInfo } from '../../claude/pairing'
import { useToasts } from '../../store/uiStore'
import { AppFrame } from '../../ui/Layout'
import { CLAUDE_CAN, CLAUDE_CANNOT, CLAUDE_TOOLS, TOOL_ALLOW_NOTES } from './claudeUi'
import type { ConnectorStatus } from './connectLogic'
import type { ConnectorState } from './connectorDoc'

interface FakeSync {
  auth: 'idle' | 'checking' | 'signedOut' | 'signedIn'
  user: { uid: string; name: string; email: string } | null
  accountMismatch: null
  /** 同期のエンジンの状態（null = 動いていない） */
  status: { phase: string } | null
}

const sync = vi.hoisted(() => ({ store: null as unknown as UseBoundStore<StoreApi<FakeSync>> }))
const conn = vi.hoisted(() => ({
  emit: null as null | ((s: ConnectorState) => void),
  watchConnector: vi.fn(),
  setConnectorWrites: vi.fn(async (_writes: boolean) => undefined),
  deleteConnector: vi.fn(async () => undefined),
  removeConnection: vi.fn(async (_cid: string): Promise<'removed' | 'deleted' | 'none'> => 'removed'),
  renameConnection: vi.fn(async (_cid: string, _name: string) => undefined),
}))
const origin = vi.hoisted(() => ({ value: 'https://topic-studio-connector.example.workers.dev' }))

vi.mock('../../sync/controller', async () => {
  const { create: make } = await import('zustand')
  sync.store = make<FakeSync>(() => ({ auth: 'signedOut', user: null, accountMismatch: null, status: { phase: 'synced' } }))
  return { useSync: sync.store }
})
vi.mock('./connectorDoc', () => ({
  watchConnector: conn.watchConnector,
  setConnectorWrites: conn.setConnectorWrites,
  deleteConnector: conn.deleteConnector,
  removeConnection: conn.removeConnection,
  renameConnection: conn.renameConnection,
}))
vi.mock('./connectLogic', async (importOriginal) => {
  const original = await importOriginal<typeof import('./connectLogic')>()
  return {
    ...original,
    get CONNECTOR_ORIGIN() {
      return origin.value
    },
  }
})

const { ClaudeSettings, CLAUDE_LEAD, CONNECTOR_GUIDE_URL } = await import('./ClaudeSettings')

function renderSettings() {
  return render(
    <MemoryRouter>
      <AppFrame>
        <ClaudeSettings />
      </AppFrame>
    </MemoryRouter>,
  )
}

const writeText = vi.fn(async (_text: string) => undefined)

beforeEach(() => {
  origin.value = 'https://topic-studio-connector.example.workers.dev'
  conn.watchConnector.mockReset()
  conn.watchConnector.mockImplementation((fn: (s: ConnectorState) => void) => {
    conn.emit = fn
    return () => {
      conn.emit = null
    }
  })
  conn.setConnectorWrites.mockClear()
  conn.deleteConnector.mockClear()
  conn.removeConnection.mockClear()
  conn.renameConnection.mockClear()
  sync.store.setState({ auth: 'signedOut', user: null, status: { phase: 'synced' } })
  localStorage.clear()
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  // 前のテストの知らせを残さない
  useToasts.setState({ toasts: [] })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const signIn = () => sync.store.setState({ auth: 'signedIn', user: { uid: 'owner', name: '', email: 'o@example.com' } })
/** 2026-11-{d} 14:32（日本時間） */
const at = (d: number) => Date.parse(`2026-11-${String(d).padStart(2, '0')}T14:32:00+09:00`)
const entry = (cid: string, name: string, d: number, approvedOn = 'Mac'): ConnectionInfo => ({
  cid,
  name,
  pairing: `p-${cid}`,
  pairedAt: at(d),
  approvedOn,
})
const paired = (connections: ConnectionInfo[], writes = true): ConnectorStatus => ({
  uid: 'anon',
  pairedAt: connections.at(-1)?.pairedAt ?? null,
  approvedOn: 'Mac',
  writes,
  connections,
  pairingCid: connections.at(-1)?.cid ?? null,
})
async function showList(connections: ConnectionInfo[], writes = true) {
  signIn()
  renderSettings()
  await waitFor(() => expect(conn.watchConnector).toHaveBeenCalledTimes(1))
  act(() => conn.emit?.({ state: 'paired', status: paired(connections, writes) }))
  return screen.getAllByTestId('claude-connection')
}

describe('設定の「Claude との連携」', () => {
  it('コネクタの URL（…/mcp）をコピーできる。ビルドに無ければ「まだ用意されていません」。手順書へのリンクはいつも出す', async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const first = renderSettings()
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Claude との連携')
    // 頭の説明は1つの文のまま出す（JSX の折り返しで、日本語の句読点の後に空白が入らない）
    const lead = screen.getByTestId('claude-settings').querySelector('.aset-card-lead')
    expect(lead?.textContent).toBe(CLAUDE_LEAD)
    expect(CLAUDE_LEAD).not.toMatch(/[、。）] /)
    expect(CLAUDE_LEAD).toContain('許した出どころの資料を読んで版を作り、ここへ届けます。')
    expect(screen.getByTestId('claude-connector-url').textContent).toBe('https://topic-studio-connector.example.workers.dev/mcp')
    await user.click(screen.getByTestId('claude-copy-url'))
    expect(writeText).toHaveBeenCalledWith('https://topic-studio-connector.example.workers.dev/mcp')
    expect(await screen.findByText('コネクタの URL をコピーしました')).toBeTruthy()
    const guide = screen.getByTestId('claude-guide')
    expect(guide.getAttribute('href')).toBe(CONNECTOR_GUIDE_URL)
    expect(CONNECTOR_GUIDE_URL).toMatch(/\/docs\/CONNECTOR\.md$/)
    expect(guide.getAttribute('target')).toBe('_blank')
    expect(guide.getAttribute('rel')).toBe('noopener noreferrer')
    // ログインしていなければ、連携の状態は読まない
    expect(screen.getByTestId('claude-pairing-signin')).toBeTruthy()
    expect(conn.watchConnector).not.toHaveBeenCalled()
    first.unmount()

    origin.value = ''
    renderSettings()
    expect(screen.getByTestId('claude-connector-unset').textContent).toBe('コネクタはまだ用意されていません（docs/CONNECTOR.md）')
    expect(screen.queryByTestId('claude-copy-url')).toBeNull()
    expect(screen.getByTestId('claude-guide')).toBeTruthy()
  })

  it('クリップボードを使えない時は、選んでコピーするよう知らせる', async () => {
    const user = userEvent.setup()
    renderSettings()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    })
    await user.click(screen.getByTestId('claude-copy-url'))
    expect(await screen.findByText('コピーできませんでした。URL を選んでコピーしてください')).toBeTruthy()
  })

  it('できる事・できない事（同意の画面と同じ文）と、ツールの許可の案内（全部「常に許可」にする訳・ツールの名前）', () => {
    renderSettings()
    expect([...screen.getByTestId('claude-can').querySelectorAll('li')].map((li) => li.textContent)).toEqual([...CLAUDE_CAN])
    expect([...screen.getByTestId('claude-cannot').querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      ...CLAUDE_CANNOT,
    ])
    const tools = screen.getByTestId('claude-tools')
    expect(tools.textContent).toContain('claude.ai のツールの許可は、全部「常に許可」にします')
    for (const note of TOOL_ALLOW_NOTES) expect(tools.textContent).toContain(note)
    const names = [...within(tools).getByTestId('claude-tools-names').querySelectorAll('li')].map((li) => li.textContent)
    expect(names).toEqual(CLAUDE_TOOLS.map((t) => `${t.name}（${t.title}）`))
  })

  it('テストの印でログインした開発サーバー（Firebase を使わない E2E）では、連携の状態を読まない', () => {
    localStorage.setItem('topic-studio:test-auth', '1')
    signIn()
    renderSettings()
    expect(screen.getByTestId('claude-pairing-test').textContent).toBe('テスト用のログインでは、連携の状態を読みません。')
    expect(conn.watchConnector).not.toHaveBeenCalled()
  })

  it('同期のエンジンが動き始めるまで（Firebase を使わずにログインした状態など）は、連携の状態を読まない', async () => {
    signIn()
    sync.store.setState({ status: null })
    renderSettings()
    expect(screen.getByTestId('claude-pairing-loading')).toBeTruthy()
    expect(conn.watchConnector).not.toHaveBeenCalled()
    act(() => sync.store.setState({ status: { phase: 'downloading' } }))
    await waitFor(() => expect(conn.watchConnector).toHaveBeenCalledTimes(1))
  })

  it('連携の状態を出し、書き込みの許可を切り替え、確かめてからすべて解除する', async () => {
    const user = userEvent.setup()
    signIn()
    renderSettings()
    expect(screen.getByTestId('claude-pairing-loading')).toBeTruthy()
    await waitFor(() => expect(conn.watchConnector).toHaveBeenCalledTimes(1))
    act(() => conn.emit?.({ state: 'none' }))
    expect(screen.getByTestId('claude-pairing-none')).toBeTruthy()
    act(() => conn.emit?.({ state: 'error', message: '連携の状態を読めませんでした。' }))
    expect(screen.getByTestId('claude-pairing-error').textContent).toBe('連携の状態を読めませんでした。')

    act(() => conn.emit?.({ state: 'paired', status: paired([entry('c1', '接続1', 19)]) }))
    const info = screen.getByTestId('claude-pairing-info')
    expect(within(info).getByTestId('claude-writes-state').textContent).toBe('許可')
    expect(within(info).getByTestId('claude-connection-count').textContent).toBe(
      '接続 1 / 2（同時に2まで。同じアカウントで接続し直すと1つ増えます）',
    )
    const rows = within(info).getAllByTestId('claude-connection')
    expect(rows.map((r) => within(r).getByTestId('claude-connection-name').textContent)).toEqual(['接続1'])
    expect(rows[0].textContent).toContain('許可した日時 2026年11月19日 14:32')
    expect(rows[0].textContent).toContain('許可した端末 Mac')
    expect(info.textContent).toContain('書き込みを許可（すべての接続に効きます）')
    // topic_status の最後の行（connector/src/vault/core.ts の「この接続: …」）で見分ける
    expect(within(info).getByTestId('claude-connection-hint').textContent).toBe(
      'どの名前が claude.ai のどのアカウントかは、アプリからは分かりません。そのアカウントの Claude に「Topic Studio の状態（topic_status）を見て」と頼むと、最後の行に「この接続: 接続2」と出ます。',
    )

    await user.click(screen.getByTestId('claude-writes-toggle'))
    expect(conn.setConnectorWrites).toHaveBeenCalledWith(false)
    expect(await screen.findByText('Claude の書き込みを止めました（読むことはできます）')).toBeTruthy()
    // 見張っている記録が変わるまで、表示は変わらない（サーバーが受け取ってから出す）
    act(() => conn.emit?.({ state: 'paired', status: paired([entry('c1', '接続1', 19)], false) }))
    expect(screen.getByTestId('claude-writes-state').textContent).toBe('停止中（読むだけ）')

    expect(screen.getByTestId('claude-unpair').textContent).toBe('連携をすべて解除')
    await user.click(screen.getByTestId('claude-unpair'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('Claude との連携をすべて解除しますか？')
    expect(dialog.textContent).toContain('すべての接続（1件）が、その場で何も読めず、書き込めなくなります。')
    expect(conn.deleteConnector).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: '連携をすべて解除' }))
    await waitFor(() => expect(conn.deleteConnector).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Claude との連携をすべて解除しました')).toBeTruthy()
  })

  it('書き込みの許可を変えられなければ知らせる', async () => {
    const user = userEvent.setup()
    await showList([entry('c1', '接続1', 19)])
    conn.setConnectorWrites.mockRejectedValueOnce(new Error('offline'))
    await user.click(screen.getByTestId('claude-writes-toggle'))
    expect(await screen.findByText('変えられませんでした。インターネットの接続を確かめてください。')).toBeTruthy()
  })

  it('接続の一覧: 名前・許可した日時・許可した端末。名前を変える（同じ名前・空は断る）', async () => {
    const user = userEvent.setup()
    const rows = await showList([entry('c1', '接続1', 10), entry('cabc', '接続2', 11, 'iPhone')])
    expect(screen.getByTestId('claude-connection-count').textContent).toContain('接続 2 / 2')
    expect(rows.map((r) => r.getAttribute('data-cid'))).toEqual(['c1', 'cabc'])
    expect(rows[1].textContent).toContain('許可した日時 2026年11月11日 14:32 ・ 許可した端末 iPhone')

    // 同じ名前（字の幅の違いは同じ）は断る
    await user.click(within(rows[1]).getByTestId('claude-connection-rename'))
    let dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('接続の名前を変える')
    expect(dialog.textContent).toContain('名前（20字まで。どの claude.ai のアカウントか分かる名前に）')
    let input = within(dialog).getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('接続2')
    await user.clear(input)
    await user.type(input, '接続１')
    await user.click(within(dialog).getByRole('button', { name: '変更' }))
    expect(await screen.findByText('名前を変えませんでした（同じ名前の接続があります）')).toBeTruthy()
    expect(conn.renameConnection).not.toHaveBeenCalled()

    // 21字は断る
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(within(screen.getAllByTestId('claude-connection')[1]).getByTestId('claude-connection-rename'))
    dialog = await screen.findByRole('dialog')
    input = within(dialog).getByRole('textbox') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'あ'.repeat(21))
    await user.click(within(dialog).getByRole('button', { name: '変更' }))
    expect(await screen.findByText('名前を変えませんでした（接続の名前は1〜20字にしてください）')).toBeTruthy()
    expect(conn.renameConnection).not.toHaveBeenCalled()

    // 前後の空白を除いて変える
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(within(screen.getAllByTestId('claude-connection')[1]).getByTestId('claude-connection-rename'))
    dialog = await screen.findByRole('dialog')
    input = within(dialog).getByRole('textbox') as HTMLInputElement
    await user.clear(input)
    await user.type(input, ' 仕事用 ')
    await user.click(within(dialog).getByRole('button', { name: '変更' }))
    await waitFor(() => expect(conn.renameConnection).toHaveBeenCalledWith('cabc', '仕事用'))
    expect(await screen.findByText('接続の名前を「仕事用」にしました')).toBeTruthy()
  })

  it('1つ解除する: 確かめてから、その接続だけを一覧から外す。最後の1つは「連携をすべて解除」と同じ確かめ（外すのはトランザクション）', async () => {
    const user = userEvent.setup()
    const rows = await showList([entry('c1', '接続1', 10), entry('cabc', '接続2', 11)])
    await user.click(within(rows[1]).getByTestId('claude-connection-remove'))
    let dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('「接続2」の接続を解除しますか？')
    expect(dialog.textContent).toContain(
      'この接続の Claude は、次に使った時から（遅くとも1分ほどで）読めず、書き込めなくなります。ほかの接続はそのまま使えます。',
    )
    await user.click(within(dialog).getByRole('button', { name: 'この接続を解除' }))
    await waitFor(() => expect(conn.removeConnection).toHaveBeenCalledWith('cabc'))
    expect(conn.deleteConnector).not.toHaveBeenCalled()
    expect(await screen.findByText('「接続2」の接続を解除しました')).toBeTruthy()

    // 最後の1つ: トランザクションがサーバーの一覧でも最後の1つと確かめてから記録を消す（すべて解除を直に呼ばない）
    act(() => conn.emit?.({ state: 'paired', status: paired([entry('c1', '接続1', 10)]) }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    conn.removeConnection.mockResolvedValueOnce('deleted')
    await user.click(screen.getByTestId('claude-connection-remove'))
    dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('最後の接続です。連携をすべて解除しますか？')
    expect(dialog.textContent).toContain('すべての接続（1件）')
    await user.click(within(dialog).getByRole('button', { name: '連携をすべて解除' }))
    await waitFor(() => expect(conn.removeConnection).toHaveBeenCalledTimes(2))
    expect(conn.removeConnection).toHaveBeenLastCalledWith('c1')
    expect(await screen.findByText('Claude との連携をすべて解除しました')).toBeTruthy()
    expect(conn.deleteConnector).not.toHaveBeenCalled()
  })

  it('見ている一覧が1つでも、サーバーの一覧にほかの接続があれば（ほかの端末で足された）、その接続だけを外して知らせる', async () => {
    const user = userEvent.setup()
    await showList([entry('c1', '接続1', 10)])
    conn.removeConnection.mockResolvedValueOnce('removed')
    await user.click(screen.getByTestId('claude-connection-remove'))
    let dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '連携をすべて解除' }))
    await waitFor(() => expect(conn.removeConnection).toHaveBeenCalledWith('c1'))
    expect(await screen.findByText('「接続1」の接続を解除しました（ほかの端末で足された接続は、そのまま使えます）')).toBeTruthy()
    expect(conn.deleteConnector).not.toHaveBeenCalled()

    // もう無かった（ほかの端末で解除された）
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    conn.removeConnection.mockResolvedValueOnce('none')
    await user.click(screen.getByTestId('claude-connection-remove'))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '連携をすべて解除' }))
    expect(await screen.findByText('その接続はもうありません（ほかの端末で解除されました）。')).toBeTruthy()
    expect(conn.deleteConnector).not.toHaveBeenCalled()
  })

  it('連携をすべて解除: すべての接続の数を出して確かめる。やめれば何もしない', async () => {
    const user = userEvent.setup()
    await showList([entry('c1', '接続1', 10), entry('cabc', '接続2', 11)])
    await user.click(screen.getByTestId('claude-unpair'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(
      'すべての接続（2件）が、その場で何も読めず、書き込めなくなります。Claude で使うには、claude.ai でコネクタを接続し直して、もう一度許可してください（claude.ai 側のコネクタも削除しておくと確実です）。',
    )
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(conn.deleteConnector).not.toHaveBeenCalled()
  })
})
