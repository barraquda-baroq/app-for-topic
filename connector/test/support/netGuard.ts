// テストの fetch の見張り（vitest の setupFiles。単体・Workers の中・エミュレーターのどのテストも）。テストは外のサイト
// （府省・庁・Global Voices・Firebase の本物など）へ出ない（設計の 7. の「CI」）: グローバルの fetch が、手元のエミュレーター（ループバックの
// 127.0.0.1・localhost）のほかへ出ようとしたら、要求を送らずに失敗させ、そのテストも落とす（中で失敗を握りつぶしても、afterEach で落ちる）。
// 作り物の置き場（fakeFirebase.ts の fetch・作り物の出どころの fetch）は、グローバルの fetch を通らずに VaultCore へ渡すか、テストが
// fetch を差し替えて答える（Workers の中のテスト）ので、ここを通らない。差し替えの外へ漏れた要求だけがここに来る。
import { afterEach } from 'vitest'

/** 出てよいホスト（手元のエミュレーター） */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** 外へ出ようとした要求の失敗（要求は送っていない） */
export class NetGuardError extends Error {
  constructor(host: string) {
    super(`テストから外への要求は送りません（${host}）`)
    this.name = 'NetGuardError'
  }
}

/** 出てよい URL か（http・https で、ホストがループバック） */
export function allowedUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname)
  } catch {
    return false
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host || '[URL]'
  } catch {
    return '[URL]'
  }
}

const blocked: string[] = []

type Guarded = typeof fetch & { __netGuard?: true }

const current = globalThis.fetch as Guarded
if (!current.__netGuard) {
  const inner = current
  const guarded = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!allowedUrl(url)) {
      const host = hostOf(url)
      blocked.push(host)
      return Promise.reject(new NetGuardError(host))
    }
    return inner(input, init)
  }) as Guarded
  guarded.__netGuard = true
  globalThis.fetch = guarded
}

/** 断った要求のホストを取り出して空にする（断ったことを確かめるテスト用。取り出せば、そのテストは落ちない） */
export function takeBlocked(): string[] {
  return blocked.splice(0)
}

afterEach(() => {
  const hosts = takeBlocked()
  if (hosts.length)
    throw new Error(
      `テストが外へ出ようとしました（${hosts.join('・')}）。作り物の置き場（test/support/fakeFirebase.ts など）を fetch に渡してください`,
    )
})
