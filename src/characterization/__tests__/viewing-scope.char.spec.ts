// W1 CONTRACT (ADR-0027) — the read-time attribution grain is THREADED and
// FAIL-CLOSED. W1 only makes `viewingScope` available; no caller branches on it
// yet (the grain-switch dispatch is W3). This pins the one guarantee W1 ships:
// the resolved grain defaults to `personal` and only an explicit `org_wide`
// opts into participant attribution — over-attribution can never be silent.
//
// Pure over options (the getter never touches the DB), so it runs WITHOUT DBURL.

import { describe, expect, it } from 'bun:test';
import {
  QueryApplicationService,
  UNSCOPED,
  type ViewingScope,
} from '../../query.application-service.ts';

// The getter reads only options.viewingScope; the db handle is never touched.
const svc = (viewingScope?: ViewingScope | string) =>
  new QueryApplicationService({} as never, {
    scope: UNSCOPED,
    actorUserId: 'u1',
    ...(viewingScope ? { viewingScope: viewingScope as ViewingScope } : {}),
  });

describe('W1 — viewingScope fail-closed accessor (ADR-0027)', () => {
  it('defaults to personal when unset (fail-closed floor)', () => {
    expect(svc().viewingScope).toBe('personal');
  });

  it('passes org_wide through (the explicit opt-in)', () => {
    expect(svc('org_wide').viewingScope).toBe('org_wide');
  });

  it('resolves an explicit personal to personal', () => {
    expect(svc('personal').viewingScope).toBe('personal');
  });

  it('fails closed to personal on any unrecognized value (never silent org_wide)', () => {
    // A typo / future value / undefined must NOT escalate attribution.
    expect(svc('ORG_WIDE').viewingScope).toBe('personal');
    expect(svc('all').viewingScope).toBe('personal');
    expect(svc('').viewingScope).toBe('personal');
  });
});
