import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// addContactTagAndDispatch is independently tested
// (src/lib/contacts/tag-events.test.ts) and its own DB footprint (the
// automations engine, tag-chain depth, etc.) is irrelevant to the
// setContactTags diff logic under test here — mock it, but keep it
// behaviorally real: it still writes the join row, since several tests
// below assert on the resulting tag set, not just "was it called".
const mockAddContactTagAndDispatch = vi.fn();
vi.mock('@/lib/contacts/tag-events', () => ({
  addContactTagAndDispatch: (args: unknown) => mockAddContactTagAndDispatch(args),
}));

import {
  serializeContact,
  findOrCreateContact,
  setContactCustomFields,
  setContactTags,
  ContactError,
} from './contacts';

describe('serializeContact', () => {
  it('flattens contact_tags(tags(*)) onto a tags array and nulls missing fields', () => {
    const row = {
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      contact_tags: [
        { tags: { id: 't1', name: 'vip', color: '#fff' } },
        { tags: null }, // orphaned join — dropped
      ],
    };
    expect(serializeContact(row)).toEqual({
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      custom_fields: {},
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
  });

  it('tolerates a row with no contact_tags key', () => {
    const row = {
      id: 'c2',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
    };
    expect(serializeContact(row).tags).toEqual([]);
  });
});

describe('findOrCreateContact', () => {
  const noopDb = {} as SupabaseClient;

  it('rejects a non-E.164 phone with a 400 ContactError', async () => {
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toBeInstanceOf(ContactError);
  });
});

describe('serializeContact — custom_fields', () => {
  it('flattens contact_custom_values(custom_fields(field_name)) into a name -> value map', () => {
    const row = {
      id: 'c1',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
      contact_custom_values: [
        { value: 'hot', custom_fields: { field_name: 'lead_status' } },
        { value: null, custom_fields: { field_name: 'source' } },
        { value: 'orphaned', custom_fields: null }, // dangling join — dropped
      ],
    };
    expect(serializeContact(row).custom_fields).toEqual({
      lead_status: 'hot',
      source: null,
    });
  });

  it('is an empty object when the contact has no custom values', () => {
    const row = {
      id: 'c2',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
    };
    expect(serializeContact(row).custom_fields).toEqual({});
  });
});

describe('setContactCustomFields', () => {
  function makeDb(defs: { id: string; field_name: string }[]) {
    const upserts: Record<string, unknown>[] = [];
    const db = {
      from: (table: string) => {
        if (table === 'custom_fields') {
          return {
            select: () => ({
              eq: () => ({
                in: (_col: string, names: string[]) =>
                  Promise.resolve({
                    data: defs.filter((d) => names.includes(d.field_name)),
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === 'contact_custom_values') {
          return {
            upsert: (payload: Record<string, unknown>) => {
              upserts.push(payload);
              return Promise.resolve({ error: null });
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as SupabaseClient;
    return { db, upserts };
  }

  it('is a no-op for an empty fields object — no query at all', async () => {
    const { db, upserts } = makeDb([]);
    await setContactCustomFields(db, 'acct', 'c1', {});
    expect(upserts).toHaveLength(0);
  });

  it('rejects a non-string, non-null value before touching the DB', async () => {
    const { db, upserts } = makeDb([{ id: 'f1', field_name: 'lead_status' }]);
    await expect(
      setContactCustomFields(db, 'acct', 'c1', { lead_status: 42 })
    ).rejects.toMatchObject({ status: 400 });
    expect(upserts).toHaveLength(0);
  });

  it('rejects an unknown field name with a clear 400 and writes nothing', async () => {
    const { db, upserts } = makeDb([{ id: 'f1', field_name: 'lead_status' }]);
    await expect(
      setContactCustomFields(db, 'acct', 'c1', {
        lead_status: 'hot',
        bogus_field: 'x',
      })
    ).rejects.toThrow(/Unknown custom field name\(s\): bogus_field/);
    expect(upserts).toHaveLength(0);
  });

  it('upserts only the provided keys, leaving other fields alone', async () => {
    const { db, upserts } = makeDb([
      { id: 'f1', field_name: 'lead_status' },
      { id: 'f2', field_name: 'source' },
    ]);
    await setContactCustomFields(db, 'acct', 'c1', { lead_status: 'hot' });
    expect(upserts).toEqual([
      { contact_id: 'c1', custom_field_id: 'f1', value: 'hot' },
    ]);
  });

  it('allows clearing a value with null', async () => {
    const { db, upserts } = makeDb([{ id: 'f1', field_name: 'lead_status' }]);
    await setContactCustomFields(db, 'acct', 'c1', { lead_status: null });
    expect(upserts).toEqual([
      { contact_id: 'c1', custom_field_id: 'f1', value: null },
    ]);
  });
});

describe('setContactTags', () => {
  // Regression coverage for the bug where tags only ever accumulated:
  // `desired` was built from the WHOLE name->id map resolveImportTagIds
  // returns (every tag in the account), not just the requested names,
  // so the diff's `toRemove` was always empty.
  type Row = Record<string, unknown>;

  let tagsTable: Row[];
  let contactTagsTable: Row[];
  let nextTagId: number;

  function makeDb(): SupabaseClient {
    function builder(table: string) {
      const store: Row[] =
        table === 'tags' ? tagsTable : table === 'contact_tags' ? contactTagsTable : [];
      const filters: [string, unknown][] = [];
      const inFilters: [string, unknown[]][] = [];
      let mode: 'select' | 'insert' | 'delete' = 'select';
      let insertPayload: Row[] = [];

      function matches(row: Row): boolean {
        return (
          filters.every(([k, v]) => row[k] === v) &&
          inFilters.every(([k, v]) => v.includes(row[k]))
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        insert: (rows: Row | Row[]) => {
          mode = 'insert';
          insertPayload = Array.isArray(rows) ? rows : [rows];
          return chain;
        },
        delete: () => {
          mode = 'delete';
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
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
          if (mode === 'insert') {
            const created = insertPayload.map((p) => ({ id: `tag-${nextTagId++}`, ...p }));
            store.push(...created);
            return Promise.resolve({ data: created, error: null }).then(onF, onR);
          }
          if (mode === 'delete') {
            const toDelete = store.filter(matches);
            const remaining = store.filter((r) => !toDelete.includes(r));
            store.length = 0;
            store.push(...remaining);
            return Promise.resolve({ data: null, error: null }).then(onF, onR);
          }
          return Promise.resolve({ data: store.filter(matches), error: null }).then(onF, onR);
        },
      };
      return chain;
    }
    return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
  }

  function tagIdsFor(contactId: string): Set<string> {
    return new Set(
      contactTagsTable
        .filter((r) => r.contact_id === contactId)
        .map((r) => r.tag_id as string)
    );
  }

  beforeEach(() => {
    tagsTable = [];
    contactTagsTable = [];
    nextTagId = 1;
    mockAddContactTagAndDispatch.mockReset();
    mockAddContactTagAndDispatch.mockImplementation(
      async ({ contactId, tagId }: { contactId: string; tagId: string }) => {
        contactTagsTable.push({ contact_id: contactId, tag_id: tagId });
        return { added: true, dispatched: true };
      }
    );
  });

  it('removes tags not in a strict subset of the current set', async () => {
    tagsTable.push(
      { id: 'hot', account_id: 'acct', name: 'hot' },
      { id: 'warm', account_id: 'acct', name: 'warm' },
      { id: 'cold', account_id: 'acct', name: 'cold' }
    );
    contactTagsTable.push(
      { contact_id: 'c1', tag_id: 'hot' },
      { contact_id: 'c1', tag_id: 'warm' },
      { contact_id: 'c1', tag_id: 'cold' }
    );

    await setContactTags(makeDb(), 'acct', 'user-1', 'c1', ['warm']);

    expect(tagIdsFor('c1')).toEqual(new Set(['warm']));
  });

  it('clears all tags when given an empty array', async () => {
    tagsTable.push({ id: 'hot', account_id: 'acct', name: 'hot' });
    contactTagsTable.push({ contact_id: 'c1', tag_id: 'hot' });

    await setContactTags(makeDb(), 'acct', 'user-1', 'c1', []);

    expect(tagIdsFor('c1')).toEqual(new Set());
  });

  it('replaces entirely with a disjoint set', async () => {
    tagsTable.push(
      { id: 'hot', account_id: 'acct', name: 'hot' },
      { id: 'cold', account_id: 'acct', name: 'cold' }
    );
    contactTagsTable.push({ contact_id: 'c1', tag_id: 'hot' });

    await setContactTags(makeDb(), 'acct', 'user-1', 'c1', ['cold']);

    expect(tagIdsFor('c1')).toEqual(new Set(['cold']));
  });

  it('does not pull in an unrelated tag that happens to exist in the account', async () => {
    // The exact root cause: resolveImportTagIds's returned map contains
    // EVERY account tag, not just the requested one. Before the fix,
    // `desired` (built from .values() of that whole map) would include
    // 'unrelated' too, and it would get added to the contact even
    // though it was never in `tagNames`.
    tagsTable.push(
      { id: 'warm', account_id: 'acct', name: 'warm' },
      { id: 'unrelated', account_id: 'acct', name: 'unrelated-tag' }
    );

    await setContactTags(makeDb(), 'acct', 'user-1', 'c1', ['warm']);

    expect(tagIdsFor('c1')).toEqual(new Set(['warm']));
  });

  it('creates a missing tag definition and assigns only that one', async () => {
    tagsTable.push({ id: 'existing', account_id: 'acct', name: 'existing-tag' });

    await setContactTags(makeDb(), 'acct', 'user-1', 'c1', ['brand-new']);

    const created = tagsTable.find((t) => t.name === 'brand-new');
    expect(created).toBeTruthy();
    expect(tagIdsFor('c1')).toEqual(new Set([created!.id as string]));
  });
});
