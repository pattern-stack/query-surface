import { Module } from '@nestjs/common';
import { QuerySurfaceService } from './query-surface.service.ts';

/**
 * Package-owned NestJS module — mount it from a host module that binds the
 * two seams (same pattern as `@repo/integrations`'s root/host module pair):
 *
 *   @Module({
 *     imports: [QuerySurfaceModule],
 *     providers: [
 *       { provide: QUERY_SURFACE_DRIZZLE, useExisting: DRIZZLE },
 *       { provide: QUERY_SURFACE_OPTIONS, useValue: { schema, eav, scopeFor, getRequester } },
 *     ],
 *     exports: [QuerySurfaceModule],
 *   })
 *   export class QuerySurfaceHostModule {}
 *
 * Token providers must be visible to this module's injector — bind them in
 * a @Global host module, or re-provide them alongside the import.
 */
@Module({
  providers: [QuerySurfaceService],
  exports: [QuerySurfaceService],
})
export class QuerySurfaceModule {}
