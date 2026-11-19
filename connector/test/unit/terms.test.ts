// 規約の印と許しの範囲（段階3の設計の 1.7 の (2) の 3・(1) の permit・(10)）: 試しの回だけ・指紋の無いページのある出どころは本番で取らない・
// 許しの期限・規約のページが変わった・会見の道（qaPages）は試しの回だけ・許しの本数・規約のページの指紋（scopes の外の更新日では変わらない）
import { describe, expect, it } from 'vitest'
import type { SourceConfig } from '../../src/fetch/sources'
import { countPermitBody, permitBodiesLeft, qaBlocked, sourceGate, termsFingerprint, termsPageText } from '../../src/fetch/terms'
import { MirrorStore } from '../../src/vault/store'
import { fakeTermsPage } from '../fixtures/fakePages'
import { eventsOf, FAKE_SOURCES, FAKE_TERMS_FP } from '../support/fakeNews'
import { nodeSql } from '../support/nodeSql'

const NOW = Date.UTC(2026, 10, 19, 1, 16)
const base = FAKE_SOURCES[0]
const edition = { kind: 'edition' }
const trial = { kind: 'trial' }

function store(ok = true) {
  const s = new MirrorStore(nodeSql(), () => NOW)
  if (ok)
    s.putHostRule({
      host: 'example.com',
      day: '2026-11-19',
      state: 'ok',
      crawlDelay: null,
      data: {},
      checked: NOW,
      changed: null,
    })
  return s
}

describe('出どころを取ってよいか', () => {
  it("'trial-only' と指紋の無いページのある出どころは、試しの回だけ", () => {
    const s = store()
    const only: SourceConfig = { ...base, terms: { status: 'trial-only', accepted: '2026-11-01' } }
    expect(sourceGate(only, s, NOW, edition)).toMatchObject({ ok: false, state: 'trial-only' })
    expect(sourceGate(only, s, NOW, trial).ok).toBe(true)
    const nofp: SourceConfig = { ...base, termsPages: [{ ...base.termsPages[0], fingerprint: undefined }] }
    expect(sourceGate(nofp, s, NOW, edition)).toMatchObject({ ok: false, state: 'trial-only' })
    expect(sourceGate(nofp, s, NOW, null)).toMatchObject({ ok: false, state: 'trial-only' })
    expect(sourceGate(base, s, NOW, edition).ok).toBe(true)
  })

  it('許しの期限を過ぎたら「取らない（許しの期限）」・規約のページが変わったら「取らない（規約のページが変わりました）」', () => {
    const s = store()
    const p: SourceConfig = {
      ...base,
      terms: { status: 'permitted', accepted: '2026-11-01' },
      permit: {
        grantedOn: '2026-11-01',
        until: '2026-11-18',
        scope: '作り物',
        maxBodiesPerRun: 3,
        minIntervalSec: 10,
        rssAllowed: false,
      },
    }
    expect(sourceGate(p, s, NOW, trial)).toMatchObject({ ok: false, state: 'permit-expired', text: '取らない（許しの期限）' })
    s.putTermsWatch({ url: base.termsPages[0].url, source: base.id, fingerprint: 'x', state: 'changed', checked: NOW })
    expect(sourceGate(base, s, NOW, edition)).toMatchObject({ ok: false, state: 'terms-changed' })
  })

  it('robots.txt・AI の意思表示・読めないホストは取らない。今日の決まりが無い時は、取る前に読む（ok として返す）', () => {
    const s = store(false)
    expect(sourceGate(base, s, NOW, edition).ok).toBe(true)
    for (const [state, kind] of [
      ['refused', 'robots'],
      ['stopped', 'ai'],
      ['unreadable', 'unreadable'],
    ] as const) {
      s.putHostRule({ host: 'example.com', day: '2026-11-19', state, crawlDelay: null, data: {}, checked: NOW, changed: null })
      expect(sourceGate(base, s, NOW, trial)).toMatchObject({ ok: false, state: kind })
    }
  })

  it('会見の記録の道は verified になるまで試しの回だけ', () => {
    expect(qaBlocked(base, '/fake-ministry/kaiken/1.html', edition)).toBe(true)
    expect(qaBlocked(base, '/fake-ministry/kaiken/1.html', trial)).toBe(false)
    expect(qaBlocked(base, '/fake-ministry/press/1.html', edition)).toBe(false)
    const verified: SourceConfig = {
      ...base,
      body: {
        kind: 'html',
        scopes: ['main'],
        dropBlocks: ['（記者）'],
        qaPages: { paths: ['/fake-ministry/kaiken/'], verified: true },
      },
    }
    expect(qaBlocked(verified, '/fake-ministry/kaiken/1.html', edition)).toBe(false)
  })

  it('許しの社の本文は1つの回に maxBodiesPerRun まで（許しの社でなければ数えない）', () => {
    const s = store()
    const p: SourceConfig = {
      ...base,
      permit: { grantedOn: '2026-11-01', scope: '作り物', maxBodiesPerRun: 2, minIntervalSec: 10, rssAllowed: false },
    }
    expect(permitBodiesLeft(s, 'r1', base)).toBeNull()
    expect(permitBodiesLeft(s, 'r1', p)).toBe(2)
    countPermitBody(s, 'r1', p)
    countPermitBody(s, 'r1', p)
    expect(permitBodiesLeft(s, 'r1', p)).toBe(0)
    expect(permitBodiesLeft(s, 'r2', p)).toBe(2)
  })
})

describe('規約のページの指紋', () => {
  it('scopes の中の文字の指紋（更新日など scopes の外が変わっても同じ・中の文が変われば違う）', () => {
    const fp = (html: string) => termsFingerprint(termsPageText(eventsOf(html), { scopes: ['main'] }))
    expect(fp(fakeTermsPage())).toBe(FAKE_TERMS_FP)
    expect(fp(fakeTermsPage(undefined, '2027年1月1日'))).toBe(FAKE_TERMS_FP)
    expect(fp(fakeTermsPage('作り物の別の決まり'))).not.toBe(FAKE_TERMS_FP)
    expect(FAKE_TERMS_FP).toMatch(/^[0-9a-z]{16}$/)
  })
})
