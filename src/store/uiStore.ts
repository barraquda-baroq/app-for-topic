// 端末ごとの表示の設定（外観・起動アニメーション・記事の字の大きさ）とお知らせ（トースト）。
// 表示の設定は localStorage の topic-studio:prefs に保存する（同期しない。使えない環境でも既定値で動く。docs/SPEC.md の 7.5・14.3）。
// DS の src/store/uiStore.ts から、DS だけの設定（最後のモード・登録の画面・リストの畳んだ状態）を外した物
// （DS は NS の物から、resolveAppearance・migratePrefs・THEME_COLORS・トースト・attempt・アプリの更新の仕組みを写した）。
// 段階2で、記事の字の大きさ（textSize）と、端末に覚えないトップの画面の状態（useTopUi）を足した
import { create } from 'zustand'
import { DomainError } from '../domain/types'

/** 外観。ホワイト／ダーク／ディープダーク（docs/SPEC.md の 10.） */
export type Appearance = 'white' | 'dark' | 'deep-dark'
/** 外観の設定。system は端末の設定（ライト／ダーク）に合わせてホワイトかダークになる */
export type AppearanceMode = 'system' | Appearance

/** 記事の字の大きさ。小・中・大（docs/SPEC.md の 9.。<html data-text-size> に入れ、src/styles.css の --read-size などを替える） */
export type TextSize = 's' | 'm' | 'l'

export interface Prefs {
  appearance: AppearanceMode
  /**
   * 起動アニメーションを出す（既定オン）。index.html に埋め込んだ src/launch/launch.js が、アプリより先にこの値を読む
   * （false の時だけ出さない）
   */
  launchAnimation: boolean
  /**
   * 記事の字の大きさ（既定は中。カードの見出し・要約、詳細の本文・用語の説明・元記事だけに効く）。src/launch/launch.js も最初の描画の
   * 前に読んで <html data-text-size> に入れる（字の大きさが一瞬跳ばないように。設計: 段階2の 1.1・1.18）
   */
  textSize: TextSize
}

const APPEARANCE_MODES: readonly AppearanceMode[] = ['system', 'white', 'dark', 'deep-dark']
export const TEXT_SIZES: readonly TextSize[] = ['s', 'm', 'l']

/**
 * 初めは「端末の設定に合わせる」・起動アニメーションはオン・記事の字は中（16px。読む画面の本文として 15px より楽なため。開発。
 * 設計: 段階2の 3.4。■9 で確かめる）
 */
export const DEFAULT_PREFS: Prefs = {
  appearance: 'system',
  launchAnimation: true,
  textSize: 'm',
}

export const PREFS_KEY = 'topic-studio:prefs'

/**
 * 保存形式の版（保存する時に v として書く。設定の値には含めない）。段階2で textSize を足しても上げない（無い・知らない値は既定に
 * 戻すだけで、前の版の設定もそのまま読めるため。設計: 段階2の 1.1）
 */
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
    textSize: oneOf(stored.textSize, TEXT_SIZES, d.textSize),
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
  const { appearance, launchAnimation, textSize } = s
  return { appearance, launchAnimation, textSize }
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...loadPrefs(),
  setPrefs: (patch) => {
    set(patch)
    savePrefs(currentPrefs(get()))
  },
}))

// ---------- トップの画面の状態（端末に覚えない。docs/SPEC.md の 7.5・9.。設計: 段階2の 1.1・1.6・2.） ----------

/**
 * 版ごとの、トップを離れた時の位置（ほかの画面から戻った時に戻す）。scroll は、S・M はページ（'page'）、L は列ごと（'jp'・'world'。
 * ページは動かさず列の中だけスクロールするため）の位置（px）。section は S・M の切り替えの列の今の区切り（L は null）
 */
export interface TopPlace {
  scroll: Record<string, number>
  section: string | null
}

interface TopUiState {
  /**
   * 開いている「既読 n件」（foldKey(版の id, 区切り) → true）。アプリを開くたびに全部畳んで始める（端末に覚えない。DS の S・M の
   * リストと同じ作り）
   */
  openFolds: Record<string, true>
  /** 版ごとの、トップを離れた時の位置（読み込み直した・開き直した時は無いので先頭から） */
  places: Record<string, TopPlace>
  /** 「既読 n件」を開く・畳む */
  setFoldOpen: (editionId: string, section: string, open: boolean) => void
  /** トップを離れる時の位置を覚える */
  setPlace: (editionId: string, place: TopPlace) => void
}

/** 「既読 n件」の開け閉めの鍵（版の id と区切り。区切りは S・M の 'all'・ジャンル、L の 'jp'・'world'・'other'） */
export function foldKey(editionId: string, section: string): string {
  return `${editionId}\n${section}`
}

/** トップの画面の状態（開いている間だけ保つ。localStorage に書かない） */
export const useTopUi = create<TopUiState>((set, get) => ({
  openFolds: {},
  places: {},
  setFoldOpen: (editionId, section, open) => {
    const next = { ...get().openFolds }
    if (open) next[foldKey(editionId, section)] = true
    else delete next[foldKey(editionId, section)]
    set({ openFolds: next })
  },
  setPlace: (editionId, place) => set({ places: { ...get().places, [editionId]: place } }),
}))

/** テスト用: トップの画面の状態を、アプリを開いた時の物に戻す */
export function resetTopUiForTests(): void {
  useTopUi.setState({ openFolds: {}, places: {} })
}

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
