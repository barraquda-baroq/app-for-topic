// 画面の行き先と外枠。DS の段階0の src/App.tsx から（DS の MIM の行き先を外し、ログインの関所を DS の段階1の形（持ち主だと確かめた
// アカウントの時だけ画面を出す）にした物）。段階0の行き先はトップ・ログイン・設定の3つ（docs/SPEC.md の 14.5）。
// 段階2で、前の版（#/e/{版の id}。トップと同じ TopPage で開く）・版の一覧（#/editions）・追いつき（#/catch-up）を足し、
// 話題の詳細を出す所（TopicHost）を外枠に1つだけ置いた（docs/SPEC.md の 9.。設計: 段階2の 1.1・1.9）。
// 段階3で、Claude 用のコネクタとの連携の画面（#/claude/connect?s=…）を、開いた時に読み込む画面として関所の中に足した（持ち主と
// 確かめた後だけ開ける。TS の config/owner はアプリから作れない。ログインしていなければログインの画面へ移り、ログインの後に戻る。
// 段階3の設計の 3.1）
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
import { peekConnectReturn, rememberConnectReturn } from './features/claude/connectReturn'
import { LoginPage } from './features/login/LoginPage'
import { startTestAuth } from './features/login/testAuth'
import { TopPage } from './features/top/TopPage'
import { TopicHost } from './features/topic/TopicHost'
import { EDITION_ROUTE, paths } from './routes'
import { canShowData, useSync } from './sync/controller'
import { ErrorBoundary, ErrorScreen } from './ui/ErrorBoundary'
import { AppFrame } from './ui/Layout'
import { NotFound } from './ui/NotFound'

// 起動を軽くするため、トップ・ログイン以外の画面は開いた時に読み込む（PWA ではオフライン用に事前キャッシュされる）
const AppSettingsPage = lazy(() => import('./features/appSettings/AppSettingsPage').then((m) => ({ default: m.AppSettingsPage })))
const EditionsPage = lazy(() => import('./features/editions/EditionsPage').then((m) => ({ default: m.EditionsPage })))
const CatchUpPage = lazy(() => import('./features/editions/CatchUpPage').then((m) => ({ default: m.CatchUpPage })))
const ConnectPage = lazy(() => import('./features/claude/ConnectPage').then((m) => ({ default: m.ConnectPage })))

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
 * 確かめたらログインの画面からトップへ。ログインの状態を確かめている間は「読み込み中…」（起動アニメーションの下）。
 * 連携の画面（#/claude/connect?s=…）からログインの画面へ移る時は、その行き先をこのタブに覚え、確かめた後にトップでなく連携の画面へ戻す
 * （src/features/claude/connectReturn.ts。覚えた物は連携の画面が開いた時に消す）
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const auth = useSync((s) => s.auth)
  const show = useSync(canShowData)
  const { pathname, search } = useLocation()
  if (auth === 'idle' || auth === 'checking') return <PageLoading />
  if (!show && pathname !== paths.login()) {
    if (pathname === paths.claudeConnect()) rememberConnectReturn(`${pathname}${search}`)
    return <Navigate to={paths.login()} replace />
  }
  if (show && pathname === paths.login()) return <Navigate to={peekConnectReturn() ?? paths.top()} replace />
  return <>{children}</>
}

/** 1つの画面で描画エラーが起きても、他の画面へ移ればまた表示できるようにする */
function RouteErrorBoundary({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
}

/**
 * 話題の詳細の描画でエラーが起きても、後ろの画面は残す。閉じる（履歴が戻る）・ほかの話題を開く・画面を移ると、もう一度描く
 * （履歴の項目ごとの key が変わるため）
 */
function DetailErrorBoundary({ children }: { children: React.ReactNode }) {
  const { pathname, key } = useLocation()
  return <ErrorBoundary resetKey={`${pathname}\n${key}`}>{children}</ErrorBoundary>
}

/**
 * すべての画面の外枠。画面ごとの中身は <Outlet /> に入る。話題の詳細（シート・パネル・真ん中の小さな画面）は、画面の後に置いた
 * TopicHost が履歴の state.sheet を見て出す（画面ごとに置かない。どの画面から開いても同じ所が出す。設計: 段階2の 1.9）
 */
function RootLayout() {
  return (
    <AppFrame>
      <AuthGate>
        <RouteErrorBoundary>
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </RouteErrorBoundary>
        <DetailErrorBoundary>
          <TopicHost />
        </DetailErrorBoundary>
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
      // 前の版はトップと同じ画面（TopPage が :editionId を読んで、その版を開く。読めない id は「見つかりません」）
      { path: EDITION_ROUTE, element: <TopPage /> },
      { path: paths.editions(), element: <EditionsPage /> },
      { path: paths.catchUp(), element: <CatchUpPage /> },
      { path: paths.login(), element: <LoginPage /> },
      { path: paths.settings(), element: <AppSettingsPage /> },
      { path: paths.claudeConnect(), element: <ConnectPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]

// 画面を離れる前の確認（useBlocker）を後で使えるよう、NS・DS と同じくデータルーターにする
let router: ReturnType<typeof createHashRouter> | null = null

/**
 * アプリのルーター（App を描くまでは null）。開発用のフック（src/main.tsx の window.__ts.openTopic）が、今の行き先に詳細の
 * state.sheet を積むのに使う（部品の外から行き先を動かすため。設計: 段階2の 4.2）
 */
export function appRouter(): ReturnType<typeof createHashRouter> | null {
  return router
}

export function App() {
  // テストの時だけ: localStorage の topic-studio:test-auth があれば、ログインした状態で開く（開発サーバーだけ。src/features/login/testAuth.ts）
  if (import.meta.env.DEV) void startTestAuth()
  router ??= createHashRouter(routes)
  return <RouterProvider router={router} />
}
