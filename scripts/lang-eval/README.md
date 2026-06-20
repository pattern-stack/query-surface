# Agent-Ergonomics Filter Format Eval

Measures first-attempt validity of a small local model generating data-query
filter expressions in two formats, to determine whether the agent-friendly DSL
(FORMAT B) beats the raw Predicate tree (FORMAT A).

## Formats Under Test

**FORMAT A — raw Predicate tree**

The verbose, structured AST the query engine compiles:
```json
{
  "op": "eq",
  "left": { "from": "entity", "path": "name" },
  "right": { "from": "literal", "value": "Acme Corp" }
}
```

**FORMAT B — mongo/prisma forgiving DSL**

The natural form that `src/internal/language/filter-normalize.ts` accepts and
normalizes into the same canonical `FilterExpression` AST:
```json
{ "name": "Acme Corp" }
```

## Prerequisites

- [Ollama](https://ollama.com) running at `http://localhost:11434`
- A small instruct model pulled (default: `qwen2.5:7b`)
- Bun installed

```bash
# Install and start Ollama (macOS)
brew install ollama
brew services start ollama

# Pull the model
ollama pull qwen2.5:7b
```

## Running

```bash
# From the repo root
cd /Users/dug/Projects/query-surface
bun scripts/lang-eval/run.ts
```

40 LLM calls total (20 intents × 2 formats). Expect ~2–5 minutes depending on hardware.

## Output Files

| File | Contents |
|------|----------|
| `intents.json` | 20 natural-language query intents over a CRM-ish schema |
| `results.json` | Raw per-call results: intent, format, raw LLM response, parsed JSON, validity, error |
| `results.md` | Human-readable report with per-intent table + aggregate summary |

## Schema

The eval covers these CRM entities:
- `accounts`: `name`
- `opportunities`: `amount`, `dealstage`, `closedate`, `pipeline`
- `observations`: `type`, `occurred_at`, `account`, `opportunity`

## Validity Criteria

- **FORMAT A**: Recursively validated against the expected Predicate node shapes by
  `validate-predicate.ts`. Must have correct `op`, `left`/`right` structure with
  proper `from` discriminants.
- **FORMAT B**: Passed through `normalizeFilter()` from `filter-normalize.ts`.
  Valid = no throw.

## Changing the Model

Edit the `MODEL` constant at the top of `run.ts`, or modify to auto-discover from
the Ollama tags API.
