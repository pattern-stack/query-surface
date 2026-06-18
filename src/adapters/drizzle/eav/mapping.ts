// EAV value-column mapping — Shape A (dealbrain typed columns).
//
// Single source of truth for "which `field_values` column holds a value of
// data_type X". Shared by the READ resolver (compiler picks the column to
// filter/select) and the WRITE/seed path (`toFieldValueColumns` coerces a
// value into the right column).
//
// Borrowed from dealbrain proper's `toFieldValueColumns` / `extractTypedValue`
// (apps/backend/src/domain/field-values/field-value.entity.ts). The data_type
// vocabulary and the mapping below are verified against the live dealbrain
// `field_definitions.data_type` distribution:
//   value_text    : text, longtext, select, reference, email, url, id
//   value_number  : number, money, percentage
//   value_date    : date, datetime
//   value_boolean : boolean

export type EavValueColumn = 'valueText' | 'valueNumber' | 'valueDate' | 'valueBoolean';

// Covers BOTH data_type vocabularies — dealbrain Shape A (money/percentage/
// select/longtext/…) and codegen-patterns Shape B (integer/decimal/picklist/…).
// For Shape A it names the typed value column; for Shape B the resolver only
// uses coercionCategory() (derived from this), since jsonb has one value column.
/** Which `field_values` column stores a value of the given field-definition data_type. */
export function valueColumnForDataType(dataType: string): EavValueColumn {
  switch (dataType) {
    case 'number':
    case 'money':
    case 'percentage':
    case 'integer':
    case 'decimal':
      return 'valueNumber';
    case 'date':
    case 'datetime':
      return 'valueDate';
    case 'boolean':
      return 'valueBoolean';
    // text | longtext | string | select | picklist | multipicklist | reference
    // | email | url | json | id | unknown → text
    default:
      return 'valueText';
  }
}

/**
 * Coercion category for a field-definition data_type — tells the compiler how
 * to coerce a JSON filter value before comparing against the value column.
 *
 * Needed because drizzle types `numeric` as a JS string (so the value column's
 * own `.dataType` is 'string' even for money/percentage). The field
 * definition's data_type is the real authority, so EAV resolution carries it
 * as a coercion hint. Mirrors the value-column mapping above.
 */
export function coercionCategory(dataType: string): 'string' | 'number' | 'date' | 'boolean' {
  switch (valueColumnForDataType(dataType)) {
    case 'valueNumber':
      return 'number';
    case 'valueDate':
      return 'date';
    case 'valueBoolean':
      return 'boolean';
    default:
      return 'string';
  }
}

/** The four sparse value columns, all null except the one for the value's type. */
export interface FieldValueColumns {
  valueText: string | null;
  // drizzle's `numeric` maps to a JS string to avoid float precision loss.
  valueNumber: string | null;
  valueDate: Date | null;
  valueBoolean: boolean | null;
}

const EMPTY: FieldValueColumns = {
  valueText: null,
  valueNumber: null,
  valueDate: null,
  valueBoolean: null,
};

/**
 * WRITE path: coerce an untyped value into the correct typed value column.
 * Mirror of dealbrain's `toFieldValueColumns`. Used by the seed.
 */
export function toFieldValueColumns(value: unknown, dataType: string): FieldValueColumns {
  if (value == null) return { ...EMPTY };
  switch (valueColumnForDataType(dataType)) {
    case 'valueNumber':
      return { ...EMPTY, valueNumber: String(Number(value)) };
    case 'valueDate':
      return {
        ...EMPTY,
        valueDate: value instanceof Date ? value : new Date(value as string),
      };
    case 'valueBoolean':
      return { ...EMPTY, valueBoolean: Boolean(value) };
    default:
      return { ...EMPTY, valueText: String(value) };
  }
}

/**
 * READ path: extract the typed value from the populated value column.
 * Mirror of dealbrain's `extractTypedValue`. Used to merge EAV cells back into
 * hydrated rows on fetch so an opportunity row carries StageName/Amount/etc.
 * inline — indistinguishable from real columns. numeric is decoded to a JS
 * number here (drizzle hands it back as a string).
 */
export function extractTypedValue(
  cols: FieldValueColumns,
  dataType: string,
): string | number | boolean | Date | null {
  switch (valueColumnForDataType(dataType)) {
    case 'valueNumber':
      return cols.valueNumber != null ? Number(cols.valueNumber) : null;
    case 'valueDate':
      return cols.valueDate;
    case 'valueBoolean':
      return cols.valueBoolean;
    default:
      return cols.valueText;
  }
}
