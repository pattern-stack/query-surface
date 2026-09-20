# Handoff — 2026-09-20

**Branch:** `main` (protected: requires the `test` check, blocks force-push).
**Last action:** Ran the pre-publish hardening plan (`.ai-docs/plans/pre-publish-hardening.md`).
Phase 0: public history scrubbed and force-pushed (all branches + tags). Phase 1, all merged: **#44**
first CI + OIDC publish job behind the `NPM_PUBLISH_ENABLED` kill-switch · **#46** relicense to
**FSL-1.1-MIT** · **#47** publish-ready `package.json` (no runtime deps, metadata, orphan reference
`.d.ts` no longer shipped, stricter `check-pack.sh`) · **#48** char net asserts engine == SQL truth
instead of drifting literals (closed #42) · **#49** whole-repo lint green and gated in CI (closed #43).
**Next action:** Phase 2 — merge the `prepare` restore PR, then the **0.3.0 release PR**; then the
owner, by hand: (1) `npm publish --access public` from a fresh clone of `main` (npm cannot attach a
trusted publisher to a package that does not exist yet); (2) npmjs.com → package → Settings → Trusted
publishing → GitHub Actions · `pattern-stack` / `query-surface` / `ci.yml` / no environment; (3) set
repo variable `NPM_PUBLISH_ENABLED=true`; (4) prove the loop with the next bump (expect a provenance
badge on npm).
**Obstacles:** none blocking. Optional owner items left from the scrub: GitHub Support purge of the
old commits still held by `refs/pull/*` (draft ticket kept outside the repo), and deleting PR #32's
old body revision. Old commits are not reachable from any branch or tag.

## Notes
- **Suite:** 443 pass / 0 fail with `DBURL`; 155 pass / 347 skip / 0 fail without (what CI runs).
  `tsc`, `bun run lint`, `scripts/check-pack.sh` clean. Tarball: 63 files.
- **Lesson — keep `prepare`.** #47 dropped it and a follow-up restored it: sdlc-patterns consumes this
  checkout as a `file:` dep and its Docker builds rely on `bun install` here building `dist/`. #45
  (bun's git-install route fails on the optional Nest/MCP adapters' types) is still open.
- **The fixture keeps growing.** The live Bean Maxx DB gained hidden opportunity field defs and more
  key fields since the char net was pinned — that is what #42 really was. Six passing specs still
  carry literal counts beside truth queries (retrieval-eav 95/29/60, retrieval-joins 295/1,
  relevant-filter 178); they will drift the same way — convert them when they do.
- **Dead demo scripts:** `scripts/wave2-demo/server.ts` boots but its POST routes call verbs that no
  longer exist (`aggregate`/`query`); `scripts/compare-explore.ts` + `compare-qa.ts` import a removed
  `src/engine/aggregate/*`. Lint-clean, not runnable. `qs-showcase` supersedes wave2-demo — delete or
  port is the owner's call.
- **19 shipped `.d.ts` files are unreachable** from the three entry points (e.g. `adapters/drizzle/eav/*`)
  — harmless weight; and `tsconfig.json` still carries a stale "Vendored working copy" comment.
- **Engine frontier unchanged:** ADR-0028 (QueryPlan IR + `QueryBackend` port) is designed, 0% built;
  open engine issues #35, #36 (scope must reach joined tables — a correctness bug), #37; ADR-0027
  waves #12–#14.
- **DB:** `DBURL=postgres://postgres:password@localhost:54321/dealbrain` (dealbrain's dev DB, the
  synthetic Bean Maxx fixture — read-only from here).
