# Changelog

All notable changes to `@pattern-stack/query-surface`. Format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] — 2026-09-17

Drizzle 1.0, a `has_one` relationship kind, and a publishable package (#40).

### Breaking
- **Peer `drizzle-orm` is now `^1.0.0-rc.4`** (was `^0.45.2`; dev pin `1.0.0-rc.4`). Drizzle 1.0
  removed the v1 `relations()` API; introspection now walks **`defineRelations()`** output
  (relational queries v2) — no v1 import remains.
  - `registerSchema(relations, opts)` / `buildRegistrationsFromSchema(relations, opts)` take the
    `defineRelations(schema, (r) => …)` result (a `TablesRelationalConfig`), not a schema barrel.
    `registerFromDb(db)` reads `db._.relations` (a db built with `drizzle({ client, relations })`).
  - `EntityRegistration.relations` / `CatalogEntry.relations` are one table's
    `RelationsRecord` (e.g. `rels.accounts.relations`); `CatalogEntry.relations` is now
    **optional** (a table with no relations needs no entry).
  - `qEntity` / `qJunction` column maps are typed `Record<string, AnyPgColumnBuilder>` (1.0
    dropped `PgColumnBuilderBase`).
  - `QuerySurfaceModuleOptions.schema` → **`relations: TablesRelationalConfig`**.
  - `JoinHop` is `{ from, to, kind: 'belongs_to' | 'has_one', fromCol, toCol }` (was
    `{ from, to, fk, toPk }`); `belongsToPaths` is renamed **`toOnePaths`** (the old name stays as
    a deprecated alias).
- Introspection is the path for hosts **without** a declared model. A host that already knows
  its graph (e.g. a code generator emitting from entity YAML) builds an `AggregateModel`
  directly and never introspects.

### Added
- **`has_one` relationship kind** — `RelDescriptor` / `AggRelationship` / `RelationshipInfo`
  are `belongs_to | has_one | has_many`. A `has_one` (FK on the target) is **to-one** for grain
  purposes: its target's dimensions conform at the parent grain (LEFT JOIN `target.fk =
  parent.pk`, composable with `belongs_to` hops), the grain oracle ranks a `has_one` child at
  its parent's grain, and `describe` advertises its dims as conformed. Before this a declared
  model had to widen it to `has_many`, which made the oracle refuse groupings it could allow.
  Retrieval dotted paths resolve it as a LEFT JOIN (not `EXISTS`); `fetch({ expand })` attaches
  it as a single object (or `null`), and **refuses** (naming the relation and the missing
  `UNIQUE`) when more than one child matches a parent rather than attaching an arbitrary row.
  Introspection classifies `r.one.T({ from: src.pk, to: T.fk })` as `has_one`, and a
  shared-PK 1:1 (`r.one.T({ from: src.pk, to: T.pk })`) as `has_one` in **both** directions
  (so neither side adds a grain rank). Primary keys are read from the tables' PK metadata
  (column `.primaryKey()` or table `primaryKey({ columns })`), not the column name; only a
  table with no declared PK falls back to its `id` column.
- **`tenantScope({ getTenantId, column })`** — a `ScopeResolver` that reads the tenant at query
  time, so an `AsyncLocalStorage` request context (the one a host's repositories scope by)
  seeds this surface from the same boundary. Fail-closed: no tenant → the read is refused.
- Root exports `AggEntity`, `AggRelationship`, `DerivedExpr`, `DerivedMeasureDef` (the shapes a
  code generator emits into a declared `AggregateModel` / `MeasureCatalog`).
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
- Doctor `MISSING_INVERSE` now names the right inverse: `r.one.X({ from, to })` when the
  belongs_to's fk is unique (a has_one back), else `r.many.X()`.
- Doctor finding **`UNSUPPORTED_RELATION`** — a `.through()` many-to-many, composite-column,
  view-target, or non-PK-keyed relation, which the registry skips.

### Fixed
- Column typing under Drizzle 1.0's compound `column.dataType` (`'string uuid'`, `'object
  date'`, `'object json'`): a `columnDataType()` normalizer keeps date-only whole-day
  comparisons, JSON-path (`->>`) filters and searchable-column derivation working.
- `columnTypeFromPg` maps 1.0's `PgNumericNumber` / `PgNumericBigInt` (→ `number`) and
  `PgDateString` (the default `date()` mode, → `date`).

### Packaging
- No longer `private`. Publishes `dist/` only: bundled ESM via `bun build --splitting` (one
  shared chunk, so the root and `./nest` entries share one module-level registry) + `.d.ts`
  via `tsc -p tsconfig.build.json`, relative specifiers rewritten to `.js` so both `bundler`
  and `nodenext` consumers resolve them. Every runtime — Node and Bun — resolves the same
  `dist/` graph: there is deliberately **no `bun` → `src` condition** (Bun compiles TS in
  `node_modules` with the *consumer's* tsconfig, so the Nest decorators broke for a consumer
  without legacy decorators, and mixing `src` + `dist` would duplicate the registry). `prepack`
  builds.
- Optional peers: `@nestjs/common`, `@nestjs/swagger`, `rxjs`, `zod` (`./nest`),
  `@modelcontextprotocol/sdk` (`./mcp`, previously a hard dependency), and `typescript`.
- `scripts/check-pack.sh` — packs, installs the tarball into a fresh project, type-checks
  (`nodenext` + `bundler`) and imports root + `./nest` under both Node and Bun.

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
- Bun 1.3 · TypeScript 5 strict · Drizzle ORM (pinned `0.45.2` at this release) · NestJS (presentation) ·
  Postgres 16 · Biome. The `*.eval.spec.ts` suites are the gate (DB-gated on `DBURL`, ground
  truth computed independently of the path under test).

[0.2.0]: https://github.com/pattern-stack/query-surface/releases/tag/v0.2.0
[0.1.0]: https://github.com/pattern-stack/query-surface/releases/tag/v0.1.0
