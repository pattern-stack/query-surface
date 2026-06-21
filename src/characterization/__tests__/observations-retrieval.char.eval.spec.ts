// CHARACTERIZATION — the observations RETRIEVAL surface (canonical model).
//
// Pins that the promoted observations entity serves RETRIEVAL end to end:
//   - describe(observations) surfaces the `type` taxonomy + field semantics (the
//     enrichment threaded into the registry via observationsMeta), and hides the
//     infra columns (embedding, tenancy).
//   - a semantic rank_by over normalized_text surfaces the right rows, with
//     source_refs (provenance) returned for citation.
//
// DB-gated on DBURL (skips otherwise), like the sibling nets. Uses the harness's
// deterministic embed stub: it returns a REAL stored embedding for a phrase that
// appears in normalized_text, so the rank is exercised against the live vectors.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { FilterExpression } from '../../internal/language/types.ts';
import { type QuerySurfaceHarness, makeQuerySurface } from '../harness.ts';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;
const DEAL_001 = 'b65e7705-4513-5e38-8166-cf292bcc8877'; // Augment Code

suite('observations retrieval surface — characterization', () => {
  let h: QuerySurfaceHarness;
  beforeAll(() => {
    h = makeQuerySurface(DBURL!);
  });
  afterAll(async () => {
    await h.close();
  });

  it('describe surfaces the type taxonomy + retrieval semantics, hides infra columns', async () => {
    const cat = await h.service.describe('observations');
    const byKey = new Map(cat.fields.map((f) => [f.key, f]));

    // The type taxonomy is legible from describe (selectOptions → enumValues), so
    // the agent can build a typed query without a separate list_types scan.
    const typeEnum = (byKey.get('type')?.enumValues ?? []) as readonly string[];
    expect(typeEnum).toContain('pricing_signal');
    expect(typeEnum).toContain('product_request');

    // normalized_text is the searchable rank surface, carrying its semantics.
    expect(byKey.get('normalized_text')?.searchable).toBe(true);
    expect((byKey.get('normalized_text')?.note ?? '').length).toBeGreaterThan(0);

    // Provenance is exposed (for citation); embedding + tenancy are hidden infra.
    expect(byKey.get('source_refs')).toBeDefined();
    expect(byKey.get('embedding')).toBeUndefined();
    expect(byKey.get('organization_id')).toBeUndefined();
  });

  it('semantic rank_by over normalized_text surfaces the pricing cluster with provenance', async () => {
    const res = await h.service.query('observations', {
      filter: { opportunity_id: DEAL_001 } as unknown as FilterExpression,
      rank_by: { on: 'normalized_text', method: 'semantic', query: 'office-active tier', limit: 6 },
      columns: ['type', 'normalized_text', 'source_refs'],
      preview: true,
    });

    expect(res.total).toBeGreaterThan(0);
    const preview = (res.preview ?? []) as Array<Record<string, unknown>>;
    const texts = preview.map((p) => String(p.normalized_text ?? '').toLowerCase());
    // The order-form / office-active pricing cluster ranks into the top results.
    expect(texts.some((t) => t.includes('office-active'))).toBe(true);
    // Provenance comes back on the preview rows (the citation surface).
    expect(preview.some((p) => p.source_refs != null)).toBe(true);
  });
});
