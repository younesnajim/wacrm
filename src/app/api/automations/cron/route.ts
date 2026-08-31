import { timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'

// A claim (status='running') older than this is treated as orphaned —
// the process that took it died (crash, OOM, deploy) before finishing.
// Every route in this codebase that could be mid-resume caps out at a
// 60s maxDuration, so 5 minutes is generously past any legitimate
// in-flight claim while still recovering promptly.
const STALE_RUNNING_MS = 5 * 60 * 1000

// A row that crashes the process on every resume (e.g. a step with
// pathological input) would otherwise cycle running -> stale -> pending
// -> running forever. Cap retries and let it land in 'failed' instead —
// the same terminal state a normal in-process execution failure uses.
const MAX_ATTEMPTS = 5

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 *
 * Before draining, sweeps rows stuck in 'running' past
 * STALE_RUNNING_MS — a claim whose process died before marking the
 * row 'done'/'failed' would otherwise sit forever, since nothing else
 * ever revisits status='running'. Reclaimed rows go back to 'pending'
 * (picked up by the drain below, since their original run_at is still
 * in the past) unless they've exhausted MAX_ATTEMPTS, in which case
 * they're marked 'failed' directly.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  const reaped = await reapStaleRunning(admin)

  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0, ...reaped })

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({
        status: 'running',
        claimed_at: new Date().toISOString(),
        attempts: ((row.attempts as number | null) ?? 0) + 1,
      })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  return NextResponse.json({ processed, ...reaped })
}

/**
 * Find claims stuck in 'running' past STALE_RUNNING_MS and recover
 * them: back to 'pending' for another try, or 'failed' once
 * MAX_ATTEMPTS is exhausted. Guards every update with
 * `.eq('status', 'running')` so a row that legitimately finishes
 * between our SELECT and UPDATE (a slow-but-alive resume, not an
 * orphan) can't be clobbered out from under it.
 */
async function reapStaleRunning(
  admin: SupabaseClient,
): Promise<{ reclaimed: number; gaveUp: number }> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString()
  const { data: stale, error } = await admin
    .from('automation_pending_executions')
    .select('id, attempts')
    .eq('status', 'running')
    // `claimed_at IS NULL` also counts as stale — a row already stuck
    // in 'running' from before this column existed (or any future gap
    // where a claim path forgets to stamp it) would otherwise never
    // match a plain `.lt()`, since NULL < x is NULL, not true, in SQL.
    .or(`claimed_at.is.null,claimed_at.lt.${cutoff}`)

  if (error) {
    console.error('[automations-cron] stale-claim scan failed:', error.message)
    return { reclaimed: 0, gaveUp: 0 }
  }
  if (!stale || stale.length === 0) return { reclaimed: 0, gaveUp: 0 }

  let reclaimed = 0
  let gaveUp = 0
  for (const row of stale as { id: string; attempts: number | null }[]) {
    const exhausted = (row.attempts ?? 0) >= MAX_ATTEMPTS
    const { data: updated } = await admin
      .from('automation_pending_executions')
      .update(
        exhausted
          ? { status: 'failed' }
          : { status: 'pending', claimed_at: null },
      )
      .eq('id', row.id)
      .eq('status', 'running')
      .select('id')
      .maybeSingle()
    if (!updated) continue
    if (exhausted) {
      gaveUp++
      console.error(
        `[automations-cron] pending execution ${row.id} exhausted ${MAX_ATTEMPTS} attempts — marked failed`,
      )
    } else {
      reclaimed++
    }
  }
  return { reclaimed, gaveUp }
}
