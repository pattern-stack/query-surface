# ADR-0028 — Engine unification: the QueryPlan IR + the QueryBackend driven port

**Status:** proposed — grounded against live code 2026-06-21. The DESTINATION (put `query()`/`fetch()` on the planner the aggregate engine already uses; formalize the proto-IR into one dialect-neutral `QueryPlan`; extract a `QueryBackend` driven port so a second SQL backend is a new folder, not an engine rewrite) is settled in direction. The **sequencing** (strangler, not big-bang — `compiler.ts` retirement is the LAST act, gated), the **scope-resolution shape** (a per-source resolved map in the interior), and the **addressing-grammar reconciliation** (Gate 0) are settled here. Items in §Open Decisions need Dug's call. · **Scope:** retire the forked retrieval compiler by routing the row-grain verbs onto the same `normalize → plan → lower → execute` pipeline the collapse verbs use, with `grain: 'row' | 'group'` as the single discriminator; cleave the resolved plan into a backend-neutral `QueryPlan`; define `QueryBackend` (`execute` + `explain`). · **Builds on** [ADR-0024](./ADR-0024-conformed-dimensions.md) (the conformed-dimension rule + the crispified relevance leaves the IR reuses verbatim) and [ADR-0025 §2](./ADR-0025-remap-ergonomics.md) (the `DealbrainModel → AggregateModel` rename, folded into this sweep as the prep commit). · **Aligns with** the hexagonal direction stated in CLAUDE.md (extract a dialect-neutral IR + a `QueryBackend` driven port; the interior is already ~80% dialect-free).

---

## Context

There are **two forked compilers with zero cross-imports**, verified:

- **The QUERY engine** — `src/adapters/drizzle/compile/compiler.ts` (1101 lines) + `execute/runners.ts` (`runSearch`/`runFetch`/`runSearchMulti`). Powers `query()`/`fetch()`. It rolls its **own** path/join resolution (`resolvePath`/`resolveFrom` at `compiler.ts:124-183`) and imports only `internal/language` — it never touches the analytics planner.
- **The AGGREGATE engine** — `src/adapters/drizzle/compile/compile-drizzle.ts` (1022 lines) + `execute/run-drizzle.ts`. Powers `aggregate()`/`compare()`. It is **already structured plan→lower**: it consumes `planAggregate` (`grain.ts`), `resolveJoinPlan` (`join-plan.ts`), and `assertAggregateSafe` (`doctor.ts`).

The interior (`src/internal/`) is **already dialect-free** (no real drizzle-orm imports in `grain.ts`/`join-plan.ts`/`types.ts`), and the **proto-IR already exists for the aggregate path**: `JoinPlan` (a names-only `local|to-one|semijoin|reject` union, `join-plan.ts:34-38`), `AggregatePlan` (`types.ts:125`), and `Aggregate`/`Measure`/`CompositeColumn`/`ScopeFor`/`TENANT_GLOBAL` (`types.ts`). So this is **interface extraction over a path that is already half-cleaved**, not a green-field engine.

Three structural costs of the fork, each verified:

1. **`query()` bypasses the planner.** It re-derives join/EXISTS lowering by hand. A from-scratch maintenance of two lowerings is where behavior silently drifts (wrong result set, not a throw).
2. **`query()` violates invariant #3 (scope) in three places** the aggregate engine does not. `compiler.ts` has **zero** scope awareness (`grep scopeFor|ScopeFor|TENANT_GLOBAL → 0 hits`); scope is folded as a **single root-AND** at the service layer (`query.application-service.ts:206` `scoped()`), so: (a) belongs_to LEFT-JOIN ONs carry no scope; (b) the cross-grain top-k cohort folds no child scope, self-labeled *"best-effort scope"* (`compiler.ts:736-737`); (c) `fetch()` `expand` reads related entities **completely unscoped** (`expand.ts:136,196` are bare `inArray(...)` WHEREs) — a **live cross-tenant read leak**. The aggregate engine folds per-source scope through every traversed ON (`compile-drizzle.ts:299`), EXISTS body (`:330-331`), and topk membership (`:478-479`), fail-closed via `scopeSqlFor`.
3. **Semantic/relevance lowering is implemented 3× and the similarity expression copied 4×.** All four sites emit byte-identical `(1 - (emb <=> [vec]::vector))` sim∈[0,1] (`compiler.ts:712/743/960`, `compile-drizzle.ts:348`, `run-drizzle.ts:147`). The only pgvector-specific tokens are the `<=>` operator and the `::vector` cast; everything around them (cohort CTE, EXISTS semijoin, ROW_NUMBER partition, pk-in membership, NULL-partition drop) is dialect-neutral relational structure.

The forcing function: the package's stated direction is a `QueryPlan` IR + `QueryBackend` port so Snowflake/BigQuery become a new adapter folder. That is unreachable while half the surface bypasses the IR. Unify-first is the prerequisite, not a parallel track.

## Decision (settled)

### 1. One pipeline, one discriminator

All five primitives compile through the **same four stages**, with `grain` as the single seam:

```
normalize        →  plan              →  lower               →  execute
(internal/        (internal/             (adapters/drizzle —    (adapters/drizzle —
 language +         analytics:            the QueryBackend        QueryBackend.execute)
 analytics)        planAggregate +       lowering: JoinPlan→
                   resolveJoinPlan +     LEFT JOIN/EXISTS,
                   resolve scope map +   measure→GROUP BY|OVER,
                   doctor)               semantics→vector SQL,
                                         scope fold)
```

- **`normalize`** (`internal/language` + `internal/analytics/normalize.ts`) — filter-normalize, crispify `relevant → sim_gte|sim_topk` (already dialect-free, `normalize.ts:189`), text-magic expansion, defaults. **Unchanged home**; gains text-magic for the row grain.
- **`plan`** (`internal/analytics`) — `planAggregate` + `resolveJoinPlan` per dotted path + **resolve scope into a per-source map** + `assertAggregateSafe`. Produces a `QueryPlan`. **This is where `query()` joins the aggregate path.**
- **`lower` + `execute`** (`adapters/drizzle`, backend #1) — the merged SQL-bound half, serving BOTH grains.

`query()` is the **degenerate case of `aggregate()` at `grain: 'row'`**: no `GROUP BY`; measures lower to `agg() OVER (PARTITION BY …)` instead of `GROUP BY`; projection is the row PK + preview columns instead of group keys. **Window measures on `query()` already prove this is sound** (`compiler.ts` PARTITION_RN_KEY; `WindowMeasure` at `language/types.ts:128`). The grain oracle already serves both: `planAggregate` (`grain.ts`) collapses `groupGrain` to the root entity when there is no `group_by`, and `needsCte`/`rootJoinWouldFan` still govern the window-partition CTE — **no oracle change needed**.

**The exact rule for how `grain` drives lowering:**

| concern | `grain: 'group'` | `grain: 'row'` |
|---|---|---|
| measure | `agg(...)` under `GROUP BY <keys>` | `agg(...) OVER (PARTITION BY <keys>)` — rows preserved |
| projection | group keys + measure aliases (no entity id) | row PK + preview/explicit columns + additive `_rank`/`_snippet`/window cols |
| pagination | `limit` | `limit` + `offset` + the `has_more`/`total` contract |
| scope | per-source fail-closed (unchanged) | **per-source fail-closed (upgraded — see §3)** |

### 2. The `QueryPlan` IR — shared core + grain-discriminated body

**This is NOT "today's `Aggregate` + a flag."** Verified against `types.ts`: `Aggregate` has zero fields for the entire row-grain surface (no projection, no row PK contract, no `offset`, no ranking, no window-measure mode, no `has_more`/`total`, and its `order_by` keys measure aliases, not arbitrary field paths). The probe enumerated **~14 genuinely new row-grain concerns**, not free relabels. `grain` is therefore a **discriminated-union body selector**, not a boolean over one flat shape.

```ts
// === shared core (8 fields REUSED from Aggregate, types.ts:110-123, verbatim) ===
interface QueryPlanCore {
  entity: string;                              // REUSED — anchor/root
  filter?: Predicate;                          // REUSED — the ONE language (invariant #4)
  composites?: CompositeColumn[];              // REUSED — outer-SELECT ratio/PoP
  having?: Predicate;                          // REUSED — post-agg
  limit?: number;                              // REUSED
  // --- NEW shared additions ---
  offset?: number;                             // NEW — pagination (lang/types.ts page.offset has no IR home today)
  order_by?: { on: string; dir: 'asc'|'desc' }[]; // REUSED+WIDENED — must express arbitrary
                                               //   field-path sorts (incl. belongs_to/EAV) with NULLS-LAST
  joins: JoinPlan[];                           // NEW slot, REUSED TYPE (join-plan.ts:34) — resolved up front
  scope: Record<string, Predicate | typeof TENANT_GLOBAL>; // NEW — RESOLVED per-source map (see §3)
  semantics?: SemanticDescriptor[];            // NEW slot — shape REUSES the crispified leaves (see §4)
}

type QueryPlan =
  | (QueryPlanCore & {
      grain: 'group';
      group_by?: string[];                     // REUSED
      measures: Measure[];                     // REUSED
      projection: { kind: 'group'; keys: string[]; measureAliases: string[] };
    })
  | (QueryPlanCore & {
      grain: 'row';
      pk: string;                              // NEW — the row-identity contract (NO group-grain analog)
      group_by?: string[];                     // partition keys for window measures + per-group top-K
      measures: PlanMeasure[];                 // REUSED+EXTENDED — window mode
      projection: { kind: 'row'; columns: ProjectionCol[]; mode: 'preview'|'explicit'|'full' };
      ranking?: RankSpec;                       // NEW — rank_by (order-rank, distinct from filter relevance)
    });

interface PlanMeasure extends Measure {        // REUSED Measure (types.ts:83) +
  mode: 'collapse' | 'window';                 // NEW — collapse⇒GROUP BY, window⇒agg() OVER(PARTITION BY)
  partition_by?: string[];                     // NEW — only when mode:'window'
}
```

The **two genuinely-dialect-neutral proto-IR pieces are reused verbatim — do NOT redesign them** (the wave-1 lesson: don't abstract from one data point): `JoinPlan` (`join-plan.ts:34-38`, names-only 4-variant union) and the crispified `SimGteLeaf`/`SimTopkLeaf` (`language/types.ts:63-77`).

The **~14 row-grain additions** that must be scoped honestly (NOT free relabels): projection 4 modes (explicit field-path columns incl. belongs_to/EAV; curated catalog-preview; full-row fetch; additive `_rank`/`_snippet`/window output cols) + the row PK contract; `offset` + the `has_more`/`total` mode contract; the `RankSpec` (lexical FTS `ts_rank_cd` + semantic, projecting `_rank`/`_snippet`, with `min_score`) **and** a separate per-group-top-K window (`rank_by.partition_by → ROW_NUMBER` wrap, distinct from in-place window measures); the per-measure `mode:'collapse'|'window'` flag; widened `order_by`; text-magic as a shared pre-compile normalize; and the text-match descriptors surfaced as backend OUTPUT so the service can snippet.

### 3. Scope is resolved to a per-source MAP in the interior (the highest-leverage call)

`QueryPlan.scope: Record<entity, Predicate | TENANT_GLOBAL>` is resolved **inside `internal/` during planning**, NOT passed as a live `ScopeFor` function to the adapter. Rationale: this makes **invariant #3 (fail-closed coverage) a property of the dialect-free PLAN** — checkable by the char net against the IR, identical for every backend. The adapter merely folds `plan.scope[entity]` into each traversed ON / EXISTS body. A traversed/queried entity absent from the map (the resolver returned `undefined`) is a coverage gap → **REFUSE** (the existing `TENANT_GLOBAL` discipline, `types.ts:66-81`).

**This is a behavior CHANGE, stated plainly: unifying `query()` onto the planner is a scope-folding correctness FIX, not a behavior-neutral refactor.** Today `query()` satisfies invariant #3 only for root-local filters; it violates it for (1) to-one-traversed filters (`compiler.ts:188` bare join ON), (2) cross-grain relevance cohorts (`compiler.ts:736-737` "best-effort"), and (3) `fetch()` `expand` (`expand.ts:136,196` fully unscoped). Unification closes (1) and (2) **for free**. Cross-grain `query()` filters touching an uncovered/undeclared traversed source will **newly REFUSE**; a traversed out-of-scope to-one parent will **newly drop rows**. This must be pinned as an intentional invariant-#3 UPGRADE with new char rows BEFORE the cut (§Gate plan), tagged so the net documents the tightening rather than flagging a regression.

(3) `expand` is **a separately-tracked workstream** — it has no plan representation and the planner cleave leaves it untouched. `expandRows` must accept and fold the scope resolver into every belongs_to/has_many batch WHERE, fail-closed, or the unified surface stays half-leaked. **Do NOT let the unify narrative imply expand is covered.**

### 4. Semantics: one descriptor, one backend primitive

Relevance is carried as a structural `SemanticDescriptor[]` on the plan — the already-existing crisp leaf (`normalize.ts crispifyLeaf`) + the resolved cohort `JoinPlan`, unified. Minimal shape (both halves already exist and are dialect-free):

```ts
interface SemanticDescriptor {
  mode: 'threshold' | 'top_k' | 'rank';
  consumption: 'condition' | 'membership' | 'order'; // sim_gte | sim_topk | rank_by order
  embeddingColumn: string;        // resolved emb column (possibly dotted child.col)
  textColumn?: string;            // for citation/snippet
  vector: number[];               // resolved by the service before plan (no second embed)
  threshold?: number; top_k?: number; per?: string;
  cohortPlan: JoinPlan;           // REUSED — the resolved local|to-one|semijoin shape
}
```

The **only pgvector-specific thing the backend owns is ONE primitive — `similarityExpr(embCol, vector): SQL`** (the `(1 - (emb <=> v::vector))`). Hoist the 4 identical copies behind it; Snowflake substitutes `VECTOR_COSINE_SIMILARITY`, BigQuery its `ML.DISTANCE`. Everything around it (cohort CTE, EXISTS semijoin, ROW_NUMBER partition, pk-in membership, NULL-partition drop, `sim >= threshold`, pk-asc tiebreak) stays in the **shared lower**, parameterized by `similarityExpr`.

**Unify the top-k lowering as ONE "ranked cohort" node.** The per-statement-inline (query, `compiler.ts:701`) vs hoisted-`$with`-CTE-per-source (aggregate, `compile-drizzle.ts:388/457`) split is a function of `grain` + measure-source-count, NOT two engines. Adopt the aggregate's hoisted-cohort lowering as canonical; row-grain `query()` is the degenerate single-source instance. **This auto-closes the verified cross-grain best-effort-scope gap** (`compiler.ts:736-745` folds no child scope; the aggregate twin `compile-drizzle.ts:478-480` does) — a behavior-tightening the char net must pin.

The **citation companion** stays a SEPARATE row-grain plan routed through the same `QueryBackend.execute` (a `QueryPlan` with `grain:'row'` over the semantic entity, ordered by `similarityExpr`), **NOT** a bespoke backend method. This deletes the third hand-rolled cohort reimplementation (`run-drizzle.ts buildRelevanceCitation`).

### 5. The `QueryBackend` driven port — `execute` + `explain`, nothing more

```ts
interface QueryBackend {
  execute(plan: QueryPlan): Promise<{
    rows: Record<string, unknown>[];
    row_count: number;
    group_count: number | null;
    total?: number;                 // the pagination mode that produced it
    has_more?: boolean;
    textMatches?: TextMatchDescriptor[]; // surfaced so the service can snippet
    warnings?: string[];
  }>;
  explain(plan: QueryPlan): { sql: string; params: unknown[] };
}
```

`explain` is **free**: `.toSQL() → {sql, params}` already exists on both runners (`runners.ts:185,198,308`; `run-drizzle.ts:97`), gated on `include_sql`. Invariant #1 (builder-only) is preserved because `explain` returns the builder's OWN parameterized text, never a hand-built string.

**Kept ABOVE the port (NOT in `execute(plan)`)** — service-layer post-processors over flat backend rows, so a new backend does NOT reimplement them: relational `expand` (N batched IN sub-plans the service drives — model as an `ExpandSpec`); EAV inline-hydration; snippet building; multi-entity batch (`runSearchMulti` stays an orchestration fan-out of N single-entity plans — the port stays single-plan); and the citation companion (a second row-grain plan). Pushing any of these into `execute(plan)` would bloat the port and is the opposite of "new folder, no engine change."

Resist growing the port beyond `execute` + `explain`. There is exactly ONE second-backend hypothesis; the wave-1 over-abstraction lesson applies.

### 6. EAV: one lowering, two resolution policies (do not unify the policy)

EAV lowering is SQL-isomorphic across both grains (a single-row LEFT JOIN keyed on `entity_id + field_definition_id`, projecting one typed value column). The plan carries a **resolved `EavRef`**, widened to a **discriminated union over shape** — because `AggFieldMeta.eav` (`types.ts:36-39`) models only `typed-columns` and **cannot represent `query()`'s jsonb-value (Shape B) entities**:

```ts
type EavRef =
  | { shape: 'typed-columns'; valueColumn: 'value_number'|'value_text'|'value_date'|'value_boolean'; defId: string; dataType: AggColType }
  | { shape: 'jsonb-value'; defId: string; dataType: AggColType; currentOnly: boolean; validToColumn: string };
```

The backend owns the `field_values` join (the only SQL-bound step), identically for both grains; invariant #2 holds because the join is 1:1 by `UNIQUE(entity_id, field_definition_id)` and fan-safe.

**EAV RESOLUTION (key → `EavRef`) stays a grain/intent-parameterized port ABOVE plan-building** — the two policies are deliberately NOT interchangeable, verified: `query()` is fresh-per-call + `is_visible=true` gated + actor-scoped (`eav/field-map.ts:101` + the FRESH/uncached comment `:66-69`); `aggregate()` is memoized + org-scoped + deliberately UNGATED (`model.dealbrain.ts:196-197` aggregates over `is_visible=false` fields). Collapsing them onto one cache would either **leak hidden fields into `query()`/`describe()` or drop analytics-only fields from `aggregate()`**. Model as an injected `EavResolver` per intent: a GATED/FRESH resolver for query/fetch/describe, an UNGATED/MEMOIZED one for aggregate/compare.

### 7. Fold the `DealbrainModel → AggregateModel` rename (ADR-0025 §2) into the same sweep

Verified half-done: `AggregateModel` already exists as the type; `DealbrainModel` is still referenced in **12 files** (load-bearing in `compile-drizzle.ts:268`; the rest are `reference/` + specs). Finish it as the **first, isolated, mechanical prep commit** — never folded into a behavior-changing step where a real regression would hide inside rename churn. Keep `DealbrainModel` only in `adapters/reference/` as the dealbrain instance.

### 8. Diamond addressing — explicit routes, discoverable, never guessed (Gate 0, RESOLVED 2026-06-21)

A target reachable by >1 to-one (or >1 has_many) path — a **join diamond** — is irreducible: it lives in the host schema (two FK routes), exactly as it would in raw SQL, where "get everything" forces a which-join choice and even *knowing there are two routes* is tribal knowledge. The engine's policy is therefore **surface the choice, never make it silently**:

- **Each leg is separately addressable via the edge grammar** (the relationship-name path): `account.name` = the direct `obs.account_id` leg; `opportunity.account.name` = the via-opportunity leg. The normalizer lowers each named hop into an explicit `JoinPlan.hops` chain (`join-plan.ts:36`), so the resolver follows THAT route — it never auto-discovers-and-picks, and never auto-unions. "All obs connected by *any* route" is a caller-composed `or` of the legs (the one expression language, invariant #4), never an engine default — and it only arises for a genuine distinct-role diamond, not the denormalized case.
- **A bare entity-prefix with no named route stays a REJECT** (`accounts.name` from observations → ambiguous), preserving the conformed-dimension safety for the aggregate `group_by` surface — UNLESS the host declares a **canonical edge** for that destination (invariant #7), which resolves the bare form to the host-intended leg (the denormalized-diamond case, e.g. obs→account, where the direct edge is the broader, correct "this obs's account" roll-up). The engine still never guesses; it follows the declaration.
- **`describe()` makes the routes discoverable** — the agent-aware contract's job, so a route is never tribal knowledge. Today `conformedDimensions` SKIPS a diamond target entirely (`join-plan.ts:210`, the ≠1-path skip), so `describe('observations')` never advertises `account.name` at all. RESOLVED: enumerate **each leg as a distinct dimension** (`account.name` via direct, `opportunity.account.name` via deals), each tagged with its route, and **instruct in the describe payload that the entity can be expanded along that route** (e.g. `expand:['opportunities.observations']`). The choice that is invisible in raw SQL becomes an explicit, discoverable capability — strictly better than SQL, not a regression from it.
- **Falsification:** the live fixture's diamond is symmetric/redundant (verified 2026-06-21: `obs.account_id` agrees with `opportunity.account_id` 29039/29039, 0 disagree; 0 account-level obs today), so leg-divergence is data-impossible on Bean Maxx and the current gate CANNOT falsify edge-pick-vs-reject. Gate 0 requires a **synthetic asymmetric-diamond fixture** (a seeded observation whose direct account ≠ its opportunity's account) + a char spec pinning that each named leg resolves to its own route.

**Deferred (NOT this ADR) — the convenience closure.** A packaged "expand to ALL related of a derived entity" helper (the union/closure over every route) is a domain-opinionated convenience that sits ABOVE the neutral engine. Explicitly deferred: the engine stays route-explicit and opinion-free now; the convenience layer is where a dealbrain-first domain preference may later form. Build the explicit primitive now; package the opinion later.

## Sequencing — strangler, NOT big-bang (the one verdict to enforce)

The brief framed it "UNIFY-FIRST: retire `compiler.ts` … THEN cleave." **Retiring a 1101-line battle-tested compiler as the opening move is a big-bang risk** — a from-scratch lowering can return a silently different row set (not a throw). All three reviewers converged: **"retire `compiler.ts`" is the LAST act, gated, not the framing verb.** Each step leaves `main` releasable; both engines coexist until the gate is green.

- **Step 0 (free, isolated, FIRST)** — Land `DealbrainModel → AggregateModel` (§7) as its own prep commit. Mechanical, no behavior, shrinks every later diff.
- **Step 1 (Gate 0 — grammar reconciliation, BEFORE any lowering work) — RESOLVED, see Decision §8.** The verified PRIMARY hazard is **NOT the diamond — it is the addressing grammar**: `query()` walks each segment as a RELATIONSHIP NAME (`compiler.ts:145` `desc.relationships[seg]`); the planner keys the HEAD on an ENTITY NAME (`join-plan.ts:109` `head in reg`). The same path string resolves differently, and `query()`'s named-edge grammar is strictly MORE expressive for diamonds. **Decided (§8): entity-prefix as the IR normalized form + a relation-name→entity-prefix normalizer that preserves `query()`'s public request language**, lowering each named hop to an explicit `JoinPlan.hops` chain (so a named edge picks its leg; a bare ambiguous destination still rejects unless a host canonical edge is declared), reproducing `query()`'s belongs_to→has_many / has_many→has_many refusals + json-subpath behavior, and dropping the `conformedDimensions` skip so `describe()` advertises each leg. Pin the choice with a char spec on a **SYNTHETIC ASYMMETRIC diamond fixture** — the current Bean Maxx data is SYMMETRIC + redundant (verified: direct == via-opp == 295, 0 disagreements, `retrieval-joins.char.eval.spec.ts`), which **hides the divergence** so the current gate cannot falsify edge-pick-vs-reject.
- **Step 2 (Gate prerequisite — HARDEN the char net BEFORE touching the engine)** — Verified holes in exactly the lowering a re-derivation breaks silently: **zero connective coverage** (`grep and:[|or:[ → only `expand:` false positives), **zero `offset` coverage**, **`has_more===true` never asserted**, **zero `runSearchMulti` coverage**. Add (all DB-gated on DBURL, ground-truthed via raw SQL through the same pool, pinning `compiler.ts`'s CURRENT behavior FIRST): `connectives.char` (AND/OR/NOT incl. a connective branch carrying a has_many dotted path — the OR-of-EXISTS correlation case — and `fetch()`'s always-wrapped `{and:[idFilter, refinement]}`); `paged.char` (`offset>0`, `has_more===true` on a non-final page, page1∪page2 == full id-set with no overlap). These are **non-negotiable preconditions**.
- **Step 3 (no behavior change, char-verifiable)** — Define `QueryPlan` + `QueryBackend` in `internal/`; make the EXISTING aggregate adapter implement `QueryBackend`. Pure interface extraction; the full DBURL suite stays green with no spec edits.
- **Step 4 (additive, new path behind the SAME adapter, `compiler.ts` UNTOUCHED)** — Build `grain:'row'` lowering on the aggregate adapter (no GROUP BY; measures→`OVER(PARTITION BY)`; row PK + projection). **Land `fetch()` FIRST as the proof** — `fetch()` = `grain:'row'` with an id-IN filter + `AND(refinement)` is the cleanest, lowest-risk unification. Route behind a flag with `runFetch` as fallback; flip when `fetch-expand-projection.char` (20 specs) + the new connective specs are green.
- **Step 5 (port the query-only capabilities — explicit pre-retirement checklist)** — These live ONLY on the query path today and will **silently vanish** under "just point `query()` at `planAggregate`": computed-metric correlated subqueries (`compiler.ts:80-92`), EAV Shape-B jsonb (`compiler.ts:111-122` → widen `AggFieldMeta.eav`), FTS lexical rank (`ts_rank_cd`/`ts_headline`), text-magic OR-fanout, the projection/snippet/PK channel, and the **EAV-inner semijoin descriptor** (the aggregate semijoin is native-inner-only; the query side supports an EAV inner leg, today brokenly — see §Consequences). Each must be ported + char-pinned before retirement.
- **Step 6 (the actual cut, gated)** — Route `query()` onto `grain:'row'`. THIS is where the scope UPGRADE (§3) lands. Pin the desired post-unify behavior with char specs BEFORE the cut (out-of-scope traversed to-one parent drops/zeros; uncovered traversed source refuses), tagged as the intentional invariant-#3 upgrade.
- **Step 7 (separately tracked)** — `expand` scope-hardening: `expandRows` folds the scope resolver fail-closed into every batch WHERE; add a char spec for an out-of-scope expanded relation.
- **Step 8 (only now)** — Retire `compiler.ts` + `runSearch`, once the full DBURL char suite + the new connective/pagination/scope/grammar specs are green on the merged engine. Keep it as dead-but-present fallback for one release if a revert path is wanted; delete in a follow-up.

## Invariants — carried through (each survives)

- **#1 builder-only, no raw SQL** — `explain()` formalizes the existing `.toSQL()→{sql,params}` (builder-native, never hand-built). The one new SQL site (`similarityExpr`) is `sql`` over column objects + bound params. **SURVIVES (low risk).**
- **#2 grain-relative fan-safety** — unchanged for group grain; row grain is the degenerate single-source case, so no fan is introduced **iff** `mode:'window'` (`OVER`) is the only measure discriminator. The grain oracle (`grain.ts`) serves both unchanged. **SURVIVES.**
- **#3 scope fail-closed, per-source, folded through EVERY traversed entity** — the LIVE risk and the core fix. Resolving scope to a per-source MAP in `internal/` (§3) makes #3 a property of the dialect-free PLAN, verifiable identically across backends. `query()` is UPGRADED to compliance; `expand` is a tracked follow-on. **SURVIVES + STRENGTHENED.**
- **#4 ONE expression language** — the `Predicate` is already the shared carrier for filter/where/having/scope and the crispified sim leaves. No second dialect introduced. **SURVIVES (low risk).**
- **#5 conformed-dimension rule (ADR-0024)** — `resolveJoinPlan` is the single resolver for both grains; the diamond reject, to-many reject, and join-vs-semijoin rule apply identically. The grammar normalizer (Gate 0) must preserve the diamond-disambiguation decision. **SURVIVES.**
- **#7 host-supplied model** — the rename (§7) removes a false "engine knows dealbrain" signal; the EAV resolver stays a host-injected port. **SURVIVES + clarified.**

## Consequences

- The retrieval compiler retires; `query()`/`fetch()` ride the same plan→lower the collapse verbs already use. One join/EXISTS/scope/semantics lowering, not two.
- A `QueryBackend` (`execute`+`explain`) lets Snowflake/BigQuery be a new adapter folder consuming the identical `QueryPlan`, with exactly ONE pgvector primitive (`similarityExpr`) to substitute. No transpile/LookML concern (explicitly dropped).
- **Known char assertions FLIP during the cut and must be updated in lockstep** (or the net reads red and masks real regressions), each a conscious decision recorded in the ADR's decision-list: the **EAV-alias-in-EXISTS 42P01 bug** (`retrieval-joins.char.eval.spec.ts:222-243` pins `rejects.toThrow('fv_opportunities_Amount')` — `compiler.ts` renders an undeclared alias; the unified lowering either fixes it to a count of 71 **or** turns it into a clean reject — but the aggregate semijoin has NO EAV-inner support today, so a naive cut REGRESSES the intent of `opportunities.Amount`-style has_many-EAV filters); the **diamond reject** (`:112-167` will change if the grammar normalizer is adopted); the **query-vs-fetch EAV value-type** (query preview returns `'293000'` string vs fetch `293000` number) and **window-count string-vs-number** — unify collapses each onto one lowering, changing one side; the **FIELD_PATH → nativeColSql** message moves (query throws `FIELD_PATH` at resolution `compiler.ts:148`; the aggregate path defers column existence to the lowering `compile-drizzle.ts:65`).
- The cleave is interface-extraction, not rewrite (the aggregate adapter already consumes the planner) — so the diff is large but the risk is concentrated at Steps 6–8, fully gated.
- **Half-closed-invariant trap:** unifying the filter path while leaving `expand` unscoped yields an invariant #3 that LOOKS done but still leaks. §3 + Step 7 prevent this only if Step 7 actually lands.

## Open Decisions

- **§A — Diamond addressing grammar (Gate 0). ✅ RESOLVED 2026-06-21** — see Decision §8. Explicit name-the-route grammar + host-canonical default for denormalized diamonds + `describe()` per-leg surfacing (drop the skip) + a synthetic asymmetric fixture to falsify. The union-closure convenience is deferred (domain-opinionated, above the engine).
- **§B — Scope-upgrade rollout. ✅ RESOLVED 2026-06-21 — ship the tightening WITH the cut (option A).** Moving `query()` onto the planner upgrades it from a root-only AND to per-source fail-closed scope folded through every traversed entity — a behavior *tightening* (newly REFUSES an uncovered/undeclared traversed source; newly DROPS rows under an out-of-scope to-one parent). **Decision:** ship it with the Step-6 cut; pin the desired refuse/drop behavior with new char specs BEFORE the cut and tag them as an intentional invariant-#3 upgrade (so the net documents the change, not flags a regression). Rationale: the current root-only scope is a security GAP of the same class as the expand leak (§C) — preserving it would preserve a hole. This is a FORWARD decision (only bites at Step 6), so it is cheap to revisit. **Revisit-to-warn-window condition:** an *external* consumer is found calling `query()` with cross-grain filters that depends on today's looser scope (none known — query-surface is consumed in-repo via MCP/REST/demo + the companion CRM app + the agentic-patterns dogfood).
- **§C — `expand` scope leak. ✅ FIXED + MERGED 2026-06-21 (PR #15, `0ac73bb`), ahead of the unify.** `expandRows`/`expandBelongsTo`/`expandHasMany` read related entities with bare `inArray(...)` WHEREs and no scope (`expand.ts`), and `expandRows` was never passed a scope resolver — a present-day invariant-#3 violation (any rule not implied by FK reachability — row visibility, soft-delete, ADR-0027 attribution grain — was bypassed), independent of the unify. **Done:** the service builds a fail-closed `ExpandScopeResolver`, threaded through `runFetch → expandRows → both expanders`; each traversed relation folds per-entity scope via the one filter compiler; uncovered + non-`TENANT_GLOBAL` → REFUSE (`EXPAND_SCOPE`); no scope configured → unchanged. Char-pinned (`expand-scope.char.eval.spec.ts`). **Forward (still part of the reorg):** when the `QueryBackend` port lands, model expand as a service-layer `ExpandSpec` over flat rows kept ABOVE the port (so a new backend never reimplements it) — the scope fold moves with it.
- **§D — Value-type policy (open).** The verified query-preview `'293000'` (string) vs fetch/aggregate `293000` (number) EAV divergence, and window-count string-vs-number. *Rec:* numbers-as-numbers everywhere (adopt PR #10's lossless coercion on the row grain); pin the target with a `.todo` char spec and flip the string assertions in the SAME commit. Surfaced because it is a wire-format change for `query()` preview consumers.
- **§E — Unified error vocabulary (open).** `query`/`fetch` throw `FIELD_PATH` at resolution (`compiler.ts:148`); the aggregate path defers column existence to the lowering (`compile-drizzle.ts:65`). *Rec:* validate column existence in the lowering with ONE vocabulary (keeps `resolveJoinPlan` names-only); expose a stable machine-readable error code for MCP/agent callers; update any spec asserting the exact `FIELD_PATH` string in lockstep.
- **§F — Keep `compiler.ts` as a one-release fallback (open).** *Rec:* yes — dead-but-present behind the flipped flag for one release (a cheap revert path; the scope-behavior change ships at the same step), delete in a follow-up.

---

*Cross-ref: [ADR-0024 — conformed dimensions](./ADR-0024-conformed-dimensions.md) (the `resolveJoinPlan`/`JoinPlan` proto-IR + the crispified relevance leaves this IR reuses verbatim; the conformed-dimension rule the unified resolver enforces for both grains). [ADR-0025 §2 — engine type rename](./ADR-0025-remap-ergonomics.md) (the `DealbrainModel → AggregateModel` rename folded in as Step 0).*