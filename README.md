# @pattern-stack/query-surface

A **governed, agent-aware query + aggregation surface** over a host-supplied domain
model. One composition point — `QueryApplicationService` — exposes five primitives that
an agent (or a REST/MCP client) can call to discover a schema, find rows at their natural
grain, hydrate them, and collapse them into **grain-safe** grouped measures. The engine
**fails loud**: an unsafe fan-out, a non-conforming dimension, or a scope-coverage gap
comes back as an error with a reason, never a silently wrong number.

The package hard-codes **no schema**. The host supplies an `AggregateModel` (entities,
cardinality graph, EAV strategy, field tags); the reference instance
(`adapters/reference/model.dealbrain.ts`) doubles as the eval fixture.

---

## Install

```bash
bun add @pattern-stack/query-surface drizzle-orm@1.0.0-rc.4
# ./nest also needs: @nestjs/common @nestjs/swagger rxjs zod
# ./mcp  also needs: @modelcontextprotocol/sdk zod
```

Peer: **`drizzle-orm ^1.0.0-rc.4`** (Drizzle 1.0 / relational queries v2). Entry points:
`@pattern-stack/query-surface` (engine + types), `/nest` (NestJS module + REST), `/mcp`.

### Two ways to supply the model

- **Declared (primary).** Build an `AggregateModel` directly — `registry`
  (`Record<string, EntityDescriptor>`), `analytics` (`AggRegistry`), `tables`, `colByDbName`,
  optional `catalog` (`MeasureCatalog`) — and pass it as `QueryServiceOptions.aggregateModel`.
  This is the path for a host that already knows its graph (e.g. generated from entity YAML).
- **Introspected.** For a host without a declared model: hand the surface your Drizzle 1.0
  relational config and it derives the registry.

  ```ts
  const relations = defineRelations(schema, (r) => ({ /* … */ }));
  registerSchema(relations, { eav: { /* … */ } });   // or registerFromDb(drizzle({ client, relations }))
  ```

### Relationship kinds

| kind | FK lives on | cardinality | aggregate stage | retrieval path |
|---|---|---|---|---|
| `belongs_to` | this entity | to-one | dims conform (LEFT JOIN `this.fk = target.pk`) | LEFT JOIN |
| `has_one` | the target | to-one | dims conform (LEFT JOIN `target.fk = this.pk`) | LEFT JOIN |
| `has_many` | the target | to-many | filter → `EXISTS` semijoin; group → **reject** | `EXISTS` |

A `has_one` is trusted to be 1:1 — back it with a `UNIQUE` on the target's FK (`fetch`
expand refuses a parent with more than one child). Introspection reads primary keys from the
table metadata and classifies `r.one.T({ from: this.fk, to: T.pk })` as `belongs_to`,
`r.one.T({ from: this.pk, to: T.fk })` — or a shared-PK `{ from: this.pk, to: T.pk }` — as
`has_one`, and `r.many.T(…)` as `has_many`; `.through()` many-to-many is skipped
(register the junction as an entity) and reported by `diagnose()`.

---

## The five primitives

| Verb | Signature | What it does |
|---|---|---|
| **`describe`** | `describe(entity?)` | The typed field catalog (native ⊕ EAV) + the graph-derived **conformed dimension set** per metric. `describeMeasures(entity)` / `describeMetrics()` advertise the catalog by **layer**. |
| **`select`** | `select(entity, opts)` | Find IDs at their **natural grain** (+ preview rows, + `window` annotations, + semantic `relevant`/`rank_by`). Grain preserved. |
| **`fetch`** | `fetch(entity, ids, opts)` | Hydrate specific IDs into full rows. |
| **`measure`** | `measure(entity, q, opts)` | **Collapse** to grouped rows with measures — grain-safe, conformed dimensions only. |
| **`compare`** | `compare(entity, …)` | N-variant aligned comparison (period-over-period / A-vs-B) over the same measure set. |

> The verb set is locked (ADR-0024 Amendment 3): `describe · select · fetch · measure · compare`.
> All five share **one** expression language — the `Predicate` (`FilterExpression`) — for
> filters, `where`, `having`, and the conformed-dimension resolver. There is no second
> filter dialect.

```ts
// discover
const cat = await svc.describe('opportunities');          // fields + conformed dims
const measures = await svc.describeMeasures('opportunities'); // Amount.sum, Amount.avg, …

// collapse, grain-safe
await svc.measure('opportunities', {
  group_by: ['stage'],                                    // a conformed (to-one) dimension
  measures: [{ on: 'Amount', agg: 'sum', as: 'pipeline' }],
});

// find by semantic relevance (relevance IS a predicate leaf)
await svc.select('observations', {
  filter: { normalized_text: { op: 'relevant', top_k: 25 } },
}); // response carries a CITATION: the cohort definition, cutoff, and matched exemplars
```

---

## The measure / metric model (ADR-0029)

The aggregation vocabulary is **two layers**, discriminated by *how many aggregation
passes* a quantity takes:

- A **measure** is computable in **one aggregation pass** — `g( f(col₁…colₙ) )`: a
  row-level expression `f` evaluated per row, then collapsed by a single agg `g`.
- A **metric** is **post-aggregate** — arithmetic over **≥2 separately-aggregated legs**
  that no single pass yields.

The measure layer has two **grades** (atomic ⊂ expression):

| Layer · grade | Shape | Example | Status |
|---|---|---|---|
| **measure · atomic** | `agg(column)` | `SUM(Amount)`, `COUNT(id)` | shipped |
| **measure · expression** | `agg( f(col₁,col₂,…) )` — row-level, multi-column | `SUM(Amount · Probability)` (weighted pipeline) | shipped (D4) |
| **measure · expression (to-one)** | a leaf may be a `belongs_to`-reached `target.col` | `SUM(opportunities.Amount · opportunities.Probability)` at the observations grain | shipped (D4 follow-up) |
| **metric · ratio** | `agg(x) / agg(y)` | `win_rate = won / total` | shipped |
| **metric · derived** | arithmetic over ≥2 atomic legs | `gross_profit = revenue − cost`, weighted blends | shipped (D2) |
| **metric · cumulative** | running total over a window | — | routed to `select({ window })` |

The boundary is **single-pass computability**, not distribution. `SUM(price·qty)` is a
*measure* (compute the product per row, one `SUM`) even though `×` does **not** distribute
through `SUM` (`SUM(price·qty) ≠ SUM(price)·SUM(qty)`) — which is exactly why a ratio is
always a metric and a row-level product is still a measure. Aligns with dbt MetricFlow's
measure/metric split.

### Expression measures — the `RowExpr` AST

```ts
type RowExpr =
  | { col: string }                                        // a local native/EAV numeric field…
  | { lit: number }                                        // …or a belongs_to-reached `target.col`
  | { op: '+' | '-' | '*' | '/'; left: RowExpr; right: RowExpr };

// weighted pipeline — a per-row product, impossible to express as a metric
const weighted_pipeline = {
  kind: 'atomic',
  on: { op: '*', left: { col: 'Amount' }, right: { col: 'Probability' } },
  agg: 'sum', source: 'opportunities', additivity: 'additive',
};
```

Semantics that are easy to get wrong, and how this engine resolves them:

- **Missing operand → 0.** Each `{col}` leaf is `coalesce(col, 0)`, so `profit = price −
  cost` over a deal with no recorded cost yields `price`, never a dropped row. This also
  makes the expression form coincide with the derived-metric form over **all** rows
  (`SUM(a−b) ≡ SUM(a)−SUM(b)`). A host that wants "exclude rows missing X" uses a
  measure-level `where`.
- **To-one reach is 1:1, never a fan.** A dotted `{col}` is legal **only** through a single
  `belongs_to` chain to a registered numeric field; a `has_many` / diamond / non-numeric
  reach is rejected fail-loud at model load. The target's scope folds into the `belongs_to`
  `ON` (an out-of-scope parent → NULL → 0, never a leak).
- **Additivity is host-declared** for an expression measure (a product of an additive
  amount × a non-additive ratio is itself summable); the doctor bypasses its
  `SUM`-on-non-additive refusal for the expression grade only.

---

## Hard rules (invariants — the engine rejects any change that violates them)

1. **Builder-only, NO raw SQL.** Drizzle query builder; `` sql`…` `` only over column
   **objects** + bound params; `sql.raw` only for fixed keywords (operators from a closed
   set, `asc/desc`, `in`) — never a caller string.
2. **Grain-relative fan-safety.** Each measure pre-aggregates in its **own** source-entity
   CTE, joined on the group key. Fan-safety is group-grain→measure-entity relative, never
   query-root relative. A to-one (`belongs_to` / `has_one`) / EAV join is 1:1 and allowed; a
   fan-inducing join is not.
3. **Scope is FAIL-CLOSED, per-source, pre-aggregation** — folded through every traversed
   entity (to-one `ON` + semijoin `EXISTS` body). A resolver returning `undefined` for a
   queried entity is a coverage gap → REFUSE.
4. **One expression language** — the `Predicate`. No second filter dialect.
5. **Conformed-dimension rule (ADR-0024).** A dimension on B is legal at A's grain iff every
   A→B hop is to-one. A global `filter` must conform on **every** measure source, else
   REJECT — no silent per-source no-op. Source-local intent uses a measure-level `where`.
6. **Catalog by code, instances by data.** Capabilities register in code; the named-measure
   catalog is derived from `role`-tagged FieldMeta, not hand-listed.
7. **The model is host-supplied** (`AggregateModel`); the package hard-codes no schema.

---

## Architecture — hexagonal (driving / driven)

```
src/
  index.ts · query.application-service.ts   ← public API + composition root
  internal/        the dialect-free interior (no Drizzle):
                     language/  Predicate AST · normalizers · error contract
                     analytics/ the grain oracle · the doctor · join-plan (conformed-dim
                                resolver) · measure-catalog · normalize · compare
                     retrieval/ snippets
  adapters/        driven adapters:
                     drizzle/   compile/ + execute/ — the ONLY SQL-bound code
                     reference/ the dealbrain eval fixture (model + schema)
  presentation/    driving adapters: nest/ (REST). MCP/CLI grow by subpath export.
  characterization/ the char net — a DB-backed contract test pinning backend behavior
```

Driving adapters grow by **subpath export**; driven adapters grow by **folder**. The
interior speaks a dialect-neutral plan; each driven adapter lowers it. **Direction**
(ADR-0028): extract a dialect-neutral `QueryPlan` IR + a `QueryBackend` driven port so a
second backend (Snowflake/BigQuery) is a new adapter folder, not an engine rewrite.

---

## The eval IS the gate

Behavior is pinned by the `*.eval.spec.ts` + `*.char.eval.spec.ts` suites. DB-backed specs
gate on `DBURL` (skip cleanly without it). The **char net** is the regression net that let
the engine be swapped without behavior drift. Every measure/metric capability ships with an
eval that computes ground truth **independently** (raw SQL), never via the path under test.

```bash
bun install
bun run check:type                                   # tsc --noEmit
bun run lint                                          # biome, whole repo (CI gates this)
bun test                                              # DB-gated specs skip cleanly
DBURL=postgres://postgres:password@localhost:54321/dealbrain bun test   # the full eval
```

The reference DB (`:54321`) is **dealbrain's** dev DB (the Bean Maxx fixture): `Opp→Account`
is to-one, `Account→Opp` to-many, `observations` carry real 1536-dim embeddings.

---

## Stack

Bun 1.3 · TypeScript 5 (strict) · Drizzle ORM 1.0 (peer `^1.0.0-rc.4`, dev pin `1.0.0-rc.4`) · NestJS (presentation only)
· Postgres 16 · Biome.

## Design docs

- [`.ai-docs/decisions/ADR-0024`](.ai-docs/decisions/ADR-0024-conformed-dimensions.md) — conformed dimensions + relevance-as-predicate + the verb rename
- [`.ai-docs/decisions/ADR-0028`](.ai-docs/decisions/ADR-0028-engine-unification-and-query-backend.md) — the `QueryPlan` IR + `QueryBackend` port (designed)
- [`.ai-docs/decisions/ADR-0029`](.ai-docs/decisions/ADR-0029-measure-metric-model.md) — the measure/metric model (shipped through D4 + to-one cols)
- [`CHANGELOG.md`](CHANGELOG.md)

## Canonical lineage

This is the **canonical** home for the engine that previously drifted across three copies
(`dealbrain/packages/query-surface`, `query-surface-poc`, `swe-brain/packages/query-surface`),
seeded from the `swe-brain` superset (retrieval + the grain-safe analytics stage). Fixes land
**only** here; consumers bump.

## License

Source-available under the [Functional Source License, Version 1.1, MIT Future License](LICENSE)
(SPDX `FSL-1.1-MIT`, see <https://fsl.software>). This is **not** an OSI-approved open-source license.

- **Allowed:** use, modify, embed and ship this package inside your own products and internal tools.
- **Reserved:** a *Competing Use* — offering this package, or a substitute for it, to others as a
  commercial product or hosted service.
- **Converts to MIT:** each version becomes available under the MIT license two years after its release.
- **Earlier versions:** versions ≤ 0.2.0 were published on GitHub under MIT and remain MIT.

This section is a summary only — [`LICENSE`](LICENSE) is the authoritative text.
