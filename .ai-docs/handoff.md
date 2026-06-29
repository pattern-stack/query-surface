# Handoff — 2026-06-29

**Branch:** `main` (query-surface `676dc8f`, == origin, pushed). Sibling **dealbrain-projection** `72cd2b2` (LOCAL-only, no remote) — dep refreshed to the new engine. ⚠️ Another agent is concurrently active in query-surface — coordinate git (read-only checks before pushing; FF-only).

**Last action:** Shipped + LIVE-VALIDATED (through the MCP) **EAV-dim conformance through to-one joins** — EAV dims (stage/risk_level/deal_size_band/…) now group/filter/having/compare through a belongs_to join, treated like native (compose `lowerToOne` ∘ `eavValueJoin` after the scope-folded hop loop; grain-safe 1:1∘1:1; scope fail-closed; diamond/to-many still reject). Closed the describe/execute contract BOTH ways: also added **group-by-is-dimensions-only** (reject grouping by a measure, fail-loud). Built via an ultracode workflow (6 readers → judged design → worktree impl → 3 adversarial reviewers), lead-reviewed + real-data falsified. Commits `1bdd029` + `19c679d`, merged `676dc8f`, pushed. Char net: `eav-to-one-dim.eval.spec.ts` (14 specs, mutation-verified). Full suite 355 pass / 12 pre-existing no-OPENAI_API_KEY embedding fails.

**Next action:** A query-surface SHOWCASE page that includes METRICS. Two routes (Dug leans toward a fresh build): (A) **fresh page** — cleanest; demo the current 5 verbs (describe/select/fetch/**measure**/**compare**) + the EAV-to-one cross-grain as the headline ("evidence by `opportunities.stage` / `risk_level`"); no rename baggage. (B) **revive `scripts/wave2-demo/`** (`index.html` + `server.ts`) — has nice UI (metric cards, group-breakdown table, relevance explorer) BUT predates the 5-verb rename: `server.ts` still calls `h.service.aggregate(...)` / `.query(...)` (now `.measure`/`.select`) → BROKEN against main, repair first. Either way the headline to show is the new EAV-dim-through-to-one metrics. (wave2-demo run: `cd scripts/wave2-demo && DBURL=… bun run server.ts`.)

**Obstacles:**
- wave2-demo uses the deterministic **ILIKE embed stub** (semantic = phrase-match unless `OPENAI_API_KEY` is set) + an external **field-management `CRM_API`** for the resolved model (has a baseline fallback if the CRM app isn't running).
- **Semantic rank is a no-op on local beanmaxx** — stored embeddings are the placeholder dummy `[0.001,0,…]` (identical for all 29k obs). Dug has a re-seed solve elsewhere; run `dealbrain-projection/scripts/reembed-observations.ts` (real OpenAI vectors) before testing semantics.
- **dealbrain-projection has no git remote** (local-only, by choice).
- **ADR-0028 traversed-join residual** still open (query()'s to-one JOIN ON / cross-grain cohort don't fold scope; the `f3de55b` falsifier probes it) — narrow, structurally closed only by the engine reorg.

## Notes
- The 5 public verbs are `describe / select / fetch / measure / compare` (rename shipped). MCP `.mcp.json` (workspace root) local entry needs `UNSCOPED=1`; prod entry needs `ORG_ID` + sets `DB_SSL=no-verify`.
- Tenancy: `scope` is mandatory + fail-closed at the engine; `createSurface({ organizationId })` in the projection (prod-verified, no cross-tenant leak).
- Memory current: `tenancy-scope-contract`, `verb-naming-locked`, `query-surface-ship-context`, `empirical-verification-preference`, `wave2-demo-location`.
- Eval gate: `DBURL=postgres://postgres:password@localhost:54321/dealbrain bun test` → 355 pass (the ~12 fails are no-OPENAI_API_KEY embedding specs).
