// E2E のテストの入口（test/e2e/worker.ts。workerd）のグローバルの fetch の見張り（B8。段階3の設計の 7. の「E2E」「CI」）。
// その Worker からは、手元のエミュレーター（ループバックの 127.0.0.1・localhost・[::1]）のほかへ要求を送らない（府省・庁や Global Voices の
// サイト・本物の Firebase へは出ない）。出ようとしたら送らずに失敗させる（test/support/netGuard.ts と同じ決まり。あちらは vitest を読み込むので
// workerd では使えず、ここに分けた）。作り物の出どころの取りに行きは FakeNews の fetch で、ここを通らない。
// 決まりの中身は test/unit/e2eEntry.test.ts が Node で確かめる（workerd の物を読み込まない）

/** 出てよいホスト（手元のエミュレーター） */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

/** 出てよい要求か（http・https で、ホストがループバック） */
export function loopbackUrl(input: RequestInfo | URL): boolean {
  try {
    const u = new URL(urlOf(input))
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

/** inner を包み、ループバックのほかへの要求を送らずに失敗させる fetch */
export function loopbackOnly(inner: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    if (loopbackUrl(input)) return inner(input, init)
    let host = ''
    try {
      host = new URL(urlOf(input)).host
    } catch {
      // 読めない URL（ホストは出さない）
    }
    return Promise.reject(new Error(`E2E のテストの入口からは外へ要求を送りません（${host || 'URL'}）`))
  }) as typeof fetch
}
