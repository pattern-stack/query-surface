/**
 * Engine error-message prefixes — the SINGLE source of truth shared by the
 * throw sites (compiler / runners) and the nest-layer classifier
 * (`nest/errors.ts`). The classifier routes engine errors to typed
 * REST/MCP errors by matching these prefixes; defining them once means a
 * wording change at a throw site can't silently break classification.
 */
export const ENGINE_ERROR = {
  /** Prefix for an unknown root entity. Followed by the entity name. */
  UNKNOWN_ENTITY: 'Unknown entity: ',
  /** Prefix for an invalid field/relation path segment. */
  FIELD_PATH: 'Field path',
  /** Prefix for an invalid expand path. */
  EXPAND_PATH: 'Expand path',
  /** Prefix for exceeding the expand depth limit. */
  EXPAND_DEPTH: 'Expand depth',
  /** Substring marking an unsupported traversal shape in a path. */
  UNSUPPORTED_IN_PATH: 'not supported in path',
  /** Prefix for an invalid `rank_by` directive. */
  RANK: 'rank_by:',
  /** Prefix for an invalid filter shape (normalization failure). */
  FILTER: 'filter:',
  /** Prefix for a caller-input aggregate problem (bad measure field, non-additive
   *  SUM, dimension agg, unknown column, unsafe identifier, unsupported op). */
  AGGREGATE: 'aggregate:',
} as const;
