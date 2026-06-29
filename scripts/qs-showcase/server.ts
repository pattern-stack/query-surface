// query-surface · showcase server — the 5-verb tour with METRICS + a measure-definition workbench.
//
// A FRESH demo built on the renamed public surface (describe / select / fetch / measure / compare).
// Self-contained + creds-free: boots the query-surface service against the live Bean Maxx fixture
// (the same makeQuerySurface harness the evals use), registers the opportunities EAV dimensions
// (stage, deal_size_band) so the headline cross-grain metric works, and serves a single page that
// walks all five verbs — each showing the request, the compiled SQL, the bound params, the rows,
// the timing, and (for relevance) the mandatory citation.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun run scripts/qs-showcase/server.ts            # → http://localhost:7879
//
// HEADLINE: measure('observations', group_by:['opportunities.stage']) — observations counted at
// their own grain, grouped by their opportunity's EAV `stage`, reached THROUGH a to-one join.
//
// MEASURES WORKBENCH ("Measures" tab): the engine's named-measure model is "catalog by code,
// instances by data" (invariant 6). Field-aggregate measures are DERIVED from role:'measure' field
// tags — so DEFINING one = registering a `measureSpec` (field + allowed aggs + additivity), after
// which the engine auto-catalogs `Field.agg` and a query can call it by `{ ref: 'Field.agg' }`.
// This page edits that host layer live: define a measure → the surface REBUILDS → it's callable by
// name. A `count(*)` measure has no field to derive from (the catalog is field-keyed), so the page
// keeps those as a HOST-COMPOSED book entry that expands to an inline `{on:'*',agg:'count'}` — the
// honest split, badged in the UI. Definitions persist to scripts/qs-showcase/measures.json.
//
// EMBED CAVEAT: without OPENAI_API_KEY the harness uses the deterministic ILIKE phrase-stub, so a
// `relevant` query must be a phrase that appears verbatim in some observation's normalized_text.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format as formatSql } from 'sql-formatter';
import { makeQuerySurface } from '../../src/characterization/harness.ts';

const DBURL = process.env.DBURL;
if (!DBURL) {
  console.error('Set DBURL, e.g. DBURL=postgres://postgres:password@localhost:54321/dealbrain');
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 7879);
const HTML = readFileSync(join(import.meta.dir, 'index.html'), 'utf8');
const BOOK_PATH = join(import.meta.dir, 'measures.json');

// The host's resolved semantic layer: opportunities EAV select/text fields exposed as group dims.
const DIMENSION_SPECS = [
  { name: 'stage', key: 'StageName' },
  { name: 'deal_size_band', key: 'deal_size_band' },
];

// Base measure specs (mirror the engine's DEFAULT_MEASURE_SPECS). The measure book's field-aggregate
// definitions are MERGED onto these (by field key) at rebuild — so the engine catalog grows live.
type MeasureSpec = {
  key: string;
  aggs: ('sum' | 'avg' | 'count_distinct' | 'min' | 'max')[];
  additivity?: 'additive' | 'semi' | 'non';
};
const BASE_SPECS: MeasureSpec[] = [
  { key: 'Amount', aggs: ['sum', 'avg', 'min', 'max'], additivity: 'additive' },
  { key: 'ExpectedRevenue', aggs: ['sum', 'avg', 'min', 'max'], additivity: 'additive' },
  { key: 'Probability', aggs: ['avg', 'min', 'max'], additivity: 'non' },
];

// ── the measure BOOK — host-defined named measures, persisted to measures.json ────────────────────
// THREE names per measure (the discipline the slug enforces):
//   • name  — the human display label ("Total Revenue"); may change, not the contract.
//   • slug  — the STABLE, UNIQUE ref the agent calls by ({ref:'total_revenue'}); the catalog key.
//   • alias — the SQL-safe output column, derived from the slug.
// A field-aggregate def registers BOTH a measureSpec (so the field's EAV binding + role exist) AND a
// host MeasureDef keyed by `slug` (→ a real engine `{ref:slug}`). A count def registers a host
// MeasureDef of count(id) over the entity PK (id is a real field → first-class catalog measure;
// count(id) ≡ count(*) since the PK is non-null). Both are callable by {ref:slug}.
type FieldMeasure = {
  slug: string;
  kind: 'field';
  name: string;
  entity: 'opportunities';
  field: string;
  agg: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct';
  additivity: 'additive' | 'semi' | 'non';
};
type CountMeasure = { slug: string; kind: 'count'; name: string; entity: string };
// A ratio names two ATOMIC catalog measures (by slug — auto-derived `Field.agg` or a host atomic):
// e.g. win_rate = won_count / opportunity_count. Fan-safe (each leg pre-aggregates in its own CTE).
type RatioMeasure = { slug: string; kind: 'ratio'; name: string; numerator: string; denominator: string };
// A derived (ADR-0029 D2) metric: an arithmetic EXPRESSION over atomic legs — the subtractive/
// weighted gap ratio can't express (gross_profit = revenue - cost). v1 builder = a two-term form:
// `left <op> right`, where `right` is another atomic slug OR a numeric literal (a weight). Fan-safe
// (each atomic leg pre-aggregates in its own CTE; the op is OUTER-SELECT arithmetic).
type DerivedMeasure = {
  slug: string;
  kind: 'derived';
  name: string;
  op: '+' | '-' | '*' | '/';
  left: string; // an atomic measure slug
  right: string; // an atomic measure slug, OR (when rightIsLit) a numeric literal
  rightIsLit?: boolean;
};
// An EXPRESSION measure (ADR-0029 D4): a ROW-LEVEL product/expression aggregated ONCE —
// agg(leftField <op> right), evaluated PER ROW BEFORE the agg. The headline is
// weighted_pipeline = SUM(Amount · Probability). Unlike a derived metric, the op happens per-row
// (SUM(a·b) ≠ SUM(a)·SUM(b)), so it stays BELOW the aggregation boundary → a MEASURE, not a metric.
// v1 builder = `leftField <op> right`, where `right` is another numeric FIELD OR a numeric literal.
type ExpressionMeasure = {
  slug: string;
  kind: 'expression';
  name: string;
  agg: 'sum' | 'avg' | 'min' | 'max';
  op: '+' | '-' | '*' | '/';
  left: string; // a numeric field key on opportunities (e.g. Amount)
  right: string; // a numeric field key, OR (when rightIsLit) a numeric literal
  rightIsLit?: boolean;
  additivity: 'additive' | 'semi' | 'non';
};
type BookMeasure =
  | FieldMeasure
  | CountMeasure
  | RatioMeasure
  | DerivedMeasure
  | ExpressionMeasure;

function toIdentifier(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'm';
}
const aliasFor = (m: BookMeasure) => m.slug;

function loadBook(): BookMeasure[] {
  if (!existsSync(BOOK_PATH)) return [];
  try {
    return JSON.parse(readFileSync(BOOK_PATH, 'utf8')) as BookMeasure[];
  } catch {
    return [];
  }
}
function saveBook(book: BookMeasure[]): void {
  writeFileSync(BOOK_PATH, `${JSON.stringify(book, null, 2)}\n`);
}
let BOOK: BookMeasure[] = loadBook();

// Merge the book's field measures onto BASE_SPECS (union allowed aggs per field key). This registers
// the underlying field as role:'measure' (with its EAV binding) so a host MeasureDef over it validates
// + compiles. additivity is host-declared; the doctor still reads the registry at query time.
function specsFromBook(book: BookMeasure[]): MeasureSpec[] {
  const byKey = new Map<string, MeasureSpec>(BASE_SPECS.map((s) => [s.key, { ...s, aggs: [...s.aggs] }]));
  for (const m of book) {
    if (m.kind !== 'field') continue;
    const cur = byKey.get(m.field) ?? { key: m.field, aggs: [], additivity: m.additivity };
    if (!cur.aggs.includes(m.agg)) cur.aggs.push(m.agg);
    cur.additivity = m.additivity;
    byKey.set(m.field, cur);
  }
  return [...byKey.values()];
}

// Per-entity primary key, pulled from the engine's describe() catalog (NOT assumed) — resolved once
// at boot via resolvePks() since PKs are static. Used to build count(<pk>) measures.
const ENTITIES = ['opportunities', 'accounts', 'observations'];
const PKS: Record<string, string> = {};
async function resolvePks(): Promise<void> {
  // A throwaway surface just to read the catalog (describe reads the registry, runs no query). The
  // registry/PKs don't depend on measure specs, so this is independent of the live `h`.
  const probe = makeQuerySurface(DBURL!, { dimensionSpecs: DIMENSION_SPECS });
  try {
    for (const e of ENTITIES) PKS[e] = (await probe.service.describe(e as any)).primaryKey;
  } finally {
    await probe.close();
  }
}
const pkOf = (entity: string) => PKS[entity] ?? 'id';

// Build the host MeasureDef catalog (slug → atomic def) from the book. Both kinds become REAL engine
// catalog entries callable by {ref:slug}: a field measure is agg(field); an entity COUNT is
// count(<pk>) over the entity's primary key (PK is non-null + unique → count(pk) ≡ count(*), but the
// PK IS a real field, so unlike count(*) it can be a first-class catalog measure — closes the gap).
function defsFromBook(book: BookMeasure[]): Record<string, any> {
  const defs: Record<string, any> = {};
  for (const m of book) {
    if (m.kind === 'field') {
      defs[m.slug] = { kind: 'atomic', on: m.field, agg: m.agg, source: 'opportunities', additivity: m.additivity, label: m.name };
    } else if (m.kind === 'count') {
      defs[m.slug] = { kind: 'atomic', on: pkOf(m.entity), agg: 'count', source: m.entity, additivity: 'additive', label: m.name };
    } else if (m.kind === 'ratio') {
      defs[m.slug] = { kind: 'ratio', numerator: m.numerator, denominator: m.denominator, label: m.name };
    } else if (m.kind === 'expression') {
      // ROW-LEVEL expression (D4): an atomic def whose `on` is a RowExpr over LOCAL numeric cols,
      // aggregated ONCE. right is a sibling col OR a numeric literal.
      const right = m.rightIsLit ? { lit: Number(m.right) } : { col: m.right };
      defs[m.slug] = {
        kind: 'atomic',
        on: { op: m.op, left: { col: m.left }, right },
        agg: m.agg,
        source: 'opportunities',
        additivity: m.additivity,
        label: m.name,
      };
    } else {
      const right = m.rightIsLit ? { lit: Number(m.right) } : { ref: m.right };
      defs[m.slug] = { kind: 'derived', expr: { op: m.op, left: { ref: m.left }, right }, label: m.name };
    }
  }
  return defs;
}

// Optional real embed provider (OPENAI_API_KEY) — true free-text concepts instead of the ILIKE stub.
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'text-embedding-3-small';
function makeRealEmbed(): ((text: string) => Promise<number[]>) | undefined {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return undefined;
  const cache = new Map<string, number[]>();
  return async (text: string): Promise<number[]> => {
    const hit = cache.get(text);
    if (hit) return hit;
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: text, dimensions: 1536 }),
    });
    if (!r.ok) throw new Error(`embed provider ${EMBED_MODEL} failed: ${r.status} ${await r.text()}`);
    const j = (await r.json()) as { data: { embedding: number[] }[] };
    const vec = j.data[0]!.embedding;
    cache.set(text, vec);
    return vec;
  };
}
const realEmbed = makeRealEmbed();
const EMBED_MODE = realEmbed ? `live · ${EMBED_MODEL}` : 'stub · ILIKE phrase-match';

// ── the live surface — REBUILT when a field measure is defined/removed (the curate→surface loop) ──
let h: ReturnType<typeof makeQuerySurface>;
async function rebuild(): Promise<void> {
  const prev = h;
  h = makeQuerySurface(DBURL!, {
    dimensionSpecs: DIMENSION_SPECS,
    measureSpecs: specsFromBook(BOOK),
    measureDefs: defsFromBook(BOOK),
    ...(realEmbed ? { embed: realEmbed } : {}),
  });
  if (prev) await prev.close().catch(() => {});
}
await resolvePks(); // resolve static PKs from describe() BEFORE the first build (count defs need them)
await rebuild();

// ── display helpers ──────────────────────────────────────────────────────────────────────────
const pretty = (sql?: string): string | undefined => {
  if (!sql) return sql;
  try {
    return formatSql(sql, { language: 'postgresql', keywordCase: 'lower', tabWidth: 2, expressionWidth: 64 });
  } catch {
    return sql;
  }
};
function displayParams(
  params: unknown[] | undefined,
  query?: string,
): { i: number; kind: 'vector' | 'scalar'; value: string }[] {
  if (!params) return [];
  return params.map((p, idx) => {
    const arr = Array.isArray(p)
      ? (p as number[])
      : typeof p === 'string' && p.startsWith('[') && p.length > 100
        ? (JSON.parse(p) as number[])
        : null;
    if (arr && arr.length > 32) {
      const head = arr.slice(0, 4).map((n) => n.toFixed(4)).join(', ');
      return { i: idx + 1, kind: 'vector' as const, value: `⟨embedding of “${query ?? '…'}” · ${arr.length}-d⟩  [${head}, …]` };
    }
    return { i: idx + 1, kind: 'scalar' as const, value: String(p) };
  });
}
const ms = (t0: number) => Math.round(performance.now() - t0);

// ── PRESETS (the verb tour) ───────────────────────────────────────────────────────────────────
const MEASURE_PRESETS: Record<string, { title: string; blurb: string; entity: string; q: any }> = {
  obs_by_stage: {
    title: 'Evidence by opportunity stage  ·  EAV dim through a to-one join',
    blurb: 'Observations counted at THEIR grain, grouped by their opportunity’s EAV `stage` — reached through the belongs_to join (1:1 ∘ 1:1, grain-safe). The conformance just shipped.',
    entity: 'observations',
    q: { group_by: ['opportunities.stage'], measures: [{ on: '*', agg: 'count', as: 'observations' }], order_by: [{ on: 'observations', dir: 'desc' }] },
  },
  obs_by_band: {
    title: 'Evidence by deal-size band  ·  a second EAV dim, same path',
    blurb: 'Same cross-grain shape on a different EAV dimension (deal_size_band) — no code change.',
    entity: 'observations',
    q: { group_by: ['opportunities.deal_size_band'], measures: [{ on: '*', agg: 'count', as: 'observations' }], order_by: [{ on: 'observations', dir: 'desc' }] },
  },
  pipeline_by_stage: {
    title: 'Pipeline by stage  ·  named measures by {ref}',
    blurb: 'At the opportunities grain: catalog measures referenced BY NAME (`{ref}`) — Σ ExpectedRevenue + count + avg win-prob — grouped by the EAV `stage` dimension. No inline {on,agg}.',
    entity: 'opportunities',
    q: {
      group_by: ['stage'],
      measures: [
        { ref: 'ExpectedRevenue.sum', as: 'pipeline' },
        { on: '*', agg: 'count', as: 'deals' },
        { ref: 'Probability.avg', as: 'avg_win_prob' },
      ],
      order_by: [{ on: 'pipeline', dir: 'desc' }],
    },
  },
  refused_to_many: {
    title: 'Refused: group by a to-many dim  ·  the fail-loud guard',
    blurb: 'Grouping opportunities by observations.type would FAN OUT the measure. The engine refuses — read the error; it’s the trust story.',
    entity: 'opportunities',
    q: { group_by: ['observations.type'], measures: [{ on: 'ExpectedRevenue', agg: 'sum', as: 'pipeline' }] },
  },
};
const SELECT_PRESETS: Record<string, { title: string; blurb: string; entity: string; opts: any }> = {
  won_opps: {
    title: 'Opportunities in a won stage',
    blurb: 'Structured filter on the EAV `StageName` field (the retrieval path addresses EAV fields by their field key, is_visible-gated); IDs + a preview, grain preserved.',
    entity: 'opportunities',
    opts: { filter: { on: 'StageName', op: 'eq', value: 'closed_won' }, columns: ['id', 'StageName', 'Amount'], preview: true, limit: 10, include_sql: true },
  },
  relevant_obs: {
    title: 'Observations relevant to a concept  ·  relevance-as-selection',
    blurb: 'op:"relevant" with a top_k cutoff defines a cohort. Without OPENAI_API_KEY this is a verbatim phrase match (ILIKE stub); set the key for true concepts.',
    entity: 'observations',
    opts: { filter: { on: 'normalized_text', op: 'relevant', query: 'pricing', top_k: 10 }, columns: ['type', 'normalized_text', 'opportunity_id'], preview: true, include_sql: true },
  },
};
const COMPARE_PRESETS: Record<string, { title: string; blurb: string; entity: string; req: any }> = {
  won_vs_lost: {
    title: 'Won vs Lost pipeline  ·  variant-vs-variant',
    blurb: 'One base metric (Σ ExpectedRevenue + deal count), two labeled variants overriding the stage filter, aligned. Each variant inherits fan-safety + fail-closed scope.',
    entity: 'opportunities',
    req: {
      measures: [{ on: 'ExpectedRevenue', agg: 'sum', as: 'pipeline' }, { on: '*', agg: 'count', as: 'deals' }],
      variants: [
        { label: 'won', filter: { on: 'stage', op: 'eq', value: 'closed_won' } },
        { label: 'lost', filter: { on: 'stage', op: 'eq', value: 'closed_lost' } },
      ],
    },
  },
};

// ── verb runners ─────────────────────────────────────────────────────────────────────────────
async function apiDescribe(entity: string) {
  const t0 = performance.now();
  const [catalog, conformed, measures] = await Promise.all([
    h.service.describe(entity as any),
    h.service.describeConformedDimensions(entity as any),
    h.service.describeMeasures(entity as any),
  ]);
  return { entity, catalog, conformed, measures, ms: ms(t0) };
}
async function apiMeasure(body: { preset?: string }) {
  const p = MEASURE_PRESETS[body.preset ?? 'obs_by_stage'] ?? MEASURE_PRESETS.obs_by_stage;
  const t0 = performance.now();
  const res: any = await h.service.measure(p.entity as any, p.q, { include_sql: true, citation: { boundary: true } });
  return { preset: { title: p.title, blurb: p.blurb, entity: p.entity, request: p.q }, rows: res.rows, citation: res.citation, sql: pretty(res.sql), params: displayParams(res.params), ms: ms(t0) };
}
async function apiSelect(body: { preset?: string }) {
  const p = SELECT_PRESETS[body.preset ?? 'won_opps'] ?? SELECT_PRESETS.won_opps;
  const t0 = performance.now();
  const res: any = await h.service.select(p.entity as any, p.opts);
  return { preset: { title: p.title, blurb: p.blurb, entity: p.entity, request: p.opts }, total: res.total, rows: res.preview ?? res.ids?.map((id: string) => ({ id })) ?? [], ids: res.ids, sql: pretty(res.sql), params: displayParams(res.params, p.opts.filter?.query), ms: ms(t0) };
}
async function apiFetch(body: { entity?: string; ids?: string[]; columns?: string[] }) {
  const entity = body.entity ?? 'opportunities';
  const ids = (body.ids ?? []).slice(0, 25);
  const t0 = performance.now();
  const res: any = await h.service.fetch(entity as any, ids, { ...(body.columns ? { columns: body.columns } : {}), include_sql: true });
  return { entity, requested: ids.length, rows: res.rows ?? [], sql: pretty(res.sql), params: displayParams(res.params), ms: ms(t0) };
}
async function apiCompare(body: { preset?: string }) {
  const p = COMPARE_PRESETS[body.preset ?? 'won_vs_lost'] ?? COMPARE_PRESETS.won_vs_lost;
  const t0 = performance.now();
  const res: any = await h.service.compare(p.entity as any, p.req);
  return { preset: { title: p.title, blurb: p.blurb, entity: p.entity, request: p.req }, result: res, ms: ms(t0) };
}

// ── MEASURES workbench ─────────────────────────────────────────────────────────────────────────
// Resolve a book measure into the engine `measures[]` item (+ how it resolves, for the UI badge).
function resolveBookMeasure(m: BookMeasure): { item: any; resolution: string } {
  // Every kind is a real engine catalog entry — the agent calls by the STABLE SLUG, no guessing.
  // count → count(pk); field → agg(field); ratio → numerator / denominator (fan-safe legs).
  const formula =
    m.kind === 'count'
      ? `count(${m.entity}.${pkOf(m.entity)})`
      : m.kind === 'field'
        ? `${m.field} ${m.agg}`
        : m.kind === 'ratio'
          ? `${m.numerator} / ${m.denominator}`
          : m.kind === 'expression'
            ? `${m.agg}(${m.left} ${m.op} ${m.right})`
            : `${m.left} ${m.op} ${m.right}`;
  return { item: { ref: m.slug }, resolution: `engine catalog · {ref:"${m.slug}"}  (= ${formula})` };
}

// The measure-eligible fields per entity (numeric fields → aggregatable). Drawn from describe().
async function measureEligibleFields(entity: string): Promise<{ key: string; type: string; label?: string }[]> {
  const cat: any = await h.service.describe(entity as any);
  return (cat.fields ?? [])
    .filter((f: any) => f.type === 'number' || f.type === 'integer')
    .map((f: any) => ({ key: f.key, type: f.type, label: f.label }));
}

async function apiMeasuresInfo() {
  const t0 = performance.now();
  const [oppCat, obsCat, oppFields, metrics] = await Promise.all([
    h.service.describeMeasures('opportunities' as any),
    h.service.describeMeasures('observations' as any),
    measureEligibleFields('opportunities'),
    h.service.describeMetrics(),
  ]);
  // The atomic measures available as ratio legs — describeMeasures returns ONLY atomics (it skips
  // composites), across entities, deduped. This is exactly the set a ratio numerator/denominator
  // may name (auto-derived `Field.agg` + every host atomic field/count slug).
  const atomics = [...new Set([...oppCat, ...obsCat].map((m: any) => m.name))].sort();
  return {
    engineCatalog: { opportunities: oppCat, observations: obsCat },
    engineMetrics: metrics, // the metric LAYER (ADR-0029) — ratios etc., not entity-scoped
    eligibleFields: { opportunities: oppFields },
    atomics,
    book: BOOK.map((m) => ({ ...m, alias: aliasFor(m), ...resolveBookMeasure(m) })),
    ms: ms(t0),
  };
}

async function apiMeasuresDefine(body: any): Promise<unknown> {
  const name = String(body.name ?? '').trim();
  if (!name) throw new Error('define: `name` is required');
  // Slug = the stable unique ref. Caller may supply one; else derive from the name. Enforce
  // uniqueness on the SLUG (the contract) — name collisions are also refused for clarity.
  const slug = toIdentifier(String(body.slug ?? '').trim() || name);
  if (BOOK.some((m) => m.slug === slug)) throw new Error(`define: a measure with slug "${slug}" already exists`);
  if (BOOK.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`define: a measure named "${name}" already exists`);
  }
  let m: BookMeasure;
  if (body.kind === 'count') {
    const entity = String(body.entity ?? 'opportunities');
    m = { slug, kind: 'count', name, entity };
  } else if (body.kind === 'field') {
    const field = String(body.field ?? '');
    const agg = String(body.agg ?? 'sum') as FieldMeasure['agg'];
    // sum + count are additive (re-aggregatable across grain); avg/min/max/count_distinct are not.
    const additivity = (body.additivity ?? (agg === 'sum' || agg === 'count' ? 'additive' : 'non')) as FieldMeasure['additivity'];
    if (!field) throw new Error('define: a field-aggregate measure needs a `field`');
    m = { slug, kind: 'field', name, entity: 'opportunities', field, agg, additivity };
  } else if (body.kind === 'ratio') {
    const numerator = String(body.numerator ?? '');
    const denominator = String(body.denominator ?? '');
    if (!numerator || !denominator) throw new Error('define: a ratio needs a `numerator` and `denominator` (atomic measure slugs)');
    if (numerator === denominator) throw new Error('define: a ratio numerator and denominator must differ');
    m = { slug, kind: 'ratio', name, numerator, denominator };
  } else if (body.kind === 'derived') {
    const op = String(body.op ?? '') as DerivedMeasure['op'];
    if (!['+', '-', '*', '/'].includes(op)) throw new Error("define: a derived metric needs an `op` (one of + - * /)");
    const left = String(body.left ?? '');
    if (!left) throw new Error('define: a derived metric needs a `left` atomic measure slug');
    const rightIsLit = Boolean(body.rightIsLit);
    const right = String(body.right ?? '');
    if (!right) throw new Error('define: a derived metric needs a `right` (atomic measure slug or numeric literal)');
    if (rightIsLit && !Number.isFinite(Number(right))) throw new Error('define: a literal `right` must be a finite number');
    m = { slug, kind: 'derived', name, op, left, right, ...(rightIsLit ? { rightIsLit } : {}) };
  } else if (body.kind === 'expression') {
    // ROW-LEVEL expression measure (D4): agg(leftField <op> right), per-row before the agg.
    const op = String(body.op ?? '') as ExpressionMeasure['op'];
    if (!['+', '-', '*', '/'].includes(op)) throw new Error("define: an expression measure needs an `op` (one of + - * /)");
    const agg = String(body.agg ?? 'sum') as ExpressionMeasure['agg'];
    if (!['sum', 'avg', 'min', 'max'].includes(agg)) throw new Error("define: an expression measure needs an `agg` (one of sum/avg/min/max)");
    const left = String(body.left ?? '');
    if (!left) throw new Error('define: an expression measure needs a `left` numeric field key');
    const rightIsLit = Boolean(body.rightIsLit);
    const right = String(body.right ?? '');
    if (!right) throw new Error('define: an expression measure needs a `right` (numeric field key or numeric literal)');
    if (rightIsLit && !Number.isFinite(Number(right))) throw new Error('define: a literal `right` must be a finite number');
    // sum of a row-level product is host-declared additive (an additive amount × a ratio is summable).
    const additivity = (body.additivity ?? (agg === 'sum' ? 'additive' : 'non')) as ExpressionMeasure['additivity'];
    m = { slug, kind: 'expression', name, agg, op, left, right, additivity, ...(rightIsLit ? { rightIsLit } : {}) };
  } else {
    throw new Error(`define: unknown kind "${body.kind}" (expected 'count' | 'field' | 'ratio' | 'derived' | 'expression')`);
  }

  // Optimistic apply: add to the book, rebuild if it changes the engine catalog, then PROVE it
  // resolves by running a tiny grouped measure(). If anything throws, roll the book back — the page
  // never shows a measure it can't actually call (fail-loud, no half-registered state).
  const prevBook = BOOK;
  BOOK = [...BOOK, m];
  try {
    await rebuild(); // both kinds now register a host MeasureDef → the catalog must rebuild
    const { item, resolution } = resolveBookMeasure(m);
    const entity = m.kind === 'count' ? m.entity : 'opportunities';
    const t0 = performance.now();
    const res: any = await h.service.measure(entity as any, { measures: [item] }, { include_sql: true });
    saveBook(BOOK);
    // `item` is {ref:slug} — the probe proves the agent can call this measure by its name.
    return { ok: true, measure: { ...m, alias: aliasFor(m), resolution }, probe: { value: res.rows?.[0], sql: pretty(res.sql), ms: ms(t0) } };
  } catch (e) {
    BOOK = prevBook;
    await rebuild();
    throw e;
  }
}

async function apiMeasuresDelete(body: any): Promise<unknown> {
  const slug = String(body.slug ?? body.id ?? '');
  const found = BOOK.find((m) => m.slug === slug);
  if (!found) throw new Error(`delete: no measure with slug "${slug}"`);
  BOOK = BOOK.filter((m) => m.slug !== slug);
  saveBook(BOOK);
  await rebuild(); // both kinds registered a catalog entry → rebuild to drop it
  return { ok: true, removed: slug };
}

// Test a defined measure by slug: run measure(entity, {group_by?, measures:[resolved]}).
async function apiMeasuresTest(body: any): Promise<unknown> {
  const slug = String(body.slug ?? body.id ?? '');
  const m = BOOK.find((x) => x.slug === slug);
  if (!m) throw new Error(`test: no measure with slug "${slug}"`);
  const { item, resolution } = resolveBookMeasure(m);
  const entity = m.kind === 'count' ? m.entity : 'opportunities';
  const dim = body.dim ? String(body.dim) : undefined;
  const q: any = { measures: [item], ...(dim ? { group_by: [dim], order_by: [{ on: aliasFor(m), dir: 'desc' }] } : {}) };
  const t0 = performance.now();
  const res: any = await h.service.measure(entity as any, q, { include_sql: true });
  return { measure: { ...m, alias: aliasFor(m), resolution }, entity, request: q, rows: res.rows, sql: pretty(res.sql), params: displayParams(res.params), ms: ms(t0) };
}

const POST_ROUTES: Record<string, (body: any) => Promise<unknown>> = {
  '/api/measure': apiMeasure,
  '/api/select': apiSelect,
  '/api/fetch': apiFetch,
  '/api/compare': apiCompare,
  '/api/measures/define': apiMeasuresDefine,
  '/api/measures/delete': apiMeasuresDelete,
  '/api/measures/test': apiMeasuresTest,
};

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/api/info') {
      return Response.json({
        embedMode: EMBED_MODE,
        real: !!realEmbed,
        dimensions: DIMENSION_SPECS,
        entities: ['opportunities', 'accounts', 'observations'],
        groupDims: ['opportunities.stage', 'opportunities.deal_size_band', 'stage', 'deal_size_band'],
        presets: {
          measure: Object.entries(MEASURE_PRESETS).map(([key, p]) => ({ key, title: p.title })),
          select: Object.entries(SELECT_PRESETS).map(([key, p]) => ({ key, title: p.title })),
          compare: Object.entries(COMPARE_PRESETS).map(([key, p]) => ({ key, title: p.title })),
        },
      });
    }
    if (url.pathname === '/api/describe') {
      try {
        return Response.json(await apiDescribe(url.searchParams.get('entity') ?? 'observations'));
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }
    if (url.pathname === '/api/measures') {
      try {
        return Response.json(await apiMeasuresInfo());
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }
    const route = POST_ROUTES[url.pathname];
    if (route && req.method === 'POST') {
      try {
        return Response.json(await route(await req.json()));
      } catch (e) {
        // The engine's fail-loud refusals (non-conforming dim, scope gap, unsafe fan-out, bad
        // measure def) land here — surface them verbatim; they're the trust story, not noise.
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`\n  query-surface · showcase  →  http://localhost:${server.port}`);
console.log(`  embed: ${EMBED_MODE}${realEmbed ? '' : '  (set OPENAI_API_KEY for true free-text concepts)'}`);
console.log(`  measure book: ${BOOK.length} defined  (${BOOK_PATH})\n`);
