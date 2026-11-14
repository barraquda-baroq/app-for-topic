// 画面の行き先と外枠。DS の段階0の src/App.tsx から（DS の MIM の行き先を外し、ログインの関所を DS の段階1の形（持ち主だと確かめた
// アカウントの時だけ画面を出す）にした物）。段階0の行き先はトップ・ログイン・設定の3つ（docs/SPEC.md の 14.5）
import { lazy, Suspense } from 'react'
import {
  createHashRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
  useRouteError,
  type RouteObject,
} from 'react-router-dom'
import { LoginPage } from './features/login/LoginPage'
import { startTestAuth } from './features/login/testAuth'
import { TopPage } from './features/top/TopPage'
import { paths } from './routes'
import { canShowData, useSync } from './sync/controller'
import { ErrorBoundary, ErrorScreen } from './ui/ErrorBoundary'
import { AppFrame } from './ui/Layout'
import { NotFound } from './ui/NotFound'

// 起動を軽くするため、トップ・ログイン以外の画面は開いた時に読み込む（PWA ではオフライン用に事前キャッシュされる）
const AppSettingsPage = lazy(() => import('./features/appSettings/AppSettingsPage').then((m) => ({ default: m.AppSettingsPage })))

function PageLoading() {
  return (
    <div className="page" role="status">
      <p className="muted">読み込み中…</p>
    </div>
  )
}

/**
 * ログインと持ち主の関所（docs/SPEC.md の 14.4）: ログインしていない間・この端末で持ち主だと確かめていない間は、ログインの画面だけを
 * 出す（トップ・設定の画面を出さない。まだ確かめていない・持ち主でない時は、ログインの画面に文と［ログアウト］を出す）。
 * 確かめたらログインの画面からトップへ。ログインの状態を確かめている間は「読み込み中…」（起動アニメーションの下）
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const auth = useSync((s) => s.auth)
  const show = useSync(canShowData)
  const { pathname } = useLocation()
  if (auth === 'idle' || auth === 'checking') return <PageLoading />
  if (!show && pathname !== paths.login()) return <Navigate to={paths.login()} replace />
  if (show && pathname === paths.login()) return <Navigate to={paths.top()} replace />
  return <>{children}</>
}

/** 1つの画面で描画エラーが起きても、他の画面へ移ればまた表示できるようにする */
function RouteErrorBoundary({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
}

/** すべての画面の外枠。画面ごとの中身は <Outlet /> に入る */
function RootLayout() {
  return (
    <AppFrame>
      <AuthGate>
        <RouteErrorBoundary>
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </RouteErrorBoundary>
      </AuthGate>
    </AppFrame>
  )
}

/** 外枠そのものの描画に失敗した時（ふつうは各画面のエラー表示 RouteErrorBoundary が受け止める） */
function RootError() {
  const error = useRouteError()
  console.error('画面の表示中にエラーが起きました', error)
  return <ErrorScreen message={error instanceof Error ? error.message : String(error)} />
}

export const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    errorElement: <RootError />,
    children: [
      { path: paths.top(), element: <TopPage /> },
      { path: paths.login(), element: <LoginPage /> },
      { path: paths.settings(), element: <AppSettingsPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]

// 画面を離れる前の確認（useBlocker）を後で使えるよう、NS・DS と同じくデータルーターにする
let router: ReturnType<typeof createHashRouter> | null = null

export function App() {
  // テストの時だけ: localStorage の topic-studio:test-auth があれば、ログインした状態で開く（開発サーバーだけ。src/features/login/testAuth.ts）
  if (import.meta.env.DEV) void startTestAuth()
  router ??= createHashRouter(routes)
  return <RouterProvider router={router} />
}
