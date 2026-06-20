# ADR-0025 — Remap ergonomics + context-layer binding

**Status:** proposed — surfaced by the **Bean Maxx fixture switch** (ADR-0024 Amendment 2 §6): swapping the eval fixture from the old dealbrain dev DB to the richer Bean Maxx dataset on the *same* Postgres was a *config + role-tag* exercise, **not** an engine change — which is the point. The engine is already schema-agnostic: it hard-codes no entity names; the cardinality graph is introspected from Drizzle `relations()` (`buildRegistry` → `join-plan.ts`); a host binds a new domain with its own Drizzle tables + relations + ~15 lines of `role`-tagged `FieldMeta` + options (`adapters/reference/model.dealbrain.ts` is the reference instance). This ADR records the **ergonomics gap** that the 2nd concrete schema exposed: the remaining friction in *binding a new host* is not engine power, it's the **shape of the binding surface**. · **Scope:** forward items only — making remap a config exercise, not code surgery. **Deliberately a stub**; the real shape gets settled *after* Wave-2 (see §Sequencing). · **Builds on** [ADR-0024](./ADR-0024-conformed-dimensions.md) (conformed dimensions + the Wave-2 relevance-as-filter slice; Amendment 2 §6 = the Bean Maxx adoption that forced this).

---

## Context

Bean Maxx is the **second concrete host schema** the surface has been bound to (dealbrain was the first). The bind was cheap — same Postgres, host-supplied tables/relations, a handful of role tags, and reconciled options. That cheapness *validates* invariant #7 (the model is host-supplied; the package hard-codes no schema). But a 2nd schema is also the first honest signal of **where the binding surface is still dealbrain-shaped** — places where "config" silently means "the dealbrain way", and a genuinely different host would hit code, not declaration. None of these block Bean Maxx; all of them are debt that compounds at host #3. Recording them now (decision-oriented, not yet decided) so the abstraction is designed from *two* data points, not one.

## Decision (none yet — forward items)

This ADR **proposes the agenda, not the design.** The items below are the ratification targets; each is deferred past Wave-2 (§Sequencing) so the 2nd schema + relevance-as-filter teach the real shape before we draw the line.

1. **Pluggable EAV strategy.** Today the only custom-field strategy is `'typed-columns'` (`adapters/drizzle/eav/read.ts` dispatches on `desc.eav.kind === 'typed-columns'`), which bakes in dealbrain's `field_values` / `field_definitions` typed-column shape. Treat that as **canonical for now** — it's correct for both fixtures. But a 2nd custom-field model (codegen-patterns is the known 2nd shape) must land as **a new strategy behind the existing `eav.kind` dispatch**, not engine surgery. The dispatch seam already exists; the decision is to *keep it a seam* and resist inlining dealbrain assumptions deeper.

2. **Engine type rename (cosmetic coupling).** The Drizzle compiler is typed against `DealbrainModel` (`compile-drizzle.ts` — ~15 signatures: `nativeColSql`, `colObj`, `scopeSqlFor`, `compileNaiveDrizzle`, …), but `DealbrainModel` is literally `type DealbrainModel = AggregateModel` — a **pure alias** (`model.dealbrain.ts:29`). The interior is already neutral; the *naming* leaks the reference instance into engine code. **Rename the engine's usages to `AggregateModel`**; keep `DealbrainModel` **only** in `adapters/reference/` as the ready-to-import dealbrain instance — the legitimate stitching seam where the concrete host meets the generic engine. Cosmetic, low-risk, but it removes a false "the engine knows about dealbrain" signal that a new-host binder would read as coupling.

3. **First-class context-layer binding.** `observations` is currently modeled *generically* — "a `has_many` child entity with a semantic text column + an embedding column" — wired through scattered surfaces: `FieldMeta` role tags, the `semanticColumns` option (`Record<entity, Record<textCol, embeddingCol>>`, `presentation/nest/options.ts`), and the relation graph. Conceptually it is **not** just a child entity: it is a **context/evidence layer** — normalized, typed, embedded signals FK'd *up* to business entities (the obs→account direct edge + obs→opportunity→account path). Wave-2's relevance-as-filter is, precisely, *"constrain the parent grain by a semantic match on that context layer, semijoined up."* Propose a **declarable** binding —

   ```
   contextLayer: {
     entity, parents,                        // the evidence rows + their FK path(s) up to business entities
     text, embeddings: { primary, facets },  // primary = full-text vector; facets = per-type field vectors
     typeKey,                                 // the polymorphic discriminator (observations.type)
     fields,                                  // per-type typed structured_data: dims / measures / relevance-prose
   }
   ```

   — so pointing the surface at a *new* domain's evidence layer is **one declaration**, not scattered `FieldMeta` + `semanticColumns` + relation wiring that a binder has to assemble correctly across three files. This generalizes past CRM: support tickets, call transcripts, document chunks — any "evidence FK'd up to entities" layer becomes a one-line bind. **This is the highest-leverage item** and the one most coupled to Wave-2 (don't draw it until relevance-as-filter exists — §Sequencing).

   **The third field-source (surfaced in the Bean Maxx dive).** An observation is a **typed polymorphic document**: a `type` discriminator + a `structured_data` JSONB whose per-type shape is validated on write but defined in the *host's code* (the observation output schemas), **not** self-describing in the DB (`observation_schemas.output_contract` is a pointer, not a field schema). Same-type rows are consistently shaped (every `risk` → `{risk, severity, category, …}`; every `pricing_signal` → `{polarity, amount_usd, …}`), and the embedding design mirrors it: `primary` embeds the full `normalized_text`, an optional per-type **facet** embeds the one defining prose field (`risk` → `structured_data.risk`), never the categorical tags (`severity`, `category`). Today the engine can *extract* a known key (the compiler lowers JSON dotted paths to `->>`, `compile-drizzle.ts:68`) but cannot *catalog* them — the reference model tags `structured_data` as one opaque dimension, so `describe()` never advertises the per-type keys, their types, or enum values. So the catalog model gains a **third field-source — native ⊕ EAV ⊕ typed-JSONB-document** — and `contextLayer` must let the host declare, **per `type`**, which structured fields are **dimensions** (`severity`, `category`), **measures** (`amount_usd`), and **relevance prose** (`risk`). The DB can't derive this (the shape lives in host code); the binding must carry the legend. This is also what makes the pitch concrete on one entity: *a metric over a relevance cohort, grouped by a type-dimension, filtered by a structured field* all resolve on the observation row.

4. **Binding scaffold.** A tool that **introspects** a Drizzle/Postgres schema and **proposes** the model — candidate `role` tags, the relation/cardinality graph (already derivable via `relations()`), and candidate semantic columns (text + adjacent vector column) — for the host to **refine**. Today binding is hand-written (correct, but manual); the cardinality graph is already machine-derivable, so the scaffold is mostly *surfacing what the engine already introspects* plus role-tag heuristics. Goal: remap becomes a **config exercise the host edits down**, not code the host writes up.

## Consequences

- Invariant #7 (host-supplied model) stays the spine; these items make *living up to it* ergonomic rather than expert-only.
- §2 (rename) is a free, immediate clarity win and could land independently of the rest — it has no design risk, only churn.
- §3 (contextLayer) is the conceptual prize and the one that **must** wait for Wave-2: relevance-as-filter is the first consumer that treats the evidence layer *as* a layer (semijoin-up), so its real shape is taught by that build, not guessable before it.
- §1 and §4 keep the door open for host #3 without paying for it now (no premature strategy/scaffold abstraction).

## Sequencing note

**Deliberately deferred until AFTER Wave-2.** The wave-1 lesson (ADR-0024) was that abstractions drawn from one data point fabricate the wrong shape. We now have the **2nd concrete schema (Bean Maxx)**, and Wave-2 (**relevance-as-filter**, ADR-0024 §Direction A/B/C) will be the **first real consumer** of the context layer as a *layer*. Drawing the `contextLayer` binding (§3), the EAV strategy seam (§1), and the scaffold (§4) *before* those exist would re-run the premature-abstraction mistake. Hold this as a recorded agenda; settle it when Bean Maxx + relevance-as-filter have taught the abstraction its real edges.

---

*Cross-ref: [ADR-0024 — conformed dimensions](./ADR-0024-conformed-dimensions.md) (the conformed-dimension model + the Wave-2 relevance-as-filter slice that this binding work serves; Amendment 2 §6 = the Bean Maxx fixture adoption that surfaced these items).*
