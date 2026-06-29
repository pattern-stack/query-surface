# Handoff — 2026-06-26

**Branch:** `main` (query-surface `f3de55b`, == origin). Sibling **dealbrain-projection** `main` `72cd2b2` (LOCAL-only, no remote, by choice). ⚠️ Another agent is concurrently active in query-surface — coordinate git (read-only checks before pushing).

**Last action:** Shipped + PROD-VERIFIED the cross-tenant tenancy fix. (1) query-surface ENGINE: `scope` is now MANDATORY + fail-closed — `ScopeResolver | UNSCOPED` (required field + runtime guard), root `scoped()` refuses an uncovered entity (invariant #3 made total), gate/falsifier `scope-mandatory.char.eval.spec.ts`. Merged to `main`, pushed (`b092f11`). (2) dealbrain-projection CONSUMER: `createSurface({ organizationId, userId?, unscoped? })` (required org-or-explicit-unscoped, per-entity org_id resolver, junction via semijoin), `mcp-serve` gated on `ORG_ID`/`UNSCOPED=1`, **C4 fix** (tenant-portable aggregate model), **SSL option** (self-signed prod), **EAV discovery** (overlay derived from each org's `field_definitions` by data_type — drops the hardcoded specs; prod org → 203 measures + 75 dims from 554 defs). Also this session: 5-verb rename LOCKED + applied (`describe/select/fetch/measure/compare`, ADR-0024 Amendment 3), ADR-0028 Step 0 (`AggregateModel` rename). Read-only prod leak-hunt: all checks green, 0 cross-tenant leak.

**Next action:** The user wants to **explore the surface live via MCP** (see what we built) — boot the dealbrain-projection MCP locally: `cd dealbrain-projection && UNSCOPED=1 DBURL=postgres://postgres:password@localhost:54321/dealbrain bun run scripts/mcp-serve.ts` (single-tenant beanmaxx). After that, the ship-prep step proper: the **live char-net bench** (= ADR-0028 Step 2 — deep testing emitted as char specs).

**Obstacles:**
- **ADR-0028 traversed-join residual** — query()'s to-one JOIN `ON` / cross-grain cohort don't fold scope (only `expand` + the root + aggregate-per-source do). Narrow (needs a cross-tenant FK; clean data lacks it). Being probed in `f3de55b`. Structurally closed only by the engine reorg.
- **dealbrain-projection has no remote** — 4 local commits (`fc178c7`→`72cd2b2`). Not backed up.
- **Prod catalog size** — that org surfaces 203 measures + 75 dims in `describe()`; accurate but large for an agent. Curation/allowlist is a future UX lever (the explicit `measureSpecs`/`dimensionSpecs` override path exists).

## Notes
- The org-scoping bug the CANVAS thread flagged as a blocker (query-surface "OFF-LIMITS", route via `executeForOrganization`) is **FIXED** by the above — that guardrail can lift for org-scoped reads via `createSurface({ organizationId })`. Canvas agent owns updating its own `canvas-port-status`/`canvas-mvp-built` memory + `docs/handoff-port-to-dealbrain.md` §0.
- ADR-0028 engine reorg is still DESIGNED, ~Step 0 built. Steps 1–8 (the strangler) remain; the rename's code already shipped (it did NOT wait for the cut — superseded the old "fold into the cut" plan, see ADR-0024 Amendment 3).
- Eval gate: `DBURL=… bun test` → 341 pass (DB-gated specs skip without DBURL; ~12 fail only when `OPENAI_API_KEY` is unset = embedding specs, not regressions).
- Memory: `tenancy-scope-contract`, `verb-naming-locked`, `query-surface-ship-context` all current.
