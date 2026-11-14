// 端末ごとの表示の設定（外観・起動アニメーション）とお知らせ（トースト）。
// 表示の設定は localStorage の topic-studio:prefs に保存する（同期しない。使えない環境でも既定値で動く。docs/SPEC.md の 7.5・14.3）。
// DS の src/store/uiStore.ts から、DS だけの設定（最後のモード・登録の画面・リストの畳んだ状態）を外した物
// （DS は NS の物から、resolveAppearance・migratePrefs・THEME_COLORS・トースト・attempt・アプリの更新の仕組みを写した）
import { create } from 'zustand'
import { DomainError } from '../domain/types'

/** 外観。ホワイト／ダーク／ディープダーク（docs/SPEC.md の 10.） */
export type Appearance = 'white' | 'dark' | 'deep-dark'
/** 外観の設定。system は端末の設定（ライト／ダーク）に合わせてホワイトかダークになる */
export type AppearanceMode = 'system' | Appearance

export interface Prefs {
  appearance: AppearanceMode
  /**
   * 起動アニメーションを出す（既定オン）。index.html に埋め込んだ src/launch/launch.js が、アプリより先にこの値を読む
   * （false の時だけ出さない）
   */
  launchAnimation: boolean
}

const APPEARANCE_MODES: readonly AppearanceMode[] = ['system', 'white', 'dark', 'deep-dark']

/** 初めは「端末の設定に合わせる」・起動アニメーションはオン */
export const DEFAULT_PREFS: Prefs = {
  appearance: 'system',
  launchAnimation: true,
}

export const PREFS_KEY = 'topic-studio:prefs'

/** 保存形式の版（保存する時に v として書く。設定の値には含めない） */
export const PREFS_VERSION = 1

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)

/** localStorage に保存していた表示の設定を今の形に直す（知らない値・型の違う値・壊れた値は既定値にする） */
export function migratePrefs(stored: unknown): Prefs {
  if (!isRecord(stored)) return DEFAULT_PREFS
  const d = DEFAULT_PREFS
  return {
    appearance: oneOf(stored.appearance, APPEARANCE_MODES, d.appearance),
    launchAnimation: bool(stored.launchAnimation, d.launchAnimation),
  }
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    return migratePrefs(JSON.parse(raw))
  } catch {
    return DEFAULT_PREFS
  }
}

/** 外観の設定から実際の外観を決める（「端末の設定に合わせる」は端末がダークならダーク、そうでなければホワイト） */
export function resolveAppearance(mode: AppearanceMode, systemDark: boolean): Appearance {
  if (mode === 'system') return systemDark ? 'dark' : 'white'
  return mode
}

/**
 * ブラウザの枠（アドレスバー・ステータスバー）の色。ヘッダーの背景（--surface）に合わせる（docs/SPEC.md の 14.3）。
 * 最初の描画の前に外観を決める src/launch/launch.js（index.html に埋め込む）にも同じ値がある（変える時は両方そろえる）。
 */
export const THEME_COLORS: Record<Appearance, string> = {
  white: '#ffffff',
  dark: '#17181b',
  'deep-dark': '#0e0f11',
}

interface PrefsState extends Prefs {
  setPrefs: (patch: Partial<Prefs>) => void
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ v: PREFS_VERSION, ...prefs }))
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

/** 今の設定（関数を除く） */
function currentPrefs(s: PrefsState): Prefs {
  const { appearance, launchAnimation } = s
  return { appearance, launchAnimation }
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...loadPrefs(),
  setPrefs: (patch) => {
    set(patch)
    savePrefs(currentPrefs(get()))
  },
}))

// ---------- お知らせ（トースト。DS の docs/SPEC.md の 3.9） ----------

export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  id: number
  kind: 'info' | 'error'
  message: string
  /** ［元に戻す］などのボタン */
  action?: ToastAction
}

/** 消えるまで: ふつうは4秒、ボタン付き・エラーは6秒 */
export const TOAST_MS = { info: 4000, long: 6000 }
/** 重ねて出す数 */
const TOAST_MAX = 3

interface ToastState {
  toasts: Toast[]
  push: (kind: Toast['kind'], message: string, action?: ToastAction) => void
  dismiss: (id: number) => void
}

let toastSeq = 0

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message, action) => {
    const id = ++toastSeq
    set({ toasts: [...get().toasts.slice(-(TOAST_MAX - 1)), { id, kind, message, action }] })
    setTimeout(() => get().dismiss(id), kind === 'error' || action ? TOAST_MS.long : TOAST_MS.info)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

export function notify(message: string, action?: ToastAction): void {
  useToasts.getState().push('info', message, action)
}

export function notifyError(message: string): void {
  useToasts.getState().push('error', message)
}

/**
 * 操作を実行し、仕様上できない操作（DomainError）はエラーのお知らせで知らせる。
 * 成功時は戻り値を、失敗時は undefined を返す。
 */
export function attempt<R>(fn: () => R): R | undefined {
  try {
    return fn()
  } catch (e) {
    if (e instanceof DomainError) {
      notifyError(e.message)
      return undefined
    }
    notifyError(e instanceof Error ? e.message : String(e))
    console.error(e)
    return undefined
  }
}

// ---------- アプリ（PWA）の更新 ----------

interface UpdateState {
  /** 新しいバージョンが用意できた */
  ready: boolean
  /** 保存してから新しいバージョンに切り替える */
  apply: (() => Promise<void>) | null
}

export const useAppUpdate = create<UpdateState>(() => ({ ready: false, apply: null }))
