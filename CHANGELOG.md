# Changelog

All notable changes to `@pattern-stack/query-surface`. Format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **`rank_by.vector`** (#38): `select()`'s semantic rank takes a caller-supplied query vector
  beside `query` text. Exactly one of `query` | `vector` is required for `method:'semantic'`;
  `lexical` still takes `query` only. A vector skips the host's `embed()` port entirely, so a
  host can rank by a centroid over several sentences, by a vector pinned beside a saved
  definition, or by one from another pipeline. `normalizeRankBy` conforms `embedding` /
  `query_vector` / `queryVector` to `vector`; `assertRankInput` (new, service-side) rejects an
  empty / non-numeric / non-finite vector, `query` + `vector` together, and a vector on a
  lexical rank — each with a clear `rank_by:` message. Before this a `rank_by.vector` key was
  dropped silently and the request ranked by whatever `query` said.
- The MCP `select` tool and the REST `rank_by` DTO document `vector`; the DTO's `query` is now
  optional (the service enforces exactly-one).

## [0.1.0] — 2026-06-29

First tagged release — the canonical home for the governed query + aggregation surface,
consolidated from three drifted copies and matured through the conformed-dimension and
measure/metric waves.

### The surface
- **Five locked primitives** (ADR-0024 Amendment 3): `describe · select · fetch · measure ·
  compare`, over a host-supplied `AggregateModel` (the package hard-codes no schema).
- **`describe` / `describeMeasures` / `describeMetrics`** — the typed field catalog (native ⊕
  EAV) + the graph-derived conformed-dimension set, advertised by layer.
- **Relevance as a predicate leaf** — `select`/`measure` accept `op:'relevant'` (`threshold`
  or `top_k`); the response carries a calibration-grade **citation** (cohort definition,
  cutoff, exemplars, decision boundary). Cohorts hoist to a statement-level ranked CTE.

### Conformed dimensions (ADR-0024)
- A dimension on B is legal at A's grain iff every A→B hop is to-one; a to-one dim → `belongs_to`
  LEFT JOIN, a cross-grain boolean filter → `EXISTS` semijoin (never a fan-out join), a to-many
  group dim → reject, a join diamond → reject.
- A global `filter` must conform on **every** measure source else REJECT (no silent per-source
  no-op — the Q6 landmine); source-local intent uses a measure-level `where`.
- **Amendment 4:** conformed group dims resolve at **every** measure leg source, not just the
  query root.

### Measure / metric model (ADR-0029) — shipped through D4 + the to-one follow-up
- **Two-layer model:** measure (one aggregation pass) vs metric (post-aggregate arithmetic),
  with measure grades atomic ⊂ expression; criterion = single-pass computability.
- **D1** — `layer` tag on every catalog entry + `describeMetrics()`.
- **D2** — `derived` composite metric: arithmetic over ≥2 atomic legs (`gross_profit = revenue −
  cost`, weighted blends), outer-SELECT over collapsed legs, fan-safe.
- **D3** — workbench: granular `count`/`count_distinct` aggs + Measure/Metric grouping.
- **D4 — expression measures:** `AtomicMeasureDef.on` generalized from a single column to a
  row-level `RowExpr` AST (`agg(f(col₁,col₂,…))`), e.g. `SUM(Amount · Probability)`. Multi-EAV
  leaves get distinct 1:1 join aliases (no fan); operand arithmetic is builder-only (closed
  4-op set via `sql.raw`).
  - **Missing operand → 0** (`coalesce` per leaf): a missing operand is the arithmetic identity,
    not a dropped row, so `SUM(a−b) ≡ SUM(a)−SUM(b)` over all rows.
  - **To-one expression cols:** a `{col}` leaf may be a `belongs_to`-reached `target.column`
    (composing the scope-folded `lowerToOne`); a has_many/diamond/non-numeric reach is rejected
    fail-loud at model load.

### Engine invariants enforced
- Builder-only (no raw SQL); grain-relative fan-safety (per-source pre-agg CTEs); scope
  fail-closed and folded through every traversed entity; one expression language (the
  `Predicate`); catalog-by-code, instances-by-data.

### Architecture
- Hexagonal: a dialect-free interior (`internal/`), driven adapters (`adapters/drizzle`,
  `adapters/reference`), driving adapters (`presentation/nest`). A DB-backed **char net** pins
  backend behavior — the regression net that let the engine be consolidated without drift.

### Tooling
- Bun 1.3 · TypeScript 5 strict · Drizzle ORM (pinned `0.45.2`) · NestJS (presentation) ·
  Postgres 16 · Biome. The `*.eval.spec.ts` suites are the gate (DB-gated on `DBURL`, ground
  truth computed independently of the path under test).

[0.1.0]: https://github.com/pattern-stack/query-surface/releases/tag/v0.1.0
