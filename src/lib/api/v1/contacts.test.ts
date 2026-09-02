import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  serializeContact,
  findOrCreateContact,
  setContactCustomFields,
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
