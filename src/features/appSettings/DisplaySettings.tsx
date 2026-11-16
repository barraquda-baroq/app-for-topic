// 設定の「表示」（この端末だけに保存。同期しない）: 外観4つと起動アニメーションのオン・オフ（docs/SPEC.md の 14.3・14.5）。
// DS の src/features/appSettings/DisplaySettings.tsx から、言葉を TS の物にした（DS は NS の物から）。
// 選んだ外観は src/ui/Layout.tsx の PrefsEffect が <html data-theme> に入れ、次に開いた時は src/launch/launch.js が最初の描画の前に入れる。
// 段階2で、記事の字の大きさ［小｜中｜大］（textSize。docs/SPEC.md の 9.・7.5。■9 の A。設計: 段階2の 1.18）を足した。外観と同じ
// .segmented の作りで、PrefsEffect と launch.js が <html data-text-size> に入れる（効くのはカードと詳細の記事の字だけ。src/styles.css）
import { useId } from 'react'
import { usePrefs, type AppearanceMode, type TextSize } from '../../store/uiStore'

/**
 * 外観の選択肢（並びは docs/SPEC.md の 10. の順）。chunks は、狭い画面で名前を折り返す時に切らずに保つ句
 * （「端末の設定に／合わせる」で折り返し、「合わせ／る」のように切れないように）
 */
export const APPEARANCE_OPTIONS: readonly { value: AppearanceMode; label: string; chunks?: readonly string[] }[] = [
  { value: 'system', label: '端末の設定に合わせる', chunks: ['端末の設定に', '合わせる'] },
  { value: 'white', label: 'ホワイト' },
  { value: 'dark', label: 'ダーク' },
  { value: 'deep-dark', label: 'ディープダーク' },
]

/** 記事の字の大きさの選択肢（小・中・大。既定は中。値は src/styles.css の --read-size など。設計: 段階2の 3.4） */
export const TEXT_SIZE_OPTIONS: readonly { value: TextSize; label: string }[] = [
  { value: 's', label: '小' },
  { value: 'm', label: '中' },
  { value: 'l', label: '大' },
]

export function DisplaySettings() {
  const id = useId()
  const appearance = usePrefs((s) => s.appearance)
  const launchAnimation = usePrefs((s) => s.launchAnimation)
  const textSize = usePrefs((s) => s.textSize)
  const setPrefs = usePrefs((s) => s.setPrefs)

  return (
    <section className="card aset-card" aria-labelledby={`${id}-title`} data-testid="display-settings">
      <div className="aset-card-head">
        <h2 id={`${id}-title`}>表示</h2>
        <p className="aset-card-lead">この端末だけの設定です。ほかの端末には影響しません。</p>
      </div>

      <div className="aset-row">
        <div className="aset-row-label">
          <span id={`${id}-appearance`}>外観</span>
          <span className="aset-row-desc">
            端末の設定に合わせると、端末がダークモードの時はダーク、それ以外はホワイトになります。ディープダークは、ダークよりさらに暗くして明るい色を抑えます。
          </span>
        </div>
        <div className="aset-row-control">
          <div className="segmented aset-seg aset-seg-theme" role="group" aria-labelledby={`${id}-appearance`}>
            {APPEARANCE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={appearance === o.value}
                onClick={() => setPrefs({ appearance: o.value })}
                data-testid={`appearance-${o.value}`}
              >
                {o.chunks
                  ? o.chunks.map((c) => (
                      <span key={c} className="aset-chunk">
                        {c}
                      </span>
                    ))
                  : o.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="aset-row">
        <div className="aset-row-label">
          <span id={`${id}-launch`}>起動アニメーション</span>
          <span className="aset-row-desc">
            開いた時に、点で描いた新聞と「Topic
            Studio」のアニメーションを出します（2秒ほど。画面を押すかキーを押すとすぐ消えます）。ウインドウ・タブを開いた最初の1回だけです。
          </span>
        </div>
        <div className="aset-row-control">
          <label className="switch aset-switch" data-testid="launch-switch">
            <input
              type="checkbox"
              role="switch"
              checked={launchAnimation}
              onChange={(e) => setPrefs({ launchAnimation: e.target.checked })}
              aria-labelledby={`${id}-launch`}
              data-testid="launch-animation"
            />
            <span className="track" aria-hidden="true" />
            <span className="aset-switch-state" aria-hidden="true">
              {launchAnimation ? 'オン' : 'オフ'}
            </span>
          </label>
        </div>
      </div>

      <div className="aset-row">
        <div className="aset-row-label">
          <span id={`${id}-text-size`}>文字の大きさ</span>
          <span className="aset-row-desc">
            一覧のカードと詳細の、記事の字の大きさです。ヘッダー・ボタン・設定の字は変わりません。
          </span>
        </div>
        <div className="aset-row-control">
          <div className="segmented aset-seg" role="group" aria-labelledby={`${id}-text-size`} data-testid="text-size">
            {TEXT_SIZE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={textSize === o.value}
                onClick={() => setPrefs({ textSize: o.value })}
                data-testid={`text-size-${o.value}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
