import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/whatsapp/billing  (admin+)
 *
 * Current-billing-month WhatsApp message-cost summary for the caller's
 * account: total cost, per-category count/cost, free-tier usage
 * (1,000 service messages/month), and a projected month-end figure.
 *
 * A single round trip to get_message_billing_summary() (migration 053)
 * — the RPC does the aggregation, not four separate queries here. The
 * RPC re-checks is_account_member(account_id, 'admin') itself (a
 * SECURITY DEFINER function bypasses table RLS, so it has to), mirroring
 * the admin-only gate on ai_usage_log_select.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const { data, error } = await supabase.rpc('get_message_billing_summary', {
      p_account_id: accountId,
    })

    if (error) {
      console.error('[whatsapp/billing GET] rpc error:', error)
      return NextResponse.json(
        { error: 'Failed to load message costs' },
        { status: 500 },
      )
    }

    return NextResponse.json(data)
  } catch (err) {
    return toErrorResponse(err)
  }
}
