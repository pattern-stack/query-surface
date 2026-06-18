import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { QUERY_SURFACE_AUTH_GUARD } from '../tokens.ts';

/**
 * Delegating guard: the package controller declares `@UseGuards(...)` with a
 * class it owns, while authentication itself stays host policy — the host
 * binds its real guard (e.g. dealbrain's ApiKeyGuard) to
 * `QUERY_SURFACE_AUTH_GUARD`. Same seam style as integrations'
 * `I_TRPC_AUTH_MIDDLEWARE`.
 */
@Injectable()
export class QuerySurfaceAuthGuard implements CanActivate {
  constructor(@Inject(QUERY_SURFACE_AUTH_GUARD) private readonly inner: CanActivate) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    return this.inner.canActivate(context);
  }
}
