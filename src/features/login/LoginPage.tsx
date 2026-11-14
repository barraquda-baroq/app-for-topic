// ログインの画面（docs/SPEC.md の 14.4）: 最初にこの画面を出し、ログインしてから使う（ヘッダーは出さない）。DS の
// src/features/login/LoginPage.tsx から、前に別のアカウントで使っていた端末の確かめ（段階1で足す）を外した物。
// 見た目は DS と同じ表紙の組み方: 画面いっぱいに --cover（外観ごとのグレー）の地、左寄せで等幅の「Topic Studio」、その下に今日の曜日と
// 日付「SAT · 2026.11.14」、さらに下に［Google でログイン］。画面の左下に「TOPIC STUDIO  v0.1」。
// iPhone をホーム画面のアプリでなく開いた時は、ホーム画面に追加してから使う案内と［追加の手順］を出す。iPhone は Chrome を基準にし
// （DS の作者の指示）、案内の言葉は開いているブラウザ（Chrome・Safari。ほかは「ブラウザ」）の名前で出す。
// Firebase の設定がまだ仮の値の時（docs/DEPLOY.md の手順で差し替える前）は、ログインを始めずに「まだ公開の準備ができていません」と出す。
// ログインした後、持ち主を確かめている間（「確かめています…」）・持ち主の記録が無い・ほかのアカウントの記録の時は、この画面の中に
// 文とボタンを出す（何も見えない）
import { useEffect, useState } from 'react'
import { coverDateLabel } from '../../domain/dates'
import { canShowData, signIn, signOut, useSync } from '../../sync/controller'
import { firebaseConfigIsPlaceholder } from '../../sync/firebaseConfig'
import { APP_VERSION } from '../../sync/appVersion'
import { OWNER_MISMATCH_MESSAGE, OWNER_MISSING_MESSAGE } from '../../sync/syncView'
import { useDocumentTitle, useToday } from '../../ui/hooks'
import { Modal } from '../../ui/Modal'
import { InstallHelp } from './InstallHelp'
import { currentIosBrowser, currentPlatform, isStandalone, needsHomeScreenNotice, type IosBrowser } from './platform'
import './login.css'

/** 画面の左下の版（src/sync/appVersion.ts の APP_VERSION） */
export const VERSION_LABEL = `v${APP_VERSION}`

/** 持ち主を確かめている間の言葉 */
export const OWNER_CHECKING_MESSAGE = '確かめています…'

export const NOT_READY_MESSAGE = 'まだ公開の準備ができていません（docs/DEPLOY.md）'
export const OFFLINE_MESSAGE = 'ネットにつながっていません。最初の1回はネットにつないでログインしてください。'

/** iPhone の案内で呼ぶ、開いているブラウザのタブ（Chrome を基準にし、Safari で開いた時は Safari。ほかは「ブラウザ」） */
const BROWSER_TAB: Record<IosBrowser, string> = { chrome: 'Chrome のタブ', safari: 'Safari のタブ', other: 'ブラウザのタブ' }
const STAY_LABEL: Record<IosBrowser, string> = {
  chrome: 'このまま Chrome で使う',
  safari: 'このまま Safari で使う',
  other: 'このままブラウザで使う',
}

/** iPhone をホーム画面のアプリでなく開いた時の案内（DS と同じ言葉） */
export function homeScreenMessage(browser: IosBrowser): string {
  return `ホーム画面に追加してから使ってください。${BROWSER_TAB[browser]}のままだと、ホーム画面のアプリとデータが別々になり、しばらく使わないとデータが消されることもあります。`
}

/** 案内を閉じる小さなボタンの言葉 */
export function stayLabel(browser: IosBrowser): string {
  return STAY_LABEL[browser]
}

/**
 * まだログインできない（Firebase の設定が差し替え用の仮の値のまま。docs/DEPLOY.md）。
 * 開発でエミュレーターにつないでいる時（VITE_FIREBASE_EMULATOR）は、仮の値のままでもログインできる
 */
export function loginNotReady(): boolean {
  const emulator = import.meta.env.DEV && Boolean(import.meta.env.VITE_FIREBASE_EMULATOR)
  return firebaseConfigIsPlaceholder && !emulator
}

/** 電波があるか（無くなった・戻ったらすぐに変わる） */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

/** ログインの前のボタンと案内 */
function LoginActions(props: {
  online: boolean
  homeNotice: boolean
  browser: IosBrowser
  message: string | null
  busy: boolean
  onHelp: () => void
  onStay: () => void
  onLogin: () => void
}) {
  const { online, homeNotice, browser, message, busy } = props
  return (
    <>
      {!online ? (
        <p className="login-note" role="status" data-testid="login-offline">
          {OFFLINE_MESSAGE}
        </p>
      ) : null}
      {homeNotice ? (
        <div className="login-home" data-testid="login-home-notice">
          <p className="login-note">{homeScreenMessage(browser)}</p>
          <div className="login-home-actions">
            <button type="button" className="btn btn-sm" onClick={props.onHelp} data-testid="login-install-help">
              追加の手順
            </button>
            <button type="button" className="login-link" onClick={props.onStay} data-testid="login-stay-browser">
              {stayLabel(browser)}
            </button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p className="login-note is-alert" role="alert" data-testid="login-message">
          {message}
        </p>
      ) : null}
      <div>
        <button type="button" className="btn login-google" onClick={props.onLogin} disabled={busy} data-testid="login-google">
          Google でログイン
        </button>
      </div>
    </>
  )
}

/** ログインした後、まだトップの画面を出せない時の文とボタン */
function SignedInGate({ online }: { online: boolean }) {
  const busy = useSync((s) => s.busy)
  const owner = useSync((s) => s.owner)
  const email = useSync((s) => s.user?.email ?? '')
  const logout = (
    <button
      type="button"
      className="btn login-google"
      onClick={() => void signOut()}
      disabled={busy}
      data-testid="login-sign-out"
    >
      ログアウト
    </button>
  )
  if (owner === 'missing' || owner === 'mismatch') {
    return (
      <>
        <p className="login-note is-alert" role="alert" data-testid="login-owner">
          {owner === 'missing' ? OWNER_MISSING_MESSAGE : OWNER_MISMATCH_MESSAGE}
        </p>
        <div>{logout}</div>
      </>
    )
  }
  return (
    <>
      <p className="login-note" role="status" data-testid="login-owner-checking">
        {online ? OWNER_CHECKING_MESSAGE : OFFLINE_MESSAGE}
      </p>
      {email ? <p className="login-note">{email}</p> : null}
      <div>{logout}</div>
    </>
  )
}

export function LoginPage() {
  useDocumentTitle('ログイン')
  const busy = useSync((s) => s.busy)
  const error = useSync((s) => s.error)
  // ログインした後、まだトップの画面を出せない（持ち主を確かめている・持ち主でない）
  const gated = useSync((s) => s.auth === 'signedIn' && !canShowData(s))
  const online = useOnline()
  const [notice, setNotice] = useState<string | null>(null)
  const [homeNotice, setHomeNotice] = useState(() => needsHomeScreenNotice(currentPlatform(), isStandalone()))
  const [browser] = useState(currentIosBrowser)
  const [help, setHelp] = useState(false)
  // 開いたまま 0時を過ぎたら日付も変える
  const today = coverDateLabel(useToday())

  const login = () => {
    if (loginNotReady()) {
      setNotice(NOT_READY_MESSAGE)
      return
    }
    setNotice(null)
    void signIn()
  }

  // 電波が無い時は、Firebase を読み込めなかった失敗の言葉の代わりに、ネットにつなぐ案内を出す
  const message = notice ?? (online ? error : null)

  return (
    <main className="login" data-testid="login-page">
      <div className="login-body">
        <h1 className="login-logo">Topic Studio</h1>
        <p className="login-date" data-testid="login-date">
          {today}
        </p>
        <div className="login-actions">
          {gated ? (
            <SignedInGate online={online} />
          ) : (
            <LoginActions
              online={online}
              homeNotice={homeNotice}
              browser={browser}
              message={message}
              busy={busy}
              onHelp={() => setHelp(true)}
              onStay={() => setHomeNotice(false)}
              onLogin={login}
            />
          )}
        </div>
      </div>
      <p className="login-foot">
        <span>TOPIC STUDIO</span>
        <span>{VERSION_LABEL}</span>
      </p>
      {help ? (
        <Modal title="ホーム画面に追加" onClose={() => setHelp(false)} testId="install-help-modal">
          <InstallHelp framed={false} />
        </Modal>
      ) : null}
    </main>
  )
}
