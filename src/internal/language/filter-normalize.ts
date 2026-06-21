// Filter input normalizer — accepts the NATURAL (Mongo/Prisma-style) filter DSL that LLM
// agents and human devs reach for by default, and the legacy explicit {on,op,value} leaf, and
// produces the canonical `FilterExpression` AST the compiler consumes. One front-door
// translation; the engine below stays unchanged.
//
// Why this exists: small models reliably mis-emit the 3-sibling-key leaf {on,op,value} (they
// collapse "op":"eq","value":X). They DON'T mis-emit {field: value} / {field: {op: val}} —
// that idiom saturates their training data. Aligning the primitive with that prior removes a
// whole class of agent failure and reads better for humans too.
//
// Accepted forms:
//   { "dealstage": "closedwon" }                     scalar            ⇒ eq
//   { "amount": { "gt": 100000 } }                   operator object   ⇒ that op
//   { "amount": { "gte": 1000, "lte": 5000 } }       multiple ops      ⇒ AND on the field
//   { "type": { "in": ["objection","risk"] } }       in / nin          ⇒ list op
//   { "type": ["objection","risk"] }                 bare array        ⇒ in
//   { "closedate": { "is_null": true } }             null check (false ⇒ is_not_null)
//   { "stage": "x", "amount": { "gt": 1 } }          multiple fields   ⇒ implicit AND
//   { "or": [ … ] }  { "and": [ … ] }  { "not": … }  explicit logic
//   { "on": "stage", "op": "eq", "value": "x" }      legacy explicit leaf (escape hatch)
//   { "amount": { "op": "gt", "value": 1 } }         hybrid leaf — the explicit pair nested
//                                                    under a natural field key. gpt-oss-20b and
//                                                    qwen3.6 both emit this deterministically
//                                                    (2026-06-11 translation benchmark: sole
//                                                    cause of every first-attempt 400 on both);
//                                                    the literal key "op" is never an operator
//                                                    alias, so accepting it is purely additive.
//
// Ambiguity rule: an object whose keys are exactly logical combinators (and/or/not) is a
// logical node; anything else is an implicit-AND of field conditions. A field literally named
// "and"/"or"/"not" must use the legacy {on,op,value} form.

import { ENGINE_ERROR } from './error-messages.ts';
import type { FilterExpression, LeafFilter, Op, RelevantLeaf } from './types.ts';

const E = ENGINE_ERROR.FILTER;

const CANONICAL_OPS: ReadonlySet<string> = new Set<Op>([
  'eq',
  'neq',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'contains',
  'startswith',
  'endswith',
  'matches',
  'is_null',
  'is_not_null',
]);

// Natural operator-key → canonical Op. Note: `not` is intentionally NOT an alias — it is the
// logical-negation key and is handled at the object level.
const OP_ALIAS: Readonly<Record<string, Op>> = {
  eq: 'eq',
  equals: 'eq',
  ne: 'neq',
  neq: 'neq',
  in: 'in',
  nin: 'nin',
  not_in: 'nin',
  notIn: 'nin',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  between: 'between',
  contains: 'contains',
  like: 'contains',
  startswith: 'startswith',
  startsWith: 'startswith',
  endswith: 'endswith',
  endsWith: 'endswith',
  matches: 'matches',
  search: 'matches',
  is_null: 'is_null',
  isNull: 'is_null',
  is_not_null: 'is_not_null',
  isNotNull: 'is_not_null',
};

const LOGICAL = new Set(['and', 'or', 'not']);

/** Strip literal wrapping quotes / whitespace from a key (small-model over-escaping). */
const stripKey = (k: string): string => k.trim().replace(/^["']+|["']+$/g, '');

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asFilterArray(v: unknown, key: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${E} "${key}" must be an array of filters`);
  if (v.length === 0) throw new Error(`${E} "${key}" must be a non-empty array`);
  return v;
}

/** Convert one `field: value` natural condition into one or more canonical leaves. */
function fieldConditions(field: string, val: unknown): LeafFilter[] {
  if (val === null) return [{ on: field, op: 'is_null' }];
  if (Array.isArray(val)) return [{ on: field, op: 'in', value: val }];
  if (!isPlainObject(val)) return [{ on: field, op: 'eq', value: val }];

  // Hybrid leaf: {field: {op: 'gt', value: X}} — keys exactly {op} or {op,value}. The op VALUE
  // goes through the same alias table; for null-check ops a false value flips the op, mirroring
  // the natural {is_null:false} rule. Any other key alongside "op" falls through to the operator
  // loop below (and errors there), keeping the natural form authoritative.
  const byStrippedKey: Record<string, unknown> = {};
  for (const [rawKey, v] of Object.entries(val)) byStrippedKey[stripKey(rawKey)] = v;
  const strippedKeys = Object.keys(byStrippedKey);
  if (strippedKeys.includes('op') && strippedKeys.every((k) => k === 'op' || k === 'value')) {
    const rawOp = byStrippedKey.op;
    if (typeof rawOp !== 'string') {
      throw new Error(`${E} "op" on field "${field}" must be a string`);
    }
    const op = OP_ALIAS[stripKey(rawOp)];
    if (!op) {
      throw new Error(
        `${E} unknown operator "${rawOp}" on field "${field}" (expected one of: ${[...CANONICAL_OPS].join(', ')})`,
      );
    }
    if (op === 'is_null' || op === 'is_not_null') {
      const applyAsStated = byStrippedKey.value !== false;
      const flipped: Op = op === 'is_null' ? 'is_not_null' : 'is_null';
      return [{ on: field, op: applyAsStated ? op : flipped }];
    }
    if (!('value' in byStrippedKey)) {
      throw new Error(`${E} operator "${rawOp}" on field "${field}" requires a "value"`);
    }
    return [{ on: field, op, value: byStrippedKey.value }];
  }

  const leaves: LeafFilter[] = [];
  for (const [rawKey, opVal] of Object.entries(val)) {
    // Tolerate small-model over-escaping: some models emit the operator key WITH literal wrapping
    // quotes, e.g. {"amount":{"\"gt\"":1}} → key is `"gt"`. Strip wrapping quotes/whitespace.
    const opKey = stripKey(rawKey);
    const op = OP_ALIAS[opKey];
    if (!op) {
      throw new Error(
        `${E} unknown operator "${opKey}" on field "${field}" (expected one of: ${[...CANONICAL_OPS].join(', ')})`,
      );
    }
    if (op === 'is_null' || op === 'is_not_null') {
      // {is_null:true} ⇒ is_null; {is_null:false} ⇒ is_not_null (and vice-versa).
      const applyAsStated = opVal !== false;
      const flipped: Op = op === 'is_null' ? 'is_not_null' : 'is_null';
      leaves.push({ on: field, op: applyAsStated ? op : flipped });
    } else {
      leaves.push({ on: field, op, value: opVal });
    }
  }
  if (leaves.length === 0) throw new Error(`${E} empty condition object on field "${field}"`);
  return leaves;
}

/**
 * Parse a relevance leaf (Wave-2): { on, op:'relevant', query, threshold?|top_k?, per? }.
 * The crisp set is EXPLICIT + MANDATORY — EXACTLY ONE of threshold|top_k (reject neither/both,
 * no silent default; same fail-closed discipline as conform-on-every-source). Natural aliases
 * for the cutoff/partition keys are tolerated (small models emit min_score/k/group_by). The
 * service stamps the resolved vector + embeddingColumn later; those are never authored here.
 */
function normalizeRelevantLeaf(input: Record<string, unknown>): RelevantLeaf {
  const on = input.on;
  if (typeof on !== 'string' || on.trim() === '') {
    throw new Error(`${E} a 'relevant' leaf requires a non-empty "on" (the semantic text column)`);
  }
  const query = input.query;
  if (typeof query !== 'string' || query.trim() === '') {
    throw new Error(`${E} a 'relevant' leaf requires a non-empty "query" string`);
  }
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) if (k in input && input[k] != null) return input[k];
    return undefined;
  };
  const thresholdRaw = pick('threshold', 'min_score', 'cutoff');
  const topKRaw = pick('top_k', 'topK', 'k');
  const hasThreshold = thresholdRaw !== undefined;
  const hasTopK = topKRaw !== undefined;
  if (hasThreshold === hasTopK) {
    throw new Error(
      `${E} a 'relevant' leaf requires EXACTLY ONE of "threshold" or "top_k" (got ${
        hasThreshold ? 'both' : 'neither'
      }) — the crisp set must be explicit, no silent default`,
    );
  }
  const leaf: RelevantLeaf = { on, op: 'relevant', query };
  if (hasThreshold) {
    const t = Number(thresholdRaw);
    if (!Number.isFinite(t) || t < 0 || t > 1) {
      throw new Error(
        `${E} 'relevant' "threshold" must be a similarity in [0,1] (got ${String(thresholdRaw)})`,
      );
    }
    leaf.threshold = t;
  } else {
    const k = Number(topKRaw);
    if (!Number.isInteger(k) || k <= 0) {
      throw new Error(
        `${E} 'relevant' "top_k" must be a positive integer (got ${String(topKRaw)})`,
      );
    }
    leaf.top_k = k;
  }
  const per = pick('per', 'per_group', 'group_by', 'partition_by');
  if (per !== undefined) {
    if (typeof per !== 'string') throw new Error(`${E} 'relevant' "per" must be a string column`);
    leaf.per = per;
  }
  return leaf;
}

export function normalizeFilter(input: unknown): FilterExpression {
  if (!isPlainObject(input)) {
    throw new Error(`${E} a filter must be a JSON object`);
  }
  const keys = Object.keys(input);
  if (keys.length === 0) throw new Error(`${E} a filter object must not be empty`);

  const hasLogical = keys.some((k) => LOGICAL.has(k));
  if (hasLogical) {
    if (!keys.every((k) => LOGICAL.has(k))) {
      throw new Error(
        `${E} cannot mix and/or/not with field conditions in one object — wrap the field conditions in their own object`,
      );
    }
    if (keys.length !== 1) {
      throw new Error(`${E} use exactly one of and/or/not per object`);
    }
    if ('and' in input) {
      return { and: asFilterArray(input.and, 'and').map(normalizeFilter) };
    }
    if ('or' in input) {
      return { or: asFilterArray(input.or, 'or').map(normalizeFilter) };
    }
    return { not: normalizeFilter(input.not) };
  }

  // Relevance leaf {on, op:'relevant', query, threshold?|top_k?, per?} — passes through as a
  // RelevantLeaf (no `value`); checked before the legacy-leaf branch since 'relevant' is not a
  // value op (CANONICAL_OPS). The service resolves its vector/embeddingColumn before compile.
  if ('on' in input && 'op' in input && stripKey(String(input.op)) === 'relevant') {
    return normalizeRelevantLeaf(input);
  }

  // Crispified relevance leaves (sim_gte / sim_topk) — the PRIVATE shapes crispifyRelevant emits
  // BEFORE compile. The retrieval compiler re-runs this front-door normalizer on the (already
  // canonical) crispified filter, so the normalizer must be IDEMPOTENT over them: pass through
  // verbatim (they are not value ops, carry no `value`, and are never caller-authored). Without
  // this, a crisp leaf hits the legacy-leaf branch below and is rejected as an "unknown op".
  if ('on' in input && 'op' in input) {
    const op = stripKey(String(input.op));
    if (op === 'sim_gte' || op === 'sim_topk') return input as unknown as FilterExpression;
  }

  // Legacy explicit leaf {on, op, value} — kept as an escape hatch (and back-compat).
  if ('on' in input && 'op' in input) {
    const on = input.on;
    const op = input.op;
    if (typeof on !== 'string') throw new Error(`${E} leaf "on" must be a string`);
    if (typeof op !== 'string' || !CANONICAL_OPS.has(op)) {
      throw new Error(`${E} unknown op "${String(op)}"`);
    }
    return { on, op: op as Op, value: (input as { value?: unknown }).value };
  }

  // Natural object: implicit AND across each field condition.
  const leaves: FilterExpression[] = [];
  for (const [field, val] of Object.entries(input)) {
    leaves.push(...fieldConditions(field, val));
  }
  return leaves.length === 1 ? leaves[0] : { and: leaves };
}
