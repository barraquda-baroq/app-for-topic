// S・M のトップの上に固定の切り替えの列「総合｜政治｜経済｜テック｜AI｜事件｜スポーツ｜エンタメ」（docs/SPEC.md の 9.。DS の
// src/features/top/TopPage.tsx の .top-switcher を写した物。設計: 段階2の 1.3）。押すとその区切りの先頭へ移る（移す処理と、今の区切りを
// スクロールの位置で決めるのは TopStack）。今の区切りは aria-current と下の 2px の線。
// 数は付けない（付けると 360px に入らない。D9 にも寄せる）。話題が0本のジャンルは押せない見た目（aria-disabled・淡い字）にし、
// 位置は動かさない（DS の 3.7 の考え）。言葉は短い形（src/domain/fixedTexts.ts の GENRE_TAB_LABELS。「テック」「事件」）
import type { JSX, Ref } from 'react'
import { testIds } from './testIds'

export interface SwitcherTab {
  /** 区切り（'all' かジャンル） */
  section: string
  label: string
  /** 話題が0本（押せない見た目。位置は残す） */
  empty: boolean
  /** 移る先の区切りの要素の id（aria-controls） */
  controls?: string
}

export interface GenreSwitcherProps {
  tabs: readonly SwitcherTab[]
  /** 今の区切り */
  current: string
  /** 押した時（話題が0本のジャンルは呼ばない） */
  onJump: (section: string) => void
  navRef?: Ref<HTMLElement>
}

export function GenreSwitcher({ tabs, current, onJump, navRef }: GenreSwitcherProps): JSX.Element {
  return (
    <nav ref={navRef} className="top-switcher" aria-label="総合とジャンルへ移動" data-testid={testIds.topSwitcher}>
      <div className="top-switcher-row">
        {tabs.map((t) => (
          <button
            key={t.section}
            type="button"
            className={`top-switcher-btn${t.empty ? ' is-empty' : ''}`}
            aria-current={current === t.section ? 'true' : undefined}
            aria-disabled={t.empty ? 'true' : undefined}
            aria-controls={t.empty ? undefined : t.controls}
            onClick={() => {
              if (!t.empty) onJump(t.section)
            }}
            data-testid={testIds.topSwitcherTab}
            data-section={t.section}
          >
            <span className="top-switcher-name">{t.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
