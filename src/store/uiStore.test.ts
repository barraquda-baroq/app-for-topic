// 端末ごとの表示の設定（docs/SPEC.md の 7.5・14.3）とお知らせ。DS の src/store/uiStore.test.ts から（DS だけの設定の分を外した）。
// 段階2で、記事の字の大きさ（textSize）と、端末に覚えないトップの画面の状態（useTopUi）の確かめを足した
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PREFS,
  foldKey,
  migratePrefs,
  PREFS_KEY,
  PREFS_VERSION,
  resetTopUiForTests,
  resolveAppearance,
  THEME_COLORS,
  useTopUi,
} from './uiStore'

describe('表示の設定の読み直し（migratePrefs）', () => {
  it('初めは「端末の設定に合わせる」・起動アニメーションはオン・記事の字は中。保存先は topic-studio:prefs', () => {
    expect(DEFAULT_PREFS).toEqual({ appearance: 'system', launchAnimation: true, textSize: 'm' })
    expect(PREFS_KEY).toBe('topic-studio:prefs')
  })

  it('保存した設定はそのまま読む（保存形式の版 v は設定の値に含めない。DS だけの項目は読まない）', () => {
    const prefs = migratePrefs({
      v: PREFS_VERSION,
      appearance: 'deep-dark',
      launchAnimation: false,
      textSize: 'l',
      lastMode: 'week',
    })
    expect(prefs).toEqual({ appearance: 'deep-dark', launchAnimation: false, textSize: 'l' })
  })

  it('記事の字の大きさは小・中・大のどれか。無い（段階1までの設定）・知らない値は中にする。保存形式の版は上げない（1 のまま）', () => {
    for (const t of ['s', 'm', 'l'] as const) expect(migratePrefs({ textSize: t }).textSize).toBe(t)
    expect(migratePrefs({ v: 1, appearance: 'dark', launchAnimation: false })).toEqual({
      appearance: 'dark',
      launchAnimation: false,
      textSize: 'm',
    })
    for (const bad of ['xl', 'M', 16, null, true]) expect(migratePrefs({ textSize: bad }).textSize).toBe('m')
    expect(PREFS_VERSION).toBe(1)
  })

  it('外観は4つのどれか。NS の項目名（theme）・NS 1.x の light は読まない', () => {
    for (const a of ['system', 'white', 'dark', 'deep-dark'] as const) expect(migratePrefs({ appearance: a }).appearance).toBe(a)
    expect(migratePrefs({ appearance: 'light' }).appearance).toBe('system')
    expect(migratePrefs({ theme: 'dark' }).appearance).toBe('system')
  })

  it('知らない値・型の違う値・壊れたデータは既定値にする', () => {
    expect(migratePrefs({ appearance: 'sepia', launchAnimation: 'off', textSize: 'huge', extra: 1 })).toEqual(DEFAULT_PREFS)
    expect(migratePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(migratePrefs('dark')).toEqual(DEFAULT_PREFS)
    expect(migratePrefs([1, 2])).toEqual(DEFAULT_PREFS)
  })
})

describe('外観の決定（resolveAppearance）', () => {
  it('「端末の設定に合わせる」は端末がダークならダーク、そうでなければホワイト', () => {
    expect(resolveAppearance('system', true)).toBe('dark')
    expect(resolveAppearance('system', false)).toBe('white')
  })

  it('選んだ外観は端末の設定によらずそのまま', () => {
    for (const systemDark of [true, false]) {
      expect(resolveAppearance('white', systemDark)).toBe('white')
      expect(resolveAppearance('dark', systemDark)).toBe('dark')
      expect(resolveAppearance('deep-dark', systemDark)).toBe('deep-dark')
    }
  })

  it('ブラウザの枠の色は、起動アニメーション（src/launch/launch.js）の物と同じ（DS と同じ値）', () => {
    expect(THEME_COLORS).toEqual({ white: '#ffffff', dark: '#17181b', 'deep-dark': '#0e0f11' })
  })
})

describe('起動時の読み込みと保存', () => {
  afterEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('保存した設定を読み込み、変えると版つきで書く（起動アニメーションの launch.js が読む appearance・launchAnimation）', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ v: 1, appearance: 'dark' }))
    vi.resetModules()
    const { usePrefs } = await import('./uiStore')
    expect(usePrefs.getState().appearance).toBe('dark')

    usePrefs.getState().setPrefs({ appearance: 'deep-dark', launchAnimation: false })
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>
    expect(stored).toEqual({ v: PREFS_VERSION, appearance: 'deep-dark', launchAnimation: false, textSize: 'm' })

    // 記事の字の大きさも書く（起動アニメーションの launch.js も読む）
    usePrefs.getState().setPrefs({ textSize: 's' })
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')).toEqual({
      v: PREFS_VERSION,
      appearance: 'deep-dark',
      launchAnimation: false,
      textSize: 's',
    })

    vi.resetModules()
    const again = await import('./uiStore')
    expect(again.usePrefs.getState().appearance).toBe('deep-dark')
    expect(again.usePrefs.getState().launchAnimation).toBe(false)
    expect(again.usePrefs.getState().textSize).toBe('s')
  })

  it('保存内容が壊れていても既定値で起動する', async () => {
    localStorage.setItem(PREFS_KEY, '{not json')
    vi.resetModules()
    const { usePrefs } = await import('./uiStore')
    expect(usePrefs.getState().appearance).toBe('system')
    expect(usePrefs.getState().launchAnimation).toBe(true)
  })
})

describe('トップの画面の状態（useTopUi。端末に覚えない）', () => {
  afterEach(() => {
    resetTopUiForTests()
    localStorage.clear()
    vi.resetModules()
  })

  it('「既読 n件」は版と区切りごとに開け閉めし、初めは全部畳んでいる', () => {
    expect(useTopUi.getState().openFolds).toEqual({})
    useTopUi.getState().setFoldOpen('2026-11-15-12', 'all', true)
    useTopUi.getState().setFoldOpen('2026-11-15-12', 'politics', true)
    useTopUi.getState().setFoldOpen('2026-11-14-20', 'all', true)
    expect(Object.keys(useTopUi.getState().openFolds).sort()).toEqual(
      [foldKey('2026-11-14-20', 'all'), foldKey('2026-11-15-12', 'all'), foldKey('2026-11-15-12', 'politics')].sort(),
    )
    useTopUi.getState().setFoldOpen('2026-11-15-12', 'all', false)
    expect(useTopUi.getState().openFolds[foldKey('2026-11-15-12', 'all')]).toBeUndefined()
    expect(useTopUi.getState().openFolds[foldKey('2026-11-15-12', 'politics')]).toBe(true)
    // 版の id と区切りの組で分ける（区切りの名前が版の id に混ざらない）
    expect(foldKey('2026-11-15-12', 'all')).not.toBe(foldKey('2026-11-15-1', '2all'))
  })

  it('版ごとの位置（ページ・列ごとのスクロールと今の区切り）を覚える', () => {
    useTopUi.getState().setPlace('2026-11-15-12', { scroll: { page: 840 }, section: 'economy' })
    useTopUi.getState().setPlace('2026-11-14-20', { scroll: { jp: 120, world: 0 }, section: null })
    expect(useTopUi.getState().places['2026-11-15-12']).toEqual({ scroll: { page: 840 }, section: 'economy' })
    expect(useTopUi.getState().places['2026-11-14-20']).toEqual({ scroll: { jp: 120, world: 0 }, section: null })
  })

  it('localStorage に書かず、アプリを開き直すと畳んで先頭から始まる', async () => {
    localStorage.clear()
    useTopUi.getState().setFoldOpen('2026-11-15-12', 'all', true)
    useTopUi.getState().setPlace('2026-11-15-12', { scroll: { page: 840 }, section: 'economy' })
    expect(localStorage.length).toBe(0)
    vi.resetModules()
    const again = await import('./uiStore')
    expect(again.useTopUi.getState().openFolds).toEqual({})
    expect(again.useTopUi.getState().places).toEqual({})
  })
})

describe('お知らせ（トースト）', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
  })

  it('ふつうは4秒、ボタン付き・エラーは6秒で消える。3つまで重ねる', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { notify, notifyError, useToasts } = await import('./uiStore')
    notify('ふつう')
    notify('ボタン付き', { label: '元に戻す', run: () => {} })
    notifyError('エラー')
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['ふつう', 'ボタン付き', 'エラー'])
    vi.advanceTimersByTime(4000)
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['ボタン付き', 'エラー'])
    vi.advanceTimersByTime(2000)
    expect(useToasts.getState().toasts).toEqual([])

    for (const m of ['1', '2', '3', '4']) notify(m)
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['2', '3', '4'])
  })

  it('attempt: 失敗はエラーのお知らせにして undefined を返す', async () => {
    vi.resetModules()
    const { attempt, useToasts } = await import('./uiStore')
    const { DomainError } = await import('../domain/types')
    expect(attempt(() => 1)).toBe(1)
    expect(
      attempt(() => {
        throw new DomainError('できません')
      }),
    ).toBeUndefined()
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ kind: 'error', message: 'できません' })
  })
})
