# Handoff — 2026-06-29 (D4 launch-ready)

**Branch:** `main` (== origin/main, all merged, clean tree). **Next session: immediately launch the D4 workflow** (§Next).

**Last action — shipped the ADR-0029 Measure/Metric model + ADR-0024 Amendment 4 (5 PRs, all merged, eval-gated):**
- **ADR-0029** `.ai-docs/decisions/ADR-0029-measure-metric-model.md` (`b6447b8`) — the two-layer model: **measure** = one aggregation pass over a row-level expr `g(f(cols))`; **metric** = post-aggregate arithmetic over ≥2 collapsed legs. Criterion = single-pass computability (NOT distribution). Authored via an ultracode workflow, fact-checked vs the engine + dbt MetricFlow.
- **D3** (`fc943d6`) — workbench: `count`/`count_distinct` aggs + Measure/Metric optgroups (widened `DealbrainMeasureSpec.aggs` to include `count`).
- **D1** (`08e7c8f`) — `MeasureCatalogEntry.layer` + new **`describeMetrics()`** (metric layer surfaced; ratio/cumulative/derived). Layer derived from `def.kind`.
- **D2** (`6304b71`) — the **`derived` composite metric** = arithmetic over atomic measure legs (gross_profit = revenue − cost, weighted blends). `CompositeColumn` → `RatioComposite | DerivedComposite`; `DerivedExpr` AST; `validateDerivedDef` (legs atomic-only); `normalize` Map-dedupes legs → `__cmp_` aliases; `compile-drizzle.ts walkDerived` lowers the AST. Eval `derived-metric.eval.spec.ts` (12).
- **ADR-0024 Amendment 4** (`3ff8274`) — conformed group dims resolve at **every measure leg source**, not just the root (`resolveJoinPlan` bare-name → to-one-target search; `lowerGroupDim` physical-column fail-loud guard). Eval `conformed-multisource.eval.spec.ts` (CM1–6) + 5 unit cases.

Full suite: **381 pass / 12 fail** (the 12 are pre-existing no-`OPENAI_API_KEY` embedding specs — relevance-as-filter / observations-retrieval / rank_by / citation-chain). tsc clean. **Biome can't run locally** (`@biomejs/cli-darwin-arm64` native binary missing — `bun install` to fix; CI gates it).

---

## Next action — **D4: expression measures** (ADR-0029 §D4). LAUNCH THE WORKFLOW.

**The anchor (why now):** you CANNOT make a row-level-product measure like `revenue = SUM(price·qty)` today — and it can NEVER be a metric (a metric is post-aggregate: `SUM(price)·SUM(qty) ≠ SUM(price·qty)`; the multiply must be per-row, before the SUM). The only workaround today is precomputing the product as a field (how dealbrain ships `ExpectedRevenue`/`weighted_amount`). Concrete CRM case: `SUM(Amount · Probability)` (weighted pipeline). This is the genuine gap D4 closes.

**The shape:** generalize `AtomicMeasureDef.on` from a single column (`string`) to a **row-level expression AST** evaluated per row, then aggregated once — `agg( f(col₁,col₂,…) )`. Still ONE pass → still a **measure** (the EXPRESSION grade), below the aggregation boundary. NOT a metric.

**Design (bake into the workflow constraints):**
- **AST** — `RowExpr = { col: string } | { lit: number } | { op: '+'|'-'|'*'|'/'; left: RowExpr; right: RowExpr }`. `AtomicMeasureDef.on: string | RowExpr` (string stays the fast path). Host-facing in `measure-catalog.ts`.
- **Lowering touch-point** — `src/adapters/drizzle/compile/compile-drizzle.ts` `measureValue` (~line 293) returns `{ valExpr, isStar }`; today it resolves ONE column (native via `nativeColSql`, EAV via `eavValueJoin`). Make it WALK a `RowExpr`: `{col}` → resolve native/EAV (pushing the EAV `field_values` join), `{lit}` → bound param, `{op}` → `(L op R)` via `sql.raw` over the FIXED closed 4-op set + `::numeric`. Then `aggCore` (~line 240) wraps the composed `valExpr` UNCHANGED — `sum(<expr>)`, `avg(<expr>)`, etc. **This is exactly `walkDerived`'s pattern (compile-drizzle.ts:73), but PRE-aggregation over RAW columns instead of post-aggregate over collapsed `sub` aliases.**
- **THE WRINKLE (multi-EAV) — the main thing D4 adds over derived:** an expr can reference ≥2 EAV columns (e.g. `Amount · Probability`, both EAV). Each pushes its OWN `eavValueJoin`, today aliased `fv_${m.as}` (per-measure). For multiple EAV leaves in one measure that COLLIDES — give each leaf a DISTINCT join alias (`fv_${m.as}_${i}`). Grain-safety holds: each EAV join is 1:1 (entity_id + field_definition_id), so N of them compose to 1:1 → NO fan (same argument as the EAV-on-to-one work). Confirm `sourceSelect`'s join-dedup (by table name) doesn't drop a needed distinct-alias join.
- **Validation** — `validateMeasureDef` (measure-catalog.ts) must validate EACH `{col}` ref resolves to a registered field on the source (numeric for arithmetic); the op set is the closed 4; a pure-literal expr is rejected (needs ≥1 col).
- **Additivity** — host-declared (the agg's summable-ness), same as today.
- **describeMeasures** — surface the expr on the `MeasureCatalogEntry` (like `describeMetrics` carries the derived `expr`).
- **INVARIANT #1 (builder-only) — the live risk** — ops are a FIXED closed set via `sql.raw` (NEVER a caller string); `{col}` → column OBJECTS (`colObj`/`nativeColSql`); `{lit}` → bound params. Same discipline `walkDerived` already holds; re-assert at the measure-value level.
- **Workbench** (`scripts/qs-showcase/`) — an `expression` kind under the **Measure** optgroup (a small builder: col `op` col-or-literal), `defsFromBook` emits the `on: RowExpr` atomic, `resolveBookMeasure` shows the formula.

**Evals (new `expression-measure.eval.spec.ts`, DB-gated, ground truth INDEPENDENT via raw SQL):**
- `SUM(Amount · Probability)` per stage == raw `sum(amount * probability)` ground truth (the headline row-level product; both EAV → the multi-EAV-join case).
- `SUM(a − b) == SUM(a) − SUM(b)` (linear equivalence — proves the measure form matches the derived form for SUM).
- **The discriminator**: assert `SUM(Amount·Probability)` ≠ the metric `SUM(Amount)·SUM(Probability)` (proves it's genuinely a row-level measure, not a post-aggregate metric — the thing that's impossible without D4).
- Multi-EAV no-fan: grouped, assert the grouped product matches independent ground truth (no inflation from the two EAV joins).
- Fail-loud: reject a `{col}` that isn't a registered numeric field; reject a raw-string `on` (builder-only guard).

**Workflow shape — mirror the prior two** (templates saved in `…/workflows/scripts/`: `derived-metrics-impl-*.js`, and `…/scratchpad/amend4-wf.js`): 2–3 parallel designers (AST+measureValue lowering · multi-EAV grain-safety + alias scheme · eval+workbench) → 1 implementer (edits + self-validates against `bun x tsc` + the new eval + the measure/metric/eav gate suite) → 3 adversarial reviewers (**grain/fan-safety on the multi-EAV joins** · **builder-only / invariant #1** · **eval-is-real**, esp. the metric-vs-measure discriminator). Write the script to a file and launch via `{ scriptPath }` (inline scripts hit unescaped-backtick parse errors — avoid backticks inside prompt strings; use string concatenation for `DBURL`).

**Gate after the workflow:** lead-review the diff yourself (the reviewers caught a real bug in BOTH prior workflows — the fractional-divisor cast in D2, the physical-untagged-column reroute in Amendment 4); fold must-fix findings; run the full gate; one PR (the gate blocks direct push to main → `gh pr merge --rebase --delete-branch`).

---

## Notes / obstacles
- **The gate forces PR flow** — direct push to main is blocked (SDLC Gate 2). Rhythm this session: branch → workflow/edits → eval gate → `gh pr create` → `gh pr merge --rebase --delete-branch` → sync main. No CI / required reviewers configured, so PRs merge immediately once mergeable.
- **Showcase** (`scripts/qs-showcase/`, port 7879): `DBURL=… bun run server.ts`. The server caches `index.html` in a `const` at boot → **HTML edits need a server restart** (not just a browser refresh). `measures.json` is gitignored scratch (the measure book; persistence is a known stand-in — real home = host registry; see memory `measure-workbench-persistence`).
- **Stale remote branches to prune** (optional): `origin/feat/mcp-adapter`, `origin/feat/mcp-number-coercion` (1 ahead / 26 behind, superseded — MCP already in main). Two local `worktree-*` branches are merged leftovers.
- **DB:** `DBURL=postgres://postgres:password@localhost:54321/dealbrain` (dealbrain's dev DB, Bean Maxx fixture). Bring it up there if down.
- Memory current: `measure-workbench-persistence` (the whole Measure/Metric arc + Amendment 4 + D4-is-next), `verb-naming-locked`, `tenancy-scope-contract`, `query-surface-ship-context`, `empirical-verification-preference`, `wave2-demo-location`.
