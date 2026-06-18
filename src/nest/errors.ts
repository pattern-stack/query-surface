/**
 * Typed errors for the external call path. The internal use-cases translate
 * the engine's plain Errors (stable message prefixes) into these; each
 * protocol presentation maps them to its own vocabulary (REST → 404/400,
 * future MCP → tool-error content). Exported so host exception filters can
 * recognize them; the use-cases that THROW them stay package-internal.
 */

import { ENGINE_ERROR } from '../engine/error-messages.ts';

export class UnknownEntityError extends Error {
  override readonly name = 'UnknownEntityError';
  constructor(public readonly entity: string) {
    super(`${ENGINE_ERROR.UNKNOWN_ENTITY}${entity}`);
  }
}

export class InvalidQueryError extends Error {
  override readonly name = 'InvalidQueryError';
}

/**
 * Run an engine call, rethrowing caller-input problems as typed errors.
 * Anything unrecognized propagates untouched (real failures stay loud).
 */
export async function translateEngineErrors<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.startsWith(ENGINE_ERROR.UNKNOWN_ENTITY.trimEnd())) {
        throw new UnknownEntityError(error.message.replace(ENGINE_ERROR.UNKNOWN_ENTITY, ''));
      }
      if (
        error.message.startsWith(ENGINE_ERROR.FIELD_PATH) ||
        error.message.startsWith(ENGINE_ERROR.EXPAND_PATH) ||
        error.message.startsWith(ENGINE_ERROR.EXPAND_DEPTH) ||
        error.message.startsWith(ENGINE_ERROR.RANK) ||
        error.message.startsWith(ENGINE_ERROR.FILTER) ||
        error.message.startsWith(ENGINE_ERROR.AGGREGATE) ||
        error.message.includes(ENGINE_ERROR.UNSUPPORTED_IN_PATH)
      ) {
        throw new InvalidQueryError(error.message);
      }
    }
    throw error;
  }
}
