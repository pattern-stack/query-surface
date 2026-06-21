# Handoff — 2026-06-21

**Branch:** `main` (`0ac73bb`). Shared working copy is co-driven — see Obstacles.

**Last action:** Engine-reorg DESIGN session. Wrote **[ADR-0028](decisions/ADR-0028-engine-unification-and-query-backend.md)** —
unify the two forked compilers onto one `normalize → plan → lower → execute` pipeline with `grain:'row'|'group'`
as the single discriminator (`query()` = the degenerate row-grain case of `aggregate()`), extract a dialect-neutral
**`QueryPlan` IR + `QueryBackend` driven port** so Snowflake/BigQuery become a new adapter folder. Built via an
ultracode workflow (8 grounded probes → 3 adversarial reviews → synthesis). Gating decisions SETTLED: **§8/§A diamond
addressing** (name-the-route edge grammar + host-canonical default + `describe()` per-leg surfacing + synthetic
asymmetric fixture; union-closure deferred) and **§B scope-upgrade rollout** (ship the tightening WITH the cut).
Shipped the one pre-req bug fix: **the `fetch()` expand scope leak** — fail-closed scope folded through every
traversed relation (invariant #3) — **merged to main, PR #15 (`0ac73bb`)**, char-pinned (`expand-scope.char.eval.spec.ts`).

**Next action:** The engine reorg is **DESIGNED, 0% BUILT** — nothing on `main` has changed except the expand fix.
Execute ADR-0028's strangler sequence (each step PR-sized; several sessions):
  - **Step 0** — `DealbrainModel → AggregateModel` rename (free, isolated, mechanical prep).
  - **Step 1 (Gate 0)** — the relation-name→entity-prefix grammar normalizer + the **synthetic asymmetric-diamond fixture**.
  - **Step 2** — HARDEN the char net BEFORE any lowering change: connective (AND/OR/NOT incl. has_many-EXISTS), pagination
    (`offset`, `has_more===true`, page-union), `runSearchMulti` — all DB-gated, pin `compiler.ts`'s CURRENT behavior first.
  - **Steps 3–8** — define `QueryPlan`+`QueryBackend`; make the aggregate adapter implement it; add `grain:'row'` lowering
    (land `fetch()` first); port query-only capabilities (computed subqueries, EAV Shape-B jsonb, FTS lexical, text-magic,
    projection/snippet/PK, EAV-inner semijoin); the gated cut (scope upgrade lands here); retire `compiler.ts`.
Remaining ADR open items are tactical (recs in hand): **§D** value-type (numbers-as-numbers), **§E** error vocabulary,
**§F** keep `compiler.ts` one release.
**Also still PARKED:** the **surface rebrand = the "new 5 words"** (rename the 5 primitive verbs —
`describe/query/fetch/aggregate/compare`). DECIDED this session: DON'T do it standalone — **fold it into the
engine-reorg cut** (it's a breaking public-API change: REST routes + MCP tool names + agent prompts → bundle
with the cut's already-breaking scope/value-type changes = one breaking release, one consumer migration).
ACTION: Dug to supply the candidate 5 words → lock them (design-only, free) now → defer the code rename to ride
Steps 6–8. (NB: the *codebase* hexagonal reorg is already SHIPPED — only the ENGINE reorg above remains.)

**Obstacles:**
- **Co-driven working copy.** A parallel thread's uncommitted **`artifacts` WIP** lives in this shared checkout
  (`schema.dealbrain.ts` adds the `artifacts` table + relations; `harness.ts` registers it). It's RED on 2 hard-coded
  entity-count specs (`harness — smoke`, `describe-catalog` both assert exactly 3 entities; it adds a 4th). NOT ours —
  left untouched. Check `git branch --show-current` + `git status` before any commit (memory: co-driven git gotcha).
- **Pre-existing biome drift** in `src/adapters/reference/model.dealbrain.ts` (biome 1.9.4, around the `artifactId`
  role tag) on `main` HEAD — unrelated to our work; may show a red biome step in CI repo-wide.
- ADR-0028 + this handoff are uncommitted docs in the working tree (clobber risk under the co-driven copy until PR'd).

## Notes
- The interior (`src/internal/`) is ALREADY dialect-free; the aggregate path is ALREADY plan→lower (`grain.ts`,
  `join-plan.ts`, `doctor.ts`). The reorg is interface-extraction + retiring the legacy `compiler.ts` query path,
  NOT a green-field rewrite. Risk is concentrated at Steps 6–8, fully gated by the char net.
- Bean Maxx diamond is symmetric/redundant: `observations.account_id` agrees with `opportunity.account_id`
  29039/29039 (0 disagree, 0 account-level obs) — so the asymmetric-diamond char fixture MUST be synthetic.
- Eval gate (unchanged): `DBURL=postgres://postgres:password@localhost:54321/dealbrain bun test` (DB-gated specs skip
  without DBURL). The 2 current fails are the other thread's artifacts WIP, not regressions.
