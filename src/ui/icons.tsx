// 小さなインライン SVG の線のアイコン集（外部依存なし）。DS の src/ui/icons.tsx から、段階0の画面で使う物（歯車・×・✓・下向きの矢印）
// だけを写した物（DS は NS の物から）。どれも 24 四方・線の太さ 1.8・端が丸い・文字と同じ色（currentColor）。大きさは CSS の .icon（18px）で決める。
// 段階2で画面に要る物を DS・NS から足す
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
