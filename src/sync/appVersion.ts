// アプリの版（package.json の version の x.y。src/sync/appVersion.test.ts で揃っていることを確かめる）とデータの形の版。DS の
// src/sync/appVersion.ts から（docs/SPEC.md の 7.8 の「部品」）。画面（ログインの画面の左下・設定）からも読み、同期を受け持つタブの受け渡しでも
// 比べるので、Firebase を読み込まない小さなファイルにしている（appModel.ts は Firestore を使う）

/** アプリの版（ログインの画面の左下と、設定の「このアプリについて」に出す。データの形の版の記録にも添える） */
export const APP_VERSION = '0.1'

/**
 * このアプリが書くデータの形の版（今は 1。docs/SPEC.md の 7.8 の「持ち主・データの形の版・同期の表示」）。表や記録の意味を変えたら上げる
 * （users/{uid}/meta/app の model。src/sync/appModel.ts）。段階3のコネクタも同じ値（CONNECTOR_MODEL）を持ち、違えば書かない（7.7）
 */
export const DATA_MODEL = 1
