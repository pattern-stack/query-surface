// EAV read-merge — fold EAV cells back into hydrated rows so an EAV entity's
// rows carry their fields (StageName, Amount, Industry, …) inline,
// indistinguishable from real columns. The read counterpart to the compiler's
// resolveEav, and shape-aware: Shape A reads typed columns, Shape B reads the
// jsonb value (current row only).
//
// Shared by runFetch/runQuery (root rows) and expand.ts (materialized related
// rows) so EVERY surface that returns a row hydrates its EAV fields. Lives in
// its own module to avoid a service ↔ expand import cycle. Batched: one query
// over the value table for all row ids.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { registry } from '../registry.ts';
import type { EntityName } from '../types.ts';
import type { FieldMap } from './field-map.ts';
import { coercionCategory, extractTypedValue } from './mapping.ts';
import { fieldValues, fieldValuesJsonb } from './schema.ts';

// Decode a jsonb-stored value to match Shape A's typed output (numbers come
// back native from jsonb; dates are ISO strings → coerce to Date for parity).
function coerceJsonbValue(value: unknown, dataType: string): unknown {
  if (value === null || value === undefined) return value;
  switch (coercionCategory(dataType)) {
    case 'date':
      return value instanceof Date ? value : new Date(value as string);
    case 'number':
      return typeof value === 'number' ? value : Number(value);
    default:
      return value;
  }
}

export async function hydrateEavRows(
  // biome-ignore lint/suspicious/noExplicitAny: engine is schema-agnostic; Drizzle's DB type is generic over the host schema, unknown at the package level
  db: NodePgDatabase<any>,
  entity: EntityName,
  rows: Array<Record<string, unknown>>,
  fieldMap?: FieldMap,
): Promise<void> {
  const desc = registry[entity];
  if (!desc.eav || !fieldMap || fieldMap.size === 0 || rows.length === 0) return;

  const ids = rows.map((r) => String(r.id)).filter(Boolean);
  if (ids.length === 0) return;

  // field_definition_id → { key, dataType } for decoding each cell.
  const byDefId = new Map<string, { key: string; dataType: string }>();
  for (const [key, def] of fieldMap) {
    byDefId.set(def.fieldDefinitionId, { key, dataType: def.dataType });
  }

  // entity_id → { key: value } bag, decoded per shape.
  const byEntity = new Map<string, Record<string, unknown>>();
  const put = (entityId: string, key: string, value: unknown): void => {
    let bag = byEntity.get(entityId);
    if (!bag) {
      bag = {};
      byEntity.set(entityId, bag);
    }
    bag[key] = value;
  };

  if (desc.eav.kind === 'typed-columns') {
    const fvRows = await db
      .select({
        entityId: fieldValues.entityId,
        fieldDefinitionId: fieldValues.fieldDefinitionId,
        valueText: fieldValues.valueText,
        valueNumber: fieldValues.valueNumber,
        valueDate: fieldValues.valueDate,
        valueBoolean: fieldValues.valueBoolean,
      })
      .from(fieldValues)
      .where(
        and(
          eq(fieldValues.entityType, desc.eav.entityTypeValue),
          inArray(fieldValues.entityId, ids),
        ),
      );
    for (const fv of fvRows) {
      const meta = byDefId.get(fv.fieldDefinitionId);
      if (!meta) continue;
      put(fv.entityId, meta.key, extractTypedValue(fv, meta.dataType));
    }
  } else {
    // jsonb-value (Shape B): current row only (valid_to IS NULL).
    const fvRows = await db
      .select({
        entityId: fieldValuesJsonb.entityId,
        fieldDefinitionId: fieldValuesJsonb.fieldDefinitionId,
        value: fieldValuesJsonb.value,
      })
      .from(fieldValuesJsonb)
      .where(
        and(
          eq(fieldValuesJsonb.entityType, desc.eav.entityTypeValue),
          inArray(fieldValuesJsonb.entityId, ids),
          isNull(fieldValuesJsonb.validTo),
        ),
      );
    for (const fv of fvRows) {
      const meta = byDefId.get(fv.fieldDefinitionId);
      if (!meta) continue;
      put(fv.entityId, meta.key, coerceJsonbValue(fv.value, meta.dataType));
    }
  }

  for (const r of rows) {
    const bag = byEntity.get(String(r.id));
    if (bag) Object.assign(r, bag);
  }
}
