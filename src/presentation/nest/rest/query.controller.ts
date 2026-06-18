import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { InvalidQueryError, UnknownEntityError } from '../errors.ts';
import type {
  AggregateUseCase,
  CompareUseCase,
  DescribeUseCase,
  FetchUseCase,
  SearchUseCase,
} from '../use-cases.ts';
import { QuerySurfaceAuthGuard } from './query-surface-auth.guard.ts';
import {
  type AggregateRequestDto,
  type CompareRequestDto,
  type QueryFetchRequestDto,
  type QuerySearchRequestDto,
  aggregateRequestSchema,
  compareRequestSchema,
  queryFetchRequestSchema,
  querySearchRequestSchema,
} from './query.dto.ts';
import { ZodValidationPipe } from './zod-validation.pipe.ts';

const ENTITY_PARAM = {
  name: 'entity',
  type: 'string',
  description: 'Curated entity name — see GET /query/describe for the set the host exposes.',
} as const;

const ERROR_REF = { $ref: '#/components/schemas/ErrorResponseDto' } as const;

/**
 * Generic read surface over the host's curated entity set: one
 * describe/search/fetch contract for every entity, with the same JSON
 * FilterExpression and dotted-path traversal everywhere.
 *
 * Thin REST skin over the package-internal use-cases (call-path policy lives
 * there, once, shared with the future MCP projection). This layer only:
 * validates bodies (Zod), maps typed errors to HTTP, and carries OpenAPI
 * metadata. Identity never appears — the boundary interceptor entered the
 * requester context; the service resolves it ambiently.
 *
 * Auth is host policy via QUERY_SURFACE_AUTH_GUARD; the 'api-key' security
 * scheme name matches the host's DocumentBuilder registration.
 */
@Controller({ path: 'query', version: '1' })
@UseGuards(QuerySurfaceAuthGuard)
@ApiSecurity('api-key')
export class QueryController {
  private readonly logger = new Logger(QueryController.name);

  constructor(
    private readonly describeUseCase: DescribeUseCase,
    private readonly searchUseCase: SearchUseCase,
    private readonly fetchUseCase: FetchUseCase,
    private readonly aggregateUseCase: AggregateUseCase,
    private readonly compareUseCase: CompareUseCase,
  ) {}

  @Get('describe')
  @ApiOperation({
    summary: 'Describe all queryable entities + the users you can scope to',
    operationId: 'queryDescribe',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: { $ref: '#/components/schemas/QueryEntityCatalogDto' },
        },
        users: {
          type: 'array',
          description: 'Org members you may target with scope:{as:user,user:<id|email>}.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              email: { type: 'string' },
              name: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 401, schema: ERROR_REF })
  async describeAll() {
    return this.http(() => this.describeUseCase.all());
  }

  @Get('describe/:entity')
  @ApiOperation({
    summary: 'Describe one entity (typed field catalog incl. EAV virtual columns)',
    operationId: 'queryDescribeEntity',
  })
  @ApiParam(ENTITY_PARAM)
  @ApiResponse({
    status: 200,
    schema: { $ref: '#/components/schemas/QueryEntityCatalogDto' },
  })
  @ApiResponse({ status: 401, schema: ERROR_REF })
  @ApiResponse({ status: 404, schema: ERROR_REF })
  async describeEntity(@Param('entity') entity: string) {
    return this.http(() => this.describeUseCase.one(entity));
  }

  @Post(':entity')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Search an entity: filter to matching IDs (+ optional preview rows)',
    operationId: 'querySearch',
  })
  @ApiParam(ENTITY_PARAM)
  @ApiBody({ schema: { $ref: '#/components/schemas/QuerySearchRequestDto' } })
  @ApiResponse({
    status: 200,
    schema: { $ref: '#/components/schemas/QuerySearchResultDto' },
  })
  @ApiResponse({ status: 400, schema: ERROR_REF })
  @ApiResponse({ status: 401, schema: ERROR_REF })
  @ApiResponse({ status: 404, schema: ERROR_REF })
  async search(
    @Param('entity') entity: string,
    @Body(new ZodValidationPipe(querySearchRequestSchema))
    body: QuerySearchRequestDto,
  ) {
    return this.http(() => this.searchUseCase.execute(entity, body));
  }

  @Post(':entity/aggregate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Aggregate an entity: collapse to grouped rows with measures (grain-safe)',
    operationId: 'queryAggregate',
  })
  @ApiParam(ENTITY_PARAM)
  @ApiBody({ schema: { $ref: '#/components/schemas/AggregateRequestDto' } })
  @ApiResponse({
    status: 200,
    schema: { $ref: '#/components/schemas/AggregateResponseDto' },
  })
  @ApiResponse({ status: 400, schema: ERROR_REF })
  @ApiResponse({ status: 401, schema: ERROR_REF })
  @ApiResponse({ status: 404, schema: ERROR_REF })
  async aggregate(
    @Param('entity') entity: string,
    @Body(new ZodValidationPipe(aggregateRequestSchema))
    body: AggregateRequestDto,
  ) {
    return this.http(() => this.aggregateUseCase.execute(entity, body));
  }

  @Post(':entity/compare')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Compare a base aggregate across N variants (aligned + derived, or separate)',
    operationId: 'queryCompare',
  })
  @ApiParam(ENTITY_PARAM)
  @ApiBody({ schema: { $ref: '#/components/schemas/CompareRequestDto' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/CompareResponseDto' } })
  @ApiResponse({ status: 400, schema: ERROR_REF })
  @ApiResponse({ status: 401, schema: ERROR_REF })
  @ApiResponse({ status: 404, schema: ERROR_REF })
  async compare(
    @Param('entity') entity: string,
    @Body(new ZodValidationPipe(compareRequestSchema))
    body: CompareRequestDto,
  ) {
    return this.http(() => this.compareUseCase.execute(entity, body));
  }

  @Post(':entity/fetch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Fetch entity rows by IDs, with optional relational expand',
    operationId: 'queryFetch',
  })
  @ApiParam(ENTITY_PARAM)
  @ApiBody({ schema: { $ref: '#/components/schemas/QueryFetchRequestDto' } })
  @ApiResponse({
    status: 200,
    schema: { $ref: '#/components/schemas/QueryFetchResponseDto' },
  })
  @ApiResponse({ status: 400, schema: ERROR_REF })
  @ApiResponse({ status: 401, schema: ERROR_REF })
  @ApiResponse({ status: 404, schema: ERROR_REF })
  async fetch(
    @Param('entity') entity: string,
    @Body(new ZodValidationPipe(queryFetchRequestSchema))
    body: QueryFetchRequestDto,
  ) {
    const { ids, ...opts } = body;
    return this.http(() => this.fetchUseCase.execute(entity, ids, opts));
  }

  /** REST's half of the error contract: typed package errors → HTTP. */
  private async http<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof UnknownEntityError) {
        throw new NotFoundException(error.message);
      }
      if (error instanceof InvalidQueryError) {
        throw new BadRequestException(error.message);
      }
      // Anything else is an execution failure whose message can embed the
      // generated SQL + params (Drizzle wraps pg errors as
      // `Failed query: <sql> …`). Log it server-side, return an opaque 500 —
      // never the message (D4, 2026-06-11).
      this.logger.error(
        'query execution failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException('Query execution failed');
    }
  }
}
