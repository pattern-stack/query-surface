// Snippet extraction — windowed text around text-op matches.
//
// Called from runSearch when the compiler reported one or more text-op leaves
// (contains/startswith/endswith) that target columns on the root entity. For
// each matching descriptor, find where the pattern actually lives in the row's
// column value (case-insensitive), slice ±context chars, return an entry the
// agent can render or highlight.
//
// Pure function, no DB dependency. Mirrors ILIKE behavior exactly.

import type { SnippetEntry, TextMatchDescriptor } from '../language/types.ts';

const DEFAULT_CONTEXT_CHARS = 60;
const ELLIPSIS = '…';

export function buildSnippets(
  row: Record<string, unknown>,
  matches: TextMatchDescriptor[],
  contextChars: number = DEFAULT_CONTEXT_CHARS,
): SnippetEntry[] {
  const out: SnippetEntry[] = [];

  for (const m of matches) {
    const val = row[m.column];
    if (typeof val !== 'string' || val.length === 0) continue;

    const lowerVal = val.toLowerCase();
    const lowerPat = m.pattern.toLowerCase();

    // Locate the match position per op. Skip the row silently if the SQL
    // matched but JS doesn't find the pattern — shouldn't happen, but harmless.
    let matchStart: number;
    if (m.op === 'startswith') {
      if (!lowerVal.startsWith(lowerPat)) continue;
      matchStart = 0;
    } else if (m.op === 'endswith') {
      if (!lowerVal.endsWith(lowerPat)) continue;
      matchStart = val.length - m.pattern.length;
    } else {
      // 'contains'
      matchStart = lowerVal.indexOf(lowerPat);
      if (matchStart < 0) continue;
    }
    const matchEnd = matchStart + m.pattern.length;

    // Slice window around the match
    const sliceStart = Math.max(0, matchStart - contextChars);
    const sliceEnd = Math.min(val.length, matchEnd + contextChars);

    // Ellipses to signal truncation on either side
    const prefix = sliceStart > 0 ? ELLIPSIS : '';
    const suffix = sliceEnd < val.length ? ELLIPSIS : '';
    const snippet = prefix + val.slice(sliceStart, sliceEnd) + suffix;

    // Match offsets WITHIN the snippet (not the full value). The prefix
    // ellipsis is one character; account for it.
    const matchStartInSnippet = matchStart - sliceStart + prefix.length;
    const matchEndInSnippet = matchStartInSnippet + m.pattern.length;

    out.push({
      column: m.column,
      snippet,
      match: { start: matchStartInSnippet, end: matchEndInSnippet },
      full_length: val.length,
    });
  }

  return out;
}

const DEFAULT_HEAD_CHARS = 200;

/**
 * HEAD-TRUNCATION sibling for SEMANTIC matches (Wave-2 citation, step 7). buildSnippets is
 * ILIKE-positional — it locates a literal substring — so it CANNOT place a semantic (vector)
 * match, which has no literal locus. Citation exemplars instead show the head of the matched
 * row's text: the first `headChars` characters (trailing `…` when truncated), plus the full
 * length so a caller knows there's more. No offsets (there is no positional match to mark).
 */
export function buildTruncatedSnippet(
  text: unknown,
  headChars: number = DEFAULT_HEAD_CHARS,
): { snippet: string; full_length: number } {
  const val = typeof text === 'string' ? text : text == null ? '' : String(text);
  const truncated = val.length > headChars;
  const snippet = truncated ? val.slice(0, headChars) + ELLIPSIS : val;
  return { snippet, full_length: val.length };
}
