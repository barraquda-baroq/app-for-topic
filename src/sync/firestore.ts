// クラウドの保存先（Firestore）の初期化。DS の src/sync/firestore.ts をそのまま写した物（docs/SPEC.md の 3.・14.4）。
// 段階0は持ち主の記録（config/owner）を読む時だけ読み込む（起動の時はログインの状態を確かめるだけなので、Firestore の大きな部品を
// 読み込まない）。端末の中の控えは持たない memoryLocalCache（段階1から、端末の中のデータは Dexie が持つ）。
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache, type Firestore } from 'firebase/firestore'
import { emulatorHost, firebase } from './firebase'

let instance: Firestore | null = null

export function firestore(): Firestore {
  if (instance) return instance
  const fs = initializeFirestore(firebase().app, { localCache: memoryLocalCache() })
  if (emulatorHost) connectFirestoreEmulator(fs, emulatorHost, 8080)
  instance = fs
  return fs
}
