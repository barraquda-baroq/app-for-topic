// 持ち主の関所・アクセスルール・同期のテスト（*.emu.test.ts）の、Firebase エミュレーターの管理者の道具。DS の src/test/emulatorAdmin.ts
// から。Authorization: Bearer owner はエミュレーターの管理者で、アクセスルールを通さない（作者が Firebase の画面で操作するのと同じ）。
// src/sync/owner.emu.test.ts・rules.emu.test.ts と、持ち主の関所の E2E（e2e/*.sync.spec.ts。Playwright の Node の側で動く）から使う。
// 記録の文書を書く adminWriteRecord は、アプリから作れないコネクタの記録（版・話題・訂正・辞書の束・作れなかった印）を、コネクタと
// 同じ外側の形で置くため（docs/SPEC.md の 7.7。段階1の偽のコネクタ・エミュレーターに入れる道具も同じ形で書く。16.3）。
import { CONNECTOR_DEVICE, type Place } from '../domain/types'

/** エミュレーターのプロジェクト（firebase.emu.json・src/sync/firebaseConfig.ts の EMULATOR_PROJECT_ID） */
export const EMU_PROJECT = 'demo-topic-studio'

const FIRESTORE = 'http://127.0.0.1:8080'
const DOCS = `/v1/projects/${EMU_PROJECT}/databases/(default)/documents`

/** エミュレーターの Firestore に管理者の権限で頼む（返事の JSON を返す） */
export async function emulatorRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${FIRESTORE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  const text = await res.text()
  return text ? (JSON.parse(text) as unknown) : null
}

/** アクセスルールを入れ替える（本番の firestore.rules か、エミュレーター用の firestore.emu.rules） */
export async function useRules(content: string): Promise<void> {
  await emulatorRequest('PUT', `/emulator/v1/projects/${EMU_PROJECT}:securityRules`, {
    rules: { files: [{ name: 'firestore.rules', content }] },
  })
}

/**
 * エミュレーターの文書を全部消す（前のテストの購読を閉じた直後は、エミュレーターが 500 を返すことがあるので、少し待って 3回まで
 * やり直す）
 */
export async function clearFirestore(): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await emulatorRequest('DELETE', `/emulator/v1/projects/${EMU_PROJECT}/databases/(default)/documents`)
      return
    } catch (e) {
      if (i >= 2) throw e
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

/** 持ち主の記録 config/owner を管理者の権限で作る（作者が Firebase の画面で作るのと同じ。形1・docs/DEPLOY.md の 3） */
export async function adminCreateOwner(uid: string): Promise<void> {
  await emulatorRequest('PATCH', `${DOCS}/config/owner`, {
    fields: { uid: { stringValue: uid }, createdAt: { timestampValue: new Date().toISOString() } },
  })
}

/** 持ち主の記録 config/owner を管理者の権限で消す（持ち主を移す途中など） */
export async function adminDeleteOwner(): Promise<void> {
  await emulatorRequest('DELETE', `${DOCS}/config/owner`)
}

/** 管理者の権限で文書があるかを見る（path は documents の下。例 'config/owner'） */
export async function adminExists(path: string): Promise<boolean> {
  const res = await fetch(`${FIRESTORE}${DOCS}/${path}`, { headers: { Authorization: 'Bearer owner' } })
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`)
  return true
}

/** 管理者の権限で書く記録の文書（外側の8つの欄。docs/SPEC.md の 7.7 の「1件の文書の形」） */
export interface AdminRecordDoc {
  table: string
  id: string
  json: string
  hash: string
  /** 既定はコネクタの名前（'claude-connector'。src/domain/types.ts の CONNECTOR_DEVICE） */
  device?: string
  /** 既定は今。サーバー時刻の代わり（過去の時刻も入れられる。32日より前の記録を置く時など） */
  updated?: Date
  /** 文書の id（既定は '{table}:{id}'。ルールのテストで、表を取り違えた id を置く時に替える） */
  docId?: string
}

/**
 * 記録の文書を管理者の権限で書く（users/{uid}/{置き場}/{文書の id}。ルールを通さない）。chunks は 0・deleted は false
 * （コネクタが書く形。docs/SPEC.md の 7.7）。アプリから作れない Claude の記録を、ルールや同期のテストで置くため
 */
export async function adminWriteRecord(uid: string, place: Place, rec: AdminRecordDoc): Promise<void> {
  const docId = rec.docId ?? `${rec.table}:${rec.id}`
  await emulatorRequest('PATCH', `${DOCS}/users/${uid}/${place}/${encodeURIComponent(docId)}`, { fields: recordFields(rec) })
}

/** 記録の文書の外側の8つの欄（REST の fields の形） */
function recordFields(rec: AdminRecordDoc): Record<string, unknown> {
  return {
    table: { stringValue: rec.table },
    id: { stringValue: rec.id },
    json: { stringValue: rec.json },
    chunks: { integerValue: '0' },
    deleted: { booleanValue: false },
    hash: { stringValue: rec.hash },
    updated: { timestampValue: (rec.updated ?? new Date()).toISOString() },
    device: { stringValue: rec.device ?? CONNECTOR_DEVICE },
  }
}

/** まとめて書く1回の量（Firestore のまとめ書きの上限 500件と、1回に送る JSON の大きさ。エミュレーターの受け取りの上限の手前） */
const COMMIT_DOCS = 400
const COMMIT_CHARS = 1_500_000

/**
 * 記録の文書を、管理者の権限でまとめて書く（REST の documents:commit。並びの順に、400件・150万字ずつ）。形は adminWriteRecord と同じ。
 * 同期のテスト（src/sync/sync.emu.test.ts）で、作り物の1か月分（約1,500件）の版・話題をコネクタと同じ外側の形で、過去の updated で
 * 置くため（1件ずつ書くより速い。docs/SPEC.md の 16.3）
 */
export async function adminWriteRecords(uid: string, place: Place, recs: readonly AdminRecordDoc[]): Promise<void> {
  const name = (rec: AdminRecordDoc) =>
    `projects/${EMU_PROJECT}/databases/(default)/documents/users/${uid}/${place}/${rec.docId ?? `${rec.table}:${rec.id}`}`
  let writes: unknown[] = []
  let chars = 0
  const commit = async () => {
    if (!writes.length) return
    await emulatorRequest('POST', `${DOCS}:commit`, { writes })
    writes = []
    chars = 0
  }
  for (const rec of recs) {
    if (writes.length >= COMMIT_DOCS || (writes.length && chars + rec.json.length > COMMIT_CHARS)) await commit()
    writes.push({ update: { name: name(rec), fields: recordFields(rec) } })
    chars += rec.json.length
  }
  await commit()
}

/** 管理者の権限で、そのアカウントの置き場の文書の id を並べる（アプリが何を書いた・消したかを、ルールを通さずに見る） */
export async function adminDocIds(uid: string, place: Place): Promise<string[]> {
  const ids: string[] = []
  for (let token = ''; ; ) {
    const page = `${DOCS}/users/${uid}/${place}?pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`
    const r = (await emulatorRequest('GET', page)) as { documents?: { name: string }[]; nextPageToken?: string } | null
    for (const d of r?.documents ?? []) ids.push(decodeURIComponent(d.name.split('/').pop() ?? ''))
    if (!r?.nextPageToken) return ids
    token = r.nextPageToken
  }
}

/** 管理者の権限で、文書の1つの欄の文字の値を読む（無い文書・欄は undefined。path は documents の下） */
export async function adminStringField(path: string, field: string): Promise<string | undefined> {
  const res = await fetch(`${FIRESTORE}${DOCS}/${path}`, { headers: { Authorization: 'Bearer owner' } })
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { fields?: Record<string, { stringValue?: string }> }
  return body.fields?.[field]?.stringValue
}

const AUTH = 'http://127.0.0.1:9099'

/**
 * エミュレーターの仮の Google アカウントを作り（あれば、そのアカウントで入り直し）、その uid を返す。ブラウザでログインする前に
 * uid を知り、持ち主の記録 config/owner を作っておくため（持ち主の関所の E2E。e2e/*.sync.spec.ts）。sub・email はブラウザの
 * window.__ts.signInForTest(sub)（src/sync/firebase.ts の signInForTest）と同じにする（同じ sub なら同じアカウント）
 */
export async function adminGoogleUser(sub: string, email = `${sub}@example.com`): Promise<string> {
  const idToken = JSON.stringify({ sub, email, email_verified: true, name: sub })
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=emulator`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody: `id_token=${encodeURIComponent(idToken)}&providerId=google.com`,
      requestUri: 'http://localhost',
      returnSecureToken: true,
    }),
  })
  if (!res.ok) throw new Error(`signInWithIdp ${sub}: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { localId?: string }
  if (!body.localId) throw new Error(`signInWithIdp ${sub}: uid がありません`)
  return body.localId
}
