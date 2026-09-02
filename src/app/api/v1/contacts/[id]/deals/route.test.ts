import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const requireApiKey = vi.fn();
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: (...args: unknown[]) => requireApiKey(...args),
}));

import { GET } from './route';
import { forbidden } from '@/lib/api/v1/respond';

type Row = Record<string, unknown>;

function makeFakeDb() {
  const contacts: Row[] = [];
  const deals: Row[] = [];

  function builder(table: string) {
    const store: Row[] = { contacts, deals }[table] ?? [];
    const filters: [string, unknown][] = [];

    function matches(row: Row): boolean {
      return filters.every(([k, v]) => row[k] === v);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      or: () => chain, // never exercised — these tests don't send a cursor
      maybeSingle: () => {
        const rows = store.filter(matches);
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve({ data: store.filter(matches), error: null }).then(onF, onR),
    };
    return chain;
  }

  return {
    supabase: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    contacts,
    deals,
  };
}

function ctxFor(db: ReturnType<typeof makeFakeDb>, accountId = 'acct-A') {
  return {
    authType: 'api_key' as const,
    supabase: db.supabase,
    accountId,
    keyId: 'key-1',
    scopes: ['deals:read'],
    createdBy: 'user-1',
  };
}

function req() {
  return new Request('https://example.com/api/v1/contacts/c1/deals', {
    headers: { authorization: 'Bearer wacrm_live_test' },
  });
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  requireApiKey.mockReset();
});

describe('GET /api/v1/contacts/{id}/deals', () => {
  it('happy path: lists the contact\'s deals, newest first', async () => {
    const db = makeFakeDb();
    db.contacts.push({ id: 'c1', account_id: 'acct-A', phone: '+1' });
    db.deals.push(
      {
        id: 'd1',
        account_id: 'acct-A',
        contact_id: 'c1',
        pipeline_id: 'p1',
        stage_id: 's1',
        title: 'Older deal',
        value: 100,
        currency: 'USD',
        status: 'open',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'd2',
        account_id: 'acct-A',
        contact_id: 'c1',
        pipeline_id: 'p1',
        stage_id: 's1',
        title: 'Newer deal',
        value: 200,
        currency: 'USD',
        status: 'open',
        created_at: '2026-02-01T00:00:00Z',
        updated_at: '2026-02-01T00:00:00Z',
      }
    );
    requireApiKey.mockResolvedValue(ctxFor(db));

    const res = await GET(req(), paramsFor('c1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.map((d: { id: string }) => d.id)).toEqual(['d1', 'd2']);
    expect(body.data[0]).toMatchObject({ title: 'Older deal', value: 100, currency: 'USD' });
  });

  it('does not list a deal belonging to a different contact', async () => {
    const db = makeFakeDb();
    db.contacts.push({ id: 'c1', account_id: 'acct-A', phone: '+1' });
    db.deals.push({
      id: 'd-other',
      account_id: 'acct-A',
      contact_id: 'c-other',
      pipeline_id: 'p1',
      stage_id: 's1',
      title: 'Not this contact',
      value: 0,
      currency: 'USD',
      status: 'open',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    requireApiKey.mockResolvedValue(ctxFor(db));

    const res = await GET(req(), paramsFor('c1'));
    const body = await res.json();

    expect(body.data).toEqual([]);
  });

  it('cross-account isolation: a contact in another account 404s', async () => {
    const db = makeFakeDb();
    db.contacts.push({ id: 'c-victim', account_id: 'acct-B', phone: '+1' });
    db.deals.push({
      id: 'd-victim',
      account_id: 'acct-B',
      contact_id: 'c-victim',
      pipeline_id: 'p1',
      stage_id: 's1',
      title: 'Belongs to account B',
      value: 999,
      currency: 'EUR',
      status: 'open',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    requireApiKey.mockResolvedValue(ctxFor(db, 'acct-A'));

    const res = await GET(req(), paramsFor('c-victim'));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });

  it('missing scope returns 403', async () => {
    requireApiKey.mockRejectedValue(forbidden("This API key is missing the 'deals:read' scope"));

    const res = await GET(req(), paramsFor('c1'));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });
});
