# ADR-0024 — Join-graph-aware conformed dimensions (and the unified selection model)

**Status:** proposed — direction agreed in-session 2026-06-17 (Dug: *"I want this core to the product; the graph is integral and touches all areas of the surface"*). The **conformed-dimension rule (§Decision)** is settled; the **resolver design** and the **unified-selection specifics** (relevance-as-predicate, defuzzify policy, the verb rename) are **open decisions** called out in §Direction. · **Scope:** how the query surface decides which dimensions/filters are *legal* for a metric (or metric set) — derived from the join graph's cardinality + direction — and the forward model where **relevance becomes a selection predicate**, so metric-querying and relevance-retrieval are two *projections over one selection*. · **Builds on** [RFC-0001 §1](../rfcs/RFC-0001-teleological-pattern-language.md) (the Predicate language; **hard rule #9** — Predicate is the only expression language), the aggregate engine's grain/fan-safety (`assertAggregateSafe`/the doctor, `measureFans`, `groupGrain`/`grainRank`, per-source CTEs), `buildRegistry`'s cardinality graph from Drizzle `relations()`, and the named-measure-catalog + `compare()` work (#299–#310). · **Aligns with** the MetricFlow direction (measures + entities + a join graph deriving the queryable surface).

---

## Context

The aggregate surface today resolves group-by / filter columns by **physical column membership per source** (`colByDbName[source]?.[col]`), *not* by traversing the join graph. Two consequences:

1. You **cannot** group or filter a metric by a dimension that lives on a *related* entity (e.g. `sum(opportunity.amount)` grouped by `account.industry`) — the dotted path is treated as JSON on the source, not a join.
2. A filter column that resolves on **no** queried source was **silently soft-dropped** — returning the full population under a filter the caller asked for. Fixed in #310 (fail closed; see below), but that is an *interim* guard; a *compound cross-source* filter still whole-drops per source (the deferred edge).

What already exists and makes this a *scoped extension, not a rewrite*: the **cardinality graph** is built (`relations()` → `buildRegistry`), and **measure fan-safety** is solved (the doctor refuses fan-out; each measure pre-aggregates in its own source CTE and joins on the group key). The missing layer is **applying that same graph to dimensions and filters.**

The forcing function: dogfooding `compare()` as an analyst surfaced the silent-drop landmine (a variant filter on an unregistered column collapsed both legs to the grand total → a fabricated "no difference"). The right end-state isn't "patch the drop" — it's "let the graph decide what's queryable."

## Decision (settled)

1. **Conformed-dimension rule.** A dimension on entity **B** is legal at the grain of entity **A** *iff* every join hop **A→B is to-one** (many-to-one or one-to-one — the FK→PK direction). `Opp →(account_id→PK)→ Account` is to-one ⇒ Account's dimensions are conformed to Opp grain. `Account → Opp` is to-many ⇒ Opp dimensions fan out and are **illegal** as Account dimensions. For a query with measures from **multiple** entities, the legal shared dimensions are the **intersection** of dims to-one-reachable from *every* measure's source entity.

2. **Cross-grain predicates are semijoins, not joins.** A predicate at a *child* grain (e.g. an observation-level condition constraining an account-level metric) compiles to `EXISTS` / a semijoin — "accounts that *have* a matching child" — **never** a fan-out join that would multiply the measure by the match count. The grain rules govern **join-vs-semijoin**, not only dimension shareability.

3. **`describe` is graph-derived.** It advertises the conformed dimension set **per metric** (and per metric *combination*) — the queryable surface is *derived* from the graph, not hand-listed per entity.

4. **This subsumes the leaf-level-drop follow-up.** Once dims/filters resolve through the graph, every leaf is either: resolved via its to-one path (applied), a legitimate cross-source leaf (applied where it resolves, skipped where it doesn't), or non-conformed (**rejected with a clear reason**). No silent drops anywhere — which retires both #310's interim guard's bluntness and the deferred compound-cross-source edge.

## Direction (open decisions — Dug ratifies)

**A. Unified selection model.** Keep the verbs (`query` / `aggregate` / `compare`) as good *projections*; do **not** fuse them. Converge at the **selection layer**: make **relevance a Predicate *leaf kind*** (per hard rule #9) so a semantic match flows into `aggregate`/`compare` filters, not just `query`'s `rank_by`. Three operations, provisional naming **SELECT / MEASURE / RANK** (Dug's triad — supersedes the SELECT/MEASURE/PROJECT framing).
- *Open:* relevance-as-Predicate-leaf vs. a separate compose step; whether to adopt the SELECT/MEASURE/RANK rename surface-wide.

**B. Defuzzify policy.** Relevance is scored/ranked; aggregation is set-based — so a relevance predicate must be turned into a **crisp set** (threshold or top-K), and that conversion must be **explicit**, never a hidden default (it's the same silent-fabrication class as the filter-drop). *Open:* the default policy, and whether to expose a **gradient lever** later (a UI slider over the threshold — changes the cohort's semantic meaning, so it's a deliberate control). **Consistency-now beats gradient-now.**

**C. Citation / transparency (settled in spirit).** A metric computed over a **relevance-defined cohort** MUST surface *what constituted the cohort* — the definition + matched exemplars (reuse the `_snippets` machinery) — to the user **before/with** the number. "Sum of pipeline for accounts where *the buyer showed hesitancy*" must show *what counted as hesitancy* (and how many matched at what cutoff) so the cohort is **auditable, not asserted**. This is alignment integrity for semantic cohorts and is non-negotiable for trust.

**D. Score-as-measure.** The relevance score itself is aggregatable (`avg`/`max` similarity per group) — relevance is filter *and* (bucketed) dimension *and* measure, role set by projection.

**E. Drill-down is the trust motion.** Aggregate to find *where* the signal is; retrieve to see *why* (the evidence) — the agent zooms out (metrics) and in (evidence) over the *same selection*. The snippet/evidence machinery must survive into the metric path. This out-and-in zoom **is** "the explorable brain whose metric is alignment integrity."

**F. Unify `query`/`fetch` filter semantics** with `aggregate` (fail closed on a column resolving nowhere; they currently use a separate compiler that still soft-drops) — one consistent "no silent behavior" contract across the whole surface.

## Consequences

- `describe` becomes graph-derived (smarter, larger payload); the planner gains **join-path resolution** + **semijoin compilation** alongside the existing per-source-CTE measure machinery.
- The grain apparatus extends from "protect measures from fan-out" to also "decide dimension legality" and "choose join vs. semijoin for cross-grain predicates" — one mechanism, three jobs.
- A concrete, auditable **trust story** for semantic cohorts (citation), consistent with RFC-0001's alignment-integrity thesis.
- **Interim state (shipped in #310):** `aggregate()` fails closed when a filter column resolves on no source; legit cross-source filters still soft-drop; `query()`/`fetch()` still soft-drop (item F). That stopgap is honest but blunt until this resolver lands.

---

## Amendment 1 — Wave-1 SHIPPED + Wave-2 §Direction RATIFIED (2026-06-19, Dug)

**Wave-1 (the §Decision conformed-dimension rule) is SHIPPED** (sdlc-patterns #327; char net #322) and reorged into the canonical `pattern-stack/query-surface` repo. One refinement landed during build, **superseding the §Consequences "interim state"**: a global `filter` leaf must **conform on EVERY compiled measure source, else REJECT** — the per-source soft-drop ("applies where it resolves") is gone. A non-conforming leaf silently no-opped on a measure is the **Q6 landmine** (it fabricates cross-measure comparisons — e.g. a `compare` delta of 0 over different populations). Source-local intent uses a **measure-level `where`**. This fully retires the deferred compound-cross-source edge.

**Wave-2 §Direction A/B/C — RATIFIED (Dug, 2026-06-19).** Build on this; no further direction debate. Naming/field details are finalized in the Wave-2 design pass, but the decisions are locked:

1. **Relevance is a Predicate *leaf*** (§A). A new leaf op in the one expression language (proposed `{ on: <semantic/text column>, op: 'relevant', query: <string>, threshold?: number, top_k?: number }`) that flows into `query` / `aggregate` / `compare` filters identically (hard rule #9) — **NOT** a separate compose step. Lives in `internal/language` (leaf + normalize). The **SELECT/MEASURE/RANK verb rename (§A2) is NOT adopted** — keep `query`/`aggregate`/`compare`.

2. **Defuzzify is explicit and MANDATORY** (§B). A `relevant` leaf MUST carry exactly one of `threshold` or `top_k`; the engine **rejects** a relevance leaf with neither — **no silent default** (same fail-closed discipline as the conform-on-every-source rule). The crisp-set conversion happens in `internal/analytics/normalize` **before** compile (threshold → a `similarity >= t` predicate; top_k → a ranked cutoff), yielding an ordinary predicate the wave-1 resolver lowers. **No gradient lever / UI slider this wave** ("consistency now beats gradient now").

3. **Citation is MANDATORY in the response for a relevance cohort** (§C). Any `aggregate`/`compare`/`query` whose selection includes a `relevant` leaf MUST return, with the number(s): (a) the **cohort definition** (the relevance predicate + the exact cutoff applied), (b) **matched exemplars** (reuse `internal/retrieval/snippets`), (c) the **match count at that cutoff**. The cohort is auditable, never asserted — alignment-integrity for semantic cohorts, non-negotiable.

**Deferred (NOT Wave-2):** the verb rename (§A2); **score-as-measure** (§D — relevance score as `avg`/`max` per group); the **gradient lever** (§B); **drill-down** (§E) is a consuming-surface concern, not the engine. Item-F (§F) = the `FIELD_PATH` vs `AGGREGATE` error-contract unification, an IR-phase job (see the char-net backlog).

---

## Amendment 2 — Wave-2 design pass: leaf shape, defuzzify mechanics, top_k dual-mode, calibration-grade citation, fixture (2026-06-19, Dug)

§Direction A/B/C is RATIFIED (Amendment 1). This amendment closes the **mechanics** surfaced in the design pass — build-shaping decisions, not direction. Items marked **[settle in build]** are open micro-knobs with a recommendation; everything else is decided.

**1. The `relevant` leaf — final shape.** A new op in the one expression language (`internal/language/types.ts` — note the `Op` union has NO vector op today):
`{ on, op: 'relevant', query, threshold?, top_k?, per? }`
- `on` — a registered **semantic text column** (resolves to its embedding column via the existing `semanticColumns` registry, same one the rank path uses).
- `query` — the free-text concept (e.g. `"pricing objection"`).
- Exactly ONE of `threshold` | `top_k` (XOR), **mandatory** — engine REJECTS neither (ratified §B; no silent default). `per` qualifies `top_k` only (§4).
- Flows into `query`/`aggregate`/`compare` filters identically (hard rule #9).

**2. Defuzzify — the crispify step** (`internal/analytics/normalize.ts`, pre-compile). The **service** resolves `vector = embed(query)` BEFORE compile — mirroring `resolveSemanticRank` (`query.application-service.ts:262`), but now **walked over every `relevant` filter leaf** for `aggregate()`/`compare()` (which call `embed` nowhere today). Then crispify:
- **similarity** = `1 - (embedding <=> vector)` ∈ [0,1] — REUSE the rank compiler's formula (`compiler.ts:740`); higher = closer.
- **threshold** → predicate `sim >= threshold`. **top_k** → a ranked cutoff (§4).

**3. The vector-distance predicate primitive is NET-NEW (Amendment 1's "ordinary predicate the resolver already lowers" was optimistic).** There is no vector op in `Op` and no WHERE-clause distance leaf — `simExpr` exists ONLY as an `ORDER BY` in the rank compiler. So crispify yields a leaf that BOTH predicate compilers must learn to lower to `(1 - (col <=> vec::vector)) >= t`: `compiler.ts` (query/fetch) **and** `compile-drizzle.ts` (aggregate). The wave-1 conform/semijoin **wrapping** is reused; the **leaf comparison is new SQL in two places.** Plan the build for new, not reuse.

**4. `top_k` is dual-mode — global vs per-group — one ranked-CTE machinery** (resolves the "thorny" open #4). Both intents are first-class, differing ONLY in the ranked CTE's partition scope:
- **Global** — *"top 10 overall, split by account"*: `ORDER BY sim DESC LIMIT k` over the whole matched population; cohort = that global top-k; group for display (per-group counts vary, many 0).
- **Per-group** — *"grouped by account, top 10 each (6 if only 6 match)"*: `row_number() OVER (PARTITION BY <key> ORDER BY sim DESC) <= k`; each group contributes ≤ k, naturally fewer when fewer match.
Both compile to a **ranked CTE the cohort joins/semijoins against** (NOT a plain `EXISTS` — that's threshold's shape). Reuses the existing `partition_by` window infra (types.ts already models "top K most similar per account"). **[settle in build]** explicit `per` (partition key) vs inferred from `group_by` → **recommend explicit `per?`**, defaulting to the group key when grouping / global when absent. So: threshold → plain semijoin; top_k → ranked-CTE join. Two lowerings, one leaf.

**5. Citation is CALIBRATION-GRADE, not just exemplars** (strengthens §C). Any selection with a `relevant` leaf MUST return a programmatic classification-criteria block so a semantic cohort is *legible*, not asserted:
- **cohort definition** — the predicate + the EXACT operative cutoff (resolved `threshold`, or the effective similarity at the `top_k` boundary);
- **matched exemplars WITH similarity scores** (reuse `internal/retrieval/snippets.ts`) — the gradient is visible;
- the **decision boundary** — lowest-included and (where cheap) highest-excluded example — what *just* made / missed the cut;
- **match count at cutoff**.
This makes the cohort **calibratable**: near-term the agent need not pre-set a perfect threshold — cheap first call → inspect the boundary → adjust next call (an agent-driven calibration loop). This is the chosen answer to "the agent shouldn't always have to set the threshold": expose it explicitly **and** make the output teach the cutoff, rather than have the engine guess (consistent with "consistency now beats gradient now"; the gradient lever stays deferred). **[settle in build]** exact payload shape + whether highest-excluded is always computed or only on request.

---

## Amendment 3 — The verb rename LOCKED: `describe · select · fetch · measure · compare` (2026-06-25, Dug)

§A's open item ("whether to adopt the SELECT/MEASURE/RANK rename surface-wide") was deferred in Amendment 2 §1 (kept `query`/`aggregate`/`compare`) because RANK was entangled with the then-open relevance-leaf question. That question is now SHIPPED (relevance IS a Predicate leaf), so the rename is cleanly separable — and is being locked now because the surface is about to ship fresh to a consumer (Doug's work team), so they should adopt the FINAL vocabulary from day one (the verb rename is public-only + mechanical — REST routes + MCP tool names + service methods — and does NOT depend on the ADR-0028 engine reorg; it lands PRE-ship, decoupled from the cut).

**LOCKED surface (the "5 words"):**

| was | now | rationale |
|---|---|---|
| `describe` | **`describe`** | unchanged — perfect routing, industry-legible |
| `query` | **`select`** | pairs cleanly with `fetch`; routing-neutral vs `query` |
| `fetch` | **`fetch`** | KEPT (not `read`, not collapsed) — see eval |
| `aggregate` | **`measure`** | semantically correct: the catalog has `ratio`/`cumulative` measure kinds that are NOT aggregations (`types.ts:3` "a MEASURE is a leaf; AGGREGATION is a stage") |
| `compare` | **`compare`** | unchanged — perfect routing |

**RANK stays dissolved** — relevance is a Predicate leaf (`op:'relevant'`) that flows into `select`/`measure`/`compare`, NOT a verb. This is strictly more powerful than a dedicated `search` verb (the same semantic filter composes inside `measure`/`compare`, e.g. "avg deal size of opps *similar to X*, by region"). **REQUIREMENT:** `select`'s tool description MUST explicitly advertise semantic/relevance filtering, else agents invent a phantom `search` verb (see eval [B]).

### Evidence — 4 LLM routing-eval rounds (~1,600 calls, gemini-3.1-flash-lite + 2.5-flash; scripts in session scratchpad)
- **Rename is legibility-safe.** All naming sets score 0.91–0.95 primary-verb accuracy; name-only (L0) ≈ one-line (L1) — the *names* carry routing, not the descriptions. `select`/`measure` route identically to `query`/`aggregate`.
- **Don't collapse `fetch` into `select`+`expand`.** Two-phase narrow→hydrate: explicit hydrate verb = 1.00; collapsed = 0.75 and the model **never expressed hydration** (never reached for `expand`). The verb teaches the cheap path; the flag hides it.
- **`fetch` over `read`** (the close call): overall lone-hydrate tie (0.07); but `read` is **stickier** — over-fetches on select-only tasks 0.13 vs `fetch` 0.03 ("reading records" feels default). Mirror-image lexical priming (each over-triggers on its own lexeme: `read` resists "fetch/grab" 0.03 but succumbs to "read/show" 0.19). A one-line description drives ALL over-triggering to 0.00 regardless of name → the difference is moot in production; `fetch` wins on over-fetch discipline + incumbency (only 2 verbs change, not 3).
- **`measure` does NOT cannibalize `compare`** — pop/ab routing identical across `aggregate` and `measure` sets (inherent compare-vs-measure fuzziness, not a naming effect).
- **Semantic discoverability** — with a plain `select` gloss the model invents a phantom `semantic_search` verb 75% of the time; **advertising relevance in `select`'s description → 1.00 routing, 0.00 phantom** (a dedicated `search` verb also works and does NOT steal structured finds, but is redundant with the predicate and less composable — rejected).

**Recommended tool glosses** (description matters at exactly two boundaries — semantic, and PoP-vs-measure):
- `select` — *"find records by structured filters OR semantic/relevance similarity; returns ids + a light preview"* ← advertise relevance
- `measure` — *"collapse records into grouped rows with measures (counts, sums, ratios, running totals — not only aggregations)"*
- `compare` — *"period-over-period or A-vs-B aligned comparison"* ← lead with "period-over-period"

**Rollout:** rename lands PRE-ship (public-only, mechanical), decoupled from ADR-0028's engine cut. Supersedes ADR-0028 §Parked note ("fold the rename into the cut") — the fresh-consumer timing flips that: ship final names from day one so the team never eats a rename.

**6. Fixture — adopt dealbrain's "Bean Maxx" Agentic-Search dataset** (replaces the live-mutating dev DB + the ILIKE embed stub). The live dealbrain dev DB is non-hermetic — eval ground-truth counts drifted 46→51 mid-session (red baseline ≠ regression), and the ILIKE stub can't grade free-text. **Bean Maxx** (Tempo-Systems/dealbrain) is purpose-built for "Agentic Search": ~3,592 observations w/ real embeddings, 100 deals, 727 transcripts, **2,400 retrieval question/goldens + 23,843 observation-extraction goldens**, audited (`just db-audit-bm`) + frozen (versioned snapshot). Seed via `just db-seed-bm -- --fixture-dir=<dev-data-generation>` or restore `dev-snapshot/versions/*.dump`. **The goldens are the prize:** Wave-2 relevance-as-filter falsifies against known-good retrieval answers instead of hand-asserted counts. **Effort caveat (not a trivial pull):** the fixture-dir is a local artifact (a local iCloud folder), the dump is large/likely-LFS, and query-surface's `adapters/reference/{schema,model}.dealbrain` must be reconciled against Bean Maxx's (current migrated) schema. **[settle]** confirm a local copy (Dug) vs fetch; then re-baseline the eval ground-truths against Bean Maxx in the same PR.
