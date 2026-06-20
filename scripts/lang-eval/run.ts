/**
 * Agent-ergonomics eval: measures first-attempt validity of a small local model
 * generating data-query filters in two formats:
 *   FORMAT A = raw Predicate (verbose structured tree)
 *   FORMAT B = mongo/prisma forgiving DSL (what filter-normalize.ts accepts)
 *
 * Run: bun scripts/lang-eval/run.ts
 * (from /Users/dug/Projects/query-surface)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { normalizeFilter } from '../../src/internal/language/filter-normalize.ts';
import validatePredicate from './validate-predicate.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────

const OLLAMA_BASE = 'http://localhost:11434';
const TEMPERATURE = 0;
const MODEL = 'qwen2.5:7b';

// ─── Prompts ─────────────────────────────────────────────────────────────────

const FORMAT_A_SYSTEM = `You are a query builder assistant. Generate filter expressions as a raw Predicate tree JSON object.

The Predicate tree has these node types:

1. Comparison leaf: { "op": "<op>", "left": { "from": "entity", "path": "<field>" }, "right": { "from": "literal", "value": <value> } }
   Valid ops: "eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "between"
   For "in"/"nin": right.value must be an array.
   For "between": right.value must be [min, max] array.

2. String leaf: { "op": "<op>", "left": { "from": "entity", "path": "<field>" }, "pattern": "<string>" }
   Valid ops: "contains", "startsWith", "endsWith"

3. Unary leaf: { "op": "<op>", "left": { "from": "entity", "path": "<field>" } }
   Valid ops: "isNull", "isNotNull"

4. Boolean AND/OR: { "op": "and" | "or", "clauses": [ <node>, <node>, ... ] }

5. Not: { "op": "not", "clause": <node> }

Schema fields available:
- accounts: name
- opportunities: amount, dealstage, closedate, pipeline
- observations: type, occurred_at, account, opportunity

Examples:
- name = "Acme": { "op": "eq", "left": { "from": "entity", "path": "name" }, "right": { "from": "literal", "value": "Acme" } }
- amount > 5000 AND stage = "proposal": { "op": "and", "clauses": [ { "op": "gt", "left": { "from": "entity", "path": "amount" }, "right": { "from": "literal", "value": 5000 } }, { "op": "eq", "left": { "from": "entity", "path": "dealstage" }, "right": { "from": "literal", "value": "proposal" } } ] }
- name contains "tech": { "op": "contains", "left": { "from": "entity", "path": "name" }, "pattern": "tech" }
- closedate is null: { "op": "isNull", "left": { "from": "entity", "path": "closedate" } }`;

const FORMAT_B_SYSTEM = `You are a query builder assistant. Generate filter expressions using the natural mongo/prisma-style DSL.

Accepted forms:
- Scalar equality: { "field": "value" }         → eq
- Operator object: { "field": { "gt": 100 } }   → that op
- Multiple ops on same field: { "field": { "gte": 10, "lte": 100 } } → AND on the field
- In list: { "field": { "in": ["a", "b"] } }    → in operator
- Not-in list: { "field": { "nin": ["x"] } }    → not-in
- Bare array (shorthand in): { "field": ["a", "b"] } → in
- Null check: { "field": { "is_null": true } }  → is_null; false → is_not_null
- Not-null: { "field": { "is_not_null": true } }
- Text contains: { "field": { "contains": "word" } }
- Text starts with: { "field": { "startsWith": "prefix" } }  (also: startswith)
- Text ends with: { "field": { "endsWith": "suffix" } }  (also: endswith)
- Multiple fields: { "f1": "v1", "f2": { "gt": 10 } } → implicit AND
- Explicit AND: { "and": [ {...}, {...} ] }
- Explicit OR: { "or": [ {...}, {...} ] }
- Negation: { "not": { "field": "value" } }

Valid operators (inside field objects): eq, ne/neq, gt, gte, lt, lte, in, nin/not_in, between, contains/like, startsWith/startswith, endsWith/endswith, is_null/isNull, is_not_null/isNotNull, matches/search

Schema fields available:
- accounts: name
- opportunities: amount, dealstage, closedate, pipeline
- observations: type, occurred_at, account, opportunity

Examples:
- name = "Acme": { "name": "Acme" }
- amount > 5000 AND stage = "proposal": { "amount": { "gt": 5000 }, "dealstage": "proposal" }
- stage in list: { "dealstage": { "in": ["proposal", "negotiation"] } }
- (stage = "a" OR stage = "b") AND amount > 1000: { "and": [ { "or": [ { "dealstage": "a" }, { "dealstage": "b" } ] }, { "amount": { "gt": 1000 } } ] }
- name contains "tech": { "name": { "contains": "tech" } }
- closedate is null: { "closedate": { "is_null": true } }`;

// ─── Types ───────────────────────────────────────────────────────────────────

interface Intent {
  id: number;
  description: string;
  text: string;
}

interface Result {
  intent_id: number;
  intent_text: string;
  format: 'A' | 'B';
  raw_response: string;
  parsed_json: unknown;
  valid: boolean;
  error: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Call ollama /api/generate and return the full response text. */
async function callOllama(system: string, userPrompt: string): Promise<string> {
  const body = {
    model: MODEL,
    system,
    prompt: userPrompt,
    stream: false,
    options: { temperature: TEMPERATURE },
  };

  const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Ollama HTTP ${resp.status}: ${await resp.text()}`);
  }

  const data = (await resp.json()) as { response: string };
  return data.response ?? '';
}

/** Extract the first balanced JSON object from a string (strips markdown fences). */
function extractJson(raw: string): unknown {
  // Strip markdown code fences
  let text = raw.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();

  // Find first { and extract balanced object
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');

  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  if (end === -1) throw new Error('Unbalanced JSON object in response');

  const jsonStr = text.slice(start, end + 1);
  return JSON.parse(jsonStr);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const intentsPath = join(__dirname, 'intents.json');
  const intents: Intent[] = JSON.parse(readFileSync(intentsPath, 'utf8'));

  console.log(`Model: ${MODEL}`);
  console.log(`Running ${intents.length} intents × 2 formats = ${intents.length * 2} LLM calls\n`);

  const results: Result[] = [];
  let aValid = 0;
  let bValid = 0;

  for (const intent of intents) {
    const userPrompt = `Generate a filter expression for: ${intent.text}. Respond with ONLY the JSON object, no explanation.`;

    // FORMAT A
    process.stdout.write(`[${intent.id}/20] FORMAT A: ${intent.description.substring(0, 60)}... `);
    const resultA: Result = {
      intent_id: intent.id,
      intent_text: intent.text,
      format: 'A',
      raw_response: '',
      parsed_json: null,
      valid: false,
      error: null,
    };
    try {
      resultA.raw_response = await callOllama(FORMAT_A_SYSTEM, userPrompt);
      const parsed = extractJson(resultA.raw_response);
      resultA.parsed_json = parsed;
      resultA.valid = validatePredicate(parsed);
      if (!resultA.valid) resultA.error = 'Failed validatePredicate check';
    } catch (e) {
      resultA.error = (e as Error).message;
    }
    if (resultA.valid) aValid++;
    console.log(resultA.valid ? '✓' : `✗ (${resultA.error?.substring(0, 60)})`);
    results.push(resultA);

    // FORMAT B
    process.stdout.write(`[${intent.id}/20] FORMAT B: ${intent.description.substring(0, 60)}... `);
    const resultB: Result = {
      intent_id: intent.id,
      intent_text: intent.text,
      format: 'B',
      raw_response: '',
      parsed_json: null,
      valid: false,
      error: null,
    };
    try {
      resultB.raw_response = await callOllama(FORMAT_B_SYSTEM, userPrompt);
      const parsed = extractJson(resultB.raw_response);
      resultB.parsed_json = parsed;
      normalizeFilter(parsed); // throws if invalid
      resultB.valid = true;
    } catch (e) {
      resultB.error = (e as Error).message;
    }
    if (resultB.valid) bValid++;
    console.log(resultB.valid ? '✓' : `✗ (${resultB.error?.substring(0, 60)})`);
    results.push(resultB);
  }

  // Write raw results
  const resultsPath = join(__dirname, 'results.json');
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`\nRaw results written to ${resultsPath}`);

  // Build markdown report
  const aPercent = Math.round((aValid / intents.length) * 100);
  const bPercent = Math.round((bValid / intents.length) * 100);

  // Per-intent table
  const tableRows: string[] = [];
  for (const intent of intents) {
    const a = results.find((r) => r.intent_id === intent.id && r.format === 'A');
    const b = results.find((r) => r.intent_id === intent.id && r.format === 'B');
    const aStr = a?.valid ? '✓' : `✗`;
    const bStr = b?.valid ? '✓' : `✗`;
    tableRows.push(`| ${intent.id} | ${intent.description} | ${aStr} | ${bStr} |`);
  }

  // Failure patterns
  const aFailures = results.filter((r) => r.format === 'A' && !r.valid);
  const bFailures = results.filter((r) => r.format === 'B' && !r.valid);

  const md = `# Agent-Ergonomics Filter Eval

## Model
${MODEL} (temperature=0, single-shot)

## Aggregate Summary

| Format | Valid | Total | Pass Rate |
|--------|-------|-------|-----------|
| FORMAT A (raw Predicate tree) | ${aValid} | ${intents.length} | ${aPercent}% |
| FORMAT B (mongo/prisma DSL) | ${bValid} | ${intents.length} | ${bPercent}% |

## Per-Intent Results

| # | Intent | A valid? | B valid? |
|---|--------|----------|----------|
${tableRows.join('\n')}

## Format A Failures (${aFailures.length})

${aFailures.length === 0 ? '_None_' : aFailures.map((r) => `- **Intent ${r.intent_id}**: ${r.intent_text}\n  Error: ${r.error}`).join('\n')}

## Format B Failures (${bFailures.length})

${bFailures.length === 0 ? '_None_' : bFailures.map((r) => `- **Intent ${r.intent_id}**: ${r.intent_text}\n  Error: ${r.error}`).join('\n')}

## Format A Sample Output (Intent 1)

\`\`\`json
${JSON.stringify(results.find((r) => r.format === 'A' && r.intent_id === 1)?.parsed_json ?? null, null, 2)}
\`\`\`

## Format B Sample Output (Intent 1)

\`\`\`json
${JSON.stringify(results.find((r) => r.format === 'B' && r.intent_id === 1)?.parsed_json ?? null, null, 2)}
\`\`\`
`;

  const mdPath = join(__dirname, 'results.md');
  writeFileSync(mdPath, md);
  console.log(`Markdown report written to ${mdPath}`);

  // Stdout summary
  console.log('\n=== AGGREGATE SUMMARY ===');
  console.log(`FORMAT A (raw Predicate): ${aValid}/${intents.length} (${aPercent}%)`);
  console.log(`FORMAT B (mongo DSL):     ${bValid}/${intents.length} (${bPercent}%)`);

  return { aValid, bValid, total: intents.length };
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
