// compare() over the REST presentation chain — the only test that exercises the layers
// ABOVE the engine: the ZodValidationPipe, QueryController (incl. its typed-error→HTTP
// mapping), CompareUseCase, QuerySurfaceService, and QueryApplicationService.compare with
// per-source scope folding. Every other compare test drives runCompare directly and bypasses
// all of this.
//
// It builds the real provider chain by hand (constructors, not DI) and feeds the controller
// the SAME body the pipe produces — so the pipe → handler path is faithful. It does NOT spin
// an Express server (that would need @nestjs/testing + @nestjs/platform-express + supertest as
// devDeps, none installed); the HTTP transport itself is Nest plumbing, not compare logic.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain bun test compare.rest.eval

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type ArgumentMetadata, BadRequestException, NotFoundException } from '@nestjs/common';
import { QuerySurfaceService } from '../../nest/query-surface.service';
import { QueryController } from '../../nest/rest/query.controller';
import { compareRequestSchema } from '../../nest/rest/query.dto';
import { ZodValidationPipe } from '../../nest/rest/zod-validation.pipe';
import {
  AggregateUseCase,
  CompareUseCase,
  DescribeUseCase,
  FetchUseCase,
  SearchUseCase,
} from '../../nest/use-cases';
import { type DrizzleDb, makeDb } from './drizzle-db';
import { loadDealbrainModel } from './model.dealbrain';
import {
  accounts,
  accountsRelations,
  fieldValues,
  observations,
  observationsRelations,
  opportunities,
  opportunitiesRelations,
} from './schema.dealbrain';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

suite('compare() — REST presentation chain (live dealbrain)', () => {
  let db: DrizzleDb;
  let close: () => Promise<void>;
  let controller: QueryController;
  const pipe = new ZodValidationPipe(compareRequestSchema);
  const META = { type: 'body' } as ArgumentMetadata;

  beforeAll(async () => {
    ({ db, close } = makeDb(DBURL!));
    const svc = new QuerySurfaceService(db, {
      schema: {
        accounts,
        opportunities,
        observations,
        fieldValues,
        accountsRelations,
        opportunitiesRelations,
        observationsRelations,
      },
      // dealbrain test tables carry no tenancy column → declare tenant-global so compare
      // runs unscoped (fail-closed would otherwise deny an uncovered source).
      scopeFor: () => () => undefined,
      tenantGlobalEntities: ['observations', 'opportunities', 'accounts'],
      aggregateModel: () => loadDealbrainModel(db),
      getRequester: () => ({ userId: 'rest-eval' }),
    } as never);
    svc.onModuleInit(); // registerSchema, exactly as Nest would on boot
    controller = new QueryController(
      new DescribeUseCase(svc),
      new SearchUseCase(svc),
      new FetchUseCase(svc),
      new AggregateUseCase(svc),
      new CompareUseCase(svc),
    );
  });
  afterAll(async () => {
    await close?.();
  });

  const commitVsRisk = {
    measures: [{ on: '*', agg: 'count', as: 'obs' }],
    variants: [
      { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
      { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
    ],
    compare: { baseline: 'commitment', derive: ['delta'] },
  };

  it('R1 happy path: pipe-validated body → 200 stitched response, values match known truth', async () => {
    // pipe → handler, exactly as Nest binds it
    const body = pipe.transform(commitVsRisk, META);
    const res = await controller.compare('observations', body);
    if (res.delivery !== 'stitched') throw new Error('expected stitched');
    expect(res.entity).toBe('observations');
    expect(res.baseline).toBe('commitment');
    expect(res.variants).toEqual(['commitment', 'risk']);
    expect(res.rows).toHaveLength(1); // no group_by → one global row
    const row = res.rows[0]!;
    // dealbrain has 610 commitment + 367 risk observations (see compare.eval C3)
    expect(Number(row.obs__commitment)).toBe(610);
    expect(Number(row.obs__risk)).toBe(367);
    expect(row.obs__risk__delta).toBe(367 - 610);
  });

  it('R2 separate delivery: the two labeled result sets, unstitched', async () => {
    const body = pipe.transform(
      { ...commitVsRisk, group_by: ['account_id'], delivery: 'separate' },
      META,
    );
    const res = await controller.compare('observations', body);
    if (res.delivery !== 'separate') throw new Error('expected separate');
    expect(res.variants.map((v) => v.label)).toEqual(['commitment', 'risk']);
    expect(res.variants[0]!.row_count).toBeGreaterThan(0);
  });

  it('R3 DTO validation: < 2 variants → BadRequestException at the pipe (never reaches the engine)', () => {
    expect(() =>
      pipe.transform(
        {
          ...commitVsRisk,
          variants: [{ label: 'only', filter: { on: 'type', op: 'eq', value: 'risk' } }],
        },
        META,
      ),
    ).toThrow(BadRequestException);
  });

  it('R4 engine error → 400: per_variant_top + limit (mutually exclusive) maps to BadRequestException', async () => {
    const body = pipe.transform(
      { ...commitVsRisk, group_by: ['account_id'], per_variant_top: { by: 'obs', n: 3 }, limit: 5 },
      META,
    );
    await expect(controller.compare('observations', body)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('R5 unknown entity → 404 (NotFoundException), not a leaked-SQL 500', async () => {
    const body = pipe.transform(commitVsRisk, META);
    await expect(controller.compare('made_up_entity', body)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('R6 unqueryable filter column → 400 (the Q6 landmine fails loud over the wire)', async () => {
    // A variant filter on a column that resolves nowhere → engine throws (AGGREGATE) →
    // translateEngineErrors → InvalidQueryError → BadRequestException. Never a fabricated 200.
    const body = pipe.transform(
      {
        ...commitVsRisk,
        variants: [
          { label: 'a', filter: { on: 'nonsense_col', op: 'eq', value: 'x' } },
          { label: 'b', filter: { on: 'type', op: 'eq', value: 'risk' } },
        ],
      },
      META,
    );
    await expect(controller.compare('observations', body)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
