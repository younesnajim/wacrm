// ============================================================
// POST /api/v1/deals — create a deal (scope: deals:write)
//
// `contact_id`, `pipeline_id`, and `stage_id` must all belong to the
// key's account, and `stage_id` must be a stage of `pipeline_id` —
// see `createDeal` in src/lib/api/v1/deals.ts for the exact checks.
// A foreign or unknown reference is a 400 (bad input), not a 404 —
// unlike a path param, the caller supplied these ids themselves, so
// there's no enumeration risk in saying they don't resolve.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { createDeal, DealError } from '@/lib/api/v1/deals';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const contactId =
      typeof body.contact_id === 'string' ? body.contact_id.trim() : '';
    const pipelineId =
      typeof body.pipeline_id === 'string' ? body.pipeline_id.trim() : '';
    const stageId =
      typeof body.stage_id === 'string' ? body.stage_id.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';

    if (!contactId) return fail('bad_request', "'contact_id' is required", 400);
    if (!pipelineId) return fail('bad_request', "'pipeline_id' is required", 400);
    if (!stageId) return fail('bad_request', "'stage_id' is required", 400);
    if (!title) return fail('bad_request', "'title' is required", 400);

    let value: number | undefined;
    if ('value' in body) {
      if (
        typeof body.value !== 'number' ||
        !Number.isFinite(body.value) ||
        body.value < 0
      ) {
        return fail('bad_request', "'value' must be a non-negative number", 400);
      }
      value = body.value;
    }

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
    const deal = await createDeal(ctx.supabase, ctx.accountId, auditUserId, {
      contactId,
      pipelineId,
      stageId,
      title,
      value,
    });

    return ok(deal, 201);
  } catch (err) {
    if (err instanceof DealError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
