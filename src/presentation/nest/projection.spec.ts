import { describe, expect, it } from 'bun:test';
import type { CatalogField, EntityCatalog } from '../../adapters/drizzle/registry/catalog.ts';
import { buildProjectionIndex, projectRowDeep } from './projection.ts';

// Minimal catalog builders — the projection functions read only key/eav/type
// from fields and name/target from relationships, so the rest is filled with
// inert defaults.
type Rel = EntityCatalog['relationships'][number];

function field(key: string, opts: Partial<CatalogField> = {}): CatalogField {
  return {
    key,
    eav: false,
    type: 'string',
    nullable: true,
    searchable: false,
    preview: false,
    sources: {},
    ...opts,
  };
}

function rel(name: string, target: string, kind: 'belongs_to' | 'has_many' = 'belongs_to'): Rel {
  return { name, target, kind, fk: '' } as unknown as Rel;
}

function cat(entity: string, fields: CatalogField[], relationships: Rel[] = []): EntityCatalog {
  return {
    entity,
    fields,
    relationships,
    searchableColumns: [],
  } as unknown as EntityCatalog;
}

// Three curated entities mirroring the dealbrain shape: opportunities (all-EAV,
// only `id` native) with a belongs_to account and has_many opportunityContacts;
// accounts (all-EAV) carrying tenant FKs + a provider_metadata blob; and the
// opportunity_contacts join with a small native allowlist.
const catalogs: EntityCatalog[] = [
  cat(
    'opportunities',
    [field('id'), field('dealname', { eav: true }), field('organization_id')],
    [
      rel('account', 'accounts', 'belongs_to'),
      rel('opportunityContacts', 'opportunity_contacts', 'has_many'),
    ],
  ),
  cat('accounts', [
    field('id'),
    field('hs_industry', { eav: true }),
    field('organization_id'),
    field('user_id'),
    field('provider_metadata', { type: 'json' }),
  ]),
  cat('opportunity_contacts', [field('id'), field('role'), field('contact_id')]),
];

const expose = {
  opportunities: ['id'],
  accounts: ['id'],
  opportunity_contacts: ['id', 'role'],
};

const index = buildProjectionIndex(catalogs, expose);

describe('buildProjectionIndex', () => {
  it('allow-lists id + EAV fields, drops non-listed native columns', () => {
    const opp = index.get('opportunities');
    expect(opp?.fields.has('id')).toBe(true);
    expect(opp?.fields.has('dealname')).toBe(true); // EAV always passes
    expect(opp?.fields.has('organization_id')).toBe(false); // native, not listed
  });

  it('maps each relationship name to its target entity', () => {
    const opp = index.get('opportunities');
    expect(opp?.rels.get('account')).toBe('accounts');
    expect(opp?.rels.get('opportunityContacts')).toBe('opportunity_contacts');
  });
});

describe('projectRowDeep', () => {
  it('drops scalar fields not in the allowlist', () => {
    const out = projectRowDeep(
      { id: 'o1', dealname: 'Acme', organization_id: 'org1' },
      'opportunities',
      index,
    );
    expect(out).toEqual({ id: 'o1', dealname: 'Acme' });
  });

  it('projects a belongs_to relation against the TARGET allowlist (no tenant/metadata leak)', () => {
    const out = projectRowDeep(
      {
        id: 'o1',
        account: {
          id: 'a1',
          hs_industry: 'software',
          organization_id: 'org1',
          user_id: 'u1',
          provider_metadata: { vendor: 'hubspot' },
        },
      },
      'opportunities',
      index,
    );
    expect(out.account).toEqual({ id: 'a1', hs_industry: 'software' });
    const account = out.account as Record<string, unknown>;
    expect(account.organization_id).toBeUndefined();
    expect(account.user_id).toBeUndefined();
    expect(account.provider_metadata).toBeUndefined();
  });

  it('projects each entry of a has_many array relation', () => {
    const out = projectRowDeep(
      {
        id: 'o1',
        opportunityContacts: [
          { id: 'oc1', role: 'champion', contact_id: 'c1' },
          { id: 'oc2', role: 'economic buyer', contact_id: 'c2' },
        ],
      },
      'opportunities',
      index,
    );
    expect(out.opportunityContacts).toEqual([
      { id: 'oc1', role: 'champion' },
      { id: 'oc2', role: 'economic buyer' },
    ]);
  });

  it('fails closed: an entity not in the index drops to {}', () => {
    const out = projectRowDeep({ id: 'x', secret: 'leak' }, 'not_a_real_entity', index);
    expect(out).toEqual({});
  });

  it('passes a null relation value through untouched', () => {
    const out = projectRowDeep({ id: 'o1', account: null }, 'opportunities', index);
    expect(out).toEqual({ id: 'o1', account: null });
  });
});
