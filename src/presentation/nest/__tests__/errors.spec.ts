// Error-classification contract: the aggregate engine's caller-input throws must
// map to typed errors (→ 400/404), not the catch-all 500. Pure unit — no DB.
import { describe, expect, it } from 'bun:test';
import { ENGINE_ERROR } from '../../../internal/language/error-messages';
import { InvalidQueryError, UnknownEntityError, translateEngineErrors } from '../errors';

const throwing = (msg: string) => () =>
  translateEngineErrors(() => {
    throw new Error(msg);
  });

describe('translateEngineErrors — aggregate caller-input classification', () => {
  it('aggregate: doctor findings → InvalidQueryError (400)', async () => {
    await expect(
      throwing(`${ENGINE_ERROR.AGGREGATE} SUM_NON_ADDITIVE: cannot SUM "deal_probability"`)(),
    ).rejects.toBeInstanceOf(InvalidQueryError);
  });

  it('aggregate: unknown column → InvalidQueryError (400)', async () => {
    await expect(
      throwing(`${ENGINE_ERROR.AGGREGATE} unknown column "nope" on observations`)(),
    ).rejects.toBeInstanceOf(InvalidQueryError);
  });

  it('aggregate: unsafe identifier → InvalidQueryError (400)', async () => {
    await expect(
      throwing(`${ENGINE_ERROR.AGGREGATE} unsafe identifier: x) or (1=1`)(),
    ).rejects.toBeInstanceOf(InvalidQueryError);
  });

  it('unknown root/source entity → UnknownEntityError (404)', async () => {
    await expect(throwing(`${ENGINE_ERROR.UNKNOWN_ENTITY}made_up`)()).rejects.toBeInstanceOf(
      UnknownEntityError,
    );
  });

  it('an unprefixed execution error is NOT reclassified (stays a 500 upstream)', async () => {
    await expect(throwing('Failed query: select ... syntax error')()).rejects.not.toBeInstanceOf(
      InvalidQueryError,
    );
  });
});
