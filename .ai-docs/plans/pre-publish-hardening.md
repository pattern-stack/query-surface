# Plan — pre-publish hardening (history scrub → license → package hygiene → first npm release)

**Date:** 2026-09-20 · **Status:** APPROVED 2026-09-20 (D1 FSL-1.1-MIT · D2 yes · D3 0.3.0 · D4 "Pattern Stack") — **Phase 0 + Phase 1 DONE** (#44, #46–#49 merged), Phase 2 next · **Owner:** Doug
**Goal:** `@pattern-stack/query-surface` debuts on npm under a license that reserves hosted-service
rights, from a green, CI-gated `main`, with a scrubbed public history; every later release
auto-publishes on version bump via npm trusted publishing (OIDC).

> Hygiene rule for this file and every PR below: never write the third-party individual's name or
> the production figures being scrubbed — refer to them as "the third-party name" / "the prod
> metrics". Re-adding them to a public repo defeats Phase 0.

## Ground truth (verified 2026-09-20)
- Remote: **87 commits on main, 13 branches, 2 tags (`v0.1.0`, `v0.2.0`), 1 GitHub release
  (`v0.1.0`), 34 PRs, 0 forks / 0 stars / 0 watchers, main unprotected.** Sole author (3 git
  identities, all the owner) → no contributor consent needed to relicense.
- Third-party name: **1 file** (`.ai-docs/decisions/ADR-0024-conformed-dimensions.md`), present in
  **84 commits**, 2 string forms (full name; possessive + "iCloud"). Not in any commit message,
  issue, or PR body.
- Prod metrics: `.ai-docs/handoff.md` in **12 commits**; also in the **body of PR #32**.
- **PR #44 is open and green**: `.github/workflows/ci.yml` = `test` job (frozen install, tsc,
  `biome check src`, `bun test`, `scripts/check-pack.sh`) + `publish` job (OIDC, publishes iff
  `package.json` version is not on npm). Nothing on `main` yet.
- Never published to npm. `@pattern-stack` npm org exists (12 packages, write access).
- Gates today: tsc clean · `biome check src` clean · `bun test` 155/0 (347 skip) · with DBURL
  436 pass / **7 fail** (#42) · `bun run lint` **37 errors** in `scripts/` (#43).
- No action (owner ruling): fixture company names (synthetic), hard-coded UUIDs (locally generated).

## Decisions (owner must confirm before the dependent phase starts)
| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| D1 | License | **FSL-1.1-MIT** (Functional Source License). Anyone may use, modify, embed, and ship it in their own product; the one thing barred is a *competing* commercial offering of the software itself (incl. a hosted query-surface). Each release converts to plain MIT after 2 years — fits "own it *for now*", and the sibling packages' MIT future. Alternative: **Elastic-2.0** — narrower wording ("no hosted/managed service"), no sunset, but its "users access a substantial set of features" test is murky for a host that exposes this package's REST/MCP endpoints to its own customers. Rejected: AGPL (does not stop hosting, and makes embedding in closed-source hosts impractical), BSL (needs custom grant drafting), SSPL. | PR-A |
| D2 | Rewrite + force-push all branches and tags | Yes, now — cheapest it will ever be (0 forks, 1 open PR). Destructive; runs only on explicit go. | Phase 0 |
| D3 | npm debut version | **0.3.0**. Clean line: `≤0.2.0` = MIT, GitHub-only; `≥0.3.0` = new license, npm. | PR-F |
| D4 | Licensor name in the copyright line | Confirm "Pattern Stack" is the correct legal entity — it matters more under FSL, where the licensor defines "competing". | PR-A |

**Honest limits of D1:** the new license is *source-available*, not OSI open source (README must say
so; some corporate policies block it). Snapshots already public under MIT (tags `v0.1.0`/`v0.2.0`,
the `v0.1.0` release) stay MIT for anyone who already has a copy — MIT grants are irrevocable.
With 0 forks/stars and no npm release that exposure is practically nil, but it is not zero.
Not legal advice; a 30-minute counsel review of D1 before PR-F is cheap insurance.

## Phase 0 — history scrub — ✅ DONE 2026-09-20
> Executed: 113 commits rewritten (blobs + 3 commit messages), all 13 branches + 2 tags force-pushed,
> fresh-clone verify = 0 hits, PR #32 body edited, `main` now blocks force-push/deletion, local
> worktrees reset + gc'd. Backup (unsanitized — keep off GitHub): `/root/backups/`. **Open owner
> items:** file the Support ticket (`/root/backups/github-support-ticket-query-surface.md`); delete
> PR #32's old body revision (the "edited" dropdown → delete revision); re-clone on the laptop.
> New `main` tip: `3cf8df4`. Add the required `test` status check once #44 is merged.

Original runbook (SERIAL, single operator, nothing else running):
Not for the parallel swarm: it rewrites every SHA, so it goes first and alone.
1. **Freeze.** No agents active; note PR #44 is the only open PR.
2. **Backup.** `git clone --mirror` → tarball kept OFF GitHub (it contains the unsanitized history).
3. **Rewrite** in a second fresh mirror with `git-filter-repo` (`pip install git-filter-repo`),
   `--replace-text` rules: (a) the two third-party-name forms → neutral wording ("the dataset's
   author" / "a local iCloud artifact"); (b) regex rules for the prod-metrics phrases + the
   prod-connection sentence in `handoff.md` → removed/neutral. All refs, both tags.
4. **Verify before pushing:** `git grep` for every scrubbed pattern across `$(git rev-list --all)`
   → **0 hits**; tree at new `main` differs from old `main` ONLY in those two files; commit count
   unchanged (87); `bun install --frozen-lockfile && bun test` green on new `main`.
5. **Force-push** all branches + tags (`--force --all`, then `--force --tags`). PR #44's branch is
   rewritten in the same pass, so it stays consistent with the new `main`. Confirm the `v0.1.0`
   release still resolves to the rewritten tag.
6. **GitHub-side:** edit PR #32's body to drop the prod metrics (`gh pr edit 32`).
7. **Known residue (cannot be fixed from our side):** GitHub keeps `refs/pull/N/head` for all 34
   PRs plus cached commit views, so old SHAs stay fetchable by anyone who knows them until
   **GitHub Support** runs a purge/gc. Owner files that ticket (operator drafts it: repo, the
   sensitive-data-removal request, list of old branch-tip SHAs).
8. **Re-clone everything:** this worktree, `/root/wt/**` siblings, the owner's laptop. Old clones
   must never push again (they would re-introduce the old history).
9. Then enable branch protection on `main` (require the `test` check; block force-push).

**Exit:** 0 grep hits on all remote branches/tags · PR #44 still open + mergeable · support ticket filed.

## Phase 1 — parallel PRs (one agent + one worktree each, all branched from the NEW main)
Merge order matters only where noted; file ownership is disjoint to keep rebases trivial.

| PR | Scope | Files owned | Closes | Verify |
|---|---|---|---|---|
| **#44** (exists) | Add a publish kill-switch: `publish` job `if:` also requires `vars.NPM_PUBLISH_ENABLED == 'true'` — otherwise every merge to `main` runs a publish that fails red until the npm side is bootstrapped, and worse, would auto-ship whatever is on `main` the moment the trusted publisher is configured. **Merge FIRST** so PR-A…E are CI-gated. | `.github/workflows/ci.yml` | — | Actions run green on the PR; publish job skipped |
| **PR-A** license | `LICENSE` → chosen license text (D1, D4); `package.json` `license` SPDX id; README "License" section: source-available, what is allowed (use/modify/embed/ship), what is reserved (competing/hosted offering), the 2-year MIT conversion; note that `≤0.2.0` was MIT. | `LICENSE`, README license section, `package.json#license` | — | SPDX id valid (`npm pack` emits no license warning); check-pack green |
| **PR-B** package hygiene | `sql-formatter` → `devDependencies` (0 refs in shipped bundle; only `scripts/` demos import it); add `homepage`, `bugs`, `keywords`, `author`, `engines` (node ≥ 20, bun ≥ 1.3), `sideEffects`; ~~drop `prepare`~~ (**reverted** — sdlc-patterns' `file:` dep + image builds rely on it; see handoff); stop emitting the orphan `dist/adapters/reference/*.d.ts` (exclude in `tsconfig.build.json` — first prove nothing in the three entry-point graphs imports it); extend `check-pack.sh` to FAIL on `reference/` in the tarball or a non-empty unexpected `dependencies`. | `package.json` (all but `license`/`version`), `bun.lock`, `tsconfig.build.json`, `scripts/check-pack.sh` | — | `scripts/check-pack.sh` green; tarball file list diffed in the PR body; fresh-project install pulls no `sql-formatter` |
| **PR-C** char-net re-pin | The 7 drifted characterization specs. Preferred fix over re-pinning literals: where a spec already computes ground truth via SQL and *also* pins a literal, assert engine == truth and drop the literal (the fixture is non-hermetic; literals will drift again). Re-pin only where no truth query exists. No engine code changes — if a diff reaches `src/internal` or `src/adapters/drizzle/{compile,execute}/*.ts` non-test files, STOP and report. | `src/**/__tests__/*.char.eval.spec.ts` (+ the affected `*.eval.spec.ts`) | #42 | `DBURL=… bun test` → 0 fail; `bun test` (no DB) still 155/0 |
| **PR-D** scripts lint | Fix the 37 biome errors under `scripts/`; delete `scripts/explore-beanmaxx.ts` (self-described throwaway); replace the absolute personal paths in `scripts/lang-eval/{README.md,run.ts}` with repo-relative ones. Follow-up commit on `ci.yml` (after #44 merged): lint step → `bun run lint`. | `scripts/**` (except `check-pack.sh`, `fix-dts-specifiers.ts`), one line of `ci.yml` | #43 | `bun run lint` → 0 errors |
| **PR-E** docs refresh | `handoff.md` rewritten to current state (it is 3 months stale: predates #38/#40/#44 and this plan); `CLAUDE.md` test counts corrected (says 268; actual 436 with DB / 155 without) and the "lint" line updated once PR-D lands; mention CI + release flow. | `.ai-docs/handoff.md`, `CLAUDE.md` | — | grep for scrubbed patterns = 0; numbers match a fresh run |

Every Phase-1 PR: branch from new `main` · `bunx tsc --noEmit`, `biome check src`, `bun test`,
`scripts/check-pack.sh` green locally · CI green · squash-merge · hard rules in `CLAUDE.md` apply
(no raw SQL, no engine behavior change — this whole plan is packaging/docs/tests only).

## Phase 2 — release (SERIAL, after all of Phase 1 is merged)
1. **PR-F release:** `version` → D3; `CHANGELOG.md` entry (license change called out under
   **Breaking**, `sql-formatter` no longer installed, tarball contents change, CI added); README
   install snippet. Merge. Publish job stays skipped (kill-switch off).
2. **Owner, by hand (needs npm credentials + 2FA — no agent can do this):**
   `git clone` fresh → `bun install --frozen-lockfile` → `scripts/check-pack.sh` →
   `npm publish --access public`. This first publish is mandatory: npm cannot attach a trusted
   publisher to a package that does not exist yet.
3. **Owner, npmjs.com → package → Settings → Trusted publishing:** GitHub Actions ·
   org `pattern-stack` · repo `query-surface` · workflow `ci.yml` · environment *(empty)*.
   Optionally then set "require 2FA and disallow tokens" so OIDC is the only publish path.
4. **Owner:** repo variable `NPM_PUBLISH_ENABLED=true`.
5. **Prove the loop:** next real change bumps to `0.3.1` → merge → publish job ships it with a
   provenance attestation (automatic; repo is public). Confirm the provenance badge on npmjs.com.

**Done when:** npm shows the debut version under the new license · `0.3.1` (or next bump) published
by Actions with provenance, no token anywhere · `main` protected + green · #42, #43, #44 closed ·
scrub patterns = 0 hits on every remote branch/tag · GitHub Support purge ticket filed.

## Out of scope
Engine work (ADR-0028), ADR-0027 waves (#12–14), #35/#36/#37, relicensing the sibling
`@pattern-stack/*` packages, fixture company names, hard-coded UUIDs.

## Delegation shape (herdr)
- Phase 0: one operator pane, supervised, explicit go from the owner at step 5.
- Phase 1: `herdr worktree create` per PR (6 worktrees: `pr44-killswitch`, `license`,
  `pkg-hygiene`, `char-repin`, `scripts-lint`, `docs-refresh` — #44 first, the rest fan out once
  it merges), `herdr agent start` + `herdr agent prompt` with that PR's table row + the hygiene
  rule + the per-PR verify list; a coordinator pane uses `herdr agent wait` and merges in order:
  #44 → A, B, C, D (any order) → D's `ci.yml` follow-up → E (last; it records final numbers).
- Only PR-C needs `DBURL` (dealbrain dev DB on `:54321`, up as of today).
- Phase 2: coordinator opens PR-F; steps 2–4 are the owner's.
