// コネクタの版（NS の connector/src/version.ts の形）。CONNECTOR_MODEL はアプリのデータの形の版（src/sync/appVersion.ts の DATA_MODEL）を
// そのまま読む（NS は同じ値を別に書いていた。TS は1か所にして、上げ忘れない）。クラウドの users/{uid}/meta/app の model がこれと
// 違えば、書き込まない（読むのは続ける。docs/SPEC.md の 7.7）。データの形の版を上げる時は、ルールとコネクタを一緒に公開する
import { DATA_MODEL } from '../../src/sync/appVersion'

export { CONNECTOR_DEVICE } from '../../src/domain/types'

/** コネクタの版（connector/package.json・package-lock.json の version と同じ。test/unit/basics.test.ts で確かめる） */
export const CONNECTOR_VERSION = '0.1.0'
export const CONNECTOR_MODEL: number = DATA_MODEL
