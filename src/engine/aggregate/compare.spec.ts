// compare — pure unit (no DB): stitchCompare alignment/derive + runCompare orchestration
// with an injected fake variant-runner.
import { describe, expect, it } from 'bun:test';
import {
  type CompareRequest,
  type VariantRows,
  andFilter,
  runCompare,
  stitchCompare,
} from './compare';

type Rows = Record<string, unknown>[];

describe('andFilter', () => {
  it('ANDs base + variant, or returns whichever is present', () => {
    const base = { on: 'org', op: 'eq' as const, value: 'o1' };
    const v = { on: 't', op: 'eq' as const, value: 'q3' };
    expect(andFilter(base, v)).toEqual({ and: [base, v] });
    expect(andFilter(base, undefined)).toBe(base);
    expect(andFilter(undefined, v)).toBe(v);
    expect(andFilter(undefined, undefined)).toBeUndefined();
  });
});

describe('stitchCompare', () => {
  const variants: VariantRows[] = [
    {
      label: 'q2',
      rows: [
        { acct: 'a', revenue: 100 },
        { acct: 'b', revenue: 50 },
      ],
    },
    {
      label: 'q3',
      rows: [
        { acct: 'a', revenue: 150 },
        { acct: 'c', revenue: 30 },
      ],
    },
  ];

  it('aligns by group key (UNION); missing variant → null; emits value + derive columns', () => {
    const { rows } = stitchCompare(variants, {
      groupBy: ['acct'],
      baseline: 'q2',
      derive: ['delta', 'pct_change'],
    });
    const byAcct = new Map(rows.map((r) => [r.acct, r]));
    // a: in both
    expect(byAcct.get('a')).toMatchObject({
      acct: 'a',
      revenue__q2: 100,
      revenue__q3: 150,
      revenue__q3__delta: 50,
      revenue__q3__pct_change: 0.5,
    });
    // b: only in q2 (baseline) → q3 value null, delta null (variant missing)
    expect(byAcct.get('b')).toMatchObject({
      revenue__q2: 50,
      revenue__q3: null,
      revenue__q3__delta: null,
    });
    // c: only in q3 → q2 (baseline) null → delta null, pct null
    expect(byAcct.get('c')).toMatchObject({
      revenue__q2: null,
      revenue__q3: 30,
      revenue__q3__delta: null,
    });
    // baseline gets no derive columns
    expect(byAcct.get('a')).not.toHaveProperty('revenue__q2__delta');
  });

  it('index derive = variant/baseline*100; zero/absent baseline → null + warning', () => {
    const v: VariantRows[] = [
      {
        label: 'base',
        rows: [
          { k: 'x', m: 0 },
          { k: 'y', m: 4 },
        ],
      },
      {
        label: 'cur',
        rows: [
          { k: 'x', m: 10 },
          { k: 'y', m: 8 },
        ],
      },
    ];
    const { rows, warnings } = stitchCompare(v, {
      groupBy: ['k'],
      baseline: 'base',
      derive: ['index'],
    });
    const byK = new Map(rows.map((r) => [r.k, r]));
    expect(byK.get('y')).toMatchObject({ m__cur__index: 200 }); // 8/4*100
    expect(byK.get('x')!.m__cur__index).toBeNull(); // baseline 0 → undefined
    expect(warnings.some((w) => /m__index.*1 group/.test(w))).toBe(true);
  });

  it('global compare (no group_by) → one stitched row', () => {
    const v: VariantRows[] = [
      { label: 'a', rows: [{ total: 10 }] },
      { label: 'b', rows: [{ total: 25 }] },
    ];
    const { rows } = stitchCompare(v, { groupBy: [], baseline: 'a', derive: ['delta'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ total__a: 10, total__b: 25, total__b__delta: 15 });
  });

  it('refuses a column collision (value col == another cell derive col) rather than clobbering', () => {
    // measure m, label 'cur' + derive delta → "m__cur__delta"; AND value col for label
    // 'cur__delta' → "m__cur__delta". Same key → the guard must throw, not silently lose one.
    expect(() =>
      stitchCompare(
        [
          { label: 'cur__delta', rows: [{ k: 'a', m: 7 }] },
          { label: 'cur', rows: [{ k: 'a', m: 3 }] },
        ],
        { groupBy: ['k'], baseline: 'cur__delta', derive: ['delta'], measures: ['m'] },
      ),
    ).toThrow(/column collision/i);
  });
});

describe('runCompare (injected variant-runner)', () => {
  const fakeRunner = (byLabel: Record<string, Rows>) => {
    let i = 0;
    const order = Object.keys(byLabel);
    // the orchestrator calls runVariant once per variant, in order
    return async () => ({ rows: byLabel[order[i++]!]! });
  };

  const baseReq = (over: Partial<CompareRequest> = {}): CompareRequest => ({
    measures: [{ on: 'amount', agg: 'sum', as: 'revenue' }],
    variants: [{ label: 'q2' }, { label: 'q3' }],
    group_by: ['acct'],
    ...over,
  });

  it('stitched delivery aligns + derives; order_by + limit slice the stitched rows', async () => {
    const res = await runCompare(
      'opps',
      baseReq({ order_by: [{ on: 'revenue__q3', dir: 'desc' }], limit: 1 }),
      fakeRunner({
        q2: [
          { acct: 'a', revenue: 100 },
          { acct: 'b', revenue: 10 },
        ],
        q3: [
          { acct: 'a', revenue: 150 },
          { acct: 'b', revenue: 999 },
        ],
      }),
    );
    expect(res.delivery).toBe('stitched');
    if (res.delivery !== 'stitched') throw new Error('unreachable');
    expect(res.rows).toHaveLength(1); // limit 1
    expect(res.rows[0]).toMatchObject({ acct: 'b', revenue__q3: 999 }); // top by q3
    expect(res.baseline).toBe('q2');
  });

  it('separate delivery returns the N labeled results unstitched', async () => {
    const res = await runCompare(
      'opps',
      baseReq({ delivery: 'separate' }),
      fakeRunner({ q2: [{ acct: 'a', revenue: 100 }], q3: [{ acct: 'a', revenue: 150 }] }),
    );
    expect(res.delivery).toBe('separate');
    if (res.delivery !== 'separate') throw new Error('unreachable');
    expect(res.variants.map((v) => v.label)).toEqual(['q2', 'q3']);
    expect(res.variants[1]!.rows[0]).toMatchObject({ revenue: 150 });
  });

  it('order_by on an unknown stitched column is refused', async () => {
    await expect(
      runCompare(
        'opps',
        baseReq({ order_by: [{ on: 'nope', dir: 'desc' }] }),
        fakeRunner({ q2: [], q3: [] }),
      ),
    ).rejects.toThrow(/unknown compare column/i);
  });

  it('refuses < 2 variants, duplicate labels, a bad baseline, and a non-identifier label', async () => {
    await expect(
      runCompare('opps', { ...baseReq(), variants: [{ label: 'only' }] }, fakeRunner({})),
    ).rejects.toThrow(/at least 2 variants/i);
    await expect(
      runCompare(
        'opps',
        { ...baseReq(), variants: [{ label: 'x' }, { label: 'x' }] },
        fakeRunner({}),
      ),
    ).rejects.toThrow(/duplicate variant label/i);
    await expect(
      runCompare(
        'opps',
        baseReq({ compare: { baseline: 'ghost' } }),
        fakeRunner({ q2: [], q3: [] }),
      ),
    ).rejects.toThrow(/baseline "ghost" is not a variant/i);
    await expect(
      runCompare(
        'opps',
        { ...baseReq(), variants: [{ label: 'a b' }, { label: 'q3' }] },
        fakeRunner({}),
      ),
    ).rejects.toThrow(/invalid variant label/i);
  });

  it('per_variant_top pushes order_by+limit into each variant aggregate', async () => {
    const seen: unknown[] = [];
    await runCompare('opps', baseReq({ per_variant_top: { by: 'revenue', n: 3 } }), async (agg) => {
      seen.push(agg);
      return { rows: [] };
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ order_by: [{ on: 'revenue', dir: 'desc' }], limit: 3 });
  });

  it('refuses a variant label containing the reserved "__" separator (fast ban)', async () => {
    await expect(
      runCompare(
        'opps',
        { ...baseReq(), variants: [{ label: 'q2__delta' }, { label: 'q3' }] },
        fakeRunner({}),
      ),
    ).rejects.toThrow(/invalid variant label.*__/i);
  });

  it('per_variant_top is mutually exclusive with order_by/limit', async () => {
    await expect(
      runCompare(
        'opps',
        baseReq({ per_variant_top: { by: 'revenue', n: 3 }, limit: 5 }),
        fakeRunner({}),
      ),
    ).rejects.toThrow(/mutually exclusive/i);
    await expect(
      runCompare(
        'opps',
        baseReq({
          per_variant_top: { by: 'revenue', n: 3 },
          order_by: [{ on: 'revenue__q2', dir: 'desc' }],
        }),
        fakeRunner({}),
      ),
    ).rejects.toThrow(/mutually exclusive/i);
  });

  it('per_variant_top.by must be a measure alias (a group col is refused)', async () => {
    await expect(
      runCompare('opps', baseReq({ per_variant_top: { by: 'acct', n: 3 } }), fakeRunner({})),
    ).rejects.toThrow(/must be one of the measure aliases/i);
  });

  it('per_variant_top.by accepts a {ref} measure alias (ref name when no `as`) and forwards it', async () => {
    const seen: unknown[] = [];
    await runCompare(
      'opps',
      baseReq({
        measures: [{ ref: 'weighted_amount' }],
        per_variant_top: { by: 'weighted_amount', n: 5 },
      }),
      async (agg) => {
        seen.push(agg);
        return { rows: [] };
      },
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      measures: [{ ref: 'weighted_amount' }],
      order_by: [{ on: 'weighted_amount', dir: 'desc' }],
      limit: 5,
    });
  });

  it('a {ref} with an alias: per_variant_top.by must match `as`, not the ref name', async () => {
    // by = ref name → refused (alias is the `as`)
    await expect(
      runCompare(
        'opps',
        baseReq({
          measures: [{ ref: 'weighted_amount', as: 'wa' }],
          per_variant_top: { by: 'weighted_amount', n: 5 },
        }),
        fakeRunner({}),
      ),
    ).rejects.toThrow(/must be one of the measure aliases/i);
    // by = the alias → accepted + forwarded
    const seen: unknown[] = [];
    await runCompare(
      'opps',
      baseReq({
        measures: [{ ref: 'weighted_amount', as: 'wa' }],
        per_variant_top: { by: 'wa', n: 5 },
      }),
      async (agg) => {
        seen.push(agg);
        return { rows: [] };
      },
    );
    expect(seen[0]).toMatchObject({ order_by: [{ on: 'wa', dir: 'desc' }], limit: 5 });
  });

  it('warns when the baseline variant returns zero rows (all derives null)', async () => {
    const res = await runCompare(
      'opps',
      baseReq({ compare: { baseline: 'q2', derive: ['delta'] } }),
      fakeRunner({ q2: [], q3: [{ acct: 'a', revenue: 150 }] }),
    );
    if (res.delivery !== 'stitched') throw new Error('unreachable');
    expect(res.rows[0]).toMatchObject({ revenue__q3: 150, revenue__q3__delta: null });
    expect((res.warnings ?? []).some((w) => /baseline variant "q2" returned 0 rows/.test(w))).toBe(
      true,
    );
  });
});
