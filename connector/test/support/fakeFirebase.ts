// テスト用の小さな Firebase（Auth の REST・Firestore の REST の、コネクタが使う部分だけ）。fetch として渡す（NS の
// connector/test/support/fakeFirebase.ts を写し、TS の表と、接続の一覧の形（v2 だけ。接続は2まで）にした）。
// - 文書は名前の順・updated（サーバー時刻）の順に並ぶ。1回の commit の書き込みはすべて同じ時刻
// - アクセスルールの要点だけをまねる: コネクタ（config/connector の uid）は records のうち読ませる表（CLAUDE_READ_TABLES）だけを読め、
//   決まった5つの表（CONNECTOR_TABLES）に作るだけ（writes の時だけ。json は表ごとの上限まで）。private は読めない
// 本物のアクセスルールとの合わせは、エミュレーターの結合テスト（test/emu。B3 以降）で確かめる。
// URL のホストは作り物（fake-auth・fake-fs。Workers のテストは fake-firebase）で、外へは出ない（test/support/netGuard.ts）。
import { MAX_CONNECTIONS } from '../../../src/claude/pairing'
import { RECORD_LIMITS } from '../../../src/domain/limits'
import { CLAUDE_READ_TABLES, CONNECTOR_TABLES, type TableName } from '../../../src/domain/types'
import { encodeRecord, type Rec } from '../../../src/sync/codec'

type Value = Record<string, unknown>

interface Doc {
  name: string
  fields: Record<string, Value>
  updateTime: string
  createTime: string
}

/** config/connector の接続（テストの用意） */
export interface FakeConnection {
  name?: string
  pairing: string
  /** 許可した時刻（ms） */
  pairedAt?: number
  approvedOn?: string
}

export interface FakeFirebaseOptions {
  project?: string
  anonymousDisabled?: boolean
}

const READ_TABLES: ReadonlySet<string> = new Set(CLAUDE_READ_TABLES)
const WRITE_TABLES: ReadonlySet<string> = new Set(CONNECTOR_TABLES)

/** 作り物の Firebase のプロジェクト（本物の TS のプロジェクトとは別の名前） */
export const FAKE_PROJECT = 'demo-topic-studio'

export class FakeFirebase {
  readonly project: string
  readonly root: string
  readonly docs = new Map<string, Doc>()
  /** 呼ばれた回数（Firestore の操作ごと） */
  readonly calls: { op: string; status: number }[] = []
  anonymousDisabled: boolean
  /** 次の commit を、この状態で失敗させる（テスト用） */
  failNextCommit: { status: number; code: string } | null = null
  /** Firebase の1日の無料枠を使い切った（Firestore の呼び出しはすべて 429 RESOURCE_EXHAUSTED） */
  exhausted = false
  #clockUs = Date.UTC(2026, 10, 19, 0, 0, 0) * 1000
  #users = new Map<string, { refresh: string; disabled?: boolean }>()
  #tokens = new Map<string, string>()
  #seq = 0

  constructor(opts: FakeFirebaseOptions = {}) {
    this.project = opts.project ?? FAKE_PROJECT
    this.root = `projects/${this.project}/databases/(default)/documents`
    this.anonymousDisabled = opts.anonymousDisabled ?? false
  }

  readonly identityUrl = 'http://fake-auth/identitytoolkit.googleapis.com/v1'
  readonly tokenUrl = 'http://fake-auth/securetoken.googleapis.com/v1'
  readonly firestoreUrl = 'http://fake-fs/v1'

  #tick(): string {
    this.#clockUs += 1000 + Math.floor(Math.random() * 10)
    return isoMicros(this.#clockUs)
  }

  /** 同じ時刻の書き込みを作る（テスト用） */
  sameTime(): string {
    return isoMicros(this.#clockUs)
  }

  name(path: string): string {
    return `${this.root}/${path}`
  }

  // ---------- 端末・持ち主の側の操作（テストの用意） ----------

  setOwner(uid: string): void {
    this.#write([{ path: 'config/owner', fields: { uid: s(uid) } }])
  }

  /**
   * config/connector を書く（作られた時刻 createTime は、もうある記録なら変わらない。消して作り直すと変わる）。
   * 接続の一覧の形（v: 2。pairingCid は省くと最後の接続。上の pairing・pairedAt はその接続の物）。null で消す（［連携をすべて解除］）
   */
  setConnector(
    c: { uid: string; writes?: boolean; connections: Record<string, FakeConnection>; pairingCid?: string } | null,
  ): void {
    if (!c) {
      this.docs.delete(this.name('config/connector'))
      return
    }
    const last = c.pairingCid ?? Object.keys(c.connections).at(-1) ?? ''
    const lastEntry = c.connections[last]
    const ts = (ms: number | undefined) => ({ timestampValue: new Date(ms ?? Date.now()).toISOString() })
    this.#write([
      {
        path: 'config/connector',
        fields: {
          uid: s(c.uid),
          pairing: s(lastEntry?.pairing ?? ''),
          pairedAt: ts(lastEntry?.pairedAt),
          approvedOn: s(lastEntry?.approvedOn ?? 'テストの端末'),
          writes: { booleanValue: c.writes ?? true },
          v: { integerValue: '2' },
          pairingCid: s(last),
          connections: {
            mapValue: {
              fields: Object.fromEntries(
                Object.entries(c.connections).map(([cid, e]) => [
                  cid,
                  {
                    mapValue: {
                      fields: {
                        name: s(e.name ?? cid),
                        pairing: s(e.pairing),
                        pairedAt: ts(e.pairedAt),
                        approvedOn: s(e.approvedOn ?? 'テストの端末'),
                      },
                    },
                  },
                ]),
              ),
            },
          },
        },
      },
    ])
  }

  /** いまの config/connector の接続（記録が無ければ null） */
  connectorConnections(): Record<string, FakeConnection> | null {
    const d = this.docs.get(this.name('config/connector'))
    if (!d) return null
    const ms = (v: Value | undefined) => Date.parse(String(v?.timestampValue ?? ''))
    const str = (v: Value | undefined) => String(v?.stringValue ?? '')
    const map = ((d.fields.connections?.mapValue as { fields?: Record<string, Value> }) ?? {}).fields ?? {}
    const out: Record<string, FakeConnection> = {}
    for (const [cid, v] of Object.entries(map)) {
      const e = (v.mapValue as { fields: Record<string, Value> }).fields
      out[cid] = { name: str(e.name), pairing: str(e.pairing), pairedAt: ms(e.pairedAt), approvedOn: str(e.approvedOn) }
    }
    return out
  }

  /**
   * アプリの許可（連携の画面の［許可する］と同じ）: 入れ替える接続と同じ cid を外して足す。記録が無い・別のコネクタの記録なら作り直す
   * （作られた時刻が変わる）。接続が MAX_CONNECTIONS（2）あれば例外（アプリは入れ替えを求める。ルールも connections.size() <= 2）
   */
  addConnection(a: {
    uid: string
    cid: string
    pairing: string
    name?: string
    pairedAt?: number
    writes?: boolean
    replaceCid?: string
  }): void {
    const cur = this.docs.get(this.name('config/connector'))
    if (cur && cur.fields.uid?.stringValue !== a.uid) this.setConnector(null)
    const list = { ...(this.connectorConnections() ?? {}) }
    if (a.replaceCid) delete list[a.replaceCid]
    delete list[a.cid]
    if (Object.keys(list).length >= MAX_CONNECTIONS) throw new Error(`接続が${MAX_CONNECTIONS}あります`)
    list[a.cid] = { name: a.name ?? a.cid, pairing: a.pairing, pairedAt: a.pairedAt ?? Date.now(), approvedOn: 'テストの端末' }
    const writes = a.writes ?? (cur ? cur.fields.writes?.booleanValue === true : true)
    this.setConnector({ uid: a.uid, writes, connections: list, pairingCid: a.cid })
  }

  /** アプリの［この接続を解除］: 最後の1つなら記録を消す */
  removeConnection(cid: string): void {
    const cur = this.docs.get(this.name('config/connector'))
    const list = this.connectorConnections()
    if (!cur || !list) return
    delete list[cid]
    if (!Object.keys(list).length) return this.setConnector(null)
    const f = cur.fields
    const pairingCid = String(f.pairingCid?.stringValue ?? '')
    this.setConnector({
      uid: String(f.uid?.stringValue),
      writes: f.writes?.booleanValue === true,
      connections: list,
      pairingCid: list[pairingCid] ? pairingCid : undefined,
    })
  }

  /** アプリの「書き込みを許可」の切り替え（記録のほかの項目・作られた時刻は変えない） */
  setWrites(writes: boolean): void {
    const cur = this.docs.get(this.name('config/connector'))
    if (cur) this.#write([{ path: 'config/connector', fields: { ...cur.fields, writes: { booleanValue: writes } } }])
  }

  /** config/connector の作られた時刻（連携の代） */
  connectorCreateTime(): string | null {
    return this.docs.get(this.name('config/connector'))?.createTime ?? null
  }

  setAppModel(owner: string, model: number | null): void {
    if (model === null) this.docs.delete(this.name(`users/${owner}/meta/app`))
    else
      this.#write([
        {
          path: `users/${owner}/meta/app`,
          fields: {
            model: { integerValue: String(model) },
            appVersion: s('0.1'),
            updatedAt: { timestampValue: this.sameTime() },
          },
        },
      ])
  }

  /** 端末・コネクタと同じ形（8つの欄）で記録を書く */
  putRecord(owner: string, table: TableName, rec: Rec, opts: { device?: string; place?: 'records' | 'private' } = {}): string {
    const enc = encodeRecord(rec)
    return this.#write([
      {
        path: `users/${owner}/${opts.place ?? 'records'}/${table}:${rec.id}`,
        fields: {
          table: s(table),
          id: s(rec.id),
          json: s(enc.json),
          chunks: { integerValue: '0' },
          deleted: { booleanValue: false },
          hash: s(enc.hash),
          device: s(opts.device ?? 'device-a'),
        },
      },
    ])
  }

  #write(writes: { path: string; fields: Record<string, Value> }[]): string {
    const t = this.#tick()
    for (const w of writes) {
      const name = this.name(w.path)
      const prev = this.docs.get(name)
      this.docs.set(name, {
        name,
        fields: { ...w.fields, updated: { timestampValue: t } },
        updateTime: t,
        createTime: prev?.createTime ?? t,
      })
    }
    return t
  }

  /** 記録の文書の中身（テストで確かめる） */
  record(owner: string, docId: string): Record<string, unknown> | null {
    const d = this.docs.get(this.name(`users/${owner}/records/${docId}`))
    if (!d) return null
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(d.fields)) out[k] = Object.values(v)[0]
    return out
  }

  recordDocs(owner: string): Doc[] {
    const prefix = this.name(`users/${owner}/records/`)
    return [...this.docs.values()].filter((d) => d.name.startsWith(prefix))
  }

  // ---------- fetch ----------

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const body = typeof init?.body === 'string' ? init.body : ''
    // ホストではなくパスで分ける（Workers のテストではエミュレーターと同じ形の URL で呼ばれる）
    if (/\/(identitytoolkit|securetoken)\.googleapis\.com\/v1\//.test(url.pathname)) return this.#auth(url, body)
    if (url.pathname.startsWith('/v1/projects/')) {
      if (this.exhausted) {
        this.calls.push({ op: url.pathname.split(':').pop() ?? '', status: 429 })
        return jsonRes({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' } }, 429)
      }
      const auth = new Headers(init?.headers).get('Authorization') ?? ''
      const uid = this.#tokens.get(auth.replace(/^Bearer /, '')) ?? null
      const res = this.#firestore(decodeURIComponent(url.pathname.replace(/^\/v1\//, '')), JSON.parse(body || '{}'), uid)
      this.calls.push({ op: url.pathname.split(':').pop() ?? '', status: res.status })
      return res
    }
    return new Response('not found', { status: 404 })
  }

  #auth(url: URL, body: string): Response {
    if (url.pathname.endsWith('/accounts:signUp')) {
      if (this.anonymousDisabled) return jsonRes({ error: { code: 400, message: 'OPERATION_NOT_ALLOWED' } }, 400)
      const uid = `anon${++this.#seq}`
      const refresh = `refresh-${uid}-${this.#seq}`
      this.#users.set(uid, { refresh })
      const idToken = `idtoken-${uid}-${++this.#seq}`
      this.#tokens.set(idToken, uid)
      return jsonRes({ localId: uid, idToken, refreshToken: refresh, expiresIn: '3600' })
    }
    if (url.pathname.endsWith('/token')) {
      const p = new URLSearchParams(body)
      const refresh = p.get('refresh_token')
      const entry = [...this.#users.entries()].find(([, u]) => u.refresh === refresh)
      if (!entry) return jsonRes({ error: { code: 400, message: 'INVALID_REFRESH_TOKEN' } }, 400)
      if (entry[1].disabled) return jsonRes({ error: { code: 400, message: 'USER_DISABLED' } }, 400)
      const idToken = `idtoken-${entry[0]}-${++this.#seq}`
      this.#tokens.set(idToken, entry[0])
      return jsonRes({ id_token: idToken, refresh_token: refresh, expires_in: '3600', user_id: entry[0] })
    }
    return jsonRes({ error: { message: 'NOT_FOUND' } }, 404)
  }

  /** 匿名のアカウントを消す（更新用トークンが使えなくなる） */
  disableUser(uid: string): void {
    const u = this.#users.get(uid)
    if (u) u.disabled = true
  }

  /** ID トークンを使えなくする（401 を返す） */
  expireTokens(): void {
    this.#tokens.clear()
  }

  #ownerUid(): string | null {
    const d = this.docs.get(this.name('config/owner'))
    return (d?.fields.uid?.stringValue as string | undefined) ?? null
  }

  #connector(): { uid: string; writes: boolean } | null {
    const d = this.docs.get(this.name('config/connector'))
    if (!d) return null
    return { uid: d.fields.uid?.stringValue as string, writes: d.fields.writes?.booleanValue === true }
  }

  /** 記録されたコネクタか（アクセスルールの isConnector の要点: 持ち主と別の uid で、config/connector の uid） */
  #isConnector(uid: string): boolean {
    const conn = this.#connector()
    return conn !== null && conn.uid === uid && uid !== this.#ownerUid()
  }

  /** 名前で読めるか（アクセスルールの要点） */
  #canGet(path: string, uid: string | null): boolean {
    if (!uid) return false
    if (path === 'config/owner') return true
    if (path === 'config/connector')
      return this.#connector() !== null && (this.#connector()!.uid === uid || uid === this.#ownerUid())
    const owner = this.#ownerUid()
    const m = /^users\/([^/]+)\/(records|meta|private)\/(.+)$/.exec(path)
    if (!m || m[1] !== owner) return false
    if (uid === owner) return true
    if (!this.#isConnector(uid)) return false
    if (m[2] === 'meta') return m[3] === 'app'
    if (m[2] !== 'records') return false
    // 無い文書（resource == null）も読める。ある文書は読ませる表だけ
    const d = this.docs.get(this.name(path))
    return !d || READ_TABLES.has(String(d.fields.table?.stringValue ?? ''))
  }

  #firestore(path: string, body: Record<string, unknown>, uid: string | null): Response {
    if (!uid) return jsonRes({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'token' } }, 401)
    if (path.endsWith(':batchGet')) {
      const names = (body.documents as string[]) ?? []
      for (const n of names) if (!this.#canGet(n.slice(this.root.length + 1), uid)) return denied()
      return jsonRes(
        names.map((n) =>
          this.docs.has(n) ? { found: this.docs.get(n), readTime: this.sameTime() } : { missing: n, readTime: this.sameTime() },
        ),
      )
    }
    if (path.endsWith(':runQuery') || path.endsWith(':runAggregationQuery')) {
      const parent = path.slice(this.root.length + 1).replace(/:run(Aggregation)?Query$/, '')
      const owner = this.#ownerUid()
      if (parent !== `users/${owner}` || !(uid === owner || this.#isConnector(uid))) return denied()
      const q = (
        path.endsWith(':runQuery')
          ? body.structuredQuery
          : (body.structuredAggregationQuery as Record<string, unknown>).structuredQuery
      ) as Record<string, unknown>
      let list = [...this.docs.values()].filter((d) => d.name.startsWith(`${this.root}/${parent}/records/`))
      const tables = tablesOf(q.where)
      // ルールは絞り込みの代わりにならない: コネクタの問い合わせは、読ませる表だけに絞っていなければ断る
      if (uid !== owner && (!tables || tables.some((t) => !READ_TABLES.has(t)))) return denied()
      if (tables) list = list.filter((d) => tables.includes(String(d.fields.table?.stringValue ?? '')))
      if (path.endsWith(':runAggregationQuery'))
        return jsonRes([{ result: { aggregateFields: { n: { integerValue: String(list.length) } } }, readTime: this.sameTime() }])
      if (typeof q.limit === 'number') list = list.slice(0, q.limit)
      return jsonRes(
        list.length ? list.map((d) => ({ document: d, readTime: this.sameTime() })) : [{ readTime: this.sameTime() }],
      )
    }
    if (path.endsWith(':commit')) {
      if (this.failNextCommit) {
        const f = this.failNextCommit
        this.failNextCommit = null
        return jsonRes({ error: { code: f.status, status: f.code, message: 'test' } }, f.status)
      }
      const writes = (body.writes as Record<string, unknown>[]) ?? []
      const owner = this.#ownerUid()
      const conn = this.#connector()
      const isOwner = uid === owner
      for (const w of writes) {
        const upd = w.update as { name: string; fields: Record<string, Value> } | undefined
        if (!upd) return denied()
        const exists = this.docs.has(upd.name)
        const pre = w.currentDocument as { exists?: boolean } | undefined
        if (pre?.exists === false && exists)
          return jsonRes({ error: { code: 409, status: 'ALREADY_EXISTS', message: 'exists' } }, 409)
        if (isOwner) continue
        // コネクタ: 決まった5つの表に、決まった形で作るだけ（json は表ごとの上限まで）
        const f = upd.fields
        const table = String(f.table?.stringValue ?? '')
        const id = String(f.id?.stringValue ?? '')
        const keys = Object.keys(f).sort().join(',')
        const maxJson = WRITE_TABLES.has(table) ? RECORD_LIMITS.json[table as TableName] : 0
        const ok =
          conn !== null &&
          this.#isConnector(uid) &&
          conn.writes &&
          !exists &&
          WRITE_TABLES.has(table) &&
          upd.name === `${this.root}/users/${owner}/records/${table}:${id}` &&
          keys === 'chunks,deleted,device,hash,id,json,table' &&
          f.device?.stringValue === 'claude-connector' &&
          f.chunks?.integerValue === '0' &&
          f.deleted?.booleanValue === false &&
          String(f.json?.stringValue ?? '').length <= maxJson &&
          JSON.stringify(w.updateTransforms) === JSON.stringify([{ fieldPath: 'updated', setToServerValue: 'REQUEST_TIME' }])
        if (!ok) return denied()
      }
      const t = this.#tick()
      const results = writes.map((w) => {
        const upd = w.update as { name: string; fields: Record<string, Value> }
        const prev = this.docs.get(upd.name)
        this.docs.set(upd.name, {
          name: upd.name,
          fields: { ...upd.fields, updated: { timestampValue: t } },
          updateTime: t,
          createTime: prev?.createTime ?? t,
        })
        return { updateTime: t, transformResults: [{ timestampValue: t }] }
      })
      return jsonRes({ writeResults: results, commitTime: t })
    }
    return jsonRes({ error: { code: 404, status: 'NOT_FOUND', message: path } }, 404)
  }

  /** Firestore の ID トークンを持つ uid（テストで、持ち主として書く時に使う） */
  tokenFor(uid: string): string {
    const t = `idtoken-${uid}-${++this.#seq}`
    this.#tokens.set(t, uid)
    return t
  }
}

/** 問い合わせの where の表の絞り（table == … か table in […]。どちらでもなければ null） */
function tablesOf(where: unknown): string[] | null {
  const f = (where as { fieldFilter?: { field?: { fieldPath?: string }; op?: string; value?: Value } } | undefined)?.fieldFilter
  if (!f || f.field?.fieldPath !== 'table') return null
  if (f.op === 'EQUAL' && typeof f.value?.stringValue === 'string') return [f.value.stringValue]
  if (f.op === 'IN') {
    const values = ((f.value?.arrayValue as { values?: Value[] } | undefined)?.values ?? []).map((v) => v.stringValue)
    return values.every((v): v is string => typeof v === 'string') ? values : null
  }
  return null
}

function s(v: string): Value {
  return { stringValue: v }
}

function isoMicros(us: number): string {
  const ms = Math.floor(us / 1000)
  const frac = String(us % 1_000_000).padStart(6, '0')
  return `${new Date(ms).toISOString().slice(0, 19)}.${frac}Z`
}

function jsonRes(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
}

function denied(): Response {
  return jsonRes({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } }, 403)
}
