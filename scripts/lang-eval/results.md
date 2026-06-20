# Agent-Ergonomics Filter Eval

## Model
qwen2.5:7b (temperature=0, single-shot)

## Aggregate Summary

| Format | Valid | Total | Pass Rate |
|--------|-------|-------|-----------|
| FORMAT A (raw Predicate tree) | 20 | 20 | 100% |
| FORMAT B (mongo/prisma DSL) | 20 | 20 | 100% |

## Per-Intent Results

| # | Intent | A valid? | B valid? |
|---|--------|----------|----------|
| 1 | Simple equality: account name equals "Acme Corp" | ✓ | ✓ |
| 2 | Numeric greater-than: opportunity amount > 50000 | ✓ | ✓ |
| 3 | Numeric less-than: opportunity amount < 10000 | ✓ | ✓ |
| 4 | Between: opportunity amount between 10000 and 100000 | ✓ | ✓ |
| 5 | In-list: dealstage in ["proposal", "negotiation", "closed_won"] | ✓ | ✓ |
| 6 | Not-in-list: dealstage not in ["closed_lost", "disqualified"] | ✓ | ✓ |
| 7 | Null check: opportunity closedate is null | ✓ | ✓ |
| 8 | Not-null check: opportunity closedate is not null | ✓ | ✓ |
| 9 | Text contains: account name contains "tech" | ✓ | ✓ |
| 10 | Text startsWith: account name starts with "Acme" | ✓ | ✓ |
| 11 | Compound AND: amount > 50000 AND dealstage = "negotiation" | ✓ | ✓ |
| 12 | Compound OR: dealstage = "closed_won" OR dealstage = "closed_lost" | ✓ | ✓ |
| 13 | Nested AND-of-ORs: (dealstage = "proposal" OR dealstage = "negotiation") AND amount > 20000 | ✓ | ✓ |
| 14 | Negation: NOT (dealstage = "closed_lost") | ✓ | ✓ |
| 15 | Date comparison: observation occurred_at > "2024-01-01" | ✓ | ✓ |
| 16 | Multi-field AND: pipeline = "enterprise" AND amount >= 100000 AND closedate is not null | ✓ | ✓ |
| 17 | Text endsWith: account name ends with "Inc" | ✓ | ✓ |
| 18 | Numeric gte+lte (range): observation occurred_at >= "2024-01-01" AND occurred_at <= "2024-12-31" | ✓ | ✓ |
| 19 | Type equality: observation type = "email" | ✓ | ✓ |
| 20 | Complex nested: (type = "meeting" OR type = "call") AND occurred_at > "2024-06-01" | ✓ | ✓ |

## Format A Failures (0)

_None_

## Format B Failures (0)

_None_

## Format A Sample Output (Intent 1)

```json
{
  "op": "eq",
  "left": {
    "from": "entity",
    "path": "name"
  },
  "right": {
    "from": "literal",
    "value": "Acme Corp"
  }
}
```

## Format B Sample Output (Intent 1)

```json
{
  "name": "Acme Corp"
}
```
