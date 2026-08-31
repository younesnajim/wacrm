import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Ordered-queue Supabase mock: the route's calls happen in a fixed,
// known sequence (reaper scan -> per-stale-row update -> due scan ->
// per-due-row update), so each terminal call just pops the next canned
// `{ data, error }` off a queue rather than trying to reproduce
// PostgREST's actual filtering in the test double.
const h = vi.hoisted(() => ({
  responses: [] as { data: unknown; error: unknown }[],
  updateCalls: [] as { payload: Record<string, unknown> }[],
  orCalls: [] as string[],
  resumeCalls: [] as unknown[],
}))

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        update: (payload: Record<string, unknown>) => {
          h.updateCalls.push({ payload })
          return chain
        },
        eq: () => chain,
        or: (expr: string) => {
          h.orCalls.push(expr)
          return chain
        },
        lt: () => chain,
        lte: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () =>
          Promise.resolve(h.responses.shift() ?? { data: null, error: null }),
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(h.responses.shift() ?? { data: null, error: null }).then(
            onF,
            onR,
          ),
      }
      return chain
    },
  }),
}))

vi.mock('@/lib/automations/engine', () => ({
  resumePendingExecution: (arg: unknown) => {
    h.resumeCalls.push(arg)
    return Promise.resolve()
  },
}))

import { GET } from './route'

function req(secret = 'test-secret') {
  return new Request('https://example.com/api/automations/cron', {
    headers: { 'x-cron-secret': secret },
  })
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pe-1',
    automation_id: 'auto-1',
    account_id: 'acct-1',
    user_id: 'user-1',
    contact_id: 'contact-1',
    log_id: 'log-1',
    parent_step_id: null,
    branch: null,
    next_step_position: 1,
    context: {},
    attempts: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubEnv('AUTOMATION_CRON_SECRET', 'test-secret')
  h.responses = []
  h.updateCalls = []
  h.orCalls = []
  h.resumeCalls = []
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/automations/cron — auth', () => {
  it('returns 503 when the secret env var is not configured', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '')
    const res = await GET(req())
    expect(res.status).toBe(503)
  })

  it('returns 401 when the supplied secret does not match', async () => {
    const res = await GET(req('wrong-secret'))
    expect(res.status).toBe(401)
  })
})

describe('GET /api/automations/cron — stale-claim reaper', () => {
  it('reclaims a stale running row back to pending, and it is picked up in the same pass', async () => {
    h.responses = [
      // 1) reaper scan: one stale row, attempts below the cap
      { data: [{ id: 'pe-1', attempts: 1 }], error: null },
      // 2) reaper's UPDATE running->pending for pe-1
      { data: { id: 'pe-1' }, error: null },
      // 3) due scan picks up the just-reclaimed row (its original
      //    run_at is still in the past)
      { data: [pendingRow({ attempts: 1 })], error: null },
      // 4) claim UPDATE pending->running for pe-1
      { data: { id: 'pe-1' }, error: null },
    ]

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ processed: 1, reclaimed: 1, gaveUp: 0 })
    expect(h.resumeCalls).toHaveLength(1)

    // Reaper's update: back to pending, claimed_at cleared — not failed.
    expect(h.updateCalls[0].payload).toMatchObject({
      status: 'pending',
      claimed_at: null,
    })
    // The subsequent claim increments attempts off the row's current value.
    expect(h.updateCalls[1].payload).toMatchObject({ status: 'running', attempts: 2 })
    expect(h.updateCalls[1].payload.claimed_at).toBeTruthy()
  })

  it('gives up once a stale row has exhausted MAX_ATTEMPTS: marks failed, does not resume', async () => {
    h.responses = [
      // Row already at the attempt cap.
      { data: [{ id: 'pe-2', attempts: 5 }], error: null },
      { data: { id: 'pe-2' }, error: null }, // reaper's UPDATE -> failed
      { data: [], error: null }, // due scan: nothing left to process
    ]

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ processed: 0, reclaimed: 0, gaveUp: 1 })
    expect(h.resumeCalls).toHaveLength(0)
    expect(h.updateCalls[0].payload).toEqual({ status: 'failed' })
  })

  it('queries running rows with claimed_at NULL treated as stale, not just old', async () => {
    h.responses = [
      { data: [], error: null }, // no stale rows found
      { data: [], error: null }, // no due rows
    ]

    await GET(req())

    expect(h.orCalls).toHaveLength(1)
    expect(h.orCalls[0]).toContain('claimed_at.is.null')
    expect(h.orCalls[0]).toMatch(/claimed_at\.lt\./)
  })

  it('does not call resumePendingExecution for a reclaimed row unless it comes back due', async () => {
    h.responses = [
      { data: [{ id: 'pe-3', attempts: 0 }], error: null },
      { data: { id: 'pe-3' }, error: null }, // reclaimed to pending
      { data: [], error: null }, // but the due scan finds nothing (e.g. raced by another worker)
    ]

    const res = await GET(req())
    const body = await res.json()

    expect(body).toMatchObject({ processed: 0, reclaimed: 1, gaveUp: 0 })
    expect(h.resumeCalls).toHaveLength(0)
  })
})

describe('GET /api/automations/cron — normal drain', () => {
  it('claims a fresh due row (attempts 0 -> 1) and resumes it', async () => {
    h.responses = [
      { data: [], error: null }, // no stale rows
      { data: [pendingRow({ attempts: 0 })], error: null }, // one due row
      { data: { id: 'pe-1' }, error: null }, // claim succeeds
    ]

    const res = await GET(req())
    const body = await res.json()

    expect(body).toMatchObject({ processed: 1, reclaimed: 0, gaveUp: 0 })
    expect(h.resumeCalls).toEqual([
      expect.objectContaining({ id: 'pe-1', automation_id: 'auto-1' }),
    ])
    expect(h.updateCalls[0].payload).toMatchObject({ status: 'running', attempts: 1 })
    expect(h.updateCalls[0].payload.claimed_at).toBeTruthy()
  })

  it('skips a row another worker already claimed (lost the race)', async () => {
    h.responses = [
      { data: [], error: null },
      { data: [pendingRow()], error: null },
      { data: null, error: null }, // claim update matched 0 rows
    ]

    const res = await GET(req())
    const body = await res.json()

    expect(body.processed).toBe(0)
    expect(h.resumeCalls).toHaveLength(0)
  })

  it('reports zero processed with no due or stale rows', async () => {
    h.responses = [
      { data: [], error: null },
      { data: [], error: null },
    ]

    const res = await GET(req())
    const body = await res.json()

    expect(body).toEqual({ processed: 0, reclaimed: 0, gaveUp: 0 })
  })
})
