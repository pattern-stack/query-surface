# Handoff — 2026-06-30

**Branch:** `main` (== origin/main, clean tree).
**Last action:** Merged **PR #32** (`b1bd4d7`) — `ConformedDim.valueDomain: 'declared' | 'open'` on the
`describe` surface. The model now reads `field_definitions.select_options`; an EAV select dim / native
enum → `declared`, free-string/to-one → `open`. No new verb, no scan — declared values stay in
`key_fields`, live values for an `open` dim come from the existing `measure(group_by:[path])` (scoped).
MCP describe adds a `dimensions_note` when any dim is open.
**Next action:** Nothing required in-repo — `valueDomain` is complete. Frontier moved to the **retrieval
agent** (cross-repo, see memory `retrieval-agent-landscape`): the upgrade = **marry** the canvas analyst
(`canvas-workstation/src/query-surface/`, newest, new 5-verb surface, wiring-proven only) with the
**legacy v1** (`/Users/dug/Projects/retrieval-agent/src/`, proven + benchmark-calibrated, old REST
surface). Mine legacy's **eval harness** (`packages/benchmarks/agent-eval/` + ground-truth corpus +
`questions.jsonl`), its **calibrated manual**, and its **judgments**; re-target them at the analyst.
**Linchpin to verify FIRST:** does `dealbrain-projection/scripts/mcp-serve.ts` pass the engine's new
`describe.valueDomain` through, and are its MCP verb names the new `select`/`measure` or old
`query`/`aggregate`? (The analyst calls the new names — a mismatch blocks it.)
**Obstacles:** none. (Op note: the running query-surface MCP server has pre-merge code — `/mcp` reconnect
to pick up `valueDomain`.)

## Notes
- **Suite:** 398 pass / 12 fail. The 12 are the pre-existing `OPENAI_API_KEY` embedding-drift specs
  (relevance-as-filter / observations-retrieval / rank_by / citation-chain) — unrelated. `tsc` + `biome
  check src` clean. (PR #32 added 2 passing tests over the prior 396 baseline.)
- **Deferred enhancements on this feature (only if wanted, NOT gaps):** the declared-vs-observed **drift
  diff** (`dirty:true` when observed ⊄ declared) and a **high-card `limit` guard** on `measure(group_by)`.
  Both are enhancements — the capability (cardinality/values via `measure`) already exists.
- **Why declared ≠ truth (prod-grounded):** measured against prod (18 orgs, 4.2M field_values) — 43% of
  opportunity select fields have UNUSED declared options, 13.5% carry UNDECLARED (drift) values. So
  declared `select_options` is a trustworthy PRIOR, not exhaustive. See memory
  `prod-select-options-divergence`. (Prod readonly conn was used this session; not stored — Doug has it.)
- **The design exploration** (workflow: profile-verb vs tiered-inline panel) concluded the heavy "profile
  scan" machinery was unnecessary — `measure` already IS the scoped scan. We shipped only the missing
  *prior + classification*. ADR amendment under ADR-0024 was NOT written (the change is small + self-
  documenting via the inline comments + this handoff); write one if the drift-diff/guard follow-ups land.
- **DB:** `DBURL=postgres://postgres:password@localhost:54321/dealbrain` (dealbrain's dev DB, Bean Maxx).
