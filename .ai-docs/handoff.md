# Handoff — 2026-06-29 (v0.1.0 released)

**Branch:** `main` (== origin/main, clean tree). **Released `v0.1.0`** — the first tag/GitHub release.

**Last action:** Shipped ADR-0029 **D4 expression measures** + the **to-one expression-col** follow-up, then cut **v0.1.0**. Five PRs merged this session: #27 (D4 — row-level `RowExpr` measures + missing→0), #28 (biome `src` 13→0), #29 (D4 follow-up — to-one cols), #30 (docs/release — deep README, CHANGELOG, ADR-0029 shipped amendment, verb-name fixes, version 0.0.0→0.1.0). ADR-0029 is complete through D4 + to-one.

**Next action:** No committed query-surface work remains — it's at a release boundary. The active frontier is in **sibling repos** (see the workspace `../CLAUDE.md`): finish `resolveUniverse` dispatch + commit the `bySemantic` probe in **`dealbrain-projection`**; or the **L3 agents** in **`canvas-workstation`**. In-repo deferred (no pressure): D5 (measures-also-simple-metrics), the cumulative/window rung, ADR-0028 (the `QueryPlan` IR + `QueryBackend` port — only when a second backend is needed).

**Obstacles:** none blocking.

## Notes
- **Full suite:** 396 pass / 12 fail. The 12 are **pre-existing** `OPENAI_API_KEY`/embedding-drift specs (relevance-as-filter / observations-retrieval / rank_by / citation-chain) — verified unrelated via `git stash`. `tsc` clean; `biome check src` clean (cleared 13→0 in #28).
- **Fixture gap:** `accounts` has no numeric field, so the literal `Amount · account.weight_factor` to-one shape is capability-complete but not *eval-pinned* — the to-one eval reaches `observations → opportunities` instead (identical machinery).
- **Verb names:** the public surface is `describe · select · fetch · measure · compare` (locked ADR-0024 Amend 3). README + CLAUDE.md primitives were stale (`query`/`aggregate`) and were fixed in #30; deeper conceptual `aggregate()` mentions in CLAUDE.md's hard-rules prose were left (a future surgical pass).
- **DB:** `DBURL=postgres://postgres:password@localhost:54321/dealbrain` (dealbrain's dev DB, Bean Maxx fixture). Bring it up there if down.
- **Workflows this session** were lead-reviewed + independently gate-verified before merge (not merged on reviewer verdict alone) — the reviewers caught real bugs in prior workflows, so the lead pass stays mandatory.
