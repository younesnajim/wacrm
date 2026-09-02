// ============================================================
// GET /api/v1/contacts/{id}/deals — list a contact's deals
// (scope: deals:read), newest first, keyset-paginated.
//
// The contact is verified to belong to the key's account before any
// deal is returned — a foreign or unknown contact id -> 404, mirroring
// conversations/[id]/messages/route.ts.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import { serializeDeal } from '@/lib/api/v1/deals';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'deals:read');
    const { id } = await params;
    const { limit, cursor } = parseListParams(request);

    const { data: contact } = await ctx.supabase
      .from('contacts')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!contact) return fail('not_found', 'Contact not found', 404);

    let query = ctx.supabase
      .from('deals')
      .select('*')
      .eq('contact_id', id)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/contacts/deals] list error:', error);
      return fail('internal', 'Failed to list deals', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((d) => serializeDeal(d as Record<string, unknown>)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
