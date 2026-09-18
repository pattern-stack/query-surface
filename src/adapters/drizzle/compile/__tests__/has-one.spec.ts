// has_one — a to-one edge whose FK lives on the TARGET (accounts has_one account_profiles
// via account_profiles.account_id). Proves, offline (drizzle.mock(), no DB):
//   1. introspection classifies a defineRelations() `r.one` keyed PK→FK as has_one;
//   2. a HOST-SUPPLIED (declared, not introspected) AggregateModel carrying a has_one plans
//      and compiles: the has_one target's dims conform at the parent grain (LEFT JOIN on
//      target.fk = parent.pk), transitively through a belongs_to hop, and the grain oracle
//      ranks the has_one child at its parent's grain;
//   3. the SAME edge declared has_many is refused (to-many — would fan the measure);
//   4. the retrieval compiler + the schema doctor accept the has_one edge.

import { describe, expect, it } from 'bun:test';
import { type SQL, defineRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  type PgColumn,
  PgDialect,
  type PgTable,
  numeric,
  pgTable,
  primaryKey,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { grainRank, measureFans } from '../../../../internal/analytics/grain';
import {
  conformedDimensions,
  resolveJoinPlan,
  toOnePaths,
} from '../../../../internal/analytics/join-plan';
import type { AggRegistry, Aggregate } from '../../../../internal/analytics/types';
import { diagnose } from '../../diagnostics/doctor';
import { expandRows } from '../../execute/expand';
import { runAggregateDrizzle } from '../../execute/run-drizzle';
import { analyticsFromRegistry } from '../../registry/analytics-from-registry';
import type { AggregateModel } from '../../registry/model';
import {
  type EntityDescriptor,
  buildRegistry,
  configureQueryRegistry,
} from '../../registry/registry';
import { compileGroupedDrizzle } from '../compile-drizzle';
import { compile } from '../compiler';

const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey(),
  region: varchar('region'),
});
const accountProfiles = pgTable('account_profiles', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id').unique(),
  tier: varchar('tier'),
  arr: numeric('arr'),
});
const opportunities = pgTable('opportunities', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id'),
  amount: numeric('amount'),
});

const relations = defineRelations({ accounts, accountProfiles, opportunities }, (r) => ({
  accounts: {
    profile: r.one.accountProfiles({ from: r.accounts.id, to: r.accountProfiles.accountId }),
    opportunities: r.many.opportunities(),
  },
  accountProfiles: {
    account: r.one.accounts({ from: r.accountProfiles.accountId, to: r.accounts.id }),
  },
  opportunities: {
    account: r.one.accounts({ from: r.opportunities.accountId, to: r.accounts.id }),
  },
}));

// The introspected registrations for the graph above.
const introspected = [
  { name: 'accounts', table: accounts, relations: relations.accounts.relations },
  {
    name: 'account_profiles',
    table: accountProfiles,
    relations: relations.accountProfiles.relations,
  },
  { name: 'opportunities', table: opportunities, relations: relations.opportunities.relations },
];

// ---------------------------------------------------------------------------
// A DECLARED AggregateModel — built by hand, the way a code generator emits it
// from entity YAML (no introspection anywhere below).
// ---------------------------------------------------------------------------

function descriptor(
  name: string,
  table: PgTable,
  relationships: EntityDescriptor['relationships'],
): EntityDescriptor {
  return {
    name,
    table,
    primaryKey: 'id',
    columns: table as unknown as Record<string, PgColumn>,
    relationships,
    searchableColumns: [],
  };
}

function byDbName(table: PgTable): Record<string, PgColumn> {
  const out: Record<string, PgColumn> = {};
  for (const col of Object.values(table as unknown as Record<string, PgColumn>)) {
    if (col && typeof col === 'object' && 'name' in col) out[col.name] = col;
  }
  return out;
}

function declaredModel(profileKind: 'has_one' | 'has_many'): AggregateModel {
  const profile = { kind: profileKind, target: 'account_profiles', fk: 'account_id' } as const;
  const registry: Record<string, EntityDescriptor> = {
    accounts: descriptor('accounts', accounts, {
      profile,
      opportunities: { kind: 'has_many', target: 'opportunities', fk: 'account_id' },
    }),
    account_profiles: descriptor('account_profiles', accountProfiles, {
      account: { kind: 'belongs_to', target: 'accounts', fk: 'account_id' },
    }),
    opportunities: descriptor('opportunities', opportunities, {
      account: { kind: 'belongs_to', target: 'accounts', fk: 'account_id' },
    }),
  };
  const analytics: AggRegistry = {
    accounts: {
      table: 'accounts',
      pk: 'id',
      rels: { ...registry.accounts!.relationships },
      fields: { id: { type: 'uuid' }, region: { type: 'string', role: 'dimension' } },
    },
    account_profiles: {
      table: 'account_profiles',
      pk: 'id',
      rels: { ...registry.account_profiles!.relationships },
      fields: {
        tier: { type: 'string', role: 'dimension' },
        arr: { type: 'number', role: 'measure', agg: 'sum', additivity: 'additive' },
      },
    },
    opportunities: {
      table: 'opportunities',
      pk: 'id',
      rels: { ...registry.opportunities!.relationships },
      fields: {
        amount: { type: 'number', role: 'measure', agg: 'sum', additivity: 'additive' },
      },
    },
  };
  return {
    registry,
    analytics,
    tables: { accounts, account_profiles: accountProfiles, opportunities },
    colByDbName: {
      accounts: byDbName(accounts),
      account_profiles: byDbName(accountProfiles),
      opportunities: byDbName(opportunities),
    },
  };
}

const db = drizzle.mock();
const dialect = new PgDialect();
const sqlOf = (model: AggregateModel, q: Aggregate): string =>
  compileGroupedDrizzle(db, model, q).query.toSQL().sql;
const text = (s: SQL): string => dialect.sqlToQuery(s).sql;

describe('has_one — introspection (Drizzle 1.0 defineRelations)', () => {
  const reg = buildRegistry([
    { name: 'accounts', table: accounts, relations: relations.accounts.relations },
    {
      name: 'account_profiles',
      table: accountProfiles,
      relations: relations.accountProfiles.relations,
    },
    { name: 'opportunities', table: opportunities, relations: relations.opportunities.relations },
  ]);

  it('classifies r.one keyed PK→FK as has_one (fk on the target)', () => {
    expect(reg.accounts!.relationships.profile).toEqual({
      kind: 'has_one',
      target: 'account_profiles',
      fk: 'account_id',
    });
  });

  it('classifies r.one keyed FK→PK as belongs_to and r.many as has_many', () => {
    expect(reg.account_profiles!.relationships.account).toEqual({
      kind: 'belongs_to',
      target: 'accounts',
      fk: 'account_id',
    });
    expect(reg.accounts!.relationships.opportunities).toEqual({
      kind: 'has_many',
      target: 'opportunities',
      fk: 'account_id',
    });
  });

  it('the doctor counts a has_one as the inverse of a belongs_to (no MISSING_INVERSE)', () => {
    const findings = diagnose([
      { name: 'accounts', table: accounts, relations: relations.accounts.relations },
      {
        name: 'account_profiles',
        table: accountProfiles,
        relations: relations.accountProfiles.relations,
      },
      {
        name: 'opportunities',
        table: opportunities,
        relations: relations.opportunities.relations,
      },
    ]);
    expect(findings.filter((f) => f.code === 'MISSING_INVERSE')).toEqual([]);
  });
});

describe('introspection — primary keys from table metadata, not the column name', () => {
  // Shared-PK 1:1: user_settings.user_id IS its primary key (not named `id`) AND the FK.
  const users = pgTable('users', { id: uuid('id').primaryKey(), name: varchar('name') });
  const userSettings = pgTable('user_settings', {
    userId: uuid('user_id').primaryKey(),
    theme: varchar('theme'),
  });
  // Composite PK junction: its edges still classify off the OTHER side's real PK.
  const accountTags = pgTable(
    'account_tags',
    { accountId: uuid('account_id'), tag: varchar('tag') },
    (t) => [primaryKey({ columns: [t.accountId, t.tag] })],
  );
  const rels = defineRelations({ users, userSettings, accounts, accountTags }, (r) => ({
    users: { settings: r.one.userSettings({ from: r.users.id, to: r.userSettings.userId }) },
    userSettings: { user: r.one.users({ from: r.userSettings.userId, to: r.users.id }) },
    accounts: { tags: r.many.accountTags() },
    accountTags: {
      account: r.one.accounts({ from: r.accountTags.accountId, to: r.accounts.id }),
    },
  }));
  const regs = [
    { name: 'users', table: users, relations: rels.users.relations },
    { name: 'user_settings', table: userSettings, relations: rels.userSettings.relations },
    { name: 'accounts', table: accounts, relations: rels.accounts.relations },
    { name: 'account_tags', table: accountTags, relations: rels.accountTags.relations },
  ];
  const reg = buildRegistry(regs);

  it('a shared-PK 1:1 is has_one in BOTH directions (never belongs_to either way)', () => {
    expect(reg.users!.relationships.settings).toEqual({
      kind: 'has_one',
      target: 'user_settings',
      fk: 'user_id',
    });
    expect(reg.user_settings!.relationships.user).toEqual({
      kind: 'has_one',
      target: 'users',
      fk: 'id',
    });
  });

  it('…so the grain oracle ranks both sides equal and the join is PK = PK', () => {
    const analytics = analyticsFromRegistry(reg);
    expect(grainRank(analytics, 'user_settings')).toBe(grainRank(analytics, 'users'));
    expect(toOnePaths(analytics, 'users', 'user_settings')).toEqual([
      [{ from: 'users', to: 'user_settings', kind: 'has_one', fromCol: 'id', toCol: 'user_id' }],
    ]);
  });

  it('a composite-PK junction still yields belongs_to + the inverse has_many', () => {
    expect(reg.account_tags!.relationships.account).toEqual({
      kind: 'belongs_to',
      target: 'accounts',
      fk: 'account_id',
    });
    expect(reg.accounts!.relationships.tags).toEqual({
      kind: 'has_many',
      target: 'account_tags',
      fk: 'account_id',
    });
    expect(diagnose(regs).filter((f) => f.code === 'UNSUPPORTED_RELATION')).toEqual([]);
  });
});

describe('introspection — unsupported relation shapes', () => {
  it('a .through() many-to-many is skipped by the registry and reported by the doctor', () => {
    const tags = pgTable('tags', { id: uuid('id').primaryKey() });
    const accountTags = pgTable('account_tags', {
      id: uuid('id').primaryKey(),
      accountId: uuid('account_id'),
      tagId: uuid('tag_id'),
    });
    const rels = defineRelations({ accounts, tags, accountTags }, (r) => ({
      accounts: {
        tags: r.many.tags({
          from: r.accounts.id.through(r.accountTags.accountId),
          to: r.tags.id.through(r.accountTags.tagId),
        }),
      },
    }));
    const regs = [
      { name: 'accounts', table: accounts, relations: rels.accounts.relations },
      { name: 'tags', table: tags, relations: rels.tags.relations },
    ];
    expect(buildRegistry(regs).accounts!.relationships).toEqual({});
    expect(diagnose(regs).filter((f) => f.code === 'UNSUPPORTED_RELATION')).toMatchObject([
      { entity: 'accounts', severity: 'warn' },
    ]);
  });
});

describe('has_one — grain oracle + join plan (declared model)', () => {
  const { analytics } = declaredModel('has_one');

  it('a has_one child sits at its parent grain (never finer → never fans)', () => {
    expect(grainRank(analytics, 'account_profiles')).toBe(grainRank(analytics, 'accounts'));
    expect(measureFans(analytics, 'accounts', 'account_profiles')).toBe(false);
    // contrast: a has_many child IS finer
    expect(measureFans(analytics, 'accounts', 'opportunities')).toBe(true);
  });

  it('resolves a has_one target dim as a to-one LEFT JOIN on target.fk = parent.pk', () => {
    expect(resolveJoinPlan(analytics, 'accounts', 'account_profiles.tier', 'group')).toEqual({
      kind: 'to-one',
      target: 'account_profiles',
      column: 'tier',
      hops: [
        {
          from: 'accounts',
          to: 'account_profiles',
          kind: 'has_one',
          fromCol: 'id',
          toCol: 'account_id',
        },
      ],
      traversed: ['account_profiles'],
    });
  });

  it('composes a belongs_to hop then a has_one hop (opportunities → accounts → profile)', () => {
    const plan = resolveJoinPlan(analytics, 'opportunities', 'account_profiles.tier', 'group');
    expect(plan.kind).toBe('to-one');
    if (plan.kind !== 'to-one') return;
    expect(plan.hops.map((h) => h.kind)).toEqual(['belongs_to', 'has_one']);
  });

  it('describe advertises the has_one target dims as conformed at the parent grain', () => {
    const paths = conformedDimensions(analytics, 'opportunities').map((d) => d.path);
    expect(paths).toContain('account_profiles.tier');
    expect(paths).toContain('accounts.region');
  });

  it('the same edge declared has_many is refused as to-many', () => {
    const { analytics: manyReg } = declaredModel('has_many');
    const plan = resolveJoinPlan(manyReg, 'accounts', 'account_profiles.tier', 'group');
    expect(plan).toMatchObject({ kind: 'reject', code: 'to-many' });
  });
});

describe('has_one — compile (declared AggregateModel, drizzle.mock)', () => {
  const model = declaredModel('has_one');

  it('groups a parent measure by a has_one dim via LEFT JOIN target.fk = parent.pk', () => {
    const out = sqlOf(model, {
      entity: 'accounts',
      group_by: ['account_profiles.tier'],
      measures: [{ on: '*', agg: 'count', as: 'n' }],
    });
    expect(out).toContain(
      'left join "account_profiles" on "accounts"."id" = "account_profiles"."account_id"',
    );
  });

  it('reaches the has_one dim through a belongs_to hop at the opportunities grain', () => {
    const out = sqlOf(model, {
      entity: 'opportunities',
      group_by: ['account_profiles.tier'],
      measures: [{ on: 'amount', agg: 'sum', as: 'pipeline' }],
    });
    expect(out).toContain('left join "accounts" on "opportunities"."account_id" = "accounts"."id"');
    expect(out).toContain(
      'left join "account_profiles" on "accounts"."id" = "account_profiles"."account_id"',
    );
  });

  it('refuses the same query when the edge is declared has_many (fan-out)', async () => {
    await expect(
      runAggregateDrizzle(db, declaredModel('has_many'), {
        entity: 'accounts',
        group_by: ['account_profiles.tier'],
        measures: [{ on: '*', agg: 'count', as: 'n' }],
      }),
    ).rejects.toThrow(/to-many|not conformed/);
  });
});

describe('has_one — retrieval compiler', () => {
  it('a dotted has_one path filters through a to-one LEFT JOIN (no EXISTS)', () => {
    configureQueryRegistry([
      { name: 'accounts', table: accounts, relations: relations.accounts.relations },
      {
        name: 'account_profiles',
        table: accountProfiles,
        relations: relations.accountProfiles.relations,
      },
      {
        name: 'opportunities',
        table: opportunities,
        relations: relations.opportunities.relations,
      },
    ]);
    const compiled = compile({
      entity: 'accounts',
      filter: { on: 'profile.tier', op: 'eq', value: 'gold' },
    });
    const joins = compiled.joins.map((j) => text(sql`${j.on}`));
    expect(joins).toEqual(['"accounts"."id" = "account_profiles"."account_id"']);
    expect(text(sql`${compiled.where}`)).not.toContain('exists');
  });
});

describe('has_one — doctor MISSING_INVERSE names the right inverse', () => {
  it('a UNIQUE fk suggests r.one keyed pk → fk; a plain fk suggests r.many', () => {
    // Only the belongs_to sides are declared: no inverse on accounts.
    const rels = defineRelations({ accounts, accountProfiles, opportunities }, (r) => ({
      accountProfiles: {
        account: r.one.accounts({ from: r.accountProfiles.accountId, to: r.accounts.id }),
      },
      opportunities: {
        account: r.one.accounts({ from: r.opportunities.accountId, to: r.accounts.id }),
      },
    }));
    const missing = diagnose([
      { name: 'accounts', table: accounts, relations: rels.accounts.relations },
      {
        name: 'account_profiles',
        table: accountProfiles,
        relations: rels.accountProfiles.relations,
      },
      { name: 'opportunities', table: opportunities, relations: rels.opportunities.relations },
    ]).filter((f) => f.code === 'MISSING_INVERSE');
    expect(missing).toHaveLength(2);
    const [profile, opp] = [
      missing.find((f) => f.message.startsWith("'account_profiles.")),
      missing.find((f) => f.message.startsWith("'opportunities.")),
    ];
    expect(profile?.message).toContain('declares no inverse r.one.account_profiles(…)');
    expect(profile?.fix).toContain(
      'account_profiles: r.one.account_profiles({ from: r.accounts.id, to: r.account_profiles.accountId }),',
    );
    expect(opp?.message).toContain('declares no inverse r.many.opportunities(…)');
    expect(opp?.fix).toContain('opportunities: r.many.opportunities(),');
  });
});

describe('has_one — expand refuses a non-unique child set', () => {
  // A stub db: the batched child read returns `rows` (no SQL runs).
  const stubDb = (rows: Record<string, unknown>[]) =>
    ({
      select: () => ({ from: () => ({ where: async () => rows }) }),
    }) as unknown as Parameters<typeof expandRows>[0];

  it('attaches the single child object (or null) for a has_one', async () => {
    configureQueryRegistry(introspected);
    const parents: Record<string, unknown>[] = [{ id: 'a1' }, { id: 'a2' }];
    await expandRows(stubDb([{ id: 'p1', account_id: 'a1', tier: 'gold' }]), 'accounts', parents, {
      profile: {},
    });
    expect(parents).toEqual([
      { id: 'a1', profile: { id: 'p1', account_id: 'a1', tier: 'gold' } },
      { id: 'a2', profile: null },
    ]);
  });

  it('throws naming the relation and the missing UNIQUE when >1 child matches', async () => {
    configureQueryRegistry(introspected);
    const rows = [
      { id: 'p1', account_id: 'a1' },
      { id: 'p2', account_id: 'a1' },
    ];
    await expect(
      expandRows(stubDb(rows), 'accounts', [{ id: 'a1' }], { profile: {} }),
    ).rejects.toThrow(
      /has_one 'profile' → 'account_profiles' matched 2 rows .*UNIQUE constraint on account_profiles\.account_id/,
    );
  });
});
