// アプリの版（package.json の version の x.y。src/sync/appVersion.test.ts で揃っていることを確かめる）。DS の src/sync/appVersion.ts から
// （データの形の版 DATA_MODEL は段階1で足す）。画面（ログインの画面の左下・設定）からも読むので、Firebase を読み込まない小さなファイルにしている

/** アプリの版（ログインの画面の左下と、設定の「このアプリについて」に出す） */
export const APP_VERSION = '0.1'
