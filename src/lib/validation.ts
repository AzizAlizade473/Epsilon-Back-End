import { z } from 'zod';

import { ApiError } from '../errors.js';

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Field paths only; never echo submitted values (may contain phone/comment).
    const fields = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(body)'))];
    throw new ApiError(422, 'VALIDATION_FAILED', `Invalid fields: ${fields.join(', ')}`);
  }
  return result.data;
}

/** Same normalisation as the app's phoneSchema: Azerbaijani mobile → +994XXXXXXXXX. */
export const phoneSchema = z
  .string()
  .max(32)
  .transform((value) => {
    const digits = value.replace(/\D/g, '');
    if (digits.startsWith('994') && digits.length > 9) return digits.slice(3);
    if (digits.startsWith('0')) return digits.slice(1);
    return digits;
  })
  .pipe(z.string().regex(/^(50|51|55|70|77|99|10|60)\d{7}$/))
  .transform((digits) => `+994${digits}`);

export const otpCodeSchema = z.string().regex(/^\d{6}$/);
export const intentSchema = z.enum(['login', 'register']).optional();
export const idParam = z.object({ id: z.uuid() }).strict();

export const pageQuery = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

/** Opaque keyset cursor: base64url JSON of [sortValue, id]. No PII is stored in it. */
export function encodeCursor(sortValue: string, id: string): string {
  return Buffer.from(JSON.stringify([sortValue, id])).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return parse(z.tuple([z.string().max(256), z.uuid()]), value);
  } catch {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid cursor');
  }
}
