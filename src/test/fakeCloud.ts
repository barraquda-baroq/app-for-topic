// テスト用の偽のクラウドと端末（docs/SPEC.md の 16.3 の「偽のクラウド」）。エミュレーター無しで速く、同期のエンジン（src/sync/engine.ts）と
// 同じ決まりで送受信する。DS の src/test/fakeCloud.ts を写し、TS の形に直した:
// - 置き場を2つにした（Claude が読める records と、読めない private。表の置き場は codec の placeOf）。文書は codec の外側の8つの欄で持ち、
//   受け取りは codec の decodeDoc を通す（src/sync/syncPlan.ts の remoteChangeOf。エンジンと同じ）
// - サーバーの時計（cloud.now）を持ち、端末ごとに時計のずれ（clockOffset）を持てる（30日の境・サーバーの時刻の見積もり・初めての受け取りの
//   端末の時計 − 32日を確かめる）
// - 購読は、置き場ごとに「from 以上に書かれた物」の購読をまねる: 購読を始めた最初の受け取りは問い合わせの全部、その後は変わった文書だけ
//   （removed は届かない）。records は表を並べる（辞書の束は届かない）。読んだ文書の数を端末ごとに数える（7.9）
// - 初めての受け取りの2段・30日の手入れ・端末の中の削除・送る前の守り・クラウドで消えていた既読・欠けた話題を直接読む、を足した
//   （決まりは src/sync/syncPlan.ts・batch.ts の物をそのまま使う）
// - ルールのまね: アプリの書き込みは appDoc の形（表・id の形・json の上限・device がコネクタでない・削除の印でない）、削除は表ごとの id の
//   形でサーバーの時刻で30日を過ぎた物だけ（firestore.rules の appDoc・expirableRecord・expiredDay）。通らなければ投げる（テストが落ちる）
// - 外した物: 受け取り箱・復元・ゴミ箱・競合の控え・月の束（TS に無い）
// - 端末の中の保存・3者マージは本物（src/db/persistence.ts。fake-indexeddb）
import {
  createPersistence,
  type AnyRecord,
  type Change,
  type ExpireOutcome,
  type OutboxItem,
  type Persistence,
  type StoredCursors,
  type SyncCursor,
  type UserRecords,
} from '../db/persistence'
import { correctionsByTopic, editionShowState, type EditionShowState } from '../domain/editionShow'
import { isRecordIdFor } from '../domain/ids'
import { estimateServerNow, expiryDocIdBefore, jstDateOf, nextClockSkew } from '../domain/jst'
import { pressKnownTerm, unpressKnownTerm, type KnownTermPress } from '../domain/known'
import { RECORD_LIMITS } from '../domain/limits'
import { repairCorrection, repairEdition, type ShownCorrection } from '../domain/repair'
import {
  CONNECTOR_DEVICE,
  isOneOf,
  USER_TABLES,
  type ExpiringTableName,
  type KnownTerm,
  type Place,
  type ReadMark,
  type RecordDoc,
  type TableName,
} from '../domain/types'
import { DATA_MODEL } from '../sync/appVersion'
import {
  EXPIRE_BATCH_DOCS,
  EXPIRE_DAILY_DOCS,
  SEND_LIMITS,
  decideBatch,
  nothingToSend,
  sameAsBase,
  selectBatch,
  type BatchEntry,
} from '../sync/batch'
import { PLACES, docIdOf, encodeDoc, hashRecord, placeOf, recordDocOf, type Rec } from '../sync/codec'
import {
  CAUGHT_UP_SAVE_MS,
  EXPIRE_ORDER,
  MAX_TOPIC_FETCH,
  SYNC_SCHEMA,
  asCursor,
  asFirstSync,
  cursorOfMs,
  expirableIds,
  expireRangeStart,
  firstSyncSince,
  goneFromCloud,
  isSubscribedTable,
  laterCursor,
  localExpiryDate,
  msOfCursor,
  needsFirstSync,
  needsKnownRead,
  privateStart,
  remoteChangeOf,
  sendGuardTime,
  snapshotAdvance,
} from '../sync/syncPlan'

/** クラウドの1件の文書（外側の8つの欄。updated はサーバーの時刻のミリ秒） */
export interface CloudDoc {
  place: Place
  docId: string
  data: RecordDoc<number>
}

const keyOf = (place: Place, docId: string) => `${place}/${docId}`

export class FakeCloud {
  /** サーバーの時計（ミリ秒・UTC） */
  now: number
  /** いちばん新しく付けた updated（書き込みごとに違う時刻にする） */
  private last = 0
  readonly docs = new Map<string, CloudDoc>()
  /** 送る書き込みの印（端末 → その端末の最後に届いた送る書き込みの id。エンジンの users/{uid}/sync/{端末の ID}） */
  readonly marks = new Map<string, string>()
  /** config/owner の uid（null = 記録が無い） */
  owner: string | null
  /** meta/app の model（null = 記録が無い） */
  model: number | null = null
  /** 書き込みの記録（失敗した時の説明用） */
  readonly log: string[] = []
  /** 端末ごとの、読んだ文書の数（docs/SPEC.md の 7.9） */
  readonly reads = new Map<string, number>()
  /** 端末ごとの、書いた・消した文書の数 */
  readonly writes = new Map<string, number>()
  readonly deletes = new Map<string, number>()
  /** 問い合わせ（初めての受け取りの 1.）を通信の誤りで断る端末 */
  readonly failQuery = new Set<string>()
  /** records の購読を誤りで止める端末（初めての受け取りの 2. の失敗） */
  readonly failListen = new Set<string>()

  constructor(opts: { now: number; owner?: string | null }) {
    this.now = opts.now
    this.owner = opts.owner === undefined ? 'fake-user' : opts.owner
  }

  /** サーバーの時計を進める */
  tick(ms: number): void {
    this.now += ms
  }

  /**
   * 書き込みの時刻（サーバーの時刻。書き込みごとに違う値）。同じ時刻に2回書く時はサーバーの時計を 1ms 進める（updated がサーバーの時計より
   * 先にならないように。先になると、端末のサーバーの時刻の見積もりが本当の時刻より進み、本番では起きない形で30日の境を越えてしまう）
   */
  stamp(): number {
    if (this.now <= this.last) this.now = this.last + 1
    this.last = this.now
    return this.now
  }

  count(map: Map<string, number>, device: string, n: number): void {
    map.set(device, (map.get(device) ?? 0) + n)
  }

  readsOf(device: string): number {
    return this.reads.get(device) ?? 0
  }

  doc(place: Place, docId: string): CloudDoc | undefined {
    return this.docs.get(keyOf(place, docId))
  }

  /** 表の記録の文書（置き場は表で決める） */
  record(table: TableName, id: string): CloudDoc | undefined {
    return this.doc(placeOf(table), docIdOf(table, id))
  }

  /**
   * コネクタが記録を足す（作るだけ。同じ id がもうあれば「もうある」で書かない。device は 'claude-connector'）。
   * at を渡すと、その時刻を updated にする（管理者の権限で過去の時刻の文書を入れる時。エミュレーターに入れる道具と同じ）
   */
  add(table: TableName, record: Rec, opts: { at?: number } = {}): boolean {
    const place = placeOf(table)
    const docId = docIdOf(table, record.id)
    if (this.docs.has(keyOf(place, docId))) return false
    const updated = opts.at ?? this.stamp()
    this.docs.set(keyOf(place, docId), { place, docId, data: encodeDoc(table, record, { device: CONNECTOR_DEVICE, updated }) })
    this.log.push(`${CONNECTOR_DEVICE}@${updated}: 足した ${docId}`)
    return true
  }

  /** 何件かの記録を足す（作り物の版の fakeRecordsOf の順。atOf で updated を決められる） */
  addAll(
    list: readonly { table: TableName; record: Rec & { createdAt?: number } }[],
    atOf?: (r: { createdAt?: number }) => number,
  ) {
    for (const { table, record } of list) this.add(table, record, atOf ? { at: atOf(record) } : {})
  }

  /** 管理者の権限で文書を消す（Firebase の画面で消した時。ルールを通らない） */
  adminDelete(place: Place, docId: string): void {
    this.docs.delete(keyOf(place, docId))
  }

  /**
   * 端末の送るトランザクションの書き込み（ルールの appDoc のまね: アプリが作る・直すのは knownTerms（records）と reads（private）だけ、
   * id の形・json の上限・削除の印でない・device がコネクタでない。通らなければ投げる）
   */
  writeApp(place: Place, data: RecordDoc<number>, device: string): void {
    const ok =
      isOneOf(USER_TABLES, data.table) &&
      placeOf(data.table) === place &&
      isRecordIdFor(data.table, data.id) &&
      data.json.length <= RECORD_LIMITS.json[data.table] &&
      data.chunks === 0 &&
      data.deleted === false &&
      data.device !== CONNECTOR_DEVICE &&
      data.device.length >= 1 &&
      data.device.length <= 64
    if (!ok)
      throw Object.assign(new Error(`ルールで断られた書き込み ${place}/${data.table}:${data.id}`), { code: 'permission-denied' })
    const docId = docIdOf(data.table, data.id)
    this.docs.set(keyOf(place, docId), { place, docId, data })
    this.count(this.writes, device, 1)
  }

  /**
   * 30日の手入れの削除（ルールの expirableRecord・expiredDay のまね: 表ごとの id の形で、サーバーの時刻で30日を過ぎた物だけ。
   * まとめての削除は、1件でも通らなければ全部を断る）
   */
  expire(place: Place, docIds: readonly string[], device: string): void {
    const bad = docIds.filter(
      (id) => expirableIds([id], this.now).length === 0 || (place === 'private') !== id.startsWith('reads:'),
    )
    if (bad.length) throw Object.assign(new Error(`ルールで断られた削除 ${bad.join(' ')}`), { code: 'permission-denied' })
    for (const id of docIds) this.docs.delete(keyOf(place, id))
    this.count(this.deletes, device, docIds.length)
    this.log.push(`${device}@${this.now}: 30日で消した ${docIds.length}件`)
  }

  /** 購読の問い合わせ: from 以上に書かれた物（records は購読する表だけ。updated の順） */
  listen(place: Place, from: number): CloudDoc[] {
    return [...this.docs.values()]
      .filter((d) => d.place === place && d.data.updated >= from)
      .filter((d) => place !== 'records' || isSubscribedTable('records', d.data.table))
      .sort((a, b) => a.data.updated - b.data.updated || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0))
  }

  /** 文書の id の範囲の問い合わせ（30日の手入れ。gte か gt から end 未満を id の順に n 件） */
  idRange(place: Place, start: { gte: string } | { gt: string }, end: string, n: number): string[] {
    return [...this.docs.values()]
      .filter((d) => d.place === place)
      .map((d) => d.docId)
      .filter((id) => ('gte' in start ? id >= start.gte : id > start.gt) && id < end)
      .sort()
      .slice(0, n)
  }

  /** 削除の印（deleted: true・json が無い）の文書が無いか（TS は削除の印を書かない） */
  tombstones(): CloudDoc[] {
    return [...this.docs.values()].filter(
      (d) => d.data.deleted !== false || typeof d.data.json !== 'string' || d.data.chunks !== 0,
    )
  }
}

/** 購読の1つ（from 以上の問い合わせ。seen = 届けた文書の updated） */
interface FakeListener {
  from: number
  seen: Map<string, number>
  /** まだ最初の受け取り（問い合わせの全部）をしていない */
  fresh: boolean
}

/** 30日の手入れの結果（エンジンの MaintainResult と同じ形） */
export interface FakeMaintainResult {
  deleted: Partial<Record<ExpiringTableName, number>>
  total: number
  capped: boolean
  skipped: 'not-ready' | 'no-server-time' | 'done-today' | null
}

export interface FakeDeviceOptions {
  /** ログインしたアカウント（既定は 'fake-user'） */
  uid?: string
  /** 端末の時計のずれ（ミリ秒。端末の時計 = サーバーの時計 + clockOffset） */
  clockOffset?: number
  /** 端末の中の保存の名前（開き直す時に同じ物を使う） */
  dbName?: string
  /** 前に別のアカウントで同期していた端末を、このアカウントと同期してよいと確かめた（エンジンの allowAccountSwitch） */
  allowAccountSwitch?: boolean
}

let seq = 0

export class FakeDevice {
  readonly p: Persistence
  readonly uid: string
  readonly dbName: string
  readonly allowAccountSwitch: boolean
  clockOffset: number
  begun = false
  stopped = false
  /** 止まった理由（エンジンの errorCode と同じ: owner-missing・owner-mismatch・account-mismatch・listen） */
  errorCode: string | null = null
  /** クラウドのデータの形の版が高い（送らない） */
  outdated = false
  downloaded = false
  /** 初めての受け取りの途中（エンジンの firstPending・firstSince） */
  firstPending = false
  private firstSince: SyncCursor | null = null
  readonly cursor: Record<Place, SyncCursor | null> = { records: null, private: null }
  caughtUpAt: number | null = null
  private caughtUpSaved: number | null = null
  /** 端末の時計とサーバーの時刻の差の見積もり（エンジンの clockSkew） */
  skew: number | null = null
  private localExpiredDay: string | null = null
  private readonly listeners: Partial<Record<Place, FakeListener>> = {}
  private readonly synced: Record<Place, boolean> = { records: false, private: false }
  /** オフラインから戻った後、まだまとめて受け取っていない */
  private catchingUp = false
  private readonly sent = new Map<string, string[]>()
  /** 送る書き込みの印で最後に確かめた値（エンジンの lastLanded） */
  private lastLanded: string | null = null
  private attempts = 0
  /** 初めての受け取りの 1.（「知ってる」を全部読む）をした回数 */
  knownReads = 0

  constructor(
    readonly name: string,
    readonly cloud: FakeCloud,
    opts: FakeDeviceOptions = {},
  ) {
    this.uid = opts.uid ?? 'fake-user'
    this.clockOffset = opts.clockOffset ?? 0
    this.dbName = opts.dbName ?? `fake-${name}-${++seq}-${Math.random().toString(36).slice(2)}`
    this.allowAccountSwitch = opts.allowAccountSwitch ?? false
    this.p = createPersistence(this.dbName)
  }

  /** 端末の時計 */
  now(): number {
    return this.cloud.now + this.clockOffset
  }

  /** サーバーの時刻の見積もり（エンジンの serverNow） */
  serverNow(): number | null {
    return estimateServerNow(this.now(), this.skew)
  }

  /** アプリを閉じて、同じ端末で開き直す（メモリの状態を捨てる。端末の中の保存は残る） */
  reopen(opts: Pick<FakeDeviceOptions, 'clockOffset' | 'uid' | 'allowAccountSwitch'> = {}): FakeDevice {
    this.p.close()
    this.stopped = true
    return new FakeDevice(this.name, this.cloud, {
      uid: opts.uid ?? this.uid,
      clockOffset: opts.clockOffset ?? this.clockOffset,
      dbName: this.dbName,
      ...(opts.allowAccountSwitch ? { allowAccountSwitch: true } : {}),
    })
  }

  /** オフラインにする（戻った最初の受信は、それまでの書き込みをまとめて受け取る） */
  offline(): void {
    this.catchingUp = true
  }

  // ---------- 始める（エンジンの begin） ----------

  async start(): Promise<void> {
    if (this.begun || this.stopped) return
    // 持ち主（config/owner）: 無い → owner-missing、違う → owner-mismatch で同期しない
    this.cloud.count(this.cloud.reads, this.name, 1)
    const owner = this.cloud.owner
    if (owner !== this.uid) {
      if (owner !== null && (await this.p.getMeta<string>('ownerSeen')) === this.uid) await this.p.setMeta('ownerSeen', null)
      this.errorCode = owner === null ? 'owner-missing' : 'owner-mismatch'
      this.stopped = true
      return
    }
    await this.p.setMeta('ownerSeen', this.uid)
    const previous = await this.p.getMeta<string>('uid')
    if (previous !== this.uid) {
      // 前に別のアカウントで同期していた端末は、確かめた印が無ければ止める（エンジンの prepareDevice。docs/SPEC.md の 7.8）
      if (typeof previous === 'string' && previous && !this.allowAccountSwitch) {
        this.errorCode = 'account-mismatch'
        this.stopped = true
        return
      }
    }
    this.begun = true
    if (previous !== this.uid) {
      await this.p.markAllDirty()
      await this.p.setMeta('uid', this.uid)
    }
    if ((await this.p.getMeta<number>('syncSchema')) !== SYNC_SCHEMA) {
      await this.p.setMeta('cursor', null)
      await this.p.setMeta('caughtUpAt', null)
      await this.p.setMeta('firstSync', null)
      await this.p.setMeta('syncSchema', SYNC_SCHEMA)
    }
    const cursors = ((await this.p.getMeta<StoredCursors | null>('cursor')) ?? {}) as Record<string, unknown>
    for (const place of PLACES) this.cursor[place] = asCursor(cursors[place])
    const saved = await this.p.getMeta<unknown>('caughtUpAt')
    this.caughtUpAt = typeof saved === 'number' && Number.isFinite(saved) ? saved : null
    this.caughtUpSaved = this.caughtUpAt
    await this.expireLocal(true)
    // データの形の版（watchAppModel と同じ: 無い・低ければ上げる、高ければ送らない）
    this.cloud.count(this.cloud.reads, this.name, 1)
    if (this.cloud.model !== null && this.cloud.model > DATA_MODEL) this.outdated = true
    else this.cloud.model = DATA_MODEL
    this.subscribe('private', privateStart(this.cursor.private, this.now()))
    await this.beginRecords().catch(() => this.listenFailed('records'))
  }

  private subscribe(place: Place, from: SyncCursor): void {
    this.listeners[place] = { from: msOfCursor(from), seen: new Map(), fresh: true }
  }

  private listenFailed(place: Place): void {
    delete this.listeners[place]
    this.errorCode = 'listen'
  }

  /** 初めての受け取りの 1.（エンジンの readKnownTerms） */
  private async readKnownTerms(): Promise<void> {
    const now = this.now()
    if (!needsKnownRead(asFirstSync(await this.p.getMeta('firstSync')), now)) return
    if (this.cloud.failQuery.has(this.name)) throw new Error('通信できません（テスト）')
    this.knownReads += 1
    const from = this.cursor.records ? msOfCursor(this.cursor.records) : -Infinity
    const docs = [...this.cloud.docs.values()].filter(
      (d) => d.place === 'records' && d.data.table === 'knownTerms' && d.data.updated >= from,
    )
    this.cloud.count(this.cloud.reads, this.name, Math.max(1, docs.length))
    const changes: Change[] = []
    for (const d of docs) {
      this.skew = nextClockSkew(this.skew, now, d.data.updated)
      const c = remoteChangeOf(d.data, { docId: d.docId, place: 'records', deviceId: this.name, deviceNow: now })
      if (c.ok) changes.push(c.change)
    }
    await this.confirmLanded(changes)
    await this.p.applyRemote(changes, { meta: { firstSync: { knownAt: this.now() } } })
  }

  /** records の購読を始める（エンジンの beginRecords） */
  private async beginRecords(): Promise<void> {
    if (this.firstPending || needsFirstSync({ recordsCursor: this.cursor.records, caughtUpAt: this.caughtUpAt }, this.now())) {
      this.firstPending = true
      this.downloaded = false
      await this.readKnownTerms()
      this.firstSince = firstSyncSince(this.now())
      this.subscribe('records', this.firstSince)
      return
    }
    this.subscribe('records', this.cursor.records ?? firstSyncSince(this.now()))
  }

  private async resubscribe(place: Place): Promise<void> {
    if (place === 'records') await this.beginRecords().catch(() => this.listenFailed('records'))
    else this.subscribe(place, privateStart(this.cursor.private, this.now()))
  }

  /** いまの購読を始めた位置（ms。購読が無ければ null。エンジンの subscribedFrom。購読し直しを確かめる） */
  subscribedFrom(place: Place): number | null {
    return this.listeners[place]?.from ?? null
  }

  /** 記録した位置から購読し直す（エンジンの reanchor。20分より長く裏にあった後など） */
  async reanchor(): Promise<void> {
    for (const place of PLACES) await this.reanchorPlace(place)
  }

  private async reanchorPlace(place: Place): Promise<void> {
    const l = this.listeners[place]
    if (!l) return
    if (place === 'records') {
      if (this.firstPending) return
      if (needsFirstSync({ recordsCursor: this.cursor.records, caughtUpAt: this.caughtUpAt }, this.now())) {
        await this.beginRecords().catch(() => this.listenFailed('records'))
        return
      }
    }
    const c = this.cursor[place]
    if (c && laterCursor(c, cursorOfMs(l.from))) this.subscribe(place, c)
  }

  // ---------- 受け取る（エンジンの購読と handleSnapshot） ----------

  /** 受け取っていない書き込みを反映する。戻った最初はまとめて、その後は書き込みごとに */
  async receive(): Promise<boolean> {
    if (!this.begun || this.stopped) return false
    // 購読が誤りで止まっていたら、購読し直す（エンジンの resubscribeLater の後と同じ。records は初めての受け取りの途中なら 2. から）
    for (const place of PLACES) if (!this.listeners[place]) await this.resubscribe(place)
    let got = false
    for (const place of PLACES) got = (await this.receivePlace(place)) || got
    this.catchingUp = false
    return got
  }

  private async receivePlace(place: Place): Promise<boolean> {
    const l = this.listeners[place]
    if (!l) return false
    if (place === 'records' && this.cloud.failListen.has(this.name)) {
      this.listenFailed(place)
      return false
    }
    const matching = this.cloud.listen(place, l.from)
    const full = l.fresh
    const changed = full ? matching : matching.filter((d) => l.seen.get(d.docId) !== d.data.updated)
    this.cloud.count(this.cloud.reads, this.name, full ? Math.max(1, matching.length) : changed.length)
    for (const d of changed) l.seen.set(d.docId, d.data.updated)
    l.fresh = false
    if (!full && !changed.length) return false
    const groups: CloudDoc[][] = []
    if (full || this.catchingUp) groups.push(changed)
    else
      for (const d of changed) {
        const last = groups[groups.length - 1]
        if (last && last[0].data.updated === d.data.updated) last.push(d)
        else groups.push([d])
      }
    for (let i = 0; i < groups.length; i++) await this.handleSnapshot(place, groups[i], full && i === 0)
    if (this.errorCode === 'listen' && this.listeners.records) this.errorCode = null
    return changed.length > 0
  }

  private async handleSnapshot(place: Place, docs: readonly CloudDoc[], full: boolean): Promise<void> {
    const now = this.now()
    await this.expireLocal()
    const changes: Change[] = []
    let newest: SyncCursor | null = null
    for (const d of docs) {
      const at = cursorOfMs(d.data.updated)
      this.skew = nextClockSkew(this.skew, now, d.data.updated)
      if (laterCursor(at, newest)) newest = at
      if (this.staleEcho(keyOf(place, d.docId), d.data)) continue
      const c = remoteChangeOf(d.data, { docId: d.docId, place, deviceId: this.name, deviceNow: now })
      if (c.ok) changes.push(c.change)
    }
    const finishing = place === 'records' && this.firstPending && full && this.firstSince !== null
    const advance = snapshotAdvance(this.cursor[place], newest, finishing ? this.firstSince : null)
    const meta = finishing ? { caughtUpAt: now, firstSync: null } : undefined
    if (changes.length || advance || meta) {
      await this.confirmLanded(changes)
      await this.p.applyRemote(changes, { ...(advance ? { cursor: { place, at: advance } } : {}), ...(meta ? { meta } : {}) })
    }
    if (advance) this.cursor[place] = advance
    if (finishing) {
      this.firstPending = false
      this.firstSince = null
      this.caughtUpAt = now
      this.caughtUpSaved = now
    }
    if (place === 'records' && !finishing && !this.firstPending) await this.noteCaughtUp(now)
    this.synced[place] = true
    if (!this.downloaded && !this.firstPending && PLACES.every((p) => this.synced[p])) this.downloaded = true
    if (finishing) await this.reanchorPlace('records')
  }

  private async noteCaughtUp(now: number): Promise<void> {
    this.caughtUpAt = now
    if (this.caughtUpSaved !== null && Math.abs(now - this.caughtUpSaved) < CAUGHT_UP_SAVE_MS) return
    this.caughtUpSaved = now
    await this.p.setMeta('caughtUpAt', now)
  }

  private staleEcho(key: string, d: RecordDoc<number>): boolean {
    if (d.device !== this.name) return false
    const list = this.sent.get(key)
    if (!list || !list.includes(d.hash)) return false
    if (list[list.length - 1] === d.hash) {
      this.sent.set(key, [d.hash])
      return false
    }
    this.sent.set(key, list.slice(list.lastIndexOf(d.hash) + 1))
    return true
  }

  /** エンジンの confirmLandedFor と同じ: 返事を受け取れなかった書き込みの送信待ちに当たる変化は、印を読んで確かめてから */
  private async confirmLanded(changes: readonly Change[]): Promise<void> {
    const keys = changes.map((c) => `${c.table}/${c.id}`)
    if (!keys.length) return
    const txs = await this.p.unconfirmedTx(keys)
    if (!txs.size) return
    this.cloud.count(this.cloud.reads, this.name, 1)
    const landed = this.cloud.marks.get(this.name)
    if (landed && txs.has(landed)) {
      await this.p.confirmLanded(landed)
      this.lastLanded = landed
    }
  }

  // ---------- 端末の中で消す（エンジンの expireLocalNow） ----------

  async expireLocal(force = false): Promise<ExpireOutcome | null> {
    const now = this.now()
    const day = jstDateOf(now)
    if (!force && day === this.localExpiredDay) return null
    const out = await this.p.expireBefore(localExpiryDate(now))
    this.localExpiredDay = day
    return out
  }

  // ---------- 送る（エンジンの uploadBatch・uploadAll） ----------

  /**
   * 1回分を送る。replyLost = 書き込みはクラウドに届いたが、返事を受け取れなかった: 送った記録（completeUpload・送った版の指紋）を残さない
   */
  async uploadBatch(opts: { replyLost?: boolean } = {}): Promise<{ done: boolean; progressed: number; conflicts: OutboxItem[] }> {
    await this.expireLocal()
    const items = await this.p.readOutbox(100)
    if (!items.length) return { done: true, progressed: 0, conflicts: [] }
    const guardNow = sendGuardTime(this.serverNow(), this.now())
    const idle = items.filter((it) => nothingToSend(it, guardNow))
    if (idle.length) await this.p.completeUpload(idle.map((it) => ({ table: it.table, id: it.id, record: it.local })))
    const given = selectBatch(items, { ...SEND_LIMITS, serverNow: guardNow })
    if (!given.length || this.outdated) return { done: false, progressed: idle.length, conflicts: [] }
    const attempt = `${this.name}-tx-${++this.attempts}`
    // トランザクションで読む: 記録の文書と、送る書き込みの印
    this.cloud.count(this.cloud.reads, this.name, given.length + 1)
    const landed = this.cloud.marks.get(this.name) ?? null
    if (landed && landed !== this.lastLanded) {
      await this.p.confirmLanded(landed)
      this.lastLanded = landed
    }
    const batch: BatchEntry<OutboxItem>[] = given.map((b) => {
      if (!landed || b.it.tx !== landed) return b
      const it: OutboxItem = { ...b.it, base: b.it.sent ?? null, noHistory: false }
      delete it.unconfirmed
      delete it.tx
      delete it.sent
      return { ...b, it, baseHash: hashRecord(it.base) }
    })
    const clouds = batch.map((b) => this.cloud.record(b.it.table, b.it.id) ?? null)
    const states = clouds.map((c) => ({ exists: c !== null, hash: c ? c.data.hash : '' }))
    const decision = decideBatch(batch, states)
    const gone = batch.filter((b, i) => !decision.write[i] && goneFromCloud(b.it, states[i].exists))
    const goneKeys = new Set(gone.map((b) => b.it.k))
    const marks = batch.filter((b, i) => decision.write[i] && !sameAsBase(b.it)).map((b) => ({ key: b.it.k, record: b.it.local }))
    if (marks.length) await this.p.markUnconfirmed(marks, attempt)
    const updated = this.cloud.stamp()
    const written: { change: Change; key: string; hash: string }[] = []
    const settled: Change[] = []
    batch.forEach((b, i) => {
      if (!decision.write[i]) return
      if (sameAsBase(b.it)) {
        settled.push({ table: b.it.table, id: b.it.id, record: b.it.local })
        return
      }
      const place = placeOf(b.it.table)
      this.cloud.writeApp(place, recordDocOf(b.it.table, b.it.id, b.enc, { device: this.name, updated }), this.name)
      written.push({
        change: { table: b.it.table, id: b.it.id, record: b.it.local },
        key: keyOf(place, docIdOf(b.it.table, b.it.id)),
        hash: b.enc.hash,
      })
    })
    if (marks.length) this.cloud.marks.set(this.name, attempt)
    const conflicts = decision.conflicts.filter((it) => !goneKeys.has(it.k))
    this.cloud.log.push(
      `${this.name}@${updated}: 書いた ${written.map((w) => w.key).join(' ')}` +
        (conflicts.length ? ` | 書けなかった ${conflicts.map((c) => c.k).join(' ')}` : '') +
        (gone.length ? ` | クラウドで消えていた ${gone.map((g) => g.it.k).join(' ')}` : '') +
        (opts.replyLost ? '（返事を受け取れなかった）' : ''),
    )
    if (opts.replyLost) return { done: false, progressed: 0, conflicts: [] }
    if (marks.length) this.lastLanded = attempt
    for (const w of written) {
      const list = this.sent.get(w.key) ?? []
      list.push(w.hash)
      this.sent.set(w.key, list.slice(-20))
    }
    const goneChanges = gone.map((b): Change => ({ table: b.it.table, id: b.it.id, record: b.it.local }))
    await this.p.completeUpload([...written.map((w) => w.change), ...settled, ...goneChanges])
    return { done: false, progressed: idle.length + written.length + settled.length + gone.length, conflicts }
  }

  /** エンジンの pullDirectly と同じ: 書けなかったものだけをクラウドから直接読んで反映する */
  async pullDirectly(items: readonly OutboxItem[]): Promise<void> {
    const now = this.now()
    const changes: Change[] = []
    for (const it of items) {
      this.cloud.count(this.cloud.reads, this.name, 1)
      const d = this.cloud.record(it.table, it.id)
      if (!d) {
        changes.push({ table: it.table, id: it.id, record: null })
        continue
      }
      if (this.staleEcho(keyOf(d.place, d.docId), d.data)) continue
      const c = remoteChangeOf(d.data, { docId: d.docId, place: d.place, deviceId: this.name, deviceNow: now })
      if (c.ok) changes.push(c.change)
    }
    if (changes.length) {
      await this.confirmLanded(changes)
      await this.p.applyRemote(changes)
    }
  }

  /** エンジンの uploadAll と同じ: 送り終わるまで送る。書けなければ受信してから送り直す。最後に受け取る */
  async sync(): Promise<void> {
    if (!this.begun || this.stopped) return
    let stuck = 0
    for (let round = 0; round < 50 && !this.outdated; round++) {
      const r = await this.uploadBatch()
      if (r.done) break
      if (r.conflicts.length && r.progressed === 0) {
        stuck += 1
        const got = await this.receive()
        if (!got && stuck >= 3) await this.pullDirectly(r.conflicts)
        if (stuck > 6) throw new Error(`${this.name}: クラウドとの差を解消できませんでした\n${this.cloud.log.join('\n')}`)
      } else stuck = 0
    }
    await this.receive()
  }

  // ---------- 30日の手入れ（エンジンの maintain） ----------

  async maintain(): Promise<FakeMaintainResult> {
    const result: FakeMaintainResult = { deleted: {}, total: 0, capped: false, skipped: null }
    if (this.stopped || !this.begun || !this.downloaded || this.outdated) return { ...result, skipped: 'not-ready' }
    const now = this.now()
    const server = estimateServerNow(now, this.skew)
    if (server === null) return { ...result, skipped: 'no-server-time' }
    const day = jstDateOf(now)
    if ((await this.p.getMeta<string>('lastMaintainDay')) === day) return { ...result, skipped: 'done-today' }
    let budget = EXPIRE_DAILY_DOCS
    for (const table of EXPIRE_ORDER) {
      const place = placeOf(table)
      const end = expiryDocIdBefore(table, server)
      let after: string | null = null
      while (budget > 0) {
        const n = Math.min(EXPIRE_BATCH_DOCS, budget)
        const ids = this.cloud.idRange(place, after === null ? { gte: expireRangeStart(table) } : { gt: after }, end, n)
        this.cloud.count(this.cloud.reads, this.name, Math.max(1, ids.length))
        budget -= ids.length
        const doomed = expirableIds(ids, server)
        if (doomed.length) {
          this.cloud.expire(place, doomed, this.name)
          result.deleted[table] = (result.deleted[table] ?? 0) + doomed.length
          result.total += doomed.length
        }
        if (ids.length < n) break
        after = ids[ids.length - 1]
      }
      if (budget <= 0) {
        result.capped = true
        break
      }
    }
    await this.p.setMeta('lastMaintainDay', day)
    return result
  }

  // ---------- 欠けた話題を直接読む（エンジンの fetchTopics） ----------

  async fetchTopics(ids: readonly string[]): Promise<{ found: string[]; missing: string[] }> {
    const now = this.now()
    const out = { found: [] as string[], missing: [] as string[] }
    const changes: Change[] = []
    for (const id of [...new Set(ids)].slice(0, MAX_TOPIC_FETCH)) {
      this.cloud.count(this.cloud.reads, this.name, 1)
      const d = this.cloud.record('topics', id)
      if (d) this.skew = nextClockSkew(this.skew, now, d.data.updated)
      const c = d ? remoteChangeOf(d.data, { docId: d.docId, place: 'records', deviceId: this.name, deviceNow: now }) : null
      if (c?.ok) {
        changes.push(c.change)
        out.found.push(id)
      } else out.missing.push(id)
    }
    if (changes.length) await this.p.applyRemote(changes)
    return out
  }

  // ---------- アプリの操作（ストアの関数の代わり。16.2 の 7 で作るストアと同じく、端末の書き込みと送信待ちは persistence の save） ----------

  async userRecords(): Promise<UserRecords> {
    return this.p.loadUserRecords()
  }

  /** アプリの記録を1件書く（記録の参照だけを変えて save に渡す） */
  private async put(table: 'knownTerms' | 'reads', rec: AnyRecord): Promise<void> {
    const prev = await this.p.loadUserRecords()
    await this.p.save(prev, { ...prev, [table]: { ...prev[table], [rec.id]: rec } })
  }

  /** 話題を読んだ（topicId が null なら版の一覧を見ただけ）。topicIds は重なり無し・30件まで */
  async markRead(editionId: string, topicId: string | null, opts: { seen?: boolean } = {}): Promise<ReadMark> {
    const prev = (await this.p.loadUserRecords()).reads[editionId] as ReadMark | undefined
    const at = this.now()
    const topicIds = [...(prev?.topicIds ?? [])]
    if (topicId && !topicIds.includes(topicId) && topicIds.length < RECORD_LIMITS.read.topicIds) topicIds.push(topicId)
    const rec: ReadMark = {
      ...(prev ?? { id: editionId, v: 1, createdAt: at, by: 'user', ai: null, editionId, seen: false }),
      updatedAt: at,
      topicIds,
      seen: (prev?.seen ?? false) || opts.seen === true,
    } as ReadMark
    await this.put('reads', rec)
    return rec
  }

  /** 「知ってる」を押す（src/domain/known.ts の pressKnownTerm） */
  async know(press: KnownTermPress): Promise<KnownTerm> {
    const prev = (await this.p.loadUserRecords()).knownTerms[press.termId] as KnownTerm | undefined
    const rec = pressKnownTerm(prev ?? null, press, this.now())
    await this.put('knownTerms', rec)
    return rec
  }

  /** 「知ってる」を外す（記録は消さない） */
  async unknow(termId: string): Promise<KnownTerm> {
    const prev = (await this.p.loadUserRecords()).knownTerms[termId] as KnownTerm | undefined
    if (!prev) throw new Error(`知ってるの記録がありません: ${termId}`)
    const rec = unpressKnownTerm(prev, this.now())
    await this.put('knownTerms', rec)
    return rec
  }

  /**
   * 版を出すか（画面のストアと同じく、端末から版と order の話題と訂正を読み、src/domain/editionShow.ts で決める。端末の時計）。
   * 版の記録が無ければ none
   */
  async shownEdition(
    editionId: string,
    gone: ReadonlySet<string> = new Set(),
  ): Promise<{ kind: 'none' } | (EditionShowState<AnyRecord> & { corrections?: Map<string, ShownCorrection[]> })> {
    const raw = (await this.p.listEditions()).find((e) => e.id === editionId)
    if (!raw) return { kind: 'none' }
    const ed = repairEdition(raw)
    if (ed.kind !== 'ok') return { kind: 'broken' }
    const state = editionShowState(ed.value, await this.p.getTopics(ed.value.order), this.now(), gone)
    if (state.kind !== 'ready') return state
    const corrections = (await this.p.correctionsOfEdition(editionId))
      .map((c) => repairCorrection(c))
      .flatMap((r) => (r.kind === 'ok' ? [r.value] : []))
    return {
      ...state,
      corrections: correctionsByTopic(
        corrections,
        state.topics.map((t) => t.id),
      ),
    }
  }
}

/** 端末の送信待ちが空になり、クラウドの書き込みをすべて受け取るまで送受信する */
export async function settle(...ds: FakeDevice[]): Promise<void> {
  for (let round = 0; round < 20; round++) {
    for (const d of ds) await d.sync()
    const counts = await Promise.all(ds.map((d) => d.p.outboxCount()))
    if (counts.every((c) => c === 0) && !(await anyNewer(ds))) return
  }
  const rows = await Promise.all(ds.map(async (d) => `${d.name}: ${JSON.stringify(await d.p.readOutbox(5)).slice(0, 800)}`))
  throw new Error(`揃いませんでした\n${rows.join('\n')}\n${ds[0].cloud.log.join('\n')}`)
}

async function anyNewer(ds: readonly FakeDevice[]): Promise<boolean> {
  for (const d of ds) if (await d.receive()) return true
  return false
}
