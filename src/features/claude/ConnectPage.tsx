// #/claude/connect?s=<state>: Claude 用のコネクタとの連携の画面（コネクタの同意の画面の［Topic Studio で確認する］から開かれる）。
// NS の src/features/claude/ConnectPage.tsx を写して減らした物（段階3の設計の 3.1）。見せるタイトルの選び・iPhone / Android のアプリの
// 分岐・ログインの所を外した（TS の連携の画面は持ち主の関所の中にあり、ログインと持ち主の確かめは関所がする。ログインしていなければ
// ログインの画面へ移り、ログインの後にこの画面へ戻る。src/App.tsx・connectReturn.ts）。
// 1. ログイン（関所）→ 2. クラウドの持ち主のアカウントか確かめる（config/owner をサーバーから読む）→ 3. 同期がそろうのを待つ
// → 4. ビルドの時に決めたコネクタの origin から、コネクタの匿名のアカウントを受け取る（URL の uid・origin は使わない）
// → 5.「書き込みを許可」と接続の名前を選んで［許可する］→ 連携の記録の接続の一覧（2まで）に接続（指紋だけ）を足してから、
//    コネクタへ移る。接続の id は画面を開くごとに1つ作り、記録に失敗した後のやり直しでも同じものを使う（重ならない）。
//    コネクタがこのアプリより古い版なら許可させない。［許可する］の前に、claude.ai のツールの許可を全部「常に許可」にする訳と
//    ツールの名前を並べる（DS の 19.6 にならう。点検 guard-G1・G5）
// 「この接続」: 名前（既定は空いている一番小さい「接続n」）・新しい接続として足す／前の接続と入れ替える・いまの接続の一覧
// （行ごとに解除。2ある時は入れ替えるか解除しないと許可できない）・15分以内に許可した接続があれば入れ替えを勧める。
// 入れ替える先は、作者が選んだ接続が無くなってもほかの接続に移さない（2ないなら足すに戻し、2なら選び直すまで許可させない）。
// 2ある時の既定の入れ替える先は15分以内に許可した接続だけ（無ければ「選んでください」）。
// 手順は connectLogic.ts（prepareConnect・approvePairing）、URL・k・指紋の決まりはコネクタと同じ src/claude/pairing.ts
import { useEffect, useId, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  defaultConnectionName,
  newConnectionId,
  CONNECTION_NAME_MAX,
  MAX_CONNECTIONS,
  PAIRING_TTL_MS,
  type ConnectionInfo,
} from '../../claude/pairing'
import { paths } from '../../routes'
import { DATA_MODEL } from '../../sync/appVersion'
import { useSync } from '../../sync/controller'
import { useDocumentTitle } from '../../ui/hooks'
import { AppHeader } from '../../ui/Layout'
import { testAuthRequested } from '../login/testAuth'
import { PlugIcon } from './claudeIcons'
import { ToolAllowNote } from './ClaudeSettings'
import { CLAUDE_CAN, CLAUDE_CANNOT, WRITES_HINT } from './claudeUi'
import { clearConnectReturn } from './connectReturn'
import { connectionNameProblem, ConnectionList, removeOneConnection } from './ConnectionList'
import {
  approvePairing,
  CONNECTOR_ORIGIN,
  deviceLabel,
  EXISTING_READ_ERROR,
  fetchIdentity,
  prepareConnect,
  randomPairingKey,
  validState,
  type ConnectorIdentity,
  type ConnectorStatus,
} from './connectLogic'
import { leaveTo } from './leave'
import './claude.css'

type Step =
  | { step: 'checking' }
  | { step: 'notOwner' }
  | { step: 'noOwner' }
  | { step: 'ownerError' }
  | { step: 'sync' }
  | { step: 'syncTimeout' }
  | { step: 'identity' }
  | { step: 'identityError'; error: string }
  | { step: 'connectorOld'; identity: ConnectorIdentity }
  | { step: 'ready'; identity: ConnectorIdentity; ownerUid: string; existing: ConnectorStatus | null; existingError: boolean }
  | { step: 'saving' }
  | {
      step: 'saveError'
      error: string
      identity: ConnectorIdentity
      ownerUid: string
      existing: ConnectorStatus | null
      existingError: boolean
    }
  | { step: 'done' }
  | { step: 'cancelled' }

/** 連携の画面で見ている、いまの接続の一覧（解除した後・記録に失敗した後は読み直す） */
type ListState = { state: 'loading' } | { state: 'ok'; status: ConnectorStatus | null } | { state: 'error' }

/** 同期が「同期済み」になるまで待つ（なれば true） */
function waitForSynced(ms: number): Promise<boolean> {
  if (useSync.getState().status?.phase === 'synced') return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub()
      resolve(false)
    }, ms)
    const unsub = useSync.subscribe((s) => {
      if (s.status?.phase === 'synced') {
        clearTimeout(timer)
        unsub()
        resolve(true)
      }
    })
  })
}

/** テストの印でログインした開発サーバー（Firebase を使わない E2E）。公開するビルドでは false に決まり、この分岐はビルドで消える */
const testAuth = () => import.meta.env.DEV && testAuthRequested()

export function ConnectPage() {
  useDocumentTitle('Claude との連携')
  const [params] = useSearchParams()
  const state = validState(params.get('s'))
  const sync = useSync()
  const uid = sync.auth === 'signedIn' ? (sync.user?.uid ?? null) : null
  const [noCloud] = useState(testAuth)
  // 同期のエンジンが動き始めた後（Firebase を読み込んだ後）に、持ち主の記録を読み始める（Firebase を使わずにログインした状態では動かない）
  const engineReady = sync.status !== null
  const [step, setStep] = useState<Step>({ step: 'checking' })
  const [attemptNo, setAttemptNo] = useState(0)
  // 選んだ内容は記録に失敗した後も残す（連携の記録の間はフォームを外すので、フォームの中には持たない）。
  // 接続の id は画面を開くごとに1つ（claude.ai で接続し直すと、新しい画面になり新しい id）
  const [draft, setDraft] = useState<ApproveDraft>(() => ({
    writes: null,
    cid: newConnectionId(),
    name: null,
    mode: 'add',
    replaceCid: null,
  }))
  const [list, setList] = useState<ListState>({ state: 'loading' })
  const host = CONNECTOR_ORIGIN ? new URL(CONNECTOR_ORIGIN).host : ''
  const reloadList = async () => {
    setList({ state: 'loading' })
    try {
      const doc = await import('./connectorDoc')
      setList({ state: 'ok', status: await doc.readConnectorDoc() })
    } catch {
      setList({ state: 'error' })
    }
  }

  // ログインの画面の後にこの画面へ戻すための覚えは、開いたら消す（src/App.tsx の AuthGate）
  useEffect(() => clearConnectReturn(), [])

  useEffect(() => {
    if (noCloud || !CONNECTOR_ORIGIN || !state || !uid || !engineReady) return
    let cancelled = false
    const set = (s: Step) => {
      if (!cancelled) setStep(s)
    }
    void (async () => {
      set({ step: 'checking' })
      let doc: typeof import('./connectorDoc')
      try {
        doc = await import('./connectorDoc')
      } catch {
        set({ step: 'ownerError' })
        return
      }
      if (cancelled) return
      const r = await prepareConnect(
        {
          origin: CONNECTOR_ORIGIN,
          readOwnerUid: () => doc.readOwnerUid(),
          waitSynced: (ms) => waitForSynced(ms),
          fetchIdentity: (origin) => fetchIdentity(origin),
          readConnector: () => doc.readConnectorDoc(),
          dataModel: DATA_MODEL,
          cancelled: () => cancelled,
          onStep: (s) => set({ step: s }),
        },
        uid,
      )
      if (cancelled || r.step === 'cancelled') return
      if (r.step === 'ready') setList(r.existingError ? { state: 'error' } : { state: 'ok', status: r.existing })
      set(r)
    })()
    return () => {
      cancelled = true
    }
  }, [noCloud, state, uid, engineReady, attemptNo])

  const retry = () => setAttemptNo((n) => n + 1)

  const body = (() => {
    if (!CONNECTOR_ORIGIN)
      return (
        <Notice tone="warn" testId="connect-unconfigured">
          <p>
            <strong>コネクタ未設定</strong>
          </p>
          <p>
            このアプリにはコネクタの場所が設定されていないため、連携できません。docs/CONNECTOR.md の手順で
            <code>npm run connector:setup</code> を実行して、アプリを公開し直してください。
          </p>
        </Notice>
      )
    if (!state)
      return (
        <Notice tone="warn" testId="connect-no-state">
          <p>連携の印がありません。claude.ai のコネクタの画面（［Topic Studio で確認する］）からやり直してください。</p>
        </Notice>
      )
    // テストの印の時だけ（公開するビルドでは import.meta.env.DEV が false なので、この文はビルドに入らない）
    if (import.meta.env.DEV && noCloud)
      return (
        <Notice tone="info" testId="connect-test-auth">
          <p>テスト用のログインでは連携できません（クラウドに問い合わせません）。</p>
        </Notice>
      )
    if (!uid || !sync.user) return <Progress text="ログインの状態を確かめています…" />
    if (!engineReady) return <Progress text="同期の準備をしています…" testId="connect-engine-wait" />
    switch (step.step) {
      case 'checking':
        return <Progress text="持ち主のアカウントか確かめています…" />
      case 'notOwner':
        return (
          <Notice tone="danger" testId="connect-not-owner">
            <p>
              <strong>このアカウントは Topic Studio の持ち主ではありません</strong>（{sync.user.email || sync.user.name}）。
            </p>
            <p>設定の「アカウント」でログアウトして、持ち主のアカウントでログインし直してください。</p>
            <Link to={paths.settings()} className="btn">
              設定へ
            </Link>
          </Notice>
        )
      case 'noOwner':
        return (
          <Notice tone="warn" testId="connect-no-owner">
            <p>クラウドの持ち主がまだ記録されていません（docs/DEPLOY.md）。記録を作ってから、もう一度お試しください。</p>
            <RetryButton onClick={retry} />
          </Notice>
        )
      case 'ownerError':
        return (
          <Notice tone="warn" testId="connect-owner-error">
            <p>持ち主を確かめられませんでした。インターネットの接続を確かめてください。</p>
            <RetryButton onClick={retry} />
          </Notice>
        )
      case 'sync':
        return <Progress text="同期がそろうのを待っています…（初めての端末では少しかかります）" testId="connect-sync-wait" />
      case 'syncTimeout':
        return (
          <Notice tone="warn" testId="connect-sync-timeout">
            <p>同期が終わりませんでした。インターネットの接続を確かめて、もう一度お試しください。</p>
            <RetryButton onClick={retry} />
          </Notice>
        )
      case 'identity':
        return <Progress text="コネクタに問い合わせています…" />
      case 'identityError':
        return (
          <Notice tone="warn" testId="connect-identity-error">
            <p>{step.error}</p>
            <RetryButton onClick={retry} />
          </Notice>
        )
      case 'connectorOld':
        return (
          <Notice tone="warn" testId="connect-connector-old">
            <p>
              コネクタがまだこのアプリの版になっていません（いまのコネクタは {step.identity.version || '不明'}・データの形{' '}
              {step.identity.model ?? '不明'}
              ）。古いコネクタは、このアプリの記録の形を書けないため許可できません。コネクタを更新してから（docs/DEPLOY.md）、claude.ai
              でもう一度「接続」を押してください。
            </p>
          </Notice>
        )
      case 'ready':
      case 'saveError':
        return (
          <ApproveForm
            identity={step.identity}
            ownerUid={step.ownerUid}
            list={list}
            onReloadList={reloadList}
            state={state}
            error={step.step === 'saveError' ? step.error : null}
            draft={draft}
            onDraftChange={setDraft}
            onSaving={() => setStep({ step: 'saving' })}
            onDone={() => setStep({ step: 'done' })}
            onError={(error) => {
              setStep({
                step: 'saveError',
                error,
                identity: step.identity,
                ownerUid: step.ownerUid,
                existing: step.existing,
                existingError: step.existingError,
              })
              // ほかの端末で接続が足された・解除された時のために、一覧を読み直す
              void reloadList()
            }}
            onCancel={() => setStep({ step: 'cancelled' })}
          />
        )
      case 'saving':
        return <Progress text="連携を記録しています…" testId="connect-saving" />
      case 'done':
        return <Progress text="連携しました。claude.ai に戻ります…" testId="connect-done" />
      case 'cancelled':
        return (
          <Notice tone="info" testId="connect-cancelled">
            <p>連携をやめました。この画面は閉じてかまいません（claude.ai のコネクタは接続されません）。</p>
            <Link to={paths.top()} className="btn">
              トップへ
            </Link>
          </Notice>
        )
    }
  })()

  return (
    <>
      <AppHeader />
      <main className="page page-narrow cn-page" data-testid="connect-page">
        <h1 className="cn-title">
          <PlugIcon />
          Claude（claude.ai）との連携
        </h1>
        {host ? (
          <p className="cn-host" data-testid="connect-host">
            コネクタ: <code>{host}</code>
          </p>
        ) : null}
        {body}
      </main>
    </>
  )
}

function Progress({ text, testId }: { text: string; testId?: string }) {
  return (
    <p className="cn-progress" role="status" data-testid={testId ?? 'connect-progress'}>
      <span className="cn-spinner" aria-hidden="true" />
      {text}
    </p>
  )
}

function Notice({ tone, testId, children }: { tone: 'warn' | 'danger' | 'info'; testId: string; children: ReactNode }) {
  return (
    <div className={`cn-notice is-${tone}`} role={tone === 'info' ? 'status' : 'alert'} data-testid={testId}>
      {children}
    </div>
  )
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn" onClick={onClick} data-testid="connect-retry">
      もう一度
    </button>
  )
}

/** 連携の画面で選んでいる内容 */
interface ApproveDraft {
  /** 「書き込みを許可」（null = 変えていない: いまの設定のまま。記録が無ければ許可） */
  writes: boolean | null
  /** 足す接続の id（画面を開くごとに1つ。やり直しでも同じ） */
  cid: string
  /** 接続の名前（null = 既定の名前。入れ替える時は、その接続の名前） */
  name: string | null
  /** 新しい接続として足す・前の接続と入れ替える（接続が2ある時は入れ替えるだけ） */
  mode: 'add' | 'replace'
  /**
   * 入れ替える接続（null = 選んでいない: 15分以内に許可した接続、無ければ一番前の接続。2ある時は15分以内に許可した接続だけ）。
   * 選んだ接続が一覧から無くなっても、ほかの接続に移さない
   */
  replaceCid: string | null
}

interface ApproveFormProps {
  identity: ConnectorIdentity
  ownerUid: string
  /** いまの接続の一覧 */
  list: ListState
  onReloadList: () => Promise<void>
  state: string
  error: string | null
  draft: ApproveDraft
  onDraftChange: Dispatch<SetStateAction<ApproveDraft>>
  onSaving: () => void
  onDone: () => void
  onError: (error: string) => void
  onCancel: () => void
}

function ApproveForm({
  identity,
  ownerUid,
  list,
  onReloadList,
  state,
  error,
  draft,
  onDraftChange,
  onSaving,
  onDone,
  onError,
  onCancel,
}: ApproveFormProps) {
  const formId = useId()
  const [openedAt] = useState(() => Date.now())
  const [removing, setRemoving] = useState(false)
  const listed = list.state === 'ok' ? list.status : null
  // コネクタが用意し直された時（記録の uid が違う）は、前の接続は使えないので、新しく始める
  const identityChanged = !!listed && listed.uid !== identity.uid
  const current = listed && !identityChanged ? listed : null
  const connections: readonly ConnectionInfo[] = current?.connections ?? []
  const n = connections.length
  const full = n >= MAX_CONNECTIONS
  // 15分以内に許可した接続（claude.ai で接続できずにやり直している時の、使わない接続）
  const recent =
    [...connections]
      .filter((c) => c.pairedAt !== null && openedAt - c.pairedAt < PAIRING_TTL_MS && c.pairedAt - openedAt < 2 * 60_000)
      .sort((a, b) => (b.pairedAt ?? 0) - (a.pairedAt ?? 0))[0] ?? null
  // 選んでいない時の入れ替える先: 15分以内に許可した接続、無ければ一番前の接続（2ある時は選ぶまで決めない）
  const fallback = recent ?? (full ? null : (connections[0] ?? null))
  const chosen = draft.replaceCid === null ? null : (connections.find((c) => c.cid === draft.replaceCid) ?? null)
  // 選んだ入れ替える先が無くなった（一覧で解除した・ほかの端末で解除された）時は、ほかの接続に移さない
  const target = draft.replaceCid === null ? fallback : chosen
  const targetGone = draft.replaceCid !== null && chosen === null
  const mode: 'add' | 'replace' = n === 0 ? 'add' : full ? 'replace' : targetGone ? 'add' : draft.mode
  // 変えていなければいまの設定（記録が無ければ許可）。一覧を読めていない間は分からない（チェックの中間で出し、送らない）
  const writes: boolean | null = draft.writes ?? (list.state === 'ok' ? (current?.writes ?? true) : null)
  const name = draft.name ?? (mode === 'replace' && target ? target.name : defaultConnectionName(connections.map((c) => c.name)))
  const nameProblem = connectionNameProblem(name, connections, mode === 'replace' ? (target?.cid ?? null) : null)
  // 15分以内の許可の勧め。2つ目のアカウントを続けて接続した時にも出るので、別のアカウントなら入れ替えないことを添える
  // （入れ替えると前のアカウントがすぐ使えなくなる）
  const recentNote = recent
    ? `15分以内に許可した「${recent.name}」があります。同じ claude.ai のアカウントで接続できずにやり直している時は「${recent.name}と入れ替える」を選ぶと、使わない接続が一覧に残りません。` +
      (full
        ? `別の claude.ai のアカウントを足している時は、使っていない接続を選ぶか、下の一覧で1つ解除してください（「${recent.name}」と入れ替えると、そのアカウントはすぐ使えなくなります）。`
        : `別の claude.ai のアカウントを足している時は「新しい接続として足す」で許可してください（入れ替えると「${recent.name}」のアカウントはすぐ使えなくなります）。`)
    : null
  const listBusy = list.state === 'loading' || removing
  const canApprove = !listBusy && nameProblem === null && (mode === 'add' ? !full : !!target)

  const removeFromList = async (c: ConnectionInfo) => {
    setRemoving(true)
    try {
      if (await removeOneConnection(c, connections)) {
        // 選んでいた入れ替える先を解除した: 足すに戻す（名前は、作者が入れていなければ既定に戻る）
        onDraftChange((d) => (d.replaceCid === c.cid ? { ...d, mode: 'add', replaceCid: null } : d))
        await onReloadList()
      }
    } finally {
      setRemoving(false)
    }
  }
  const busy = useRef(false)
  // 「書き込みを許可」が分からない時（一覧を読めていない間）は、チェックの中間で出す
  const writesRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (writesRef.current) writesRef.current.indeterminate = writes === null
  }, [writes])

  const approve = async () => {
    if (busy.current || !canApprove) return
    busy.current = true
    onSaving()
    try {
      const doc = await import('./connectorDoc')
      const r = await approvePairing(
        {
          origin: CONNECTOR_ORIGIN,
          addConnection: (a) => doc.addConnection(a),
          deleteConnector: () => doc.deleteConnector(),
          navigate: (url) => leaveTo(url),
          randomKey: () => randomPairingKey(),
          deviceLabel: () => deviceLabel(),
        },
        {
          state,
          identity,
          ownerUid,
          // 触っていなければ送らない（トランザクションで記録の値のまま。一覧を読めなかった時に、ほかの接続の設定を変えない）
          writes: draft.writes,
          cid: draft.cid,
          name,
          defaultName: draft.name === null,
          replaceCid: mode === 'replace' ? (target?.cid ?? null) : null,
        },
      )
      if (r.ok) onDone()
      else onError(r.error)
    } catch {
      onError('連携を記録できませんでした。インターネットの接続を確かめて、もう一度お試しください。')
    } finally {
      busy.current = false
    }
  }

  return (
    <div className="cn-form" data-testid="connect-form">
      <p>
        Claude（claude.ai）が Topic Studio への接続を求めています。書き込みを許可するかと接続の名前を選んで［許可する］を押すと、
        claude.ai に戻って接続が終わります。
      </p>
      {identity.model !== null && identity.model !== DATA_MODEL ? (
        <p className="cn-notice is-warn" role="note" data-testid="connect-model-warning">
          コネクタのデータの形の版（{identity.model}）がこのアプリ（{DATA_MODEL}
          ）と違うため、コネクタは版などを書き込めません（読むことはできます）。アプリかコネクタを更新してください。
        </p>
      ) : null}

      <section className="cn-conn" aria-labelledby={`${formId}-conn`} data-testid="connect-connection">
        <h2 id={`${formId}-conn`}>
          この接続
          <span className="cn-count" data-testid="connect-connection-count">
            {n} / {MAX_CONNECTIONS}
          </span>
        </h2>
        {list.state === 'loading' ? <Progress text="確かめています…" testId="connect-connections-loading" /> : null}
        {list.state === 'error' ? (
          <p className="cn-notice is-warn" data-testid="connect-connections-error">
            {EXISTING_READ_ERROR}
          </p>
        ) : null}
        {identityChanged ? (
          <p className="cn-notice is-warn" data-testid="connect-identity-changed">
            コネクタが用意し直されたため、前の接続（{listed.connections.length}
            件）は使えなくなっています。この許可で連携を新しく始めます。
          </p>
        ) : null}
        {n === 0 ? (
          <p>Topic Studio には、claude.ai のアカウントを{MAX_CONNECTIONS}まで同時に接続できます。</p>
        ) : (
          <p data-testid="connect-connection-lead">
            いまの接続は {n}
            件です。新しく足しても、前の接続は切れません（claude.ai
            のどのアカウントかは、アプリからは分かりません。同じアカウントで接続し直した時も、新しい接続として足されます）。
          </p>
        )}
        <label className="field cn-name">
          <span>名前（あとから 設定 → Claude との連携 で変えられます）</span>
          <input
            className="input"
            value={name}
            maxLength={CONNECTION_NAME_MAX}
            aria-invalid={nameProblem ? true : undefined}
            aria-describedby={nameProblem ? `${formId}-name-problem` : undefined}
            onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
            data-testid="connect-name"
          />
        </label>
        {nameProblem ? (
          <p id={`${formId}-name-problem`} className="cl-error" role="alert" data-testid="connect-name-problem">
            {nameProblem}
          </p>
        ) : null}
        {n > 0 ? (
          <fieldset className="cn-conn-mode">
            <legend>前の接続</legend>
            <label className="check cn-conn-option">
              <input
                type="radio"
                name={`${formId}-mode`}
                checked={mode === 'add'}
                disabled={full}
                onChange={() => onDraftChange({ ...draft, mode: 'add' })}
                data-testid="connect-mode-add"
              />
              <span>新しい接続として足す（おすすめ）</span>
            </label>
            <div className="cn-conn-option">
              <input
                type="radio"
                id={`${formId}-replace`}
                name={`${formId}-mode`}
                checked={mode === 'replace'}
                onChange={() => onDraftChange({ ...draft, mode: 'replace', replaceCid: (target ?? fallback)?.cid ?? null })}
                aria-label={
                  target
                    ? `「${target.name}」と入れ替える（前の接続は使えなくなります）`
                    : '選んだ接続と入れ替える（前の接続は使えなくなります）'
                }
                data-testid="connect-mode-replace"
              />
              <span className="cn-conn-option-body">
                <select
                  className="select cn-replace-target"
                  value={target?.cid ?? ''}
                  onChange={(e) => onDraftChange({ ...draft, mode: 'replace', replaceCid: e.target.value })}
                  aria-label="入れ替える接続"
                  data-testid="connect-replace-target"
                >
                  {target ? null : (
                    <option value="" disabled>
                      選んでください
                    </option>
                  )}
                  {connections.map((c) => (
                    <option key={c.cid} value={c.cid}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <label htmlFor={`${formId}-replace`}>と入れ替える（前の接続は使えなくなります）</label>
              </span>
            </div>
          </fieldset>
        ) : null}
        {full ? (
          <p className="cn-notice is-warn" data-testid="connect-full">
            接続が{MAX_CONNECTIONS}あります（同時に{MAX_CONNECTIONS}
            まで）。入れ替える接続を選ぶか、下の一覧で1つ解除すると許可できます。
          </p>
        ) : null}
        {/* 2ある時に既定で選んである時は、なぜ選んであるかの説明として出す（作者が選んだ時は出さない） */}
        {recent && recentNote && !(mode === 'replace' && draft.replaceCid === recent.cid) ? (
          <p className="cn-notice is-info" data-testid="connect-recent">
            {recentNote}
          </p>
        ) : null}
        {n > 0 ? (
          <details className="cn-conn-details" open={full}>
            <summary>いまの接続（{n}件）</summary>
            <ConnectionList
              connections={connections}
              testIdPrefix="connect"
              busy={listBusy}
              onRemove={(c) => void removeFromList(c)}
            />
          </details>
        ) : null}
      </section>

      <div className="cn-columns">
        <section className="cn-box" aria-labelledby={`${formId}-can`} data-testid="connect-can">
          <h2 id={`${formId}-can`}>Claude ができること</h2>
          <ul>
            {CLAUDE_CAN.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
        <section className="cn-box" aria-labelledby={`${formId}-cannot`} data-testid="connect-cannot">
          <h2 id={`${formId}-cannot`}>できないこと</h2>
          <ul>
            {CLAUDE_CANNOT.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      </div>

      <div className="cn-box">
        <ToolAllowNote testId="connect-tools" />
      </div>

      <label className="check cn-writes">
        <input
          ref={writesRef}
          type="checkbox"
          checked={writes === true}
          onChange={(e) => onDraftChange({ ...draft, writes: e.target.checked })}
          data-testid="connect-writes"
        />
        <span>
          版などの書き込みも許可（すべての接続に効きます）
          <span className="cn-writes-hint">{WRITES_HINT}</span>
          {writes === null && list.state === 'error' ? (
            <span className="cn-writes-hint" data-testid="connect-writes-unknown">
              （いまの設定を読めませんでした。変えなければ、いまの設定のままです。コネクタが用意し直されていた時は許可になります）
            </span>
          ) : null}
        </span>
      </label>

      <p className="cn-warn" data-testid="connect-phishing-note">
        claude.ai で「接続」を押した直後でなければ、心当たりのない依頼です。［やめる］を押してください。
      </p>
      {error ? (
        <p className="cl-error" role="alert" data-testid="connect-error">
          {error}
        </p>
      ) : null}
      <div className="cn-actions">
        <button type="button" className="btn" onClick={onCancel} data-testid="connect-cancel">
          やめる
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void approve()}
          disabled={!canApprove}
          data-testid="connect-approve"
        >
          許可する
        </button>
      </div>
    </div>
  )
}
