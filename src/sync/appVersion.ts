// アプリの版（package.json の version の x.y。src/sync/appVersion.test.ts で揃っていることを確かめる）とデータの形の版。DS の
// src/sync/appVersion.ts から（docs/SPEC.md の 7.8 の「部品」）。画面（ログインの画面の左下・設定）からも読み、同期を受け持つタブの受け渡しでも
// 比べるので、Firebase を読み込まない小さなファイルにしている（appModel.ts は Firestore を使う）

/** アプリの版（ログインの画面の左下と、設定の「このアプリについて」に出す。データの形の版の記録にも添える） */
export const APP_VERSION = '0.1'

/**
 * このアプリが書くデータの形の版（docs/SPEC.md の 7.8 の「持ち主・データの形の版・同期の表示」）。表や記録の意味を変えたら上げる
 * （users/{uid}/meta/app の model。src/sync/appModel.ts）。段階3で作ったコネクタ（connector/）も同じ値（CONNECTOR_MODEL）を持ち、違えば書かない（7.7）。
 * 段階3で 1 → 2 に上げた: 出典に著者の欄（author）を足し、出典の表示（社ごとの出典の書き方と「…を加工して作成」。src/domain/credit.ts）が
 * 出どころの規約の条件になったため。出典の表示を持つアプリが1台でも開かれるまで、コネクタは版も話題も足さない（古い端末は「要更新」）
 */
export const DATA_MODEL = 2
