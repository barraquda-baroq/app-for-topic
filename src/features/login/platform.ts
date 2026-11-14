// 端末とブラウザの見分け（ログインの画面の iPhone の案内と、ホーム画面に追加の手順で使う。docs/SPEC.md の 14.4）。DS の段階0の
// src/features/login/platform.ts に、DS が後で直した iPadOS の見分け（navigator.platform の MacIntel。DS の src/ui/device.ts）を入れた物

export type Platform = 'ios' | 'android' | 'desktop'

/**
 * 端末の見分け。maxTouchPoints は navigator.maxTouchPoints、navPlatform は navigator.platform（iPadOS の Safari は UA を Mac にし、
 * navigator.platform も MacIntel を返すので、タッチの指の数で見分ける。Mac の Safari は 0）
 */
export function detectPlatform(userAgent: string, maxTouchPoints = 0, navPlatform = ''): Platform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios'
  if ((/Macintosh/i.test(userAgent) || navPlatform === 'MacIntel') && maxTouchPoints > 1) return 'ios'
  if (/Android/i.test(userAgent)) return 'android'
  return 'desktop'
}

/** いまの端末 */
export function currentPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'desktop'
  return detectPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0, navigator.platform ?? '')
}

/**
 * iPhone・iPad で開いているブラウザ（ログインの画面の案内の言葉に使う）。iPhone は Chrome を基準にし、Safari でも同じ
 * 「共有 → ホーム画面に追加」で置けるので、どちらで開いていても案内する（作者の指示「iOS では Chrome 基準でいい」）
 */
export type IosBrowser = 'chrome' | 'safari' | 'other'

/**
 * iOS のブラウザの見分け（iPhone・iPad と見分けた後に使う）。iOS の Chrome は UA に「CriOS/版」を名乗る（中身は今も WebKit の見込み）。
 * Edge・DuckDuckGo などは Safari と同じ「Version/… Safari/…」も名乗るので、先に名前で除く。
 * Mac を名乗る iPadOS の Safari も「Version/… Safari/…」なので Safari になる
 */
export function detectIosBrowser(userAgent: string): IosBrowser {
  if (/\bCriOS\//.test(userAgent)) return 'chrome'
  if (/\b(?:FxiOS|EdgiOS|OPiOS|OPT|GSA|DuckDuckGo|Ddg|YaBrowser)\//.test(userAgent)) return 'other'
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(userAgent)) return 'safari'
  return 'other'
}

/** いまの iOS のブラウザ */
export function currentIosBrowser(): IosBrowser {
  if (typeof navigator === 'undefined') return 'other'
  return detectIosBrowser(navigator.userAgent)
}

/** ホーム画面に追加したアプリとして開いている（iPhone の navigator.standalone か、表示の形が standalone） */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const nav = navigator as Navigator & { standalone?: boolean }
  if (nav.standalone === true) return true
  return window.matchMedia?.('(display-mode: standalone)').matches ?? false
}

/**
 * ログインの画面に「ホーム画面に追加してから使ってください」を出すか（iPhone・iPad をホーム画面のアプリでなく開いている時。
 * ブラウザ（Chrome・Safari）のタブとホーム画面のアプリはデータが別々になり、しばらく使わないとデータが消されることもあるため。
 * docs/SPEC.md の 14.4。DS の D44）
 */
export function needsHomeScreenNotice(platform: Platform, standalone: boolean): boolean {
  return platform === 'ios' && !standalone
}
