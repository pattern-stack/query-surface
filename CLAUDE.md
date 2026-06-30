# @pattern-stack/query-surface

The **agent-aware query + aggregation surface** — one composition point
(`QueryApplicationService`) exposing a few primitives over a host-supplied domain model,
projected to REST / MCP / agents. This is the **canonical home**: it ended the 3-copy fork
(query-surface was vendored in `swe-brain/packages/query-surface`, `query-surface-poc`, and
dealbrain copies). **All query-surface work happens HERE now**, not in those copies.

**Always read first:**
1. [`.ai-docs/handoff.md`](.ai-docs/handoff.md) — current state + the actionable next phase
   (the run/falsify commands, what's DONE, what's next).
2. [`.ai-docs/decisions/ADR-0024-conformed-dimensions.md`](.ai-docs/decisions/ADR-0024-conformed-dimensions.md)
   — the conformed-dimension model (shipped) + the ratified Wave-2 §Direction (Amendment 1).
3. [`.ai-docs/decisions/ADR-0028-engine-unification-and-query-backend.md`](.ai-docs/decisions/ADR-0028-engine-unification-and-query-backend.md)
   — the **engine reorg** design (the *codebase* hexagonal reorg already shipped; this is the
   remaining ENGINE work): unify the two forked compilers onto one `grain:'row'|'group'` pipeline +
   extract the `QueryPlan` IR + `QueryBackend` port. **Designed, 0% built** — strangler sequence inside.

## The primitives
- `describe(entity?)` — typed field catalog (native ⊕ EAV) + the graph-derived **conformed
  dimension set** per metric.
- `select(entity, …)` — find IDs (+ preview, + `window` annotations, + semantic `relevant`/`rank_by`), **grain preserved**.
- `fetch(entity, ids, …)` — hydrate IDs into rows.
- `measure(entity, q, …)` — **collapse** to grouped rows with measures, **grain-safe** (the verb formerly named `aggregate`; rename locked ADR-0024 Amendment 3).
- `compare(entity, …)` — N-variant aligned comparison (PoP / variant-vs-variant).

## Architecture — hexagonal (driving / driven)
- `src/internal/` — the **dialect-free interior** (no Drizzle): `language/` (Predicate AST,
  normalizers, error contract), `analytics/` (the grain oracle, the doctor, **`join-plan.ts`** =
  the conformed-dimension resolver, measure-catalog, normalize, compare), `retrieval/` (snippets).
- `src/adapters/` — **driven** adapters: `drizzle/` (`compile/` + `execute/` — the ONLY SQL-bound
  code), `reference/` (the dealbrain eval fixture: `model.dealbrain` + `schema.dealbrain`).
- `src/presentation/` — **driving** adapters: `nest/` (the NestJS module/service/REST). Future
  driving adapters (`/mcp`, `/cli`) grow by subpath export; driven adapters grow by folder.
- `src/characterization/` — the **char net**: a DB-backed contract test that pins backend behavior
  (the future `QueryBackend` falsifier).
- Composition root: `src/index.ts` + `src/query.application-service.ts`.
- **Direction:** extract a dialect-neutral IR (`QueryPlan`) + a `QueryBackend` driven port so a
  second backend (Snowflake/BigQuery) is a new adapter folder, not an engine rewrite. The interior
  is ~80% dialect-free already; retrieval's compiler isn't cleaved yet. See `.ai-docs/handoff.md`.

## Hard rules (invariants — reject any change that violates them)
1. **Builder-only, NO raw SQL.** Drizzle query builder; `` sql`…` `` ONLY over column OBJECTS +
   bound params; `sql.raw` ONLY for fixed keywords (`=`, `asc/desc`, `in`) — never a caller string.
2. **Grain-relative fan-safety.** Each measure pre-aggregates in its OWN source-entity CTE, joined
   on the group key. Fan-safety is group-grain→measure-entity relative, never query-root relative.
   Oracle: `internal/analytics/grain.ts`; refusals: `doctor.ts`. A to-one (`belongs_to`) / EAV join
   is 1:1 and allowed; a fan-inducing join is not.
3. **Scope is FAIL-CLOSED, per-source, pre-aggregation** — and folded through EVERY traversed
   entity (the to-one join `ON` + the semijoin `EXISTS` body). A resolver that returns `undefined`
   for a queried/traversed entity is a coverage gap → REFUSE (never emit it unscoped).
4. **One expression language** — the `Predicate` (`FilterExpression`). Filters / where / having and
   the conformed-dimension resolver all consume it. No second filter dialect.
5. **Conformed-dimension rule (ADR-0024).** A dimension on B is legal at A's grain iff every A→B
   hop is to-one. group_by/filter on a to-one dim → `belongs_to` LEFT JOIN; a cross-grain boolean
   filter → `EXISTS` semijoin (NEVER a fan-out join); a to-many group dim → reject; a join diamond
   → reject (ambiguous). **A global `filter` must conform on EVERY measure source, else REJECT** —
   no silent per-source no-op (the Q6 landmine: it fabricates cross-measure comparisons).
   Source-local intent uses a **measure-level `where`**.
6. **Catalog by code, instances by data.** Capabilities (measures/dims) register in code; the
   named-measure catalog is derived from the `role`-tagged FieldMeta, not hand-listed.
7. **The model is host-supplied** (`AggregateModel`); the package hard-codes no schema.
   `adapters/reference/model.dealbrain.ts` is the reference instance + eval fixture.

## The eval IS the gate
Behavior is pinned by the `*.eval.spec.ts` + `*.char.eval.spec.ts` suites; DB-backed specs gate on
`DBURL` (skip cleanly without it). The char net is the regression net that let the engine be swapped
without behavior drift.

```bash
DBURL=postgres://postgres:password@localhost:54321/dealbrain bun test   # 268 pass / 0 fail
bun test                          # DB-gated specs skip cleanly (still green)
bunx tsc --noEmit                 # types
bunx @biomejs/biome check src     # lint + format (CI gates this — run before pushing)
```
The dealbrain dev DB (`:54321`) is **dealbrain's, not this repo's** — bring it up there if down. It's
the reference fixture: `Opp→Account` is to-one, `Account→Opp` to-many, `observations` carry real
1536-dim embeddings.

## Stack
Bun 1.3 + TypeScript 5 (strict) + Drizzle + NestJS (presentation only) + Postgres 16. Biome.
Package: `@pattern-stack/query-surface`.

## What this is *not*
- Not coupled to a single backend — the IR / `QueryBackend` direction keeps the interior
  dialect-neutral; Drizzle is adapter #1.
- Not the swe-brain monorepo's copy — this is the canonical source of truth.
- Not a place for raw SQL (invariant 1) or a second filter dialect (invariant 4).
