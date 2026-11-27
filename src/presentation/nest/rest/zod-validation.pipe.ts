import {
  type ArgumentMetadata,
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { ZodError, ZodType } from 'zod';

/**
 * Package-local Zod validation pipe — same error contract as the dealbrain
 * backend's `core/pipes/zod-validation.pipe.ts` (`{message, error, errors}`),
 * duplicated here so the package presentation has no host imports.
 */
@Injectable()
// Typed by the schema's output. `any` by default, as the pipe was typed before Zod 4 (Zod 3's `ZodSchema` was
// `ZodType<any>`; Zod 4's is `ZodType<unknown>`), so an untyped pipe keeps its callers' types.
// biome-ignore lint/suspicious/noExplicitAny: the default keeps the pre-Zod-4 typing of `transform`'s result.
export class ZodValidationPipe<Output = any> implements PipeTransform<unknown, Output> {
  constructor(private schema: ZodType<Output>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): Output {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        error: 'Bad Request',
        errors: this.formatZodError(result.error),
      });
    }

    return result.data;
  }

  private formatZodError(error: ZodError): Record<string, string[]> {
    const errors: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const path = issue.path.join('.') || 'root';
      if (!errors[path]) errors[path] = [];
      errors[path].push(issue.message);
    }
    return errors;
  }
}
