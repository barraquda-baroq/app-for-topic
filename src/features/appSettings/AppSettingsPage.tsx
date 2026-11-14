// 設定の画面（#/settings。別のページ。docs/SPEC.md の 14.5）。DS の段階0の src/features/appSettings/AppSettingsPage.tsx から。
// 上に［‹ 戻る］。段階0の区切りは「表示」（外観4つ・起動アニメーション。src/features/appSettings/DisplaySettings.tsx）、
// 「アカウント」（ログインしているアカウントと［ログアウト］）、「ホーム画面に追加」（src/features/login/InstallHelp.tsx を枠付きで）、
// 「このアプリについて」（版と、同梱する書体のライセンス）。同期の状態・文字の大きさ・Claude との連携などは後の段階で足す
import { useId } from 'react'
import { APP_VERSION } from '../../sync/appVersion'
import { signOut, useSync } from '../../sync/controller'
import { useDocumentTitle } from '../../ui/hooks'
import { AppHeader, useGoBack } from '../../ui/Layout'
import { InstallHelp } from '../login/InstallHelp'
import { DisplaySettings } from './DisplaySettings'

/** 同梱する書体のライセンスの表示（SIL Open Font License 1.1。全文は public/licenses/RobotoMono-OFL.txt） */
export const FONT_NOTICE = 'Roboto Mono — Copyright 2015 The Roboto Mono Project Authors（SIL Open Font License 1.1）'
/** 書体のライセンスの全文（公開物の中。オフラインでも開ける。vite.config.ts の PWA_WORKBOX） */
export const FONT_LICENSE_URL = './licenses/RobotoMono-OFL.txt'

/** アカウント（ログインしているアカウントと［ログアウト］。ログアウトするとログインの画面に戻る） */
function AccountSection() {
  const id = useId()
  const email = useSync((s) => s.user?.email ?? '')
  const busy = useSync((s) => s.busy)
  return (
    <section className="card aset-card" aria-labelledby={`${id}-title`} data-testid="account-settings">
      <div className="aset-card-head">
        <h2 id={`${id}-title`}>アカウント</h2>
      </div>
      <div className="aset-row">
        <div className="aset-row-label">
          <span>ログインしているアカウント</span>
          {email ? (
            <span className="aset-row-desc" data-testid="account-email">
              {email}
            </span>
          ) : null}
        </div>
        <div className="aset-row-control">
          <button type="button" className="btn" onClick={() => void signOut()} disabled={busy} data-testid="sign-out">
            ログアウト
          </button>
        </div>
      </div>
    </section>
  )
}

/** このアプリについて（版と、同梱する書体のライセンス） */
function AboutSection() {
  const id = useId()
  return (
    <section className="card aset-card" aria-labelledby={`${id}-title`} data-testid="about-app">
      <div className="aset-card-head">
        <h2 id={`${id}-title`}>このアプリについて</h2>
      </div>
      <div className="aset-row">
        <div className="aset-row-label">
          <span>アプリの版</span>
        </div>
        <div className="aset-row-control">
          <span data-testid="about-version">
            Topic Studio <span className="mono">{APP_VERSION}</span>
          </span>
        </div>
      </div>
      <div className="aset-row">
        <div className="aset-row-label">
          <span>書体のライセンス</span>
          <span className="aset-row-desc" data-testid="about-font">
            {FONT_NOTICE}
          </span>
        </div>
        <div className="aset-row-control">
          <a className="btn btn-sm" href={FONT_LICENSE_URL} target="_blank" rel="noopener" data-testid="about-font-license">
            全文を開く
          </a>
        </div>
      </div>
    </section>
  )
}

export function AppSettingsPage() {
  useDocumentTitle('設定')
  const goBack = useGoBack()
  return (
    <>
      <AppHeader />
      <main className="page page-narrow stack" data-testid="app-settings">
        <div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={goBack} data-testid="settings-back">
            ‹ 戻る
          </button>
        </div>
        <h1 className="visually-hidden">設定</h1>
        <DisplaySettings />
        <AccountSection />
        <InstallHelp />
        <AboutSection />
      </main>
    </>
  )
}
