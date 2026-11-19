#!/usr/bin/env node
// 作り物の版を Firebase エミュレーターに入れる: npm run seed:emu -- --days 35（docs/SPEC.md の 16.3 の「エミュレーターに入れる」・
// docs/DEPLOY.md の 7）。先に別の画面でエミュレーターを動かしておく
// （npx firebase emulators:start --config firebase.emu.json --only auth,firestore --project demo-topic-studio）。
// 管理者の権限（Authorization: Bearer owner。ルールを通らない）で、コネクタと同じ外側の文書（device: 'claude-connector'）を、
// 版の日時に合わせた過去の updated で users/{uid}/records に書く（32日より前の物も混ぜる）。書くのはエミュレーターだけで、本物の
// プロジェクトには届かない。
// 中身は src/test/seedEmulator.ts（作り物の版は src/test/fixtures/fakeEditions.ts）。TypeScript のファイルは、vite の runnerImport で
// 読み込む（vite.config.ts と同じ解き方で、拡張子の無い import も読める。ほかの道具を足さずに済む。設定ファイルは読まない）。
// オプション:
//   --days N         何日分か（3以上。既定 35）
//   --sub NAME       書く先の、エミュレーターの仮の Google アカウント（既定 dev-author。無ければ作る。メールは NAME@example.com）。
//                    開発サーバーの console で __ts.signInForTest('NAME') とすると、このアカウントでログインできる
//   --uid UID        書く先のアカウントの uid（エミュレーターのログイン画面で作ったアカウント。開発サーバーの console の __ts.syncUid()）
//   --seed TEXT      作り物の乱数の種（既定 fake-month。同じ種からは同じ物）
//   --until DATE     いちばん新しい版の日付（YYYY-MM-DD。日本時間。既定は2時間より前に始まった、いちばん新しい枠の日）
//   --until-slot S   その日の最後の枠（12 か 20）
//   --owner          持ち主の記録 config/owner もこのアカウントにする（VITE_E2E_OWNER_LOCK=1 の開発サーバーで開く時と、コネクタを試す時に要る）
//   --connector UID  連携の記録 config/connector も、このコネクタの匿名のアカウントにする（書き込みを許可。--owner と一緒に使う）。
//                    エミュレーターにつないだコネクタ（wrangler dev）を試す時。UID はコネクタの /connect/identity の uid
//                    （例: npm run seed:emu -- --owner --connector UID。連携の画面を通さないので、claude.ai からの連携の確かめはしない）
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const USAGE = `使い方: npm run seed:emu -- [--days 35] [--sub dev-author | --uid UID] [--seed fake-month] [--until YYYY-MM-DD] [--until-slot 12|20] [--owner [--connector UID]]`

/** 既定の値（src/test/seedEmulator.ts の SEED_DEFAULTS と同じ。引数の読み取りは TypeScript を読み込む前にする） */
export const DEFAULTS = { days: 35, sub: 'dev-author', seed: 'fake-month' }

/** 引数を読む（間違いは Error で知らせる） */
export function parseArgs(argv) {
  const out = {
    days: DEFAULTS.days,
    sub: DEFAULTS.sub,
    uid: null,
    seed: DEFAULTS.seed,
    until: null,
    untilSlot: null,
    owner: false,
    connector: null,
    help: false,
  }
  const args = argv.flatMap((a) =>
    a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a],
  )
  for (let i = 0; i < args.length; i++) {
    const name = args[i]
    const value = () => {
      const v = args[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`${name} の値がありません`)
      i += 1
      return v
    }
    if (name === '--help' || name === '-h') out.help = true
    else if (name === '--owner') out.owner = true
    else if (name === '--days') {
      const v = value()
      const n = Number(v)
      // makeFakeMonth は3日以上（続報の鎖に3日要る）。1年を超える量は無料枠の見積もり（7.9）から外れるので断る
      if (!/^\d+$/.test(v) || n < 3 || n > 366) throw new Error(`--days は 3〜366 の整数にしてください（${v}）`)
      out.days = n
    } else if (name === '--sub') {
      const v = value()
      if (!/^[0-9A-Za-z._-]{1,64}$/.test(v)) throw new Error(`--sub は英数字と . _ - の 64字までにしてください（${v}）`)
      out.sub = v
    } else if (name === '--uid') {
      const v = value()
      if (!/^[0-9A-Za-z]{1,128}$/.test(v)) throw new Error(`--uid は英数字にしてください（${v}）`)
      out.uid = v
    } else if (name === '--connector') {
      const v = value()
      if (!/^[0-9A-Za-z]{1,128}$/.test(v)) throw new Error(`--connector は英数字にしてください（${v}）`)
      out.connector = v
    } else if (name === '--seed') {
      const v = value()
      if (!v.trim()) throw new Error('--seed が空です')
      out.seed = v
    } else if (name === '--until') {
      const v = value()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--until は YYYY-MM-DD にしてください（${v}）`)
      out.until = v
    } else if (name === '--until-slot') {
      const v = value()
      if (v !== '12' && v !== '20') throw new Error(`--until-slot は 12 か 20 にしてください（${v}）`)
      out.untilSlot = v
    } else throw new Error(`知らない引数です: ${name}`)
  }
  // コネクタは、持ち主の記録が書く先のアカウントの時だけ読み書きできる（ルールの isConnector）
  if (out.connector && !out.owner) throw new Error('--connector は --owner と一緒に使ってください')
  if (out.connector && out.uid && out.connector === out.uid)
    throw new Error('--connector と --uid が同じです（持ち主はコネクタにならない）')
  return out
}

/** 数を 1,234 の形にする */
const n = (v) => v.toLocaleString('en-US')

/** 書いた結果の文 */
export function report(plan, uid, args) {
  const c = plan.counts
  const lines = [
    `作り物の版をエミュレーターに入れました（users/${uid}/records。updated は版の日時に合わせた過去の時刻）`,
    `  版 ${n(c.editions)}・話題 ${n(c.topics)}・辞書の束 ${n(c.termPacks)}・作れなかった印 ${n(c.editionFails)}・訂正 ${n(c.corrections)}（合わせて ${n(plan.total)}件）`,
    `  いちばん新しい版: ${plan.newestEditionId}（${plan.until} の ${plan.untilSlot}:00版まで。種 ${args.seed}）`,
    `  初めての受け取りの窓（端末の時計 − 32日）より前: ${n(plan.beforeFirstSync)}件（新しい端末は受け取らない）`,
    `  版の日付が30日の境の外: ${n(plan.outsideRetention)}件（その日の最初の受け取りの後、30日の手入れで消える）`,
  ]
  if (args.owner) lines.push(`  持ち主の記録 config/owner も、このアカウント（${uid}）にしました`)
  if (args.connector)
    lines.push(
      `  連携の記録 config/connector も、コネクタの匿名のアカウント（${args.connector}）にしました（書き込みを許可。連携の画面を通していません）`,
    )
  if (!args.uid)
    lines.push(
      `  エミュレーターにつないだ開発サーバーの console で __ts.signInForTest('${args.sub}') とすると、このアカウントでログインします`,
    )
  return lines.join('\n')
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    console.error(USAGE)
    process.exit(1)
  }
  if (args.help) {
    console.log(USAGE)
    return
  }
  const { runnerImport } = await import('vite')
  const { module: seed } = await runnerImport(path.join(repoDir, 'src/test/seedEmulator.ts'), {
    root: repoDir,
    logLevel: 'error',
  })
  const opts = { days: args.days, seed: args.seed, owner: args.owner }
  if (args.connector) opts.connector = args.connector
  if (args.until) opts.until = args.until
  if (args.untilSlot) opts.untilSlot = args.untilSlot
  try {
    // 書く前に作って確かめる（今より後の updated になる時は、何も書かずに止まる）
    seed.seedPlan(opts)
    const uid = await seed.seedTargetUid(args.uid ? { uid: args.uid } : { sub: args.sub })
    const plan = await seed.seedEmulator(uid, opts)
    console.log(report(plan, uid, args))
  } catch (e) {
    const text = e instanceof Error ? `${e.message}${e.cause instanceof Error ? `（${e.cause.message}）` : ''}` : String(e)
    if (/ECONNREFUSED|fetch failed/.test(text)) {
      console.error(
        'エミュレーターにつながりません。先に別の画面で、次のとおりにエミュレーターを動かしてください（docs/DEPLOY.md の 7）',
      )
      console.error('  npx firebase emulators:start --config firebase.emu.json --only auth,firestore --project demo-topic-studio')
    } else console.error(text)
    process.exit(1)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
