import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------
// requireApiKey is unit-tested on its own (src/lib/auth/api-context.test.ts)
// — these tests mock it directly rather than re-deriving key-hash/rate-
// limit machinery, and focus on what's new in the route: account
// scoping and custom-field handling actually happening correctly.
// ---------------------------------------------------------------------
const requireApiKey = vi.fn();
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: (...args: unknown[]) => requireApiKey(...args),
}));

import { GET, PATCH } from './route';
import { forbidden } from '@/lib/api/v1/respond';

type Row = Record<string, unknown>;

/**
 * Minimal in-memory fake of the Supabase query builder, purpose-built
 * for the contacts/{id} route: enough `.eq()`/`.in()` filtering to make
 * account scoping genuinely load-bearing (not just trusted), and a
 * `contacts` select that computes the `contact_tags`/
 * `contact_custom_values` embeds dynamically from the other tables —
 * so a write made mid-test (e.g. an upsert) is reflected the next time
 * a contact is re-fetched, exactly like real Postgrest.
 */
function makeFakeDb() {
  const contacts: Row[] = [];
  const contactTags: Row[] = [];
  const tags: Row[] = [];
  const customFields: Row[] = [];
  const contactCustomValues: Row[] = [];

  function embedContact(row: Row): Row {
    const tagJoins = contactTags
      .filter((ct) => ct.contact_id === row.id)
      .map((ct) => ({
        tags: tags.find((t) => t.id === ct.tag_id) ?? null,
      }));
    const customJoins = contactCustomValues
      .filter((cv) => cv.contact_id === row.id)
      .map((cv) => {
        const field = customFields.find((f) => f.id === cv.custom_field_id);
        return {
          value: cv.value,
          custom_fields: field ? { field_name: field.field_name } : null,
        };
      });
    return { ...row, contact_tags: tagJoins, contact_custom_values: customJoins };
  }

  function builder(table: string) {
    const store: Row[] =
      {
        contacts,
        contact_tags: contactTags,
        tags,
        custom_fields: customFields,
        contact_custom_values: contactCustomValues,
      }[table] ?? [];

    const filters: [string, unknown][] = [];
    const inFilters: [string, unknown[]][] = [];
    let mode: 'select' | 'update' | 'upsert' = 'select';
    let payload: Row = {};

    function matches(row: Row): boolean {
      return (
        filters.every(([k, v]) => row[k] === v) &&
        inFilters.every(([k, v]) => v.includes(row[k]))
      );
    }

    function execute(): { data: unknown; error: null } {
      if (mode === 'update') {
        const targets = store.filter(matches);
        for (const t of targets) {
          Object.assign(t, payload, { updated_at: 'updated-now' });
        }
        return { data: targets, error: null };
      }
      if (mode === 'upsert') {
        const existing = store.find(
          (r) =>
            r.contact_id === payload.contact_id &&
            r.custom_field_id === payload.custom_field_id
        );
        if (existing) Object.assign(existing, payload);
        else store.push({ id: `row-${store.length + 1}`, ...payload });
        return { data: null, error: null };
      }
      return { data: store.filter(matches), error: null };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      update: (p: Row) => {
        mode = 'update';
        payload = p;
        return chain;
      },
      upsert: (p: Row) => {
        mode = 'upsert';
        payload = p;
        return chain;
      },
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return chain;
      },
      in: (k: string, v: unknown[]) => {
        inFilters.push([k, v]);
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => {
        const r = execute();
        const found = ((r.data as Row[]) ?? [])[0] ?? null;
        const data = found && table === 'contacts' ? embedContact(found) : found;
        return Promise.resolve({ data, error: r.error });
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(execute()).then(onF, onR),
    };
    return chain;
  }

  return {
    supabase: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    contacts,
    contactTags,
    tags,
    contactCustomValues,
    customFields,
  };
}

function ctxFor(db: ReturnType<typeof makeFakeDb>, accountId = 'acct-A') {
  return {
    authType: 'api_key' as const,
    supabase: db.supabase,
    accountId,
    keyId: 'key-1',
    scopes: ['contacts:read', 'contacts:write'],
    createdBy: 'user-1',
  };
}

function req(method: string, body?: unknown) {
  return new Request('https://example.com/api/v1/contacts/c1', {
    method,
    headers: { authorization: 'Bearer wacrm_live_test', 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

function baseContact(overrides: Row = {}): Row {
  return {
    id: 'c1',
    account_id: 'acct-A',
    phone: '+14155550123',
    name: 'Jane',
    email: null,
    company: null,
    avatar_url: null,
    created_at: 'created-then',
    updated_at: 'updated-then',
    ...overrides,
  };
}

beforeEach(() => {
  requireApiKey.mockReset();
});

describe('GET /api/v1/contacts/{id} — custom_fields', () => {
  it('happy path: includes custom_fields keyed by field name', async () => {
    const db = makeFakeDb();
    db.contacts.push(baseContact());
    db.customFields.push({ id: 'f1', account_id: 'acct-A', field_name: 'lead_status' });
    db.contactCustomValues.push({
      id: 'ccv1',
      contact_id: 'c1',
      custom_field_id: 'f1',
      value: 'hot',
    });
    requireApiKey.mockResolvedValue(ctxFor(db));

    const res = await GET(req('GET'), paramsFor('c1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.custom_fields).toEqual({ lead_status: 'hot' });
  });

  it('cross-account isolation: a contact in another account 404s, not the data', async () => {
    const db = makeFakeDb();
    db.contacts.push(baseContact({ id: 'c-victim', account_id: 'acct-B' }));
    requireApiKey.mockResolvedValue(ctxFor(db, 'acct-A'));

    const res = await GET(req('GET'), paramsFor('c-victim'));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });

  it('missing scope returns 403', async () => {
    requireApiKey.mockRejectedValue(forbidden("This API key is missing the 'contacts:read' scope"));

    const res = await GET(req('GET'), paramsFor('c1'));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });
});

describe('PATCH /api/v1/contacts/{id} — custom_fields', () => {
  it('happy path: upserts the provided custom field', async () => {
    const db = makeFakeDb();
    db.contacts.push(baseContact());
    db.customFields.push({ id: 'f1', account_id: 'acct-A', field_name: 'lead_status' });
    requireApiKey.mockResolvedValue(ctxFor(db));

    const res = await PATCH(
      req('PATCH', { custom_fields: { lead_status: 'hot' } }),
      paramsFor('c1')
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.custom_fields).toEqual({ lead_status: 'hot' });
  });

  it('leaves custom fields not mentioned in the request unchanged', async () => {
    const db = makeFakeDb();
    db.contacts.push(baseContact());
    db.customFields.push(
      { id: 'f1', account_id: 'acct-A', field_name: 'lead_status' },
      { id: 'f2', account_id: 'acct-A', field_name: 'source' }
    );
    // Pre-existing value on a field the PATCH will NOT mention.
    db.contactCustomValues.push({
      id: 'ccv1',
      contact_id: 'c1',
      custom_field_id: 'f2',
      value: 'referral',
    });
    requireApiKey.mockResolvedValue(ctxFor(db));

    const res = await PATCH(
      req('PATCH', { custom_fields: { lead_status: 'hot' } }),
      paramsFor('c1')
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.custom_fields).toEqual({
      lead_status: 'hot',
      source: 'referral', // untouched
    });
  });

  it('unknown custom field name: clear 400, and nothing in the request is applied', async () => {
    const db = makeFakeDb();
    db.contacts.push(baseContact({ name: 'Original Name' }));
    db.customFields.push({ id: 'f1', account_id: 'acct-A', field_name: 'lead_status' });
    requireApiKey.mockResolvedValue(ctxFor(db));

    const res = await PATCH(
      req('PATCH', {
        name: 'New Name', // sent alongside the bad custom field — must NOT apply either
        custom_fields: { lead_status: 'hot', bogus_field: 'x' },
      }),
      paramsFor('c1')
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('bogus_field');

    // Nothing was written: name unchanged, no custom value row created.
    expect(db.contacts[0].name).toBe('Original Name');
    expect(db.contactCustomValues).toHaveLength(0);
  });

  it('cross-account isolation: cannot write a custom field onto another account\'s contact', async () => {
    const db = makeFakeDb();
    db.contacts.push(baseContact({ id: 'c-victim', account_id: 'acct-B' }));
    db.customFields.push({ id: 'f1', account_id: 'acct-B', field_name: 'lead_status' });
    requireApiKey.mockResolvedValue(ctxFor(db, 'acct-A'));

    const res = await PATCH(
      req('PATCH', { custom_fields: { lead_status: 'hot' } }),
      paramsFor('c-victim')
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(db.contactCustomValues).toHaveLength(0);
  });

  it('missing scope returns 403', async () => {
    requireApiKey.mockRejectedValue(forbidden("This API key is missing the 'contacts:write' scope"));

    const res = await PATCH(
      req('PATCH', { custom_fields: { lead_status: 'hot' } }),
      paramsFor('c1')
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });
});

describe('PATCH /api/v1/contacts/{id} — omitting `tags`', () => {
  it('leaves tags untouched when the tags key is absent entirely (must not clear)', async () => {
    const db = makeFakeDb();
    db.contacts.push(baseContact());
    db.tags.push(
      { id: 't-hot', account_id: 'acct-A', name: 'hot', color: '#f00' },
      { id: 't-cold', account_id: 'acct-A', name: 'cold', color: '#00f' }
    );
    db.contactTags.push(
      { contact_id: 'c1', tag_id: 't-hot' },
      { contact_id: 'c1', tag_id: 't-cold' }
    );
    requireApiKey.mockResolvedValue(ctxFor(db));

    // No `tags` key at all — only an unrelated scalar field.
    const res = await PATCH(req('PATCH', { company: 'Acme' }), paramsFor('c1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.tags.map((t: { name: string }) => t.name).sort()).toEqual([
      'cold',
      'hot',
    ]);
    // The join rows themselves are untouched, not just coincidentally
    // re-derived the same way.
    expect(db.contactTags).toHaveLength(2);
  });
});
