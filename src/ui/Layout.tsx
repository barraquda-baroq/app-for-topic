// アプリの外枠: ヘッダー、外観の反映、アプリの更新の帯、お知らせ（トースト）、ダイアログ。DS の src/ui/Layout.tsx から
// （DS は NS の物から）。ヘッダー（docs/SPEC.md の 9.・14.5）: 左に TS のアイコンと名前、右に設定の歯車。
// DS の［MIM］は持ち込まない。版の表示・同期の表示は後の段階（段階1・2）で足す
import { useCallback, useEffect, useLayoutEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { paths } from '../routes'
import { saveBeforeLeave } from '../store/lifecycle'
import { notifyError, resolveAppearance, THEME_COLORS, useAppUpdate, usePrefs, useToasts } from '../store/uiStore'
import { DialogHost, cancelAllDialogs } from './dialogs'
import { GearIcon, XIcon } from './icons'
import './layout.css'

/**
 * 1つ前の画面へ戻る（設定の［‹ 戻る］）。その行き先を直接開いた時（アプリの中で移ってきた履歴が無い時）は、
 * アプリの外へ戻らないよう、トップへ置き換える（React Router は最初の履歴の key を 'default' にする）
 */
export function useGoBack(): () => void {
  const navigate = useNavigate()
  const { key } = useLocation()
  return useCallback(() => {
    if (key !== 'default') void navigate(-1)
    else void navigate(paths.top(), { replace: true })
  }, [navigate, key])
}

/**
 * 各画面のヘッダー（ログインの画面では出さない）。actions にほかのボタンを渡すと、設定の歯車の左に並ぶ。
 * 左のアイコンと名前を押すとトップへ。幅 380px 未満では名前を出さない（src/ui/layout.css）
 */
export function AppHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className="app-header" data-testid="app-header">
      <Link to={paths.top()} className="brand" aria-label="Topic Studio（トップへ）" data-testid="brand">
        <img src="./icon.svg" alt="" width={26} height={26} />
        <span className="brand-name">Topic Studio</span>
      </Link>
      <span className="spacer" />
      {actions}
      <Link to={paths.settings()} className="icon-btn" aria-label="設定" title="設定" data-testid="open-settings">
        <GearIcon />
      </Link>
    </header>
  )
}

function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  // ダイアログ表示中は画面本体が操作不可（inert）になるので、お知らせは body 直下に出す
  return createPortal(
    <div className="toasts" aria-live="assertive">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <p>{t.message}</p>
          {t.action ? (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                dismiss(t.id)
                t.action?.run()
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button type="button" onClick={() => dismiss(t.id)} aria-label="閉じる">
            <XIcon />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}

/**
 * アプリの新しい版を受け取ったら「アプリの新しい版があります ［更新する］」の帯を出す（ニュースの「版」と紛れないように「アプリの」を付ける）。押すと入力中の下書きを保存してから読み込み直す
 * （docs/SPEC.md の 14.6。押すまでは勝手に切り替えない）。保存はここの1か所だけでする（src/main.tsx の apply は新しい版に切り替えるだけ）
 */
export function UpdateBanner() {
  const ready = useAppUpdate((s) => s.ready)
  const apply = useAppUpdate((s) => s.apply)
  if (!ready || !apply) return null
  const update = async () => {
    // 端末に保存できなかった時（容量が足りない・閉じられた）は読み込み直さない（画面の編集が消えないように。DS の段階1の直し。
    // 段階0は保存する物が無いので、いつも切り替える）
    if (!(await saveBeforeLeave())) {
      notifyError('この端末に保存できなかったため、更新をやめました。少し待ってからもう一度押してください。')
      return
    }
    await apply()
  }
  return (
    <div className="banner banner-info" role="status" data-testid="update-banner">
      <span className="grow">アプリの新しい版があります</span>
      <button type="button" className="btn btn-sm" onClick={() => void update()} data-testid="app-update">
        更新する
      </button>
    </div>
  )
}

/**
 * 外観を <html> に反映する（docs/SPEC.md の 14.3）。
 * data-theme には実際の外観（white / dark / deep-dark）を入れる。「端末の設定に合わせる」の間は端末の切り替えにも追従する。
 * ブラウザの枠の色（<meta name="theme-color">）も外観に合わせる。最初の描画前は index.html のスクリプト（src/launch/launch.js）が同じことをする。
 */
export function PrefsEffect() {
  const appearance = usePrefs((s) => s.appearance)
  useEffect(() => {
    const root = document.documentElement
    const query = appearance === 'system' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined
    const apply = () => {
      const resolved = resolveAppearance(appearance, query?.matches ?? false)
      root.setAttribute('data-theme', resolved)
      let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      if (!meta) {
        meta = document.createElement('meta')
        meta.name = 'theme-color'
        document.head.appendChild(meta)
      }
      meta.content = THEME_COLORS[resolved]
    }
    apply()
    query?.addEventListener?.('change', apply)
    return () => query?.removeEventListener?.('change', apply)
  }, [appearance])
  return null
}

/**
 * 画面（パス）が変わったら先頭から表示する（スマホでトップを下までスクロールしてから設定を開いた時など）。
 * ブラウザの「戻る／進む」では動かさない（ブラウザが元の位置に戻す）
 */
function ScrollOnNavigate() {
  const { pathname } = useLocation()
  const navType = useNavigationType()
  useLayoutEffect(() => {
    if (navType !== 'POP') window.scrollTo(0, 0)
    // パスが変わった時だけ動かす（navType は同じ時に一緒に変わるので、依存に入れない）
  }, [pathname])
  return null
}

/** 画面が変わったら、開いたままの確認・入力ダイアログはキャンセル扱いで閉じる */
function CloseDialogsOnNavigate() {
  const { pathname } = useLocation()
  useEffect(() => cancelAllDialogs, [pathname])
  return null
}

export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <ScrollOnNavigate />
      <CloseDialogsOnNavigate />
      <PrefsEffect />
      <UpdateBanner />
      {children}
      <Toasts />
      <DialogHost />
    </div>
  )
}
