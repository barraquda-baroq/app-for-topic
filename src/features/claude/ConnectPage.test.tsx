// 連携の画面（#/claude/connect。src/features/claude/ConnectPage.tsx。NS の src/features/claude/ConnectPage.test.tsx を写し、見せる
// タイトル・送信待ち・ログインの所・2.8 までの v1 の記録の所を外して、接続の数を 2 にした物）: 持ち主の確かめ・同期を待つ・コネクタの
// 場所の固定（URL の uid・origin は使わない）・k は指紋だけを Firestore に書く・コネクタの版・［やめる］・この接続（名前・足す／入れ替える・
// 2ある時・15分以内の許可・一覧で解除・一覧を読めなかった時・同じ名前）・ツールの許可の案内・テストの印。
// 連携の記録を読み書きする所（connectorDoc.ts）・コネクタへ移る所（leave.ts）・コネクタ（fetch）は差し替える
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi, UseBoundStore } from 'zustand'
import { useToasts } from '../../store/uiStore'
import { AppFrame } from '../../ui/Layout'
import { CLAUDE_CAN, CLAUDE_CANNOT, CLAUDE_TOOLS, WRITES_HINT } from './claudeUi'
import type { ConnectionApproval, ConnectorStatus } from './connectLogic'

const ORIGIN = 'https://topic-studio-connector.example.workers.dev'

async function sha(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface FakeSync {
  auth: 'idle' | 'checking' | 'signedOut' | 'signedIn'
  user: { uid: string; name: string; email: string } | null
  status: { phase: string; pending: number } | null
  accountMismatch: null
  busy: boolean
  error: string | null
}

const sync = vi.hoisted(() => ({ store: null as unknown as UseBoundStore<StoreApi<FakeSync>> }))
const doc = vi.hoisted(() => ({
  owner: 'owner-uid' as string | null,
  /** いまの連携の記録（null = 無い） */
  existing: null as ConnectorStatus | null,
  written: [] as unknown[],
  readOwnerUid: vi.fn(),
  readConnectorDoc: vi.fn(),
  addConnection: vi.fn(),
  deleteConnector: vi.fn(),
  removeConnection: vi.fn(),
}))
const leave = vi.hoisted(() => ({ leaveTo: vi.fn() }))
const origin = vi.hoisted(() => ({ value: 'https://topic-studio-connector.example.workers.dev' }))

vi.mock('../../sync/controller', async () => {
  const { create: make } = await import('zustand')
  sync.store = make<FakeSync>(() => ({
    auth: 'signedIn',
    user: { uid: 'owner-uid', name: '持ち主', email: 'owner@example.com' },
    status: { phase: 'synced', pending: 0 },
    accountMismatch: null,
    busy: false,
    error: null,
  }))
  return { useSync: sync.store }
})
vi.mock('./connectorDoc', () => ({
  readOwnerUid: doc.readOwnerUid,
  readConnectorDoc: doc.readConnectorDoc,
  addConnection: doc.addConnection,
  deleteConnector: doc.deleteConnector,
  removeConnection: doc.removeConnection,
}))
vi.mock('./leave', () => leave)
vi.mock('./connectLogic', async (importOriginal) => {
  const original = await importOriginal<typeof import('./connectLogic')>()
  return {
    ...original,
    get CONNECTOR_ORIGIN() {
      return origin.value
    },
  }
})

const { ConnectPage } = await import('./ConnectPage')

const fetchMock = vi.fn()

function renderPage(state = 'state-123') {
  return render(
    <MemoryRouter initialEntries={[`/claude/connect?s=${encodeURIComponent(state)}&uid=attacker&origin=https://evil.example`]}>
      <AppFrame>
        <Routes>
          <Route path="/claude/connect" element={<ConnectPage />} />
        </Routes>
      </AppFrame>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  origin.value = ORIGIN
  doc.owner = 'owner-uid'
  doc.existing = null
  doc.written = []
  for (const f of [doc.readOwnerUid, doc.readConnectorDoc, doc.addConnection, doc.deleteConnector, doc.removeConnection])
    f.mockReset()
  doc.readOwnerUid.mockImplementation(async () => doc.owner)
  doc.readConnectorDoc.mockImplementation(async () => doc.existing)
  doc.addConnection.mockImplementation(async (d: ConnectionApproval) => {
    doc.written.push(d)
  })
  doc.deleteConnector.mockImplementation(async () => undefined)
  leave.leaveTo.mockReset()
  fetchMock.mockReset()
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify({ uid: 'anon-uid', version: '0.1.0', model: 2 }), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  sessionStorage.clear()
  useToasts.setState({ toasts: [] })
  sync.store.setState({
    auth: 'signedIn',
    user: { uid: 'owner-uid', name: '持ち主', email: 'owner@example.com' },
    status: { phase: 'synced', pending: 0 },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
})

describe('連携の画面', () => {
  it('持ち主なら、ビルドの時に決めたコネクタに問い合わせ、許可すると指紋だけを書いてコネクタへ移る', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(screen.getByTestId('connect-host').textContent).toContain('topic-studio-connector.example.workers.dev')
    const form = await screen.findByTestId('connect-form')
    // URL の uid・origin は使わない
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`${ORIGIN}/connect/identity`)
    expect(form.textContent).toContain('心当たりのない依頼')
    // できる事・できない事（同意の画面と同じ文）と、ツールの許可の案内（全部「常に許可」にする訳とツールの名前）は［許可する］の前
    expect([...within(form).getByTestId('connect-can').querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      ...CLAUDE_CAN,
    ])
    expect([...within(form).getByTestId('connect-cannot').querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      ...CLAUDE_CANNOT,
    ])
    const tools = within(form).getByTestId('connect-tools')
    expect(tools.textContent).toContain('claude.ai のツールの許可は、全部「常に許可」にします')
    expect(within(tools).getByTestId('connect-tools-names').querySelectorAll('li')).toHaveLength(CLAUDE_TOOLS.length)
    const approveButton = within(form).getByTestId('connect-approve')
    expect(tools.compareDocumentPosition(approveButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 書き込みの許可の説明（足すだけ。消す・直すはできない）
    expect(form.querySelector('.cn-writes-hint')?.textContent).toBe(WRITES_HINT)
    expect(screen.getByTestId('connect-writes').parentElement?.textContent).toContain(
      '版などの書き込みも許可（すべての接続に効きます）',
    )

    // 書き込みは許可しない
    await user.click(within(form).getByTestId('connect-writes'))
    await user.click(approveButton)

    await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
    const url = new URL(leave.leaveTo.mock.calls[0][0] as string)
    expect(url.origin).toBe(ORIGIN)
    expect(url.pathname).toBe('/pair/callback')
    expect(url.searchParams.get('state')).toBe('state-123')
    const k = url.searchParams.get('k')!
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(doc.written).toEqual([
      {
        uid: 'anon-uid',
        pairing: await sha(`state-123.${k}`),
        approvedOn: 'ブラウザ',
        writes: false,
        cid: expect.stringMatching(/^c[0-9a-z]{12}$/),
        name: '接続1',
        defaultName: true,
        replaceCid: null,
      },
    ])
    expect(JSON.stringify(doc.written)).not.toContain(k)
    expect(screen.getByTestId('connect-done')).toBeTruthy()
  })

  it('記録に失敗しても、選んだ内容（書き込みを許可しない）はそのまま。やり直すと writes: false・同じ接続の id で記録する', async () => {
    const user = userEvent.setup()
    doc.addConnection.mockImplementationOnce(async (d: ConnectionApproval) => {
      doc.written.push({ failed: d.cid })
      throw Object.assign(new Error('x'), { code: 'unavailable' })
    })
    renderPage()
    const form = await screen.findByTestId('connect-form')
    await user.click(within(form).getByTestId('connect-writes'))
    expect((within(form).getByTestId('connect-writes') as HTMLInputElement).checked).toBe(false)
    await user.click(within(form).getByTestId('connect-approve'))
    expect((await screen.findByTestId('connect-error')).textContent).toBe(
      '連携を記録できませんでした。インターネットの接続を確かめて、もう一度お試しください。',
    )
    expect((screen.getByTestId('connect-writes') as HTMLInputElement).checked).toBe(false)
    await waitFor(() => expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(false))
    await user.click(screen.getByTestId('connect-approve'))
    await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
    expect(doc.written).toHaveLength(2)
    const [failed, ok] = doc.written as [{ failed: string }, ConnectionApproval]
    expect(ok.writes).toBe(false)
    expect(ok.cid).toBe(failed.failed)
  })

  it('持ち主でなければ問い合わせも記録もしない', async () => {
    doc.owner = 'someone-else'
    renderPage()
    const notice = await screen.findByTestId('connect-not-owner')
    expect(notice.textContent).toContain('このアカウントは Topic Studio の持ち主ではありません（owner@example.com）')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(doc.readConnectorDoc).not.toHaveBeenCalled()
    expect(doc.addConnection).not.toHaveBeenCalled()
  })

  it('持ち主の記録が無い・読めない時は先へ進まず、［もう一度］で確かめ直す', async () => {
    const user = userEvent.setup()
    doc.owner = null
    renderPage()
    await screen.findByTestId('connect-no-owner')
    expect(fetchMock).not.toHaveBeenCalled()
    doc.owner = 'owner-uid'
    await user.click(screen.getByTestId('connect-retry'))
    await screen.findByTestId('connect-form')
    cleanup()
    doc.readOwnerUid.mockImplementation(async () => Promise.reject(new Error('offline')))
    renderPage()
    await screen.findByTestId('connect-owner-error')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('同期がそろうまで待ち、そろってから問い合わせる', async () => {
    sync.store.setState({ status: { phase: 'downloading', pending: 0 } })
    renderPage()
    await screen.findByTestId('connect-sync-wait')
    expect(fetchMock).not.toHaveBeenCalled()
    act(() => sync.store.setState({ status: { phase: 'synced', pending: 0 } }))
    await screen.findByTestId('connect-form')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('連携の印が無ければ・コネクタの場所がビルドに無ければ先へ進まない', async () => {
    const first = renderPage('a b')
    expect(screen.getByTestId('connect-no-state')).toBeTruthy()
    expect(doc.readOwnerUid).not.toHaveBeenCalled()
    first.unmount()
    origin.value = ''
    renderPage()
    expect(screen.getByTestId('connect-unconfigured').textContent).toContain('コネクタ未設定')
    expect(screen.queryByTestId('connect-host')).toBeNull()
    expect(doc.readOwnerUid).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('テストの印でログインした開発サーバー（Firebase を使わない E2E）では、クラウドにもコネクタにも問い合わせない', async () => {
    localStorage.setItem('topic-studio:test-auth', '1')
    renderPage()
    expect(screen.getByTestId('connect-test-auth')).toBeTruthy()
    await new Promise((r) => setTimeout(r, 20))
    expect(doc.readOwnerUid).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('同期のエンジンが動き始めるまで（Firebase を使わずにログインした状態など）は、持ち主の記録も読まない', async () => {
    sync.store.setState({ status: null })
    renderPage()
    expect(screen.getByTestId('connect-engine-wait')).toBeTruthy()
    await new Promise((r) => setTimeout(r, 20))
    expect(doc.readOwnerUid).not.toHaveBeenCalled()
    act(() => sync.store.setState({ status: { phase: 'synced', pending: 0 } }))
    await screen.findByTestId('connect-form')
    expect(doc.readOwnerUid).toHaveBeenCalled()
  })

  it('開いたら、ログインの後に戻すための覚え（sessionStorage）を消す', () => {
    sessionStorage.setItem('topic-studio:connect-return', JSON.stringify({ path: '/claude/connect?s=x', at: Date.now() }))
    renderPage()
    expect(sessionStorage.getItem('topic-studio:connect-return')).toBeNull()
  })

  it('コネクタのアカウントが持ち主と同じ・答えが無い時は先へ進まない。［やめる］では何も書かない', async () => {
    const user = userEvent.setup()
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ uid: 'owner-uid', model: 2 }), { status: 200 }))
    const first = renderPage()
    await screen.findByTestId('connect-identity-error')
    first.unmount()

    // コネクタがアプリより新しい版: 許可はできる（書き込めないことを知らせる）
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ uid: 'anon-uid', model: 3 }), { status: 200 }))
    renderPage()
    const form = await screen.findByTestId('connect-form')
    expect(within(form).getByTestId('connect-model-warning').textContent).toContain('（3）')
    await user.click(within(form).getByTestId('connect-cancel'))
    expect(screen.getByTestId('connect-cancelled')).toBeTruthy()
    expect(doc.addConnection).not.toHaveBeenCalled()
    expect(leave.leaveTo).not.toHaveBeenCalled()
  })

  it('コネクタがアプリより古い版なら、許可させない', async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ uid: 'anon-uid', version: '0.0.9', model: 1 }), { status: 200 }),
    )
    renderPage()
    const old = await screen.findByTestId('connect-connector-old')
    expect(old.textContent).toBe(
      'コネクタがまだこのアプリの版になっていません（いまのコネクタは 0.0.9・データの形 1）。古いコネクタは、このアプリの記録の形を書けないため許可できません。コネクタを更新してから（docs/DEPLOY.md）、claude.ai でもう一度「接続」を押してください。',
    )
    expect(screen.queryByTestId('connect-approve')).toBeNull()
    expect(doc.readConnectorDoc).not.toHaveBeenCalled()
    expect(doc.addConnection).not.toHaveBeenCalled()
  })

  describe('この接続（複数の接続。2まで）', () => {
    const min = 60_000
    const entry = (cid: string, name: string, agoMin: number) => ({
      cid,
      name,
      pairing: `p-${cid}`,
      pairedAt: Date.now() - agoMin * min,
      approvedOn: 'Mac',
    })
    const status = (connections: ReturnType<typeof entry>[], over: Partial<ConnectorStatus> = {}): ConnectorStatus => ({
      uid: 'anon-uid',
      pairedAt: connections.at(-1)?.pairedAt ?? null,
      approvedOn: 'Mac',
      writes: true,
      connections,
      pairingCid: connections.at(-1)?.cid ?? null,
      ...over,
    })

    it('初めての接続: 0 / 2・既定の名前は「接続1」・前の接続の選択は出ない', async () => {
      renderPage()
      const section = await screen.findByTestId('connect-connection')
      expect(within(section).getByTestId('connect-connection-count').textContent).toBe('0 / 2')
      expect(section.textContent).toContain('Topic Studio には、claude.ai のアカウントを2まで同時に接続できます。')
      expect((within(section).getByTestId('connect-name') as HTMLInputElement).value).toBe('接続1')
      expect(within(section).queryByTestId('connect-mode-add')).toBeNull()
      expect(within(section).queryByTestId('connect-connections')).toBeNull()
      // 記録が無ければ書き込みは許可
      expect((screen.getByTestId('connect-writes') as HTMLInputElement).checked).toBe(true)
    })

    it('1つある記録の横に足す: 既定の名前は「接続2」。前の接続は切れないことを知らせる', async () => {
      const user = userEvent.setup()
      doc.existing = status([entry('c1', '接続1', 60 * 24)])
      renderPage()
      const section = await screen.findByTestId('connect-connection')
      expect(within(section).getByTestId('connect-connection-count').textContent).toBe('1 / 2')
      expect(within(section).getByTestId('connect-connection-lead').textContent).toBe(
        'いまの接続は 1件です。新しく足しても、前の接続は切れません（claude.ai のどのアカウントかは、アプリからは分かりません。同じアカウントで接続し直した時も、新しい接続として足されます）。',
      )
      expect((within(section).getByTestId('connect-name') as HTMLInputElement).value).toBe('接続2')
      expect((within(section).getByTestId('connect-mode-add') as HTMLInputElement).checked).toBe(true)
      // 1日前の許可は「15分以内」ではない
      expect(within(section).queryByTestId('connect-recent')).toBeNull()
      const list = within(section).getAllByTestId('connect-connection-row')
      expect(list.map((r) => within(r).getByTestId('connect-connection-name').textContent)).toEqual(['接続1'])
      expect(within(section).queryByTestId('connect-connection-rename')).toBeNull()
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続2', replaceCid: null })])
    })

    it('入れ替える: 名前は入れ替える接続の名前（書き直すまで）。同じ名前・空は断る。入れ替える接続を渡す', async () => {
      const user = userEvent.setup()
      doc.existing = status([entry('c1', '接続1', 600)])
      renderPage()
      const section = await screen.findByTestId('connect-connection')
      await user.click(within(section).getByTestId('connect-mode-replace'))
      const name = within(section).getByTestId('connect-name') as HTMLInputElement
      // 15分以内の許可が無ければ、一番前の接続
      expect((within(section).getByTestId('connect-replace-target') as HTMLSelectElement).value).toBe('c1')
      expect(name.value).toBe('接続1')
      await user.clear(name)
      expect(within(section).getByTestId('connect-name-problem').textContent).toBe('名前を入れてください')
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(true)
      await user.type(name, '新しい Mac')
      expect(within(section).queryByTestId('connect-name-problem')).toBeNull()
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '新しい Mac', replaceCid: 'c1', defaultName: false })])
    })

    it('同じ名前の接続があれば許可できない（字の幅・空白の違いも同じ）', async () => {
      const user = userEvent.setup()
      doc.existing = status([entry('c1', '接続1', 600)])
      renderPage()
      const name = (await screen.findByTestId('connect-name')) as HTMLInputElement
      await user.clear(name)
      await user.type(name, ' 接続１')
      expect(screen.getByTestId('connect-name-problem').textContent).toBe('同じ名前の接続があります')
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(true)
      expect(name.getAttribute('aria-invalid')).toBe('true')
    })

    it('15分以内に許可した接続があれば入れ替えを勧め、入れ替える先の既定にする。触らずに許可すると前の接続は残る', async () => {
      const user = userEvent.setup()
      doc.existing = status([entry('cnew', '接続1', 5)])
      renderPage()
      const recent = await screen.findByTestId('connect-recent')
      expect(recent.textContent).toBe(
        '15分以内に許可した「接続1」があります。同じ claude.ai のアカウントで接続できずにやり直している時は「接続1と入れ替える」を選ぶと、使わない接続が一覧に残りません。別の claude.ai のアカウントを足している時は「新しい接続として足す」で許可してください（入れ替えると「接続1」のアカウントはすぐ使えなくなります）。',
      )
      await user.click(screen.getByTestId('connect-mode-replace'))
      expect((screen.getByTestId('connect-replace-target') as HTMLSelectElement).value).toBe('cnew')
      // その接続と入れ替える時は勧めない
      expect(screen.queryByTestId('connect-recent')).toBeNull()
      await user.click(screen.getByTestId('connect-mode-add'))
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続2')
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続2', replaceCid: null })])
    })

    const two = () => [entry('c1', '接続1', 1000), entry('c2', '接続2', 900)]

    it('接続が2ある時: 足すことはできず入れ替えになる（15分以内の許可が無ければ、選ぶまで許可できない）。一覧が開き、1つ解除すると足せる', async () => {
      const user = userEvent.setup()
      doc.existing = status(two())
      renderPage()
      const section = await screen.findByTestId('connect-connection')
      expect(within(section).getByTestId('connect-full').textContent).toBe(
        '接続が2あります（同時に2まで）。入れ替える接続を選ぶか、下の一覧で1つ解除すると許可できます。',
      )
      expect((within(section).getByTestId('connect-mode-add') as HTMLInputElement).disabled).toBe(true)
      expect((within(section).getByTestId('connect-mode-replace') as HTMLInputElement).checked).toBe(true)
      expect(section.querySelector('details')?.open).toBe(true)
      // 入れ替える先は決めていない（一番前の接続を勝手に選ばない）
      const select = within(section).getByTestId('connect-replace-target') as HTMLSelectElement
      expect(select.value).toBe('')
      expect(select.selectedOptions[0].textContent).toBe('選んでください')
      expect(within(section).getByTestId('connect-mode-replace').getAttribute('aria-label')).toBe(
        '選んだ接続と入れ替える（前の接続は使えなくなります）',
      )
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(true)
      // 一覧で1つ解除する（読み直すまで［許可する］は待つ）
      let resolveRead: (s: ConnectorStatus) => void = () => undefined
      doc.removeConnection.mockImplementation(async () => 'removed')
      doc.readConnectorDoc.mockImplementation(() => new Promise<ConnectorStatus>((r) => (resolveRead = r)))
      const rows = within(section).getAllByTestId('connect-connection-row')
      await user.click(within(rows[1]).getByTestId('connect-connection-remove'))
      const dialog = await screen.findByRole('dialog')
      expect(dialog.textContent).toContain('「接続2」の接続を解除しますか？')
      await user.click(within(dialog).getByRole('button', { name: 'この接続を解除' }))
      await waitFor(() => expect(doc.removeConnection).toHaveBeenCalledWith('c2'))
      await screen.findByTestId('connect-connections-loading')
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(true)
      act(() => resolveRead(status(two().filter((c) => c.cid !== 'c2'))))
      await waitFor(() => expect(screen.queryByTestId('connect-full')).toBeNull())
      expect(screen.getByTestId('connect-connection-count').textContent).toBe('1 / 2')
      expect((screen.getByTestId('connect-mode-add') as HTMLInputElement).checked).toBe(true)
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続2')
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続2', replaceCid: null })])
    })

    it('接続が2ある時: 入れ替える接続を選ぶと許可できる（名前はその接続の名前）', async () => {
      const user = userEvent.setup()
      doc.existing = status(two())
      renderPage()
      const select = (await screen.findByTestId('connect-replace-target')) as HTMLSelectElement
      await user.selectOptions(select, 'c2')
      expect(select.value).toBe('c2')
      // 選んだ後は「選んでください」を出さない
      expect([...select.options].map((o) => o.value)).not.toContain('')
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続2')
      expect(screen.getByTestId('connect-mode-replace').getAttribute('aria-label')).toBe(
        '「接続2」と入れ替える（前の接続は使えなくなります）',
      )
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続2', replaceCid: 'c2', defaultName: true })])
    })

    it('接続が2ある時: 15分以内に許可した接続があれば、それを入れ替える先にしておき、なぜかを知らせる', async () => {
      const user = userEvent.setup()
      doc.existing = status([entry('c1', '接続1', 1000), entry('c2', '接続2', 3)])
      renderPage()
      const select = (await screen.findByTestId('connect-replace-target')) as HTMLSelectElement
      expect(select.value).toBe('c2')
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続2')
      expect(screen.getByTestId('connect-recent').textContent).toContain('15分以内に許可した「接続2」があります。')
      // 足すことはできないので、別のアカウントなら使っていない接続を選ぶか1つ解除するように言う（足すとは言わない）
      expect(screen.getByTestId('connect-recent').textContent).toContain(
        '別の claude.ai のアカウントを足している時は、使っていない接続を選ぶか、下の一覧で1つ解除してください（「接続2」と入れ替えると、そのアカウントはすぐ使えなくなります）。',
      )
      expect(screen.getByTestId('connect-recent').textContent).not.toContain('新しい接続として足す')
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(false)
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続2', replaceCid: 'c2' })])
    })

    it('接続が2ある時: 入れ替える接続を選んでから、その接続を一覧で解除すると、足すに戻る（ほかの接続と入れ替えない）', async () => {
      const user = userEvent.setup()
      doc.existing = status(two())
      renderPage()
      const section = await screen.findByTestId('connect-connection')
      await user.selectOptions(within(section).getByTestId('connect-replace-target'), 'c1')
      expect((within(section).getByTestId('connect-name') as HTMLInputElement).value).toBe('接続1')
      doc.removeConnection.mockImplementation(async () => 'removed')
      doc.existing = status(two().filter((c) => c.cid !== 'c1'))
      const row = within(section)
        .getAllByTestId('connect-connection-row')
        .find((r) => r.getAttribute('data-cid') === 'c1')!
      await user.click(within(row).getByTestId('connect-connection-remove'))
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'この接続を解除' }))
      await waitFor(() => expect(screen.getByTestId('connect-connection-count').textContent).toBe('1 / 2'))
      expect(doc.removeConnection).toHaveBeenCalledWith('c1')
      expect((screen.getByTestId('connect-mode-add') as HTMLInputElement).checked).toBe(true)
      expect((screen.getByTestId('connect-mode-replace') as HTMLInputElement).checked).toBe(false)
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続1')
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続1', replaceCid: null })])
    })

    it('記録に失敗して読み直した一覧に、選んだ入れ替える先が無ければ（2のまま）、ほかの接続に移さず選び直すまで許可できない', async () => {
      const user = userEvent.setup()
      const { ConnectionLimitError } = await import('./connectLogic')
      doc.existing = status(two())
      renderPage()
      await user.selectOptions(await screen.findByTestId('connect-replace-target'), 'c1')
      // ほかの端末で c1 が解除され、別の接続（30分前）が足された
      doc.existing = status([entry('c2', '接続2', 900), entry('c3', '接続3', 30)])
      doc.addConnection.mockImplementationOnce(async () => {
        throw new ConnectionLimitError()
      })
      await user.click(screen.getByTestId('connect-approve'))
      expect((await screen.findByTestId('connect-error')).textContent).toContain('接続が2あります（同時に2まで）')
      await waitFor(() => expect(screen.queryByTestId('connect-connections-loading')).toBeNull())
      expect(doc.readConnectorDoc).toHaveBeenCalledTimes(2)
      const select = screen.getByTestId('connect-replace-target') as HTMLSelectElement
      expect(select.value).toBe('')
      expect((screen.getByTestId('connect-mode-replace') as HTMLInputElement).checked).toBe(true)
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(true)
      await user.selectOptions(select, 'c3')
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続3', replaceCid: 'c3' })])
    })

    it('画面で見ている一覧が1つでも、［この接続を解除］はその接続だけを外す（ほかの端末で足された接続は残る）', async () => {
      const user = userEvent.setup()
      doc.existing = status([entry('c1', '接続1', 600)])
      renderPage()
      const section = await screen.findByTestId('connect-connection')
      // その間にほかの端末で「接続2」が足された（サーバーの一覧は2つ）
      doc.removeConnection.mockImplementation(async () => 'removed')
      doc.existing = status([entry('cx', '接続2', 3)])
      await user.click(within(section).getByText(/いまの接続/, { selector: 'summary' }))
      await user.click(within(section).getByTestId('connect-connection-remove'))
      const dialog = await screen.findByRole('dialog')
      expect(dialog.textContent).toContain('最後の接続です。連携をすべて解除しますか？')
      await user.click(within(dialog).getByRole('button', { name: '連携をすべて解除' }))
      await waitFor(() => expect(doc.removeConnection).toHaveBeenCalledWith('c1'))
      expect(doc.deleteConnector).not.toHaveBeenCalled()
      expect(
        await screen.findByText('「接続1」の接続を解除しました（ほかの端末で足された接続は、そのまま使えます）'),
      ).toBeTruthy()
      await waitFor(() => expect(screen.getByTestId('connect-connection-count').textContent).toBe('1 / 2'))
      expect(screen.getAllByTestId('connect-connection-name').map((e) => e.textContent)).toEqual(['接続2'])
    })

    it('いまの一覧を読めなかった時: 既定の名前「接続1」は、記録に「接続1」があればトランザクションで「接続2」になる', async () => {
      const user = userEvent.setup()
      const { addedConnectorDoc } = await import('./connectLogic')
      const server = {
        uid: 'anon-uid',
        v: 2,
        pairing: 'h-old',
        pairedAt: 1,
        approvedOn: 'iPad',
        writes: true,
        pairingCid: 'c1',
        connections: { c1: { name: '接続1', pairing: 'h-old', pairedAt: 1, approvedOn: 'iPad' } },
      }
      let saved: Record<string, unknown> | null = null
      doc.addConnection.mockImplementation(async (a: ConnectionApproval) => {
        doc.written.push(a)
        saved = addedConnectorDoc(server, a, 'SERVER')
      })
      doc.readConnectorDoc.mockImplementation(async () => Promise.reject(new Error('offline')))
      renderPage()
      expect((await screen.findByTestId('connect-connections-error')).textContent).toBe(
        'いまの接続の一覧を読めませんでした（許可はできます）',
      )
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続1')
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続1', defaultName: true })])
      const cid = (doc.written[0] as ConnectionApproval).cid
      expect(saved!.connections).toEqual({
        c1: expect.objectContaining({ name: '接続1', pairing: 'h-old' }),
        [cid]: expect.objectContaining({ name: '接続2' }),
      })
    })

    it('作者が入れた名前と同じ名前の接続が、ほかの端末で足されていたら、知らせて一覧を読み直す（何も書かない）', async () => {
      const user = userEvent.setup()
      const { addedConnectorDoc, DUPLICATE_NAME_ERROR } = await import('./connectLogic')
      doc.existing = status([entry('c1', '接続1', 600)])
      // サーバーの記録には、もう「仕事用」がある
      const server = {
        uid: 'anon-uid',
        v: 2,
        pairing: 'p-cx',
        pairedAt: 2,
        approvedOn: 'Mac',
        writes: true,
        pairingCid: 'cx',
        connections: {
          c1: { name: '接続1', pairing: 'p-c1', pairedAt: 1, approvedOn: 'Mac' },
          cx: { name: '仕事用', pairing: 'p-cx', pairedAt: 2, approvedOn: 'Mac' },
        },
      }
      doc.addConnection.mockImplementation(async (a: ConnectionApproval) => {
        addedConnectorDoc({ ...server, connections: { cx: server.connections.cx } }, a, 'SERVER')
        doc.written.push(a)
      })
      renderPage()
      const name = (await screen.findByTestId('connect-name')) as HTMLInputElement
      await user.clear(name)
      await user.type(name, '仕事用')
      expect(screen.queryByTestId('connect-name-problem')).toBeNull()
      doc.existing = status([entry('cx', '仕事用', 3)])
      await user.click(screen.getByTestId('connect-approve'))
      expect((await screen.findByTestId('connect-error')).textContent).toBe(DUPLICATE_NAME_ERROR)
      await waitFor(() => expect(screen.getByTestId('connect-name-problem').textContent).toBe('同じ名前の接続があります'))
      expect(doc.readConnectorDoc).toHaveBeenCalledTimes(2)
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(true)
      expect(doc.written).toEqual([])
      expect(leave.leaveTo).not.toHaveBeenCalled()
    })

    it('いまの一覧を読めなかった時に、コネクタが用意し直されていれば、触らなくても許可になる（そう添えてある）', async () => {
      const user = userEvent.setup()
      const { addedConnectorDoc } = await import('./connectLogic')
      // 前のコネクタの記録で、書き込みを止めている
      let server: Record<string, unknown> | null = {
        uid: 'old-anon',
        v: 2,
        pairing: 'h-old',
        pairedAt: 1,
        approvedOn: 'iPad',
        writes: false,
        pairingCid: 'c1',
        connections: { c1: { name: '接続1', pairing: 'h-old', pairedAt: 1, approvedOn: 'iPad' } },
      }
      doc.addConnection.mockImplementation(async (a: ConnectionApproval) => {
        server = addedConnectorDoc(server, a, 'SERVER')
        doc.written.push(a)
      })
      doc.deleteConnector.mockImplementation(async () => {
        server = null
      })
      doc.readConnectorDoc.mockImplementation(async () => Promise.reject(new Error('offline')))
      renderPage()
      await screen.findByTestId('connect-connections-error')
      expect(screen.getByTestId('connect-writes-unknown').textContent).toContain('コネクタが用意し直されていた時は許可になります')
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.deleteConnector).toHaveBeenCalledTimes(1)
      expect((doc.written[0] as ConnectionApproval).writes).toBeNull()
      expect(server).toMatchObject({ uid: 'anon-uid', writes: true })
    })

    it('いまの一覧を読めなかった時: 「書き込みを許可」は分からないと出し、触らなければ送らない（記録の値のまま）', async () => {
      const user = userEvent.setup()
      doc.readConnectorDoc.mockImplementation(async () => Promise.reject(new Error('offline')))
      const first = renderPage()
      await screen.findByTestId('connect-connections-error')
      const box = screen.getByTestId('connect-writes') as HTMLInputElement
      expect(box.checked).toBe(false)
      expect(box.indeterminate).toBe(true)
      expect(screen.getByTestId('connect-writes-unknown').textContent).toBe(
        '（いまの設定を読めませんでした。変えなければ、いまの設定のままです。コネクタが用意し直されていた時は許可になります）',
      )
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect((doc.written[0] as ConnectionApproval).writes).toBeNull()
      first.unmount()

      // 触ればその値（すべての接続に効く）
      renderPage()
      await screen.findByTestId('connect-connections-error')
      await user.click(screen.getByTestId('connect-writes'))
      const box2 = screen.getByTestId('connect-writes') as HTMLInputElement
      expect(box2.checked).toBe(true)
      expect(box2.indeterminate).toBe(false)
      expect(screen.queryByTestId('connect-writes-unknown')).toBeNull()
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(2))
      expect((doc.written[1] as ConnectionApproval).writes).toBe(true)
    })

    it('書き込みの既定は、いまの「書き込みを許可」', async () => {
      doc.existing = status([entry('c1', '接続1', 600)], { writes: false })
      renderPage()
      expect(((await screen.findByTestId('connect-writes')) as HTMLInputElement).checked).toBe(false)
    })

    it('コネクタが用意し直された時は、前の接続は数えずに新しく始める（知らせる）', async () => {
      doc.existing = status([entry('c1', '接続1', 600), entry('cabc', '接続2', 300)], { uid: 'old-anon', writes: false })
      renderPage()
      const notice = await screen.findByTestId('connect-identity-changed')
      expect(notice.textContent).toBe(
        'コネクタが用意し直されたため、前の接続（2件）は使えなくなっています。この許可で連携を新しく始めます。',
      )
      expect(screen.getByTestId('connect-connection-count').textContent).toBe('0 / 2')
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続1')
      expect((screen.getByTestId('connect-writes') as HTMLInputElement).checked).toBe(true)
      expect(screen.queryByTestId('connect-connections')).toBeNull()
    })

    it('接続が2の時の記録の失敗（ほかの端末で足された）を知らせ、一覧を読み直す', async () => {
      const user = userEvent.setup()
      const { ConnectionLimitError } = await import('./connectLogic')
      doc.addConnection.mockImplementationOnce(async () => {
        throw new ConnectionLimitError()
      })
      renderPage()
      await user.click(await screen.findByTestId('connect-approve'))
      expect((await screen.findByTestId('connect-error')).textContent).toContain('接続が2あります（同時に2まで）')
      await waitFor(() => expect(doc.readConnectorDoc).toHaveBeenCalledTimes(2))
      expect(leave.leaveTo).not.toHaveBeenCalled()
    })
  })
})
