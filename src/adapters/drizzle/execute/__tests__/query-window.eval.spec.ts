// Window measures via the REAL package query() (not aggregate()) — proving the
// "selection within query" face: agg() OVER (PARTITION BY …) annotates rows,
// grain preserved, returned as a normal (fetchable) query result.
//
//   DBURL=postgres://postgres:PW@localhost:54321/dealbrain bun test query-window.eval

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { SearchEntityResult } from '../../../../internal/language/types';
import { QueryApplicationService, UNSCOPED } from '../../../../query.application-service';
import {
  accounts,
  accountsRelations,
  fieldValues,
  observations,
  observationsRelations,
  opportunities,
  opportunitiesRelations,
} from '../../../reference/schema.dealbrain';
import { configureQueryRegistry } from '../../registry/registry';
import { type DrizzleDb, makeDb } from '../drizzle-db';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

suite('query() window measures — live dealbrain', () => {
  let db: DrizzleDb;
  let close: () => Promise<void>;
  let svc: QueryApplicationService;

  beforeAll(() => {
    ({ db, close } = makeDb(DBURL!));
    configureQueryRegistry([
      { name: 'accounts', table: accounts, relations: accountsRelations },
      {
        name: 'opportunities',
        table: opportunities,
        relations: opportunitiesRelations,
        eav: { kind: 'typed-columns', valueTable: fieldValues, entityTypeValue: 'opportunity' },
      },
      { name: 'observations', table: observations, relations: observationsRelations },
    ]);
    svc = new QueryApplicationService(db, {
      scope: UNSCOPED,
      actorUserId: 'x',
      actorOrganizationId: 'e7e24eb2-49ba-45cb-88b1-43696d1e9ed8',
    });
  });
  afterAll(async () => {
    await close?.();
  });

  it('count(*) OVER (PARTITION BY account_id) annotates rows WITHOUT collapsing', async () => {
    const res = (await svc.select('observations', {
      columns: ['account_id'],
      window: [{ on: '*', agg: 'count', partition_by: ['account_id'], as: 'acct_total' }],
      preview: true,
      page: { limit: 5 },
    })) as SearchEntityResult;

    expect(res.preview?.length).toBe(5); // rows preserved, not collapsed to groups
    const row = res.preview![0]! as Record<string, unknown>;
    expect(row).toHaveProperty('acct_total');

    // the annotation equals a direct count for that row's account
    const acct = row.account_id as string | null;
    if (acct) {
      const ref = await db.execute(
        sql`select count(*)::int n from observations where account_id = ${acct}`,
      );
      expect(Number(row.acct_total)).toBe(Number((ref.rows[0] as { n: number }).n));
    }
  });
});
