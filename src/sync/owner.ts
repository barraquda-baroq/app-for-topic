// 持ち主の確かめ（docs/SPEC.md の 14.4。形1）: Firestore の config/owner（作者が Firebase の画面で作る。アプリは読むだけ）の uid が、
// ログインしたアカウントかを確かめる。DS の src/sync/engine.ts の OWNER_DOC・readOwner・checkOwner をそのまま写した物。
// 段階0には同期のエンジンが無いので小さなファイルに分けた（段階1で入れるエンジンも、ここから読む）
import { doc, getDocFromServer, type Firestore } from 'firebase/firestore'

/** クラウドの持ち主を記録する文書（作者が Firebase の画面で作る。アプリは読むだけ。形1） */
export const OWNER_DOC = ['config', 'owner'] as const

/** 持ち主の記録（config/owner）の uid（無ければ null）。サーバーから読む（通信できなければ投げる） */
export async function readOwner(fs: Firestore): Promise<string | null> {
  const snap = await getDocFromServer(doc(fs, ...OWNER_DOC))
  if (!snap.exists()) return null
  const uid = (snap.data() as { uid?: unknown }).uid
  return typeof uid === 'string' ? uid : null
}

/** 持ち主を確かめる: ok・missing（記録が無い）・mismatch（ほかのアカウント） */
export async function checkOwner(fs: Firestore, uid: string): Promise<'ok' | 'missing' | 'mismatch'> {
  const owner = await readOwner(fs)
  if (owner === null) return 'missing'
  return owner === uid ? 'ok' : 'mismatch'
}
