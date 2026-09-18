// Post-build: make every relative import in dist/**/*.d.ts a `.js` specifier.
//
// The sources import siblings both as `./x.ts` and extensionless `./x` (moduleResolution
// Bundler allows both). tsc copies those specifiers into the emitted declarations verbatim,
// which a consumer on `moduleResolution: node16/nodenext` cannot resolve. Rewriting each to
// the `.js` path of the emitted file (`./x.js` or `./x/index.js`) resolves under every mode.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.d.ts') ? [p] : [];
  });
}

const SPEC = /(from\s+|import\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;

let rewritten = 0;
for (const file of walk(root)) {
  const src = readFileSync(file, 'utf8');
  const out = src.replace(SPEC, (whole, lead: string, q: string, spec: string) => {
    const base = spec.replace(/\.(ts|js)$/, '');
    const abs = resolve(dirname(file), base);
    const target = existsSync(`${abs}.d.ts`)
      ? `${base}.js`
      : existsSync(join(abs, 'index.d.ts'))
        ? `${base}/index.js`
        : null;
    if (!target) throw new Error(`${file}: cannot resolve declaration for '${spec}'`);
    return `${lead}${q}${target}${q}`;
  });
  if (out !== src) {
    writeFileSync(file, out);
    rewritten++;
  }
}
console.log(`fix-dts-specifiers: rewrote ${rewritten} declaration file(s) under ${root}`);
