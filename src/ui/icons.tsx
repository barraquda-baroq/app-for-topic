// 小さなインライン SVG の線のアイコン集（外部依存なし）。DS の src/ui/icons.tsx から、段階0の画面で使う物（歯車・×・✓・下向きの矢印）
// だけを写した物（DS は NS の物から）。どれも 24 四方・線の太さ 1.8・端が丸い・文字と同じ色（currentColor）。大きさは CSS の .icon（18px）で決める。
// 段階2で、画面に要る物を DS から足した（下向きの山形・左右の山形・クリップ・同期の雲2つ）。外へのリンクは DS の LinkIcon が鎖の形なので
// 写さず、TS で描き足した（設計: 段階2の 1.1）
import type { ReactNode, SVGProps } from 'react'

/**
 * title を渡すと読み上げる絵（role="img"）になり、渡さなければ飾り（aria-hidden）になる。
 * small は 14px より小さく出す時: 12px にして線を 2.4 にする（12px で線が 1.2px になり、等倍の画面でにじまない）
 */
export type IconProps = SVGProps<SVGSVGElement> & { title?: string; small?: boolean }

/** 線の太さ（ふつう） */
export const ICON_STROKE = 1.8
/** 線の太さ（14px より小さく出す時） */
export const ICON_STROKE_SMALL = 2.4

function Svg({ title, small, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={small ? 'icon icon-sm' : 'icon'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={small ? ICON_STROKE_SMALL : ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  )
}

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12 5 5 9-10" />
  </Svg>
)
export const XIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)
export const GearIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
)
export const DownloadIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Svg>
)

// ---------- 段階2で DS から写したアイコン（名前も DS のまま） ----------

/** 畳む・開く（「既読 n件」・版の表示の ▾ など）: 下向きの山形（DS の名前のまま。DS に ChevronDownIcon は無い） */
export const DownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
)
/** 先へ（「この版の選び方 ▸」など）: 右向きの山形 */
export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
)
/** 戻る（設定の［‹ 戻る］など）: 左向きの山形 */
export const ChevronLeftIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m15 6-6 6 6 6" />
  </Svg>
)
/** ［クリップ］（文をクリップボードへ）: 重なった2枚の紙 */
export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Svg>
)

const CLOUD = 'M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.4 9.1 4.5 4.5 0 0 0 7 18z'

/** 同期の表示: 雲 */
export const CloudIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d={CLOUD} />
  </Svg>
)

/** 同期の表示（オフライン・止まっている時）: 斜線付きの雲 */
export const CloudOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d={CLOUD} />
    <path d="m4 4 16 16" />
  </Svg>
)

// ---------- 段階2で TS が描き足したアイコン ----------

/** 外へのリンク（元記事。新しいタブで開く）: 右上の角が開いた四角と、そこから右上へ出る矢印 */
export const ExternalLinkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4.5" />
    <path d="M14 4h6v6M20 4l-9 9" />
  </Svg>
)
