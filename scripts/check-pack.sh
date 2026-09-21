#!/usr/bin/env bash
# Pre-publish check: pack the package, install the tarball into a fresh project, then
# type-check (nodenext + bundler) and import it from Node. Usage: scripts/check-pack.sh [workdir]
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd); WORK=${1:-$(mktemp -d)}
rm -rf "$WORK" && mkdir -p "$WORK/pack" "$WORK/app"
( cd "$REPO" && npm pack --pack-destination "$WORK/pack" >/dev/null 2>&1 )
TGZ=$(ls "$WORK"/pack/*.tgz); echo "tarball: $(basename "$TGZ")"
tar -tzf "$TGZ" | grep -E "__tests__|characterization|\.spec\.ts|package/src/" && { echo "FAIL: tests or src in tarball"; exit 1; } || true
tar -tzf "$TGZ" | grep -E "adapters/reference" && { echo "FAIL: reference fixture (adapters/reference) in tarball"; exit 1; } || true
# The package is peer-deps only: a runtime `dependencies` entry would be installed into every consumer.
tar -xzOf "$TGZ" package/package.json | node -e "
const d = JSON.parse(require('fs').readFileSync(0, 'utf8')).dependencies ?? {};
if (Object.keys(d).length) { console.error('FAIL: packed package.json has dependencies: ' + Object.keys(d).join(', ')); process.exit(1); }
console.log('packed package.json: no runtime dependencies');"
cd "$WORK/app"
cat > package.json <<JSON
{ "name": "qs-consumer", "private": true, "type": "module" }
JSON
# --legacy-peer-deps: drizzle-orm 1.0 RC declares an optional `effect` peer that npm's
# resolver rejects (`npm i drizzle-orm@1.0.0-rc.4` fails the same way with this package
# absent). This is the install route the README documents for npm; drop the flag once
# Drizzle 1.0 is stable. Bun resolves the same graph without it (checked at the end).
npm install --no-audit --no-fund --silent --legacy-peer-deps "$TGZ" drizzle-orm@1.0.0-rc.4 typescript@5.9.3 @types/node@22 \
  @nestjs/common@11 @nestjs/core@11 @nestjs/swagger@11 rxjs@7 zod@3 reflect-metadata >/dev/null
cat > consumer.ts <<'TS'
import type {
  AggEntity, AggFieldMeta, AggRegistry, AggRelationship, AggregateModel, DerivedMeasureDef,
  EntityDescriptor, MeasureCatalog, RatioMeasureDef, RelDescriptor,
} from '@pattern-stack/query-surface';
import { QueryApplicationService, TENANT_GLOBAL, toOnePaths } from '@pattern-stack/query-surface';
import type { QuerySurfaceModuleOptions } from '@pattern-stack/query-surface/nest';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { pgTable, uuid, varchar } from 'drizzle-orm/pg-core';

const accounts = pgTable('accounts', { id: uuid('id').primaryKey(), region: varchar('region') });
const profiles = pgTable('profiles', { id: uuid('id').primaryKey(), accountId: uuid('account_id') });
const hasOne: RelDescriptor = { kind: 'has_one', target: 'profiles', fk: 'account_id' };
const rel: AggRelationship = { kind: 'has_one', target: 'profiles', fk: 'account_id' };
const region: AggFieldMeta = { type: 'string', role: 'dimension' };
const ent: AggEntity = { table: 'accounts', pk: 'id', rels: { profile: rel }, fields: { region } };
const analytics: AggRegistry = { accounts: ent };
const registry: Record<string, EntityDescriptor> = {
  accounts: {
    name: 'accounts', table: accounts, primaryKey: 'id',
    columns: accounts as unknown as Record<string, PgColumn>,
    relationships: { profile: hasOne }, searchableColumns: [],
  },
};
const ratio: RatioMeasureDef = { kind: 'ratio', numerator: 'a.sum', denominator: 'b.sum' } as RatioMeasureDef;
const derived = {} as DerivedMeasureDef;
const catalog: MeasureCatalog = {};
export const model: AggregateModel = {
  registry, analytics, tables: { accounts, profiles },
  colByDbName: { accounts: { id: accounts.id, region: accounts.region } }, catalog,
};
export const _ = [QueryApplicationService, TENANT_GLOBAL, toOnePaths, ratio, derived];
export type _Opts = QuerySurfaceModuleOptions;
TS
for MODE in nodenext bundler; do
  MOD=$([ "$MODE" = nodenext ] && echo NodeNext || echo ESNext)
  cat > tsconfig.$MODE.json <<JSON
{ "compilerOptions": { "target": "ES2022", "module": "$MOD", "moduleResolution": "$MODE",
  "strict": true, "noEmit": true, "skipLibCheck": false, "types": ["node"],
  "experimentalDecorators": true, "emitDecoratorMetadata": true }, "files": ["consumer.ts"] }
JSON
  if npx tsc -p tsconfig.$MODE.json > tsc.$MODE.log 2>&1; then echo "tsc ($MODE, skipLibCheck:false): OK"
  else
    # drizzle's own .d.ts may not be clean under skipLibCheck:false — separate ours from theirs
    grep -v "node_modules/drizzle-orm\|node_modules/@nestjs\|node_modules/@types" tsc.$MODE.log | grep "error TS" && { echo "FAIL tsc $MODE"; cat tsc.$MODE.log | head -30; exit 1; }
    echo "tsc ($MODE, skipLibCheck:false): OK for this package (third-party d.ts errors only: $(grep -c 'error TS' tsc.$MODE.log))"
  fi
done
node -e "import('@pattern-stack/query-surface').then(m => console.log('node import (root):', Object.keys(m).length, 'exports; has_one-aware toOnePaths =', typeof m.toOnePaths))"
node -e "import('reflect-metadata').then(() => import('@pattern-stack/query-surface/nest')).then(m => console.log('node import (./nest):', Object.keys(m).length, 'exports'))"
# Bun resolves the same dist/ graph (no `bun` condition: a src/ condition would make Bun
# compile the Nest decorators per the CONSUMER's tsconfig, and splitting root/nest across
# src + dist would duplicate the module-level registry). No decorator tsconfig here on purpose.
bun -e "
for (const s of ['@pattern-stack/query-surface', '@pattern-stack/query-surface/nest']) {
  const p = import.meta.resolve(s);
  if (!p.includes('/dist/') || !p.endsWith('.js')) throw new Error('bun resolved ' + s + ' outside dist: ' + p);
}
const m = await import('@pattern-stack/query-surface');
await import('reflect-metadata');
const n = await import('@pattern-stack/query-surface/nest');
console.log('bun import (dist): root', Object.keys(m).length, 'exports; ./nest', Object.keys(n).length, 'exports');
"
