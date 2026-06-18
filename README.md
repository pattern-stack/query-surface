# @pattern-stack/query-surface

The agent-aware semantic query + aggregation surface — one composition point
(`QueryApplicationService`) exposing five primitives over a host schema:

- `describe(entity?)` — the typed field catalog (native ⊕ EAV)
- `query(entity, …)` — find IDs (+ preview, + `window` annotations), **grain preserved**
- `fetch(entity, ids, …)` — hydrate IDs into rows
- `aggregate(entity, q, …)` — **collapse** to grouped rows with measures, **grain-safe**
- `compare(entity, …)` — the same aggregate across N labeled variants, aligned + derived

## Canonical lineage

This is the **canonical** home for the engine that previously drifted across three
copies (`dealbrain/packages/query-surface`, `dugshub/query-surface-poc`,
`swe-brain/packages/query-surface`). It is seeded from the `swe-brain` engine — the
superset (retrieval + the grain-safe analytics stage) — at `main@a8500bf`. Both
products converge here; fixes land **only** in this repo and consumers bump.

## Architecture (hexagonal)

```
src/
  index.ts · query.application-service.ts   ← public API + composition root
  internal/      the hexagon interior — dialect-free, persistence-free
  adapters/      driven adapters (Drizzle today; Snowflake/BigQuery future) + reference fixtures
  presentation/  driving adapters (Nest today; MCP/CLI/tRPC future, by subpath export)
```

Driving adapters grow by **subpath export**; driven adapters grow by **folder**. The
interior speaks a dialect-neutral plan; each driven adapter lowers it. The eval/
characterization suite is the driven adapter's contract test (DB-gated on `DBURL`).

## Develop

```bash
bun install
bun run check:type    # tsc --noEmit
bun test              # DB-backed eval specs skip without DBURL
DBURL=postgres://… bun test   # run the number-proving evals against a live host
```
