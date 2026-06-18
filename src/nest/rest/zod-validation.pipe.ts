import {
  type ArgumentMetadata,
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { ZodError, ZodSchema } from 'zod';

/**
 * Package-local Zod validation pipe — same error contract as the dealbrain
 * backend's `core/pipes/zod-validation.pipe.ts` (`{message, error, errors}`),
 * duplicated here so the package presentation has no host imports.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata) {
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
