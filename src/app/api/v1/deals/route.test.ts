import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const requireApiKey = vi.fn();
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: (...args: unknown[]) => requireApiKey(...args),
}));

import { POST } from './route';
import { forbidden } from '@/lib/api/v1/respond';

type Row = Record<string, unknown>;

/** Minimal in-memory fake — flat `.eq()` filtering only, no embeds
 *  needed for deal creation. */
function makeFakeDb() {
  const contacts: Row[] = [];
  const pipelines: Row[] = [];
  const pipelineStages: Row[] = [];
  const deals: Row[] = [];
  const accounts: Row[] = [
    { id: 'acct-A', owner_user_id: 'owner-A', default_currency: 'USD' },
    { id: 'acct-B', owner_user_id: 'owner-B', default_currency: 'EUR' },
  ];
  const whatsappConfig: Row[] = [];

  function builder(table: string) {
    const store: Row[] =
      {
        contacts,
        pipelines,
        pipeline_stages: pipelineStages,
        deals,
        accounts,
        whatsapp_config: whatsappConfig,
      }[table] ?? [];

    const filters: [string, unknown][] = [];
    let mode: 'select' | 'insert' = 'select';
    let payload: Row = {};

    function matches(row: Row): boolean {
      return filters.every(([k, v]) => row[k] === v);
    }

    function execute(): { data: Row[]; error: null } {
      if (mode === 'insert') {
        const inserted: Row = {
          id: `deal-${deals.length + 1}`,
          created_at: 'created-now',
          updated_at: 'updated-now',
          ...payload,
        };
        store.push(inserted);
        return { data: [inserted], error: null };
      }
      return { data: store.filter(matches), error: null };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      insert: (p: Row) => {
        mode = 'insert';
        payload = p;
        return chain;
      },
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => {
        const r = execute();
        return Promise.resolve({ data: r.data[0] ?? null, error: r.error });
      },
      single: () => {
        const r = execute();
        return Promise.resolve({ data: r.data[0] ?? null, error: r.error });
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(execute()).then(onF, onR),
    };
    return chain;
  }

  return {
    supabase: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    contacts,
    pipelines,
    pipelineStages,
    deals,
  };
}

function ctxFor(db: ReturnType<typeof makeFakeDb>, accountId = 'acct-A') {
  return {
    authType: 'api_key' as const,
    supabase: db.supabase,
    accountId,
    keyId: 'key-1',
    scopes: ['deals:write'],
    createdBy: 'user-1',
  };
}

function req(body: unknown) {
  return new Request('https://example.com/api/v1/deals', {
    method: 'POST',
    headers: { authorization: 'Bearer wacrm_live_test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Seeds a coherent contact/pipeline/stage triple in `accountId`. */
function seedValidDealInputs(db: ReturnType<typeof makeFakeDb>, accountId: string) {
  db.contacts.push({ id: 'c1', account_id: accountId, phone: '+1' });
  db.pipelines.push({ id: 'p1', account_id: accountId, name: 'Sales' });
  db.pipelineStages.push({ id: 's1', pipeline_id: 'p1', name: 'New' });
}

beforeEach(() => {
  requireApiKey.mockReset();
});

describe('POST /api/v1/deals', () => {
  it('happy path: creates the deal with status open and the account default currency', async () => {
    const db = makeFakeDb();
    seedValidDealInputs(db, 'acct-A');
    requireApiKey.mockResolvedValue(ctxFor(db));

    const res = await POST(
      req({ contact_id: 'c1', pipeline_id: 'p1', stage_id: 's1', title: 'New lead', value: 5000 })
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({
      contact_id: 'c1',
      pipeline_id: 'p1',
      stage_id: 's1',
      title: 'New lead',
      value: 5000,
      currency: 'USD',
      status: 'open',
    });
  });

  it('defaults value to 0 when omitted', async () => {
    const db = makeFakeDb();
    seedValidDealInputs(db, 'acct-A');
    requireApiKey.mockResolvedValue(ctxFor(db));

    const res = await POST(req({ contact_id: 'c1', pipeline_id: 'p1', stage_id: 's1', title: 'New lead' }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.value).toBe(0);
  });

  it('cross-account isolation: a contact from another account is rejected (400, not found)', async () => {
    const db = makeFakeDb();
    seedValidDealInputs(db, 'acct-A');
    db.contacts.push({ id: 'c-victim', account_id: 'acct-B', phone: '+2' });
    requireApiKey.mockResolvedValue(ctxFor(db, 'acct-A'));

    const res = await POST(
      req({ contact_id: 'c-victim', pipeline_id: 'p1', stage_id: 's1', title: 'x' })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.message).toContain('contact_id');
    expect(db.deals).toHaveLength(0);
  });

  it('cross-account isolation: a pipeline from another account is rejected', async () => {
    const db = makeFakeDb();
    seedValidDealInputs(db, 'acct-A');
    db.pipelines.push({ id: 'p-victim', account_id: 'acct-B', name: 'Other' });
    db.pipelineStages.push({ id: 's-victim', pipeline_id: 'p-victim', name: 'New' });
    requireApiKey.mockResolvedValue(ctxFor(db, 'acct-A'));

    const res = await POST(
      req({ contact_id: 'c1', pipeline_id: 'p-victim', stage_id: 's-victim', title: 'x' })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.message).toContain('pipeline_id');
    expect(db.deals).toHaveLength(0);
  });

  it('cross-account isolation: a stage belonging to a different pipeline is rejected', async () => {
    const db = makeFakeDb();
    seedValidDealInputs(db, 'acct-A');
    // A second, otherwise-valid pipeline in the SAME account, with its
    // own stage — proves this is a pipeline/stage coherence check, not
    // just an account check.
    db.pipelines.push({ id: 'p2', account_id: 'acct-A', name: 'Support' });
    db.pipelineStages.push({ id: 's2', pipeline_id: 'p2', name: 'Open' });
    requireApiKey.mockResolvedValue(ctxFor(db, 'acct-A'));

    const res = await POST(
      req({ contact_id: 'c1', pipeline_id: 'p1', stage_id: 's2', title: 'x' })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.message).toContain('stage_id');
    expect(db.deals).toHaveLength(0);
  });

  it('missing scope returns 403', async () => {
    requireApiKey.mockRejectedValue(forbidden("This API key is missing the 'deals:write' scope"));

    const res = await POST(req({ contact_id: 'c1', pipeline_id: 'p1', stage_id: 's1', title: 'x' }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });

  it('rejects a missing title with 400', async () => {
    const db = makeFakeDb();
    seedValidDealInputs(db, 'acct-A');
    requireApiKey.mockResolvedValue(ctxFor(db));

    const res = await POST(req({ contact_id: 'c1', pipeline_id: 'p1', stage_id: 's1' }));
    expect(res.status).toBe(400);
  });
});
