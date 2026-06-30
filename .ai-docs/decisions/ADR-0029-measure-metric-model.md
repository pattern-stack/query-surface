# ADR-0029 — The Measure / Metric layered model

**Status:** SHIPPED through D4 + the to-one expression-col follow-up — see **Amendment 1** (2026-06-29) for the build record and the row-level NULL / additivity decisions. Originally surfaced in-session 2026-06-29 while exposing the just-shipped host-named measure defs in the workbench (`c776ccb` + `0430b3b`, PRs #19/#20). The **two-layer model with its measure-layer grades (§Decision 1) and the single-pass-computability decision criterion (§Decision 2)** are settled; the **build** is staged behind a strangler (§Sequencing) and one tactical UI fix is do-now. This ADR NAMES the model — it does not yet change the engine (except D3's no-engine UI fix). · **Scope:** the layering of the aggregation vocabulary — what is a **measure** (computable in one aggregation pass over a row-level expression) vs a **metric** (post-aggregate arithmetic over collapsed legs) — and where the existing `ratio`/`cumulative`/`count(pk)` work sits in it; EXCLUDES dimension naming (D6) and the second-backend reorg (ADR-0028). · **Builds on** [ADR-0024](./ADR-0024-conformed-dimensions.md) (the named-measure catalog derived from `role`-tagged FieldMeta + `compare()`; the conformed-dimension rule a metric's group keys still obey) and [ADR-0028](./ADR-0028-engine-unification-and-query-backend.md) (the `Aggregate` shape + `QueryPlan` IR these tiers compile through). · **Aligns with** dbt MetricFlow's measure/metric split (measures as aggregation building blocks; metrics — simple/ratio/derived/cumulative/conversion — as the queryable layer above the aggregation boundary).

---

## Context

We just shipped **host-named measure definitions**: the `measureDefs` slug-ref registration hook merged onto the auto-derived `Field.agg` catalog at model load (`src/adapters/reference/model.dealbrain.ts:167,274-290`), with the **slug as the agent-facing contract** (call a measure by `{ref:'total_revenue'}`, never by guessing `on`/`agg`). It came with three companions: `describe().primaryKey` surfaced so a host/agent can address an entity's identity column without assuming its name (`src/adapters/drizzle/registry/catalog.ts:89-91`); **`count(pk)` closing the count gap** — `count(id)` over that primary key is registered as a first-class catalog measure (`count(id) ≡ count(*)`, `scripts/qs-showcase/index.html:513-514,561`); and **ratio measures** — `numerator / denominator` over two atomic legs, computed as outer-SELECT arithmetic and therefore fan-safe by construction (`src/internal/analytics/types.ts:94-108`, `src/internal/analytics/measure-catalog.ts:31-39`). Commits `c776ccb` + `0430b3b`, PRs #19/#20.

Exposing all of this in the workbench surfaced the modeling debt. The define-a-measure form offers a single **`kind` dropdown — `count` / `field` (field aggregate) / `ratio`** (`scripts/qs-showcase/index.html:535`). That dropdown **conflates two orthogonal axes**: `count`-vs-`field` is an *aggregation* choice (which agg over which column), while `ratio` is a *layer* choice (a post-aggregate composition over two already-collapsed measures). They are not siblings. Worse, the **field-aggregate agg picker offers only `sum`/`avg`/`min`/`max`** (`scripts/qs-showcase/index.html:582`) — it cannot even pick `count` or `count_distinct`, though both are first-class in the `Agg` union (`src/internal/analytics/types.ts:14`), so `count` got bolted on as its own top-level "kind" to route around the gap.

And we have **no Metric layer at all in the additive sense**. `ratio` exists; the code comments already call it a "ratio metric" and `cumulative` a "running-total metric" (`src/internal/analytics/measure-catalog.ts:31,41`). But there is **no derived/subtractive metric** — no `gross_profit = revenue − cost`, no weighted blend — because the only post-aggregate composite the engine knows is the hard-coded `ratio` `CompositeColumn` (`src/internal/analytics/types.ts:99-108`). Meanwhile a genuinely *different* unbuilt thing — a **multi-column row-level** measure like `SUM(price * qty)` — is silently lumped in nobody's tier, because `Measure.on` and `AtomicMeasureDef.on` are **single-column** (`src/internal/analytics/types.ts:84`, `src/internal/analytics/measure-catalog.ts:18-19`).

The forcing function: the agent-facing surface now hands out named handles, and three structurally different things (`count`, a field aggregate, a ratio) sit on one flat dropdown that **teaches the wrong mental model** — so before we add `derived` (the real gap) we must NAME the layers, or every future kind lands on the same conflated axis.

## Decision (settled)

### 1. The model — two LAYERS, with the measure layer in two GRADES

The boundary that matters is **how many aggregation passes** a quantity takes:

- A **measure** is computable in **one aggregation pass** — `g( f(col₁…colₙ) )`: a row-level expression `f` evaluated per row, collapsed by a single agg `g`.
- A **metric** is **post-aggregate** — arithmetic over **≥2 separately-aggregated legs** that no single pass yields.

That is the binary `layer: 'measure' | 'metric'` discriminator D1 adopts. The measure layer then has two implementation **grades** by the arity of `f`, and **atomic ⊂ expression** (atomic is the arity-1 degenerate case, not a disjoint peer):

**Measure / grade ATOMIC = `agg(column)`. HAVE IT.** A single aggregation over a single field of one source — the arity-1 row-level expression. `AtomicMeasureDef.kind:'atomic'` with `on` a **single field key** (or `relation.field`; EAV fields resolve as columns) and one `agg` (`src/internal/analytics/measure-catalog.ts:16-29`). Auto-derived from every `role:'measure'` FieldMeta tag (`measuresFromRegistry`, `src/internal/analytics/measure-catalog.ts:138-164`); host-nameable by slug (`measureDefs`, `model.dealbrain.ts:167`). `count(pk)` is an atomic measure over the identity column.

**Measure / grade EXPRESSION = `agg( f(col₁, col₂, …) )` — MULTI-COLUMN but ROW-LEVEL.** E.g. `SUM(price * qty)`, `SUM(revenue − cost)`. The arithmetic happens **per row, before one aggregation** — still **one pass**, hence still a *measure* (below the aggregation boundary), not a metric. This is **NOT YET supported**: `on` is single-column today (`measure-catalog.ts:18-19`, `types.ts:84`).

**Metric = POST-AGGREGATE composition** over already-collapsed legs:
- **ratio** = `agg(x) / agg(y)`. **HAVE** — the `CompositeColumn{kind:'ratio'}` outer-SELECT arithmetic over two atomic legs (`types.ts:99-108`, `measure-catalog.ts:31-39`).
- **derived** = arithmetic / expression over measures and metrics, **including subtraction** (`revenue − cost`, weighted blends). **THE GAP** — no `CompositeColumn` kind for it yet.
- **cumulative** = a measure accumulated over a time window. **HALF** — the catalog *type* can hold a `CumulativeMeasureDef` (`measure-catalog.ts:41-55`), but `aggregate()` **refuses** it and routes the caller to `query({ window })` — the throw lives in `normalizeAggregate` (`src/internal/analytics/normalize.ts:70-74`, the `CUMULATIVE_IS_WINDOW` message), and the `agg() OVER (PARTITION BY …)` path it points at already ships.

> Naming note: we keep the prose shorthand of three rungs (atomic · expression · metric) for the three concrete `def.kind`s, but the **axis is binary** (measure vs metric). Atomic and expression are nested grades of the measure layer, not a third independent tier — every combination is either single-pass (measure) or multi-pass (metric).

**TIER is not ADDITIVITY.** The grade/layer above is a *structural* property (how many aggregation passes); **additivity** is an orthogonal *semantic* property the engine already tracks separately (the `Additivity` union, `types.ts:15`). `AVG`/`MIN`/`MAX` are perfectly legal grade-ATOMIC measures (single-pass) yet **non-additive** — they cannot be re-aggregated across grain the way `SUM`/`COUNT` legs can (`AVG` of subgroup `AVG`s ≠ global `AVG`). So "atomic measure" must NOT be read as "additive measure". This constrains using a non-additive leg in a derived metric: it is sound at its **own** grain but cannot be rolled up a grain, which keeps D2's per-source-CTE pre-aggregation honest for those legs.

### 2. The decision criterion — the operative rule

> **A combination is a MEASURE iff it can be computed as ONE aggregation pass** — there exists a row-level expression `f(col₁…colₙ)` and a single agg `g` such that the quantity is `g( f(col₁…colₙ) )`. **Otherwise it is a METRIC** — it requires arithmetic over **≥2 separately-aggregated legs** that no single pass produces.

This is single-pass *computability*, and it is the **whole** criterion. Examples:

- `SUM(price · qty)` is a **measure**: compute `price · qty` per row, one `SUM`. (Grade EXPRESSION.)
- `SUM(revenue − cost)` is a **measure**: compute `revenue − cost` per row, one `SUM`. (Grade EXPRESSION.)
- `agg(x) / agg(y)` (a ratio) is a **metric**: no single agg over a row-level expression yields it — you must aggregate `x` and `y` separately, then divide.

**Distribution/linearity is a SEPARATE fact — do NOT conflate it with the measure test.** Single-pass computability (`∃ f,g. quantity = g(f(cols))`) is *not* the same property as distribution (`g(f(a,b)) = f(g(a),g(b))`). The canonical Tier-EXPRESSION measure `SUM(price · qty)` proves they differ: it is single-pass (so a measure), yet `×` does **not** distribute through `SUM` (`SUM(price·qty) ≠ SUM(price)·SUM(qty)`). Distribution answers a *different* question: **when does an additive combination have BOTH a measure-form and a numerically-equal metric-form**, so the two are interchangeable (and equally fan-safe)? That is the subtraction case:

- `SUM(a − b) ≡ SUM(a) − SUM(b)` — `SUM` distributes through `±`, so the expression measure and the derived metric coincide numerically.
- `AVG(a − b) ≡ AVG(a) − AVG(b)` — likewise. `AVG` is **linear over a fixed row set**: `AVG(a−b) = SUM(a−b)/N = (SUM(a)−SUM(b))/N = AVG(a)−AVG(b)`, since `N` (the row count) is identical for `a`, `b`, and `a−b`.
- `MAX(a) − MAX(b)` is **NOT** `MAX(a − b)` — `MAX` is not linear. So a `−` over two `MAX`es has only a metric form.

The aggs that **distribute through `+`, `−`, and scalar `·`** (over a fixed row set) are **`SUM`, `COUNT`, and `AVG`**. `SUM` is the one that aggregates additive expression *values*; `COUNT` (≡ `SUM(1)`) and `AVG` are linear over row-sets but `COUNT` counts non-null presence and carries no expression magnitudes — a row-level additive expression therefore collapses into `SUM`. The **non-linear** aggs are **`MIN`, `MAX`, `COUNT_DISTINCT`** (and future `median`/`percentile`): any `+`/`−` *across* two of them has no measure form and must be a post-aggregate metric. Crucially, **none of `SUM`/`AVG` distribute through `×` or `÷` of two columns** — which is exactly why a ratio is always a metric and `price·qty` is still a single-pass measure (not a distribution identity). This matches how MetricFlow draws the boundary — a measure aggregates a row-level `expr` once, whereas ratio/derived combine already-aggregated values (see §MetricFlow).

### 3. MetricFlow mapping

dbt MetricFlow draws the same boundary; we map onto it (not adopt its YAML):

| MetricFlow | our model | status |
|---|---|---|
| **measure** = `agg` over a single column ([build/measures](https://docs.getdbt.com/docs/build/measures)) | grade **atomic** (measure layer) | **HAVE** |
| **measure** with multi-column row-level `expr` (any valid SQL, e.g. a `CASE WHEN` aggregated `sum` — [build/measures](https://docs.getdbt.com/docs/build/measures)) | grade **expression** (measure layer) | **GAP** |
| **simple metric** — wraps one measure to make it queryable ([build/metrics-overview](https://docs.getdbt.com/docs/build/metrics-overview)) | atomic measure, **queried directly by `{ref}`** (we don't wrap — see D5) | **HAVE** (different exposure) |
| **ratio metric** — `numerator / denominator`, each aggregated separately then divided, post-aggregation ([build/ratio](https://docs.getdbt.com/docs/build/ratio)) | **metric — ratio** (`CompositeColumn{kind:'ratio'}`) | **HAVE** |
| **derived metric** — expression over OTHER metrics, e.g. `gross_profit = revenue − cost`; `offset_window` for PoP ([build/derived](https://docs.getdbt.com/docs/build/derived)) | **metric — derived** | **GAP** |
| **cumulative metric** — a measure accumulated over a time window ([build/cumulative](https://docs.getdbt.com/docs/build/cumulative)) | **metric — cumulative** (type-enumerable, routed to `query({window})`) | **HALF** |
| **conversion metric** — base event → conversion event for an entity in a window ([build/metrics-overview](https://docs.getdbt.com/docs/build/metrics-overview)) | not modeled | **OUT OF SCOPE** |

MetricFlow's full agg list is `sum, min, max, average, median, count_distinct, percentile, sum_boolean` plus `count` as a first-class agg type (whose count-rows idiom is `agg: count, expr: 1`) ([build/measures](https://docs.getdbt.com/docs/build/measures)) — a superset of our `count | count_distinct | sum | avg | min | max` (`types.ts:14`); `median`/`percentile`/`sum_boolean` are future agg additions, orthogonal to this layering. Note MetricFlow queries **metrics + dimensions, never measures directly** — a measure becomes queryable only once you author a metric (typically a simple metric) for it. We deliberately diverge (D5).

### Numbered decisions

**D1 — Introduce the Measure-vs-Metric LAYER as a first-class concept; ONE catalog namespace, each entry TAGGED with its layer.** Do **not** fork the catalog. `MeasureCatalog` stays one `name → def` map (`measure-catalog.ts:58-61`); we add a `layer: 'measure' | 'metric'` discriminator derived from the def kind (`atomic` → measure; `ratio`/`derived`/`cumulative` → metric). Ratio and cumulative move **conceptually** under Metric — the code comments already call them "metric" (`measure-catalog.ts:31,41`), so this names what the implementation already believes. **Proposed surfacing:** `describe()` would expose the layer so the agent and the workbench can group by it — note that **today** the live discovery surface advertises **atomic only**: `describeMeasures` skips every non-atomic def (`src/query.application-service.ts:316-318` — *"Only atomic measures are entity-sourced; ratios/cumulatives compose them (advertised later)"*), so neither ratio nor cumulative is surfaced yet. Advertising the metric layer is part of this work, not current behavior.

**D2 — Add a `derived` composite kind = an expression over measure/metric refs.** Generalize the ratio's existing outer-SELECT arithmetic (`CompositeColumn`, `types.ts:99-108`) from a hard-coded `numerator/denominator` divide to a small expression over leg aliases. This is what covers **subtractive and weighted** metrics (`revenue − cost`, `0.7·a + 0.3·b`). **Fan-safe by construction** — like `ratio`, it operates on **already-collapsed** legs in the final projection, never a fan-inducing join, so it adds no fan-out (`types.ts:94-98`). Each leg pre-aggregates **within its own source grain** — its own per-source CTE when legs span entities, otherwise the same `GROUP BY` with one agg column per leg (the `needsCte`/`rootJoinWouldFan` path, `types.ts:127-130`) — and the metric is outer-SELECT arithmetic over the collapsed values.

**D3 — TACTICAL, DO NOW (no engine change): fix the workbench agg picker + UI grouping.** Add `count` + `count_distinct` to the **field-aggregate** agg picker (currently only `sum`/`avg`/`min`/`max`, `scripts/qs-showcase/index.html:582`), and **fold `count(id)` into it as a "count over entity" preset** rather than its own top-level `kind` (it is just `count` over the `primaryKey`, `catalog.ts:89-91`). Group `ratio` (and future `derived`) under a **"Metric"** header in the define form, separated from the measure aggs. Pure UI — the engine already supports `count`/`count_distinct` (`types.ts:14`).

**D4 — Expression (multi-column, row-level) measures = generalize `AtomicMeasureDef.on` from a column to a row-level expression.** The measure layer's EXPRESSION grade, NOT part of the metric layer (it is below the aggregation boundary). **Invariant-1 tension (builder-only, NO raw SQL):** an expression measure must compile from **column OBJECTS + bound params**, never a caller-supplied SQL string — the same discipline the rest of the engine holds (`` sql`…` `` over column objects only). The design is a tiny row-level expression AST (`col`, `literal`, `+ − × ÷`) that lowers to Drizzle column expressions — **not** a passthrough `expr` field. This is the hardest grade and is sequenced last.

**D5 — Keep measures DIRECTLY QUERYABLE for the agent now; record MetricFlow's wrap-everything end-state as the deferred NORTH STAR.** In MetricFlow a measure is queryable only by defining a **simple metric** that wraps it (one measure per simple metric; in the latest dbt YAML the wrapped measure is typically defined *inline* in the simple metric, not as a separate top-level object) — there is no automatic exposure, so a uniform query surface means authoring a simple metric for **each** measure. The end-state where **everything callable by `{ref}` is a metric** is cleaner long-term and **Dug endorses the direction** — but for an agent **today** an extra wrapper layer is friction with no payoff, so we **keep atomic measures directly queryable** (`{ref:'Amount.sum'}`) and defer the uniform "a simple metric per measure" exposure to a later wave.

**D6 — DimensionDefs slug-refs are NOT needed until COMPUTED dimensions exist.** A raw dimension is **already addressed by its field key** — there is nothing to name. Slug-refs earn their keep only for things you *can't* spell with a field key (computed/derived dimensions, none yet). Separately: the **unified `FieldDef` exposure layer** (one `role`-tagged field list = `measureSpecs ∪ dimensionSpecs`) is a **different concern** from this `{ref}` naming layer — it is about *what fields exist and their roles*, not *what named handles compose them*. Keep them decoupled; neither blocks the other.

## Sequencing — strangler, NOT big-bang

1. **Step 0 (free, do NOW, isolated)** — D3's UI fix: add `count`/`count_distinct` to the field-agg picker, fold `count(id)` into a "count over entity" preset, regroup `ratio` under a "Metric" header. No engine change; ships independently of everything below.
2. **Tag the layer (D1)** — add the `layer` discriminator to `MeasureDef` + surface it in `describe()` (extending `describeMeasures`, today atomic-only, to advertise the metric layer). Mechanical; no behavior change to existing atomic queries.
3. **Add `derived` (D2)** — generalize `CompositeColumn` to a leg-expression composite; register + validate like `ratio`. Unlocks subtractive/weighted metrics. This is the high-value gap.
4. **Expression measures (D4)** — generalize `on` to a row-level column-object expression AST (the EXPRESSION grade). Hardest; gated on invariant #1.
5. **A-simple-metric-per-measure (D5, north star)** — only once 1–4 are stable: expose every atomic measure *also* via a simple metric so the `{ref}` surface is uniform. Deferred — Dug chose to keep measures directly queryable today.

## Invariants — carried through (each survives)

- **#1 builder-only, NO raw SQL** — D2's `derived` composite is outer-SELECT arithmetic over engine-generated leg aliases (no caller SQL). D4's expression measure is the live risk and is **explicitly constrained**: a column-object + bound-param expression AST, never a caller string — same rule as `similarityExpr`. **SURVIVES (D4 gated on it).**
- **#2 grain-relative fan-safety** — metrics add **no fan**: each leg pre-aggregates within its source grain (its own per-source CTE when legs span entities; otherwise the same `GROUP BY` — `types.ts:94-98,127-130`), and the metric is outer-SELECT arithmetic over the collapsed values. A `derived` metric is the same shape with more legs / a richer operator. The grain oracle (`grain.ts`) and doctor are unchanged. **SURVIVES.**
- **#3 scope fail-closed, per-source** — untouched: a metric composes already-scoped, already-collapsed legs; each leg's CTE carries its own per-source scope exactly as today. **SURVIVES.**
- **#4 ONE expression language** — a metric's leg refs and a measure's `where` (`types.ts:89-90`) consume the existing `Predicate`. D4's row-level *arithmetic* AST is a value-expression, NOT a second *filter* dialect — the `Predicate` remains the only boolean language. **SURVIVES.**
- **#5 conformed-dimension rule (ADR-0024)** — a metric's group keys still resolve through the to-one (`belongs_to` LEFT JOIN) / `EXISTS` semijoin rule; a metric adds no new group grain (it composes legs already collapsed to the group key). **SURVIVES.**
- **#6 catalog by code, instances by data** — atomic measures stay derived from `role`-tagged FieldMeta (`measuresFromRegistry`, `measure-catalog.ts:138-164`); slugs (`measureDefs`) and future `derived` defs are host data merged onto that floor. **SURVIVES.**
- **fail-loud** — already enforced and extended by the layering: a ratio leg that is not atomic is **rejected at registration** (`validateRatioDef`, `measure-catalog.ts:120-124`); a slug colliding with an auto-derived key is **refused** (`model.dealbrain.ts:275-279`); a non-additive field named as summable is refused (`validateMeasureDef`, `measure-catalog.ts:84-103`); a cumulative ref handed to `aggregate()` is refused with a pointer to `query({window})` (`normalize.ts:70-74`). `derived` inherits the same registration-time validation. **SURVIVES + extended.**

## Consequences

- The agent-facing vocabulary becomes **honest about levels**: `count` stops masquerading as a peer of `ratio`; the workbench teaches "pick an aggregation" (measure) vs "compose a metric" (post-aggregate) as two distinct moves.
- **D2 is the genuine capability unlock** — subtractive/weighted metrics (`gross_profit`, blended scores) become expressible without raw SQL, fan-safe for free.
- Interim asymmetry until Step 4: a multi-column combination is expressible as a *metric* (post-aggregate, via `derived`) but **not** yet as a row-level *measure* (the EXPRESSION grade) — so `SUM(a) − SUM(b)` works before `SUM(a − b)` does. For the **linear** aggs (`SUM`, `COUNT`, `AVG`) the two are numerically identical (§2), so the gap is ergonomic, not correctness; the doctor still refuses any non-linear misuse (`−` across two `MIN`/`MAX`/`COUNT_DISTINCT`).
- D5 means we **diverge from MetricFlow's "query metrics, not measures"** posture for now — a deliberate, reversible call (the north star re-converges).
- D6 keeps two layers from being conflated prematurely: the `{ref}` naming layer and the `FieldDef` exposure layer stay independent, so neither blocks the other's wave.

### Alternatives considered

- **REJECT — a flat agg dropdown `[Count, Sum, Avg, Min, Max, Ratio]`.** This is the status-quo `kind` dropdown's sin (`scripts/qs-showcase/index.html:535`) taken further: it puts the **aggregation axis** (count/sum/avg…) and the **layer axis** (measure vs ratio/derived metric) on one list. They are orthogonal — a ratio is not "another agg" — and flattening them is exactly the conceptual error this ADR names. Rejected.
- **REJECT FOR NOW — gating measures behind metrics, MetricFlow-style** (every queryable thing is a metric; a simple metric wraps one measure). Cleaner end-state and the recorded north star (D5), but **worse for an agent today**: an extra wrapper indirection with no current payoff. Deferred to Step 5, not adopted now.

---

## Amendment 1 — D1–D4 + to-one expression cols SHIPPED (2026-06-29, Dug)

The strangler sequence (§Sequencing) is **complete through D4**, all eval-gated and merged to `main`:

- **D1** (`08e7c8f`) — `layer` tag on `MeasureCatalogEntry` + `describeMetrics()`.
- **D2** (`6304b71`) — the `derived` composite metric (arithmetic over atomic legs; `gross_profit = revenue − cost`, weighted blends). Eval `derived-metric.eval.spec.ts`.
- **D3** (`fc943d6`) — workbench granular `count`/`count_distinct` aggs + Measure/Metric optgroups.
- **D4 — expression measures** (PR #27, `8db92a8` + `c2b25a1`) — `AtomicMeasureDef.on` generalized from a single column to a **row-level `RowExpr` AST** (`{col}|{lit}|{op,left,right}`, closed 4-op), evaluated per row then aggregated once: `agg(f(col₁,col₂,…))`. Headline `weighted_pipeline = SUM(Amount·Probability)` — single-pass, hence a *measure*, never a metric. Multi-EAV leaves get distinct 1:1 join aliases (`fv_<as>_<i>`); the doctor bypasses its `SUM`-on-non-additive refusal for the expression grade. Eval `expression-measure.eval.spec.ts`.
- **D4 follow-up — to-one expression cols** (PR #29, `aaa4e12`) — a `{col}` leaf may be an explicit dotted `target.column` reached via a single `belongs_to` (to-one) chain, composing the existing scope-folded `lowerToOne`. A has_many / diamond / non-numeric / unregistered reach is rejected fail-loud at model load.

**Two row-level semantic decisions made during the build (the ones §2's distribution discussion implied but did not pin):**

1. **Missing operand → 0 (the arithmetic identity), never a dropped row.** Each `{col}` leaf compiles to `coalesce(col, 0)`. Rationale: `profit = sales_price − item_cost` over a deal with no recorded cost must yield `sales_price`, not vanish from the total (a NULL operand makes the per-row expression NULL, and `SUM` silently skips it). This **dissolves an intersection-NULL subtlety** the first cut carried: with coalesce, the expression form coincides with the post-aggregate derived form over **all** rows (`SUM(a−b) ≡ SUM(a)−SUM(b)`), exactly as §2 claims, rather than only over the co-present subset. A host that genuinely wants "exclude rows missing X" uses a measure-level `where` on X.

2. **Additivity is HOST-DECLARED for an expression measure; the doctor bypasses its per-field `SUM`-on-non-additive refusal for this grade only.** A row-level product of an additive amount × a non-additive ratio (`SUM(Amount·Probability)`, `Probability` is `additivity:'non'`) is itself additively summable — there is no single field whose additivity governs the expression. A *string* atomic `SUM` on a non-additive field is still refused (no regression). Validation instead checks each leaf resolves to a registered numeric field.

**Grain note (to-one cols):** summing a parent attribute at the child grain counts it once per child — defined semantics, **not** a fan (the `belongs_to` LEFT JOIN adds zero rows beyond the child base grain). Source the measure at the parent for parent-grain weighting. Pinned by `expression-measure.eval.spec.ts` D4-8 (obs-grain total ≠ opp-grain total).

**Still deferred:** D5 (measures-also-queryable-as-simple-metrics — the MetricFlow north star), the cumulative/window rung (routed to `select({ window })`).

---

*Cross-ref: [ADR-0024 — conformed dimensions](./ADR-0024-conformed-dimensions.md) (the named-measure catalog derived from `role`-tagged FieldMeta that the atomic grade reuses; the conformed-dimension rule a metric's group keys still obey — invariant #5). [ADR-0028 — engine unification](./ADR-0028-engine-unification-and-query-backend.md) (the `Aggregate` shape + `QueryPlan` IR the `derived`/expression grades compile through). Aligns with dbt MetricFlow's measure/metric split ([build/measures](https://docs.getdbt.com/docs/build/measures), [build/metrics-overview](https://docs.getdbt.com/docs/build/metrics-overview), [build/ratio](https://docs.getdbt.com/docs/build/ratio), [build/derived](https://docs.getdbt.com/docs/build/derived), [build/cumulative](https://docs.getdbt.com/docs/build/cumulative)).*