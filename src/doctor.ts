// diagnose() — a read-only health check on a consumer's registered entities.
//
// The query surface is introspection-first: relationships come ONLY from
// Drizzle relations() declarations (the compiler resolves joins through them).
// So the surface is exactly as capable as the relations() graph is complete —
// and the failure mode is silent: a missing relation just means no dotted path,
// no expand, no error. diagnose() surfaces those gaps and hands back the
// relations() snippet to close each one.
//
// It is the lenient sibling of buildRegistry(): where buildRegistry throws on
// the first inconsistency (correct for a runtime boot), diagnose collects every
// gap as a Finding and never throws — and it additionally reads FK constraints,
// which buildRegistry never consults. Both sit on ./introspect; neither
// touches Drizzle internals directly.
//
// v1 scope: relationships only. EAV-overlay detection is deferred until the
// consumer's value-table structure is mapped onto the EavStrategy shapes.

import {
  type RelationsConfig,
  evaluateRelations,
  foreignKeys,
  tableColumns,
  tableName,
} from './introspect.ts';
import type { EntityRegistration } from './registry.ts';

export type Severity = 'error' | 'warn' | 'info';

export type FindingCode =
  | 'DANGLING_FK' // FK constraint with no relations() edge → invisible to the surface
  | 'MISSING_INVERSE' // belongs_to with no inverse many() → expand works one direction only
  | 'EDGE_TO_UNREGISTERED' // relation targets an unregistered/excluded table → silently dropped
  | 'HEURISTIC_FK'; // *_id column, no FK constraint and no relation → possible missing link

export interface Finding {
  severity: Severity;
  code: FindingCode;
  /** Logical entity name the finding is about. */
  entity: string;
  /** Column (DB name) involved, when applicable. */
  column?: string;
  message: string;
  /** Paste-ready relations() snippet that closes the gap, when applicable. */
  fix?: string;
}

export interface DiagnoseOptions {
  /** DB column names to skip in the HEURISTIC_FK check (beyond the defaults). */
  ignoreHeuristicColumns?: string[];
}

// Columns that end in _id but are conventionally NOT relational (tenant/external
// plumbing). isVisible:false columns are also skipped — see below.
const DEFAULT_HEURISTIC_IGNORES = ['external_id'];

interface Resolved {
  reg: EntityRegistration;
  rels: RelationsConfig;
}

/** Strip a trailing `Id` (JS prop) → a conventional relation name. */
function relNameFromProp(prop: string): string {
  return prop.endsWith('Id') ? prop.slice(0, -2) : prop;
}

/** DB column name → JS property name for a table (for snippet identifiers). */
function propFor(reg: EntityRegistration | undefined, dbColumn: string): string {
  if (!reg) return dbColumn;
  for (const [prop, col] of Object.entries(tableColumns(reg.table))) {
    if (col.name === dbColumn) return prop;
  }
  return dbColumn;
}

export function diagnose(
  entities: readonly EntityRegistration[],
  opts: DiagnoseOptions = {},
): Finding[] {
  const findings: Finding[] = [];
  const heuristicIgnores = new Set([
    ...DEFAULT_HEURISTIC_IGNORES,
    ...(opts.ignoreHeuristicColumns ?? []),
  ]);

  // Resolve every registration once: its evaluated relations + table name lookups.
  const byTable = new Map<string, Resolved>(); // DB table name → resolved
  const byEntity = new Map<string, Resolved>(); // logical name   → resolved
  for (const reg of entities) {
    const rels = reg.relations ? evaluateRelations(reg.relations, reg.table) : {};
    const resolved: Resolved = { reg, rels };
    byTable.set(tableName(reg.table), resolved);
    byEntity.set(reg.name, resolved);
  }

  for (const { reg, rels } of byEntity.values()) {
    const entity = reg.name;
    const srcTable = tableName(reg.table);

    // One-relations on this entity, by the DB FK column they bind.
    const oneByFkColumn = new Map<string, { relName: string; targetTable: string }>();
    for (const [relName, rel] of Object.entries(rels)) {
      if (rel.constructor.name === 'One' && rel.config?.fields?.length) {
        oneByFkColumn.set(rel.config.fields[0].name, {
          relName,
          targetTable: tableName(rel.referencedTable),
        });
      }
    }

    // --- EDGE_TO_UNREGISTERED: any relation pointing at a table we didn't register.
    for (const [relName, rel] of Object.entries(rels)) {
      const target = tableName(rel.referencedTable);
      if (!byTable.has(target)) {
        findings.push({
          severity: 'warn',
          code: 'EDGE_TO_UNREGISTERED',
          entity,
          message:
            `relation '${relName}' → '${target}' targets a table that isn't registered ` +
            `(excluded, or missing from the schema). The edge is silently dropped — register '${target}' or remove it from excludes.`,
        });
      }
    }

    // --- DANGLING_FK: declared FK with no One-relation binding its column.
    const fks = foreignKeys(reg.table);
    const fkColumns = new Set(fks.flatMap((fk) => fk.fromColumns));
    for (const fk of fks) {
      const covered = fk.fromColumns.some((c) => oneByFkColumn.has(c));
      if (covered) continue;
      const srcCol = fk.fromColumns[0];
      const srcProp = fk.fromProps[0];
      const relName = relNameFromProp(srcProp);
      const targetReg = byTable.get(fk.toTable)?.reg;
      const targetProp = propFor(targetReg, fk.toColumns[0]);
      findings.push({
        severity: 'error',
        code: 'DANGLING_FK',
        entity,
        column: srcCol,
        message:
          `'${entity}.${srcCol}' is a foreign key to '${fk.toTable}' but has no relations() entry — ` +
          `the surface can't see this relationship (no dotted-path filters, no expand).`,
        fix:
          `// in ${entity}'s entity file — merge into the existing relations() if present:\n` +
          `export const ${srcTable}Relations = relations(${srcTable}, ({ one }) => ({\n` +
          `  ${relName}: one(${fk.toTable}, {\n` +
          `    fields: [${srcTable}.${srcProp}],\n` +
          `    references: [${fk.toTable}.${targetProp}],\n` +
          `  }),\n` +
          `}));`,
      });
    }

    // --- HEURISTIC_FK: *_id column with neither an FK constraint nor a relation.
    for (const [prop, col] of Object.entries(tableColumns(reg.table))) {
      const db = col.name;
      if (db === 'id' || !db.endsWith('_id')) continue;
      if (heuristicIgnores.has(db)) continue;
      if (reg.fieldMeta?.[prop]?.isVisible === false) continue; // tenant/plumbing (user_id, organization_id, …)
      if (fkColumns.has(db) || oneByFkColumn.has(db)) continue; // already a real FK or a relation
      findings.push({
        severity: 'info',
        code: 'HEURISTIC_FK',
        entity,
        column: db,
        message:
          `'${entity}.${db}' looks like a foreign key (ends in _id) but has no FK constraint and no relation. ` +
          `If it references another entity, add a .references() + a relations() entry; otherwise ignore.`,
      });
    }
  }

  // --- MISSING_INVERSE: a belongs_to (One) to a registered entity that has no
  // inverse many() back. expand then works one direction only.
  for (const { reg, rels } of byEntity.values()) {
    const srcTable = tableName(reg.table);
    for (const [relName, rel] of Object.entries(rels)) {
      if (rel.constructor.name !== 'One') continue;
      const target = byTable.get(tableName(rel.referencedTable));
      if (!target) continue; // already reported as EDGE_TO_UNREGISTERED
      const hasInverse = Object.values(target.rels).some(
        (r) => r.constructor.name === 'Many' && tableName(r.referencedTable) === srcTable,
      );
      if (hasInverse) continue;
      const targetTable = tableName(target.reg.table);
      findings.push({
        severity: 'warn',
        code: 'MISSING_INVERSE',
        entity: target.reg.name,
        message:
          `'${reg.name}.${relName}' points to '${target.reg.name}', but '${target.reg.name}' declares no inverse ` +
          `many('${srcTable}') — you can expand ${reg.name}→${target.reg.name} but not ${target.reg.name}→${reg.name}.`,
        fix: `// add to ${targetTable}Relations:\n` + `${srcTable}: many(${srcTable}),`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Presentation — pure (returns a string); callers own stdout. Shared by the
// demo bin (src/doctor.ts) and the CLI (src/cli/index.ts).
// ---------------------------------------------------------------------------

const SEV_LABEL: Record<Severity, string> = {
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
};
const SEV_ORDER: Severity[] = ['error', 'warn', 'info'];

function indentBlock(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

export interface FormatOptions {
  /** Optional colorizer for the per-finding header line; defaults to identity. */
  paint?: (severity: Severity, text: string) => string;
}

/** Render findings grouped by severity, each with its fix snippet. */
export function formatFindings(findings: Finding[], opts: FormatOptions = {}): string {
  const paint = opts.paint ?? ((_sev: Severity, text: string) => text);
  if (findings.length === 0) {
    return 'schema doctor: no relationship gaps found — the surface can see every declared FK.';
  }
  const counts = SEV_ORDER.map(
    (s) => `${findings.filter((f) => f.severity === s).length} ${s}`,
  ).join(', ');
  const lines: string[] = [`schema doctor: ${findings.length} finding(s) — ${counts}`, ''];
  for (const sev of SEV_ORDER) {
    for (const f of findings.filter((x) => x.severity === sev)) {
      const where = f.column ? `${f.entity}.${f.column}` : f.entity;
      lines.push(paint(sev, `[${SEV_LABEL[sev]}] ${f.code} — ${where}`));
      lines.push(indentBlock(f.message, '  '));
      if (f.fix) {
        lines.push('  fix:');
        lines.push(indentBlock(f.fix, '    '));
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
