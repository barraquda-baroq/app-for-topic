// コネクタとの連携の記録（Firestore の config/connector）と、クラウドの持ち主（config/owner）を読み書きする（NS の
// src/features/claude/connectorDoc.ts を写した物。段階3の設計の 3.1）。持ち主だけが書ける（firestore.rules）。同期のエンジン
// （src/sync/engine.ts）は連携の記録を読まず、この画面の部品が読む。画面からは必要になった時に読み込む（ログインしていない端末で
// Firestore を読み込まない）。fs を渡さなければアプリの Firestore（src/sync/firestore.ts）を使う（エミュレーターのテストは、
// エミュレーターにつないだ Firestore を渡す。src/features/claude/connectorDoc.emu.test.ts）。
// 接続の一覧（2まで）を書き換えるのはトランザクションだけ（足す・入れ替える・名前を変える・1つ解除する。最後の1つを解除する時は
// 記録を消す）。書く内容は connectLogic.ts の addedConnectorDoc などが決める
import {
  deleteDoc,
  doc,
  getDocFromServer,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  updateDoc,
  type Firestore,
} from 'firebase/firestore'
import { firestore } from '../../sync/firestore'
import { readOwner } from '../../sync/owner'
import {
  addedConnectorDoc,
  parseConnectorDoc,
  removedConnectorDoc,
  renamedConnectorDoc,
  type ConnectionApproval,
  type ConnectorStatus,
} from './connectLogic'

const connectorRef = (fs: Firestore) => doc(fs, 'config', 'connector')

/** クラウドの持ち主のアカウント（記録が無ければ null。サーバーから読む。読めなければ throw） */
export async function readOwnerUid(fs: Firestore = firestore()): Promise<string | null> {
  const uid = await readOwner(fs)
  return uid ? uid : null
}

export type ConnectorState =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'paired'; status: ConnectorStatus }
  | { state: 'error'; message: string }

/**
 * 連携の記録を見張る（サーバーから届いた内容だけを出す。この端末で変えた内容も、サーバーが受け取るまでは出さない:
 * 「連携を解除」「書き込みを許可」が本当に効いたかを出すため）
 */
export function watchConnector(fn: (s: ConnectorState) => void, fs: Firestore = firestore()): () => void {
  return onSnapshot(
    connectorRef(fs),
    { includeMetadataChanges: true },
    (snap) => {
      if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) return
      if (!snap.exists()) return fn({ state: 'none' })
      const status = parseConnectorDoc(snap.data({ serverTimestamps: 'estimate' }))
      fn(status ? { state: 'paired', status } : { state: 'none' })
    },
    (err) => {
      const code = (err as { code?: string }).code
      fn({
        state: 'error',
        message:
          code === 'permission-denied'
            ? '連携の状態を読めませんでした（持ち主のアカウントでログインしているか、アクセスルールを公開したかを確かめてください）。'
            : '連携の状態を読めませんでした。',
      })
    },
  )
}

/** いまの連携の記録をサーバーから読む（無い・正しい接続が1つも無ければ null。読めなければ throw） */
export async function readConnectorDoc(fs: Firestore = firestore()): Promise<ConnectorStatus | null> {
  const snap = await getDocFromServer(connectorRef(fs))
  return snap.exists() ? parseConnectorDoc(snap.data()) : null
}

/**
 * 接続を足す（a.replaceCid があれば、その接続と入れ替える）。サーバーが受け取るまで待つ。pairedAt はサーバー時刻。
 * 別のコネクタの記録なら IdentityChangedError（呼ぶ側が記録を消してから、もう一度足す）、上限（2）まであれば ConnectionLimitError
 */
export async function addConnection(a: ConnectionApproval, fs: Firestore = firestore()): Promise<void> {
  const ref = connectorRef(fs)
  await runTransaction(fs, async (tx) => {
    const snap = await tx.get(ref)
    tx.set(ref, addedConnectorDoc(snap.exists() ? snap.data() : null, a, serverTimestamp()))
  })
}

/** 接続の名前を変える（もう無い接続なら ConnectionGoneError。指紋・時刻・最後の接続はそのまま） */
export async function renameConnection(cid: string, name: string, fs: Firestore = firestore()): Promise<void> {
  const ref = connectorRef(fs)
  await runTransaction(fs, async (tx) => {
    const snap = await tx.get(ref)
    tx.set(ref, renamedConnectorDoc(snap.exists() ? snap.data() : null, cid, name))
  })
}

/**
 * 接続を1つ解除する（その接続の Claude は、次に使った時から読めず書き込めなくなる。ほかの接続はそのまま）。
 * 最後の1つなら記録を消す（= 連携をすべて解除）。'deleted' = 記録を消した・'removed' = 一覧から外した・'none' = もう無かった
 */
export async function removeConnection(cid: string, fs: Firestore = firestore()): Promise<'removed' | 'deleted' | 'none'> {
  const ref = connectorRef(fs)
  return runTransaction(fs, async (tx) => {
    const snap = await tx.get(ref)
    const r = removedConnectorDoc(snap.exists() ? snap.data() : null, cid)
    if (r.kind === 'delete') {
      tx.delete(ref)
      return 'deleted'
    }
    if (r.kind === 'set') {
      tx.set(ref, r.doc)
      return 'removed'
    }
    return 'none'
  })
}

/** 「書き込みを許可」を変える（すべての接続に効く。連携の指紋・時刻・一覧はそのまま） */
export async function setConnectorWrites(writes: boolean, fs: Firestore = firestore()): Promise<void> {
  await updateDoc(connectorRef(fs), { writes })
}

/** 連携をすべて解除する（記録を消す。その場でコネクタは何も読み書きできなくなり、次の許可は新しい代になる） */
export async function deleteConnector(fs: Firestore = firestore()): Promise<void> {
  await deleteDoc(connectorRef(fs))
}
