# ADR-0001 — The forgiving DSL is Predicate's ingress sugar, not a dialect

- **Status:** Proposed — 2026-06-20
- **Amends:** swe-brain `RFC-0002 §4` (Expression-language convergence) + `CLAUDE.md` Hard Rule 9. Drafted here (the language's implementation home) to be lifted into RFC-0002 as **Amendment C** once ratified.
- **Decision owner:** Dug

---

## Context

swe-brain's Hard Rule 9 / RFC-0002 §4 lock **Predicate** as the one expression
language: *"FilterExpression is deprecated-on-contact; no new consumer speaks
it, no adapter is written for it… no translation layers."*

query-surface was built (in the swe-brain lineage, now this repo) on a different
bet: a **forgiving Mongo/Prisma-style DSL** (`{amount:{gt:100000}}`,
`{type:["risk","objection"]}`, implicit-AND across fields, hybrid `{op,value}`
leaves) over a `FilterExpression` AST. The bet is empirical, documented inline
in `filter-normalize.ts`: small models **reliably generate** the natural form
and **reliably mis-emit** verbose structured leaves. The whole point of the
surface is that agents author filters, so first-attempt validity is the metric.

The standalone `query-surface-poc` adopted §4 **literally** — it deleted
`FilterExpression` *and* the forgiving normalizer, exposing **raw Predicate**
(`{op:'eq', left:{from:'entity',path}, right:{from:'literal',value}}`). Its
agents now must emit the verbose tree by hand.

**The tension is a conflation in §4.** "FilterExpression" names two different
things that §4 deprecates as one:

1. the **canonical AST** — the `{on,op,value}` tree the compiler walks; and
2. the **agent-facing ingress** — the forgiving wire shorthand agents type.

Deprecating (1) is right. Deprecating (2) throws away the only reason
query-surface is agent-usable, for no language-purity gain.

## Decision

**Separate the two layers and sanction the ingress.**

1. **Canonical AST = Predicate.** `FilterExpression`-as-canonical-AST is
   deprecated and replaced by the locked Predicate tree (RFC-0002 §4 unchanged
   on this point). The compiler walks Predicate.

2. **The forgiving Mongo/Prisma DSL is a SANCTIONED surface syntax** — a
   forgiving **deserializer** that parses into Predicate's *resolved-residue*
   subset. It is **not** `FilterExpression`, **not** a competing dialect, and
   **not** a translation/adapter layer. It is Predicate's agent-facing wire
   sugar, exactly as `[1,2]` and `new Array(1,2)` are two surfaces of one Array.

The **"no translation layers"** invariant is preserved verbatim: there is no
`FilterExpression ↔ Predicate` translator anywhere. There is **one language
(Predicate) with two surface encodings** — the explicit canonical form and the
forgiving sugar — both *deserializing* to the same tree.

## The boundary (load-bearing)

The sugar can express **only** the resolved-residue subset: `{from:'entity'}`
path vs `{from:'literal'}` value comparisons, under `and`/`or`/`not`, over the
op set. It **cannot** express the dynamic bindings (`trigger` / `step` / `loop`
/ `context` / `computed` / `secret`) — those stay explicit Predicate. This is a
clean split, not a compromise:

| Surface | Covers | Used for |
|---|---|---|
| **Forgiving sugar** | entity-path vs literal, and/or/not | data queries + static filters — the ~95% case agents author |
| **Explicit Predicate** | the full Binding set | dynamic-scope filters in workflows (filters that reference live run state) |

Both are the same language. An agent querying data writes `{"dealstage":"won"}`;
an agent authoring a workflow filter that references `trigger.payload` writes the
explicit binding.

## Why this matters beyond query-surface

Because `query-surface-poc` took the literal reading, **every agent-facing
Predicate surface in swe-brain today demands raw Predicate** — trigger
authoring, Find where-clauses, the frontend FilterEditor. Sanctioning the sugar
lets it become the standard forgiving ingress for **all** Predicate surfaces.
This *serves* RFC-0002 §4.2's invariant ("the LLM plans inside the structural
envelope") rather than fighting it — it just makes the envelope one agents can
hit on the first try.

## Empirical basis

`scripts/lang-eval/` measures small-model first-attempt **structural validity**
generating a filter in each form (FORMAT A = raw Predicate, FORMAT B = the
forgiving DSL validated through this repo's `filter-normalize`).

> **Result (2026-06-20, `scripts/lang-eval/`):** model `qwen2.5:7b`, temp 0,
> 20 intents — raw Predicate **20/20**, forgiving DSL **20/20**. **Inconclusive
> (ceiling effect):** a capable 7B model given detailed specs saturates both
> forms, so the headline metric found no gap.
>
> The signal is **qualitative**: even at 100% structural validity, raw Predicate
> forced the model to *decompose* compact operations — `between` → `and:[gte,lte]`,
> `in` → OR-of-eq chains, `isNotNull` → `not:{isNull}` — emitting ~20-line nested
> trees where the forgiving form was a one-liner. The lenient validator accepted
> the decompositions as structurally valid; a **stricter canonical-form validator
> would drop raw Predicate well below 100%.** So the verbosity cost is real but
> unquantified.
>
> To get a decisive number the eval needs a harder setup: a weaker/smaller model
> (≤3B, quantized), minimal prompts (no worked examples), and/or a canonical-form
> validator. Deferred with the convergence decision — the direction question
> (below) is not yet evidence-settled.

## Consequences

- **This repo's convergence (the prototype):** canonical AST `FilterExpression
  → Predicate`; the compiler's leaf reads the Predicate leaf
  (`{op,left,right}` / `{op,clauses}` / `{op,clause}`); **`filter-normalize` is
  RETAINED and retargeted** to emit Predicate (not deleted, contra
  `query-surface-poc`). The package's public filter type becomes Predicate; the
  forgiving ingress survives. The characterization net (DB-backed) is the gate.
- **`find.ts` becomes a native fit:** it already hands a resolved Predicate;
  query-surface now accepts it without the documented boundary cast.
- **RFC-0002 §4 table** (query-surface row) → "boundary types swap to Predicate;
  **forgiving ingress retained as Predicate surface sugar**; compiler internals
  retained."
- **Hard Rule 9** gains the carve-out: the one language is Predicate; a forgiving
  *deserializer* for its residue subset is sanctioned surface syntax, not a
  second dialect.

## Alternatives rejected

- **Literal §4 (what `query-surface-poc` did)** — delete the forgiving form,
  agents emit raw Predicate. Rejected: sacrifices the agent-generation goal that
  is query-surface's reason to exist; the eval quantifies the cost.
- **A FilterExpression↔Predicate translation adapter** — keep both ASTs, bridge
  them. Rejected: this is the exact anti-pattern §4 forbids, and it entrenches
  two languages instead of one language with two surfaces.
