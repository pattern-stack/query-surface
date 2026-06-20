/**
 * FORMAT A — raw Predicate shape validator.
 * Returns true if the node matches the expected recursive Predicate structure, false otherwise.
 */

const COMPARISON_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'between']);
const STRING_OPS = new Set(['contains', 'startsWith', 'endsWith']);
const UNARY_OPS = new Set(['isNull', 'isNotNull']);
const BOOL_OPS = new Set(['and', 'or']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateEntityRef(node: unknown): boolean {
  if (!isPlainObject(node)) return false;
  return node.from === 'entity' && typeof node.path === 'string';
}

function validateLiteralRef(node: unknown): boolean {
  if (!isPlainObject(node)) return false;
  return node.from === 'literal' && 'value' in node;
}

export default function validatePredicate(node: unknown): boolean {
  if (!isPlainObject(node)) return false;

  const op = node.op;
  if (typeof op !== 'string') return false;

  // Comparison: { op, left: {from:"entity", path}, right: {from:"literal", value} }
  if (COMPARISON_OPS.has(op)) {
    return validateEntityRef(node.left) && validateLiteralRef(node.right);
  }

  // String: { op, left: {from:"entity", path}, pattern: string }
  if (STRING_OPS.has(op)) {
    return validateEntityRef(node.left) && typeof node.pattern === 'string';
  }

  // Unary: { op, left: {from:"entity", path} }
  if (UNARY_OPS.has(op)) {
    return validateEntityRef(node.left);
  }

  // Boolean AND/OR: { op, clauses: [...] }
  if (BOOL_OPS.has(op)) {
    if (!Array.isArray(node.clauses) || node.clauses.length === 0) return false;
    return node.clauses.every((clause: unknown) => validatePredicate(clause));
  }

  // Not: { op: "not", clause: <node> }
  if (op === 'not') {
    return validatePredicate(node.clause);
  }

  return false;
}
