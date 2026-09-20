import { describe, expect, test } from 'bun:test';
import { type SQL, defineRelations, sql } from 'drizzle-orm';
import { PgDialect, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { projectCatalog } from '../../../../presentation/nest/projection.ts';
import { buildEntityCatalog } from '../../registry/catalog.ts';
import type { ComputedFieldSpec } from '../../registry/registry.ts';
import { registerSchema } from '../../registry/schema-registry.ts';
import { compile } from '../compiler.ts';
import { buildComputedExpr, computedSelectShape } from '../computed.ts';

// A minimal two-table graph (parent has_many child) so the test stays offline —
// no reference model, no DB.
const parents = pgTable('parents', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 255 }),
});
const children = pgTable('children', {
  id: uuid('id').primaryKey(),
  parentId: uuid('parent_id'),
  occurredAt: timestamp('occurred_at'),
  scope: varchar('scope', { length: 32 }),
});
const relations = defineRelations({ parents, children }, (r) => ({
  parents: { children: r.many.children() },
  children: { parent: r.one.parents({ from: r.children.parentId, to: r.parents.id }) },
}));

const COMPUTED: Record<string, ComputedFieldSpec[]> = {
  parents: [
    {
      key: 'child_count',
      agg: 'count',
      over: 'children',
      type: 'integer',
      label: 'Children',
      preview: true,
      filter: [{ on: 'scope', op: 'eq', value: 'deal' }],
    },
    {
      key: 'last_activity_at',
      agg: 'max',
      over: 'children',
      field: 'occurred_at',
      type: 'datetime',
      label: 'Last Activity',
    },
  ],
};

function configure(): void {
  registerSchema(relations, { computed: COMPUTED });
}

const dialect = new PgDialect();
const text = (s: SQL | undefined): string => (s ? dialect.sqlToQuery(sql`${s}`).sql : '');

describe('computed metrics — catalog', () => {
  test('count is a non-null integer, max a nullable datetime, both computed+non-searchable', () => {
    configure();
    const cat = buildEntityCatalog('parents');
    expect(cat.fields.find((f) => f.key === 'child_count')).toMatchObject({
      type: 'integer',
      nullable: false,
      computed: true,
      searchable: false,
      preview: true,
    });
    expect(cat.fields.find((f) => f.key === 'last_activity_at')).toMatchObject({
      type: 'datetime',
      nullable: true,
      computed: true,
    });
  });

  test('computed fields survive describe projection despite the native allowlist', () => {
    configure();
    const pub = projectCatalog(buildEntityCatalog('parents'), { parents: ['id'] });
    const keys = pub.fields.map((f) => f.key);
    expect(keys).toContain('child_count');
    expect(keys).toContain('last_activity_at');
    expect(keys).not.toContain('name');
  });
});

describe('computed metrics — SQL synthesis (rule-1: builder-only)', () => {
  test('count → correlated count(*)::int subquery with the sub-filter', () => {
    configure();
    const rendered = text(buildComputedExpr('parents', COMPUTED.parents[0]));
    expect(rendered).toContain('select count(*)::int from "children"');
    expect(rendered).toContain('"children"."parent_id" = "parents"."id"');
    expect(rendered).toContain('"children"."scope" ='); // deal sub-filter
  });

  test('max → max(col) over the relationship; datetime display wraps in to_char', () => {
    configure();
    const spec = COMPUTED.parents[1];
    const comparable = text(buildComputedExpr('parents', spec));
    const display = text(buildComputedExpr('parents', spec, { display: true }));
    expect(comparable).toContain('select max("children"."occurred_at")');
    expect(comparable).not.toContain('to_char'); // comparison path = raw timestamp
    expect(display).toContain('to_char(');
    expect(
      dialect.sqlToQuery(sql`${buildComputedExpr('parents', spec, { display: true })}`).params,
    ).toContain('YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  });

  test('count display form is unchanged (no to_char on integer aggregates)', () => {
    configure();
    const display = text(buildComputedExpr('parents', COMPUTED.parents[0], { display: true }));
    expect(display).toContain('count(*)::int');
    expect(display).not.toContain('to_char');
  });
});

describe('computed metrics — filter / sort / projection wiring', () => {
  test('filtering on a computed field emits the subquery in WHERE', () => {
    configure();
    const compiled = compile({
      entity: 'parents',
      filter: { on: 'child_count', op: 'gt', value: 5 },
    });
    const where = text(compiled.where);
    expect(where).toContain('select count(*)::int from "children"');
    expect(where).toContain('> ');
  });

  test('sorting a datetime computed field orders on the raw timestamp (not to_char), nulls last', () => {
    configure();
    const compiled = compile({
      entity: 'parents',
      sort: [{ field: 'last_activity_at', dir: 'desc' }],
    });
    const order = compiled.orderBy.map((o) => text(sql`${o}`)).join(' | ');
    expect(order).toContain('select max("children"."occurred_at")');
    expect(order).not.toContain('to_char');
    expect(order).toContain('desc nulls last');
  });

  test('projecting a datetime computed field uses the ISO display form', () => {
    configure();
    const compiled = compile({ entity: 'parents' }, undefined, ['last_activity_at']);
    const proj = compiled.projection.last_activity_at as SQL.Aliased;
    expect(proj.fieldAlias).toBe('last_activity_at');
    expect(text(proj.sql)).toContain('to_char(');
  });

  test('computedSelectShape includes all metrics; previewOnly narrows to flagged', () => {
    configure();
    expect(Object.keys(computedSelectShape('parents')).sort()).toEqual([
      'child_count',
      'last_activity_at',
    ]);
    expect(Object.keys(computedSelectShape('parents', { previewOnly: true }))).toEqual([
      'child_count',
    ]);
  });
});
