// 話題の詳細の開け閉めと履歴（docs/SPEC.md の 9.・14.5）。DS の src/features/calendar/common/sheets.ts の「同じ行き先に state.sheet を
// 積む」形を写した物（DS の iPhone の絵の手当て whenScreenClean と、登録の画面の分は外した）。
// 詳細は行き先にせず、開いている画面（トップ・前の版・追いつき）の行き先のまま、履歴の state に { sheet, sheetPage } を積む
// （行き先にすると、移るたびに一覧が先頭へ戻り、今の版の一覧が作り直されるため。DS と同じ。開発。設計: 段階2）。
// ［×］・Esc・背景で閉じる時は履歴を1つ戻す（戻る物が無い時は state.sheet を外して置き換える）。OS の「戻る」でも state.sheet が
// 無くなるので閉じる。もう開いている時に開く（前の話題・続報へのリンク）は置き換えて、履歴を増やさない。
// どこに出すか（S・M は下からのシート、L は side の列に重ねるパネル。差し込み口が無ければ真ん中の小さな画面）は
// src/features/topic/TopicHost.tsx が決める。L の列は PanelSlot（差し込み口）を置き、出ている間だけ usePanelSlots に入る
import { createElement, useContext, useLayoutEffect, useMemo, useRef, type JSX } from 'react'
import { UNSAFE_DataRouterContext, useLocation, useNavigate, type Location } from 'react-router-dom'
import { create, type StoreApi, type UseBoundStore } from 'zustand'

/** L で詳細を重ねる列（国内・世界） */
export type PanelSide = 'jp' | 'world'

/** 履歴の state.sheet。side は L で重ねる列（S・M と、列の無い画面は null） */
export interface TopicSheetState {
  kind: 'topic'
  id: string
  side: PanelSide | null
}

/**
 * このページの読み込みの印。詳細を開いた時に state に一緒に置き、読み込み直した後に残った state.sheet と見分ける
 * （読み込み直した後は、その話題が端末にあれば TopicHost が開き直し、無ければ閉じる。docs/SPEC.md の 9.。DS と同じ）
 */
export const PAGE_ID = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** 履歴の state（詳細の印と、それを開いたページの印。ほかの物と並ぶ） */
export interface SheetHistoryState {
  sheet?: TopicSheetState
  /** 詳細を開いた時のページの読み込みの印（PAGE_ID） */
  sheetPage?: string
}

const PANEL_SIDES: readonly PanelSide[] = ['jp', 'world']

/** 履歴の state から、開いている詳細（無い・形の違う物は null） */
export function sheetOf(state: unknown): TopicSheetState | null {
  if (!state || typeof state !== 'object') return null
  const sheet = (state as SheetHistoryState).sheet as unknown
  if (!sheet || typeof sheet !== 'object') return null
  const s = sheet as Partial<TopicSheetState>
  if (s.kind !== 'topic' || typeof s.id !== 'string' || s.id === '') return null
  const side = PANEL_SIDES.includes(s.side as PanelSide) ? (s.side as PanelSide) : null
  return { kind: 'topic', id: s.id, side }
}

/** その詳細の印が、このページの読み込みの後に開いた物か（読み込み直す前の物でないか） */
export function openedOnThisPage(state: unknown): boolean {
  return Boolean(state && typeof state === 'object' && (state as SheetHistoryState).sheetPage === PAGE_ID)
}

/** navigate の state にそのまま渡す物（開発用のフック・テストも使う） */
export function sheetState(topicId: string, side: PanelSide | null): { sheet: TopicSheetState; sheetPage: string } {
  return { sheet: { kind: 'topic', id: topicId, side }, sheetPage: PAGE_ID }
}

/** 履歴の state から詳細の印を外した物（ほかの物は残す） */
function withoutSheet(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== 'object') return {}
  const rest = { ...(state as Record<string, unknown>) }
  delete rest.sheet
  delete rest.sheetPage
  return rest
}

/**
 * 閉じるために履歴を戻している所（同じ所でもう一度押しても2つ戻らないように。key と時刻。DS と同じ）。時刻は performance.now
 * （E2E・見本は Date を止めて開くので、Date.now では「戻るのを待つ間」が終わらない）
 */
let popping: { key: string; at: number } | null = null
/** 戻るのを待つ間（この間に同じ所でもう一度閉じても戻らない） */
export const POP_GUARD_MS = 1000

/**
 * このアプリの履歴の最初の項目か（React Router のハッシュの履歴は history.state.idx に番号を置く）。最初の項目で戻ると
 * アプリの外へ出るので、戻らずに置き換える。メモリの履歴（テスト）では番号が無いので、key だけで決める
 */
function atFirstEntry(): boolean {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx
  return typeof idx === 'number' && idx === 0
}

/**
 * 押した時の今の行き先を読む物（描いた時の行き先ではなく、ルーターが今いる所）。閉じるは、開いた部品が消えた後に呼ばれることが
 * ある（クリップの窓を閉じた後など）。描いた時の行き先で決めると、閉じた後の一覧の履歴を詳細で置き換えたり、もう1つ前の画面まで
 * 戻ったりする（DS と同じ）。データのルーター（src/App.tsx の createHashRouter・テストの createMemoryRouter）の中だけで使う
 */
export function useCurrentLocation(): () => Location {
  const data = useContext(UNSAFE_DataRouterContext)
  if (!data) throw new Error('useCurrentLocation はデータのルーターの中で使います')
  const { router } = data
  return useMemo(() => () => router.state.location, [router])
}

export interface TopicSheetApi {
  /** 開いている詳細（無ければ null） */
  current: TopicSheetState | null
  /**
   * 開く（もう開いている時は置き換え。履歴を増やさない）。side を渡さない時は、もう開いている詳細の列のまま（前の話題へのリンクで
   * パネルが真ん中の小さな画面に替わらないように）、開いていなければ null
   */
  openTopic: (topicId: string, opts?: { side?: PanelSide | null }) => void
  /** 閉じる（履歴を1つ戻す。戻る物が無ければ state.sheet を外して置き換え） */
  closeTopic: () => void
}

/**
 * 詳細を開く・閉じる（どの部品からも呼べる）。openTopic・closeTopic は描き直しても同じ物（行き先が変わっても作り直さないので、
 * React.memo のカードに渡しても描き直さない）。開く・閉じるは押した時の今の行き先から決める
 */
export function useTopicSheet(): TopicSheetApi {
  const navigate = useNavigate()
  const currentLocation = useCurrentLocation()
  const location = useLocation()
  const actions = useMemo(
    () => ({
      openTopic: (topicId: string, opts?: { side?: PanelSide | null }) => {
        const loc = currentLocation()
        const open = sheetOf(loc.state)
        const side = opts && 'side' in opts ? (opts.side ?? null) : (open?.side ?? null)
        const state: SheetHistoryState = { ...withoutSheet(loc.state), ...sheetState(topicId, side) }
        void navigate({ pathname: loc.pathname, search: loc.search }, { state, replace: open !== null })
      },
      closeTopic: () => {
        const loc = currentLocation()
        if (!sheetOf(loc.state)) return
        if (popping && popping.key === loc.key && performance.now() - popping.at < POP_GUARD_MS) return
        if (loc.key !== 'default' && !atFirstEntry()) {
          popping = { key: loc.key, at: performance.now() }
          void navigate(-1)
        } else {
          // 戻る物が無い（この行き先を詳細の印付きで開いた）時は、印を外して置き換える
          void navigate({ pathname: loc.pathname, search: loc.search }, { replace: true, state: withoutSheet(loc.state) })
        }
      },
    }),
    [navigate, currentLocation],
  )
  const open = sheetOf(location.state)
  const id = open?.id ?? null
  const side = open?.side ?? null
  // 中身が同じなら同じ物を返す（受け取る側の useEffect が、行き先が変わるたびに動かないように）
  const current = useMemo<TopicSheetState | null>(() => (id === null ? null : { kind: 'topic', id, side }), [id, side])
  return useMemo(() => ({ current, ...actions }), [current, actions])
}

/** L の列の差し込み口（列ごとに1つ。出ている間だけ要素が入る。パネルは side の差し込み口へ createPortal する） */
export const usePanelSlots: UseBoundStore<StoreApi<Record<PanelSide, HTMLElement | null>>> = create<
  Record<PanelSide, HTMLElement | null>
>(() => ({ jp: null, world: null }))

/**
 * L の列が置く差し込み口（列の一覧の兄弟に置く。列の中で position: absolute; inset: 0。空の間は箱を持たず、押せる所も持たない。
 * src/styles.css の .panel-slot）。出ている間だけ usePanelSlots に入る（testid panel-slot・data-side）
 */
export function PanelSlot({ side }: { side: PanelSide }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    usePanelSlots.setState({ [side]: el } as Partial<Record<PanelSide, HTMLElement | null>>)
    return () => {
      // 同じ列の差し込み口が先に置き替わっていたら、新しい方を消さない
      if (usePanelSlots.getState()[side] === el)
        usePanelSlots.setState({ [side]: null } as Partial<Record<PanelSide, HTMLElement | null>>)
    }
  }, [side])
  return createElement('div', { ref, className: 'panel-slot', 'data-testid': 'panel-slot', 'data-side': side })
}

/** テスト用: 閉じる時の守り（2回戻らない）を外す */
export function resetSheetsForTests(): void {
  popping = null
}
