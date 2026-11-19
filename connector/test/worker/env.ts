// workerd のテストの env（cloudflare:test）の型 = コネクタの Env（NS の connector/test/worker/env.ts を写した物）
import type { Env as ConnectorEnv } from '../../src/env'

declare global {
  namespace Cloudflare {
    interface Env extends ConnectorEnv {}
  }
}

export {}
