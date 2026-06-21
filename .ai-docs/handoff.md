# Handoff — 2026-06-20

**Branch:** `main` (live). The shared working copy is checked out on the now-merged `feat/relevant-leaf`.
**Last action:** Wave-2 SHIPPED to `main` (PR #6, `4f654b5`) — relevance-as-filter + calibration citation,
EAV-select-fields-as-conformed-dimensions (ADR-0025 §3), and the field-management semantic-layer binding
(`loadDealbrainModel(db, measureSpecs?, dimensionSpecs?)`). Merged clean with `main`'s ADR-0027 viewing-scope;
**315 pass / 0 fail**, tsc + biome clean. codegen-patterns **#552** (v0.28.1, two generator fixes) also merged.
**Next action:** Update `CLAUDE.md` on `main` to mark Wave-2 SHIPPED (Phase-2 done); then IR/`QueryBackend`
extraction (the remaining hexagonal step) OR the char-net divergence backlog (`grep -rn SUSPECTED-DIVERGENCE`).
**Obstacles:**
- The shared working copy has 4 dirty files (`src/index.ts`, `presentation/nest/options.ts`,
  `query-surface.service.ts`, `scripts/lang-eval/run.ts`) + untracked `viewing-scope.char.spec.ts` — the
  ADR-0027 thread's WIP, already committed on `main`. NOT this session's; leave for that thread.
- real-embed-provider fixture gap (deep-semantic relevance still falsified via the ILIKE stub).

## Notes
- **The field-management app is a NEW companion repo:** `~/Projects/crm-field-management` (git-init'd,
  committed `057dcef`, no remote yet). A codegen-scaffolded NestJS+Drizzle+Bun app on :3210 that curates CRM
  custom fields into a resolved semantic model query-surface consumes. The "low-investment semantic layer":
  a locked canonical library (exact `match_keys`) + tiers (baseline/available/noise, closed-by-default) +
  **1:N derived measures/dimensions per field** (Amount → sum/avg/max measures + a dim, each a named row).
  See memory `crm-field-management-app`. DB = dedicated `crm_field_mgmt` on :54321; `src/cli/` seed/etl/match.
- **The live demo loop:** `crm-field-management` :3210/ui (curate) → query-surface `scripts/wave2-demo` :7878
  (↻ sync) → the measure/dim appears + computes, no restart. Both apps run via `bun run dev` / `bun run …server.ts`.
- The fixture is Bean Maxx (dealbrain :54321), backfilled; reset dump at `~/Projects/query-surface-fixtures/`.
