// Claude との連携（設定の「Claude との連携」・連携の画面）で使うアイコン。NS の src/features/claude/claudeIcons.tsx から、TS で使う
// コネクタの印（差し込み）だけを写した物。作りは src/ui/icons.tsx と同じ（24 四方・線 1.8・丸い端・文字と同じ色・飾り）
import type { SVGProps } from 'react'
import { ICON_STROKE } from '../../ui/icons'

/** コネクタ（差し込み） */
export const PlugIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg
    className="icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={ICON_STROKE}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...p}
  >
    <path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0z" />
    <path d="M12 16v5" />
  </svg>
)
