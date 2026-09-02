// ============================================================
// Shared deal logic for the public API (v1) deal endpoints.
//
// Kept out of the route files so `POST /api/v1/deals` and
// `GET /api/v1/contacts/{id}/deals` share one serializer and one
// creation path — mirrors the split in `contacts.ts`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ApiDeal {
  id: string;
  contact_id: string;
  pipeline_id: string;
  stage_id: string;
  title: string;
  value: number;
  currency: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/** Thrown by the helpers below; routes map `.status`/`.message`. */
export class DealError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DealError';
    this.status = status;
  }
}

/** Project a `deals` row into the public shape — no `account_id`,
 *  `user_id`, `team_id`, or `assigned_to`; same "hide internal FKs"
 *  policy as `serializeContact`/`serializeMessage`. */
export function serializeDeal(row: Record<string, unknown>): ApiDeal {
  return {
    id: row.id as string,
    contact_id: row.contact_id as string,
    pipeline_id: row.pipeline_id as string,
    stage_id: row.stage_id as string,
    title: row.title as string,
    value: Number(row.value),
    currency: row.currency as string,
    status: row.status as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export interface CreateDealInput {
  contactId: string;
  pipelineId: string;
  stageId: string;
  title: string;
  /** Defaults to 0 (the column's own default) when omitted. */
  value?: number;
}

/**
 * Create a deal, validating that `contactId` and `pipelineId` both
 * belong to `accountId`, and that `stageId` is actually a stage of
 * `pipelineId` — not just some stage somewhere in the account. A
 * mismatched stage/pipeline pair would otherwise silently corrupt the
 * deal (a stage shown against a pipeline it was never part of).
 *
 * `status` is fixed to `'open'` and `currency` is taken from the
 * account's configured default — same choices the automation engine's
 * own `create_deal` step already makes (see
 * `src/lib/automations/engine.ts`), kept consistent here rather than
 * letting the public API mint deals with a currency wacrm's own
 * automations would never choose.
 */
export async function createDeal(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  input: CreateDealInput
): Promise<ApiDeal> {
  const { data: contact } = await db
    .from('contacts')
    .select('id')
    .eq('id', input.contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!contact) {
    throw new DealError("'contact_id' does not belong to this account", 400);
  }

  const { data: pipeline } = await db
    .from('pipelines')
    .select('id')
    .eq('id', input.pipelineId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!pipeline) {
    throw new DealError("'pipeline_id' does not belong to this account", 400);
  }

  // pipeline_stages has no account_id of its own — scoping by the
  // already-verified pipeline_id both confirms account ownership
  // transitively and enforces the stage genuinely belongs to that
  // pipeline, not merely to the account at large.
  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('id', input.stageId)
    .eq('pipeline_id', input.pipelineId)
    .maybeSingle();
  if (!stage) {
    throw new DealError("'stage_id' is not a stage of 'pipeline_id'", 400);
  }

  const { data: acct } = await db
    .from('accounts')
    .select('default_currency')
    .eq('id', accountId)
    .maybeSingle();

  const { data: created, error } = await db
    .from('deals')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      contact_id: input.contactId,
      pipeline_id: input.pipelineId,
      stage_id: input.stageId,
      title: input.title,
      value: input.value ?? 0,
      currency: (acct?.default_currency as string | undefined) ?? 'USD',
      status: 'open',
    })
    .select('*')
    .single();

  if (error || !created) {
    console.error('[api/v1/deals] create error:', error);
    throw new DealError('Failed to create deal', 500);
  }

  return serializeDeal(created as Record<string, unknown>);
}
