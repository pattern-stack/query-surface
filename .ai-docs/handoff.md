# Handoff — query-surface canonical repo · Phase 2 = Wave-2 (semantic selection)

**This repo** = `pattern-stack/query-surface` (`/Users/dug/Projects/query-surface`) — the NEW
**canonical home**, ending the 3-copy fork (was vendored in `swe-brain/packages/query-surface`,
`query-surface-poc`, and dealbrain copies). The **hexagonal reorg is DONE here.** Future
query-surface work happens in THIS repo, not the swe-brain copy.

## Run / verify (the falsification path — works today)
```bash
# from repo root
DBURL=postgres://postgres:password@localhost:54321/dealbrain bun test   # 268 pass / 0 fail
bun test                                                                # skip-clean (202 skip) — DB-gated
bunx tsc --noEmit                                                       # clean
bunx @biomejs/biome check src                                          # clean
```
**Prereq:** the dealbrain dev DB must be running on `:54321` (it's dealbrain's, not this repo's —
bring it up there if down). Without `DBURL` the DB-backed evals skip cleanly, so the suite is still
green — but you can't *falsify* Wave-2 without it.

Live dealbrain (:54321): Opp→Account is to-one, Account→Opp to-many; `observations` carry real
1536-dim embeddings; 46 of 169 accounts have a `'risk'` observation. The char-net harness used a
**stub embed** (ILIKE-by-phrase) — a real/seeded embed provider is the fixture gap for deep semantic.

## Layout (where Wave-2 lands)
- `internal/` — **dialect-free interior** (no Drizzle): `language/` (Predicate AST + normalizers +
  error contract), `analytics/` (grain, doctor, **`join-plan.ts`** = the conformed-dim resolver,
  measure-catalog, normalize, compare), `retrieval/` (`snippets.ts`).
- `adapters/drizzle/` — the Drizzle backend (`compile/compile-drizzle.ts`, `execute/run-drizzle.ts`);
  `adapters/reference/` — the dealbrain eval fixture (`model.dealbrain`, `schema.dealbrain`).
- `presentation/nest/` — the Nest driving adapter.
- `characterization/` — the QueryBackend contract test (the char net).

## Wave-1 = DONE (seeded + current — ADR-0024 conformed dimensions)
`join-plan.ts` (neutral, dialect-free resolver: `resolveJoinPlan`/`belongsToPaths`/
`conformedDimensions`) + Drizzle lowering in `compile-drizzle.ts`. Behaviors: to-one `belongs_to`
LEFT JOIN · cross-grain boolean filter → `EXISTS` semijoin (native inner, table named INSIDE) ·
reject to-many group dims · reject diamonds (ambiguous, no silent edge-pick) · scope folded through
EVERY traversed entity (fail-closed). **THE LOAD-BEARING RULE:** a global `filter` must **conform on
EVERY measure source, else REJECT** — a per-source no-op is the Q6 landmine (fabricates cross-measure
comparisons; source-local intent → a measure-level `where`). `describeConformedDimensions()` advertises
the graph-derived conformed set. Falsifiers: `conformed-dimensions.eval` C1–C15, `compare.eval` C16,
`join-plan.spec`.

## PHASE 2 = WAVE-2 — relevance as a selection, with citation  ← THE NEXT-WEEK PRIORITY ("semi")
**Demo (the pitch thesis, RFC-0001 alignment-integrity):** a metric over a **relevance-defined
cohort, with the cohort shown BEFORE the number** — e.g. *"total pipeline for accounts where the
buyer showed hesitancy"* → surfaces what counted as hesitancy + matched exemplars + how many matched
at what cutoff. Relevance becomes a *filter*, not just `query.rank_by`.

**Decisions — RATIFIED (Dug, 2026-06-19; recorded in ADR-0024 *Amendment 1*). These are LOCKED —
build on them, no further direction debate; only the field names are open (settle in the build):**
1. **Relevance is a Predicate LEAF** (§A, ratified) — a leaf op (proposed `{ on, op:'relevant', query,
   threshold?|top_k? }`) so a semantic match flows into `query`/`aggregate`/`compare` filters
   identically (hard rule #9). Lands in `internal/language/types.ts` + `filter-normalize.ts`. NOT a
   separate compose step; the SELECT/MEASURE/RANK rename is NOT adopted.
2. **Defuzzify is EXPLICIT + MANDATORY** (§B, ratified) — the leaf MUST carry `threshold` or `top_k`;
   the engine **rejects** one with neither (**no silent default** — same fail-closed discipline as the
   conform-on-every-source rule). Lands in `internal/analytics/normalize.ts` — crispify pre-compile
   into an ordinary predicate the wave-1 resolver already lowers. No gradient lever this wave.
3. **Citation IN the response** (§C, ratified) — for a relevance cohort, return the cohort definition
   (predicate + exact cutoff) + matched exemplars (reuse `internal/retrieval/snippets.ts`) +
   match-count-at-cutoff. Non-negotiable (alignment-integrity).
- **DEFERRED (not Wave-2):** the SELECT/MEASURE/RANK verb rename (§A2), score-as-measure (§D), the
  gradient slider, drill-down (§E — a consuming-surface concern). The broader unified-selection vision
  (§D/§E/§F) lives in the copied **ADR-0024 §Direction (A–F)**; Wave-2 is the A/B/C slice.

**Build approach (mirror wave-1) — direction is ratified, so go straight to build:** brief design pass
to finalize leaf field names → build IR-shaped (leaf + defuzzify in `internal/`, thin lowering in
`adapters/drizzle/`) → falsify vs live dealbrain (the embed port: the rank path already embeds;
relevance-as-filter needs embed at the aggregate path; the char-net harness embed is a stub) →
adversarial review pass.

## Also remaining (NOT phase 2)
- **IR extraction** (the other hexagonal step): pull a dialect-neutral `QueryPlan` + a `QueryBackend`
  driven port out of `compile-drizzle`/the retrieval compiler, so a 2nd backend (Snowflake/BigQuery)
  is a new adapter folder. `internal/analytics` is ~80% dialect-free already; retrieval's compiler is
  NOT cleaved. Gated by the char net (present). Multi-backend payoff is roadmap-future, not now.
- **Char-net backlog — the 14 divergences the contract test pinned.** Full evidence (repro +
  file:line) in sdlc-patterns **#322**; each is also tagged in THIS repo —
  `grep -rn "SUSPECTED-DIVERGENCE" src/characterization/__tests__`. Behavior is *pinned* (the evals
  assert today's behavior), so any fix flips its pin in the same PR.
  - *IR-phase:* **(1)** item-F — query/fetch already fail-closed (they throw, not soft-drop); the real
    residual is the `FIELD_PATH` vs `AGGREGATE` **error-contract unification**.
  - *retrieval-path bugs:* **(2)** EAV-inner-leg `EXISTS` emits broken SQL (42P01 — alias w/o
    `field_values AS …`; native inner legs work); **(3)** retrieval **diamond silent edge** —
    `observations.account.name` picks the direct, ~61%-NULL `obs.account_id` over the via-opp path
    (the *aggregate* path rejects diamonds as of wave-1; *retrieval* still silently picks).
  - *describe()/catalog:* **(12)** phantom `enableRLS` field on every entity; **(13)** non-enum EAV
    fields carry `enumValues:[]` + an empty-options enum is indistinguishable from a string;
    **(14)** pgvector `embedding` catalogs as type `'string'`.
  - *projection/curation:* **(10)** raw `fetch` ships the full 1536-dim `embedding` + `normalized_text`
    inline; **(11)** `projectRowDeep` tenant-leak guard is inert without an `exposeColumns` allowlist
    (FKs survive; doesn't fail-closed).
  - *EAV semantics:* **(4)** two divergent EAV read paths — query/fetch is `is_visible`-gated, the
    aggregate overlay is ungated (`weighted_amount` is aggregate-only, throws on query/fetch);
    **(5)** EAV numeric is a STRING in `query()` preview but a number in `fetch()`; **(6)** percentage
    EAV (`hs_deal_stage_probability`) is stored 0..1 with no scale normalization.
  - *rank/window:* **(7)** window `count(*)` returns a STRING, not a number (no coercion, unlike
    aggregate); **(8)** lexical `ORDER BY ts_rank` has no secondary tiebreak (top-K row identity
    nondeterministic); **(9)** `partition_by` lexical without `min_score` returns arbitrary-K, not
    top-K-relevant.
  - *fixture gaps (need data, not code):* EAV Shape B (user-owned `field_definitions`), deep/non-stub
    semantic ranking (the harness embed is a stub), `tenantGlobalEntities` bypass, **`compare()` has
    zero characterization**, multi-hop to-one / multi-hop has_many.

## Provenance / cross-refs
Wave-1 shipped to swe-brain as **sdlc-patterns#327** (char net **#322**). Seeded here from
swe-brain `main@a8500bf`, then reorged (`3a3e06e` hexagonal layout, `8a6c8ab` `__tests__/`). ADR-0024
copied from swe-brain's ADR log (`.ai-docs/decisions/`) for self-containment.

**Process gotcha:** when a repo is co-driven (parallel threads run git ops in the same working copy),
**check `git branch --show-current` before commit/push** — a wave-1 commit once landed on the wrong
branch in the swe-brain copy.
