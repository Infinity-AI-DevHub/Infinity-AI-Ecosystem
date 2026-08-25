/**
 * Input validation and output encoding helpers.
 * Every endpoint validates its input against a schema before touching the domain.
 */
import { z } from 'zod';
import { badRequest, unprocessable } from './errors.js';
import { config } from './config.js';

export { z };

export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw unprocessable(
      'Request validation failed',
      result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(body)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export const uuid = z.string().uuid('Must be a valid identifier');

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .email('Must be a valid email address')
  .transform((v) => v.toLowerCase());

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(config.limits.maxPageSize).default(25),
});

export type Pagination = z.infer<typeof paginationSchema>;

/** Opaque cursor over (timestamp, id) so pages stay stable while rows are inserted. */
export function encodeCursor(value: { at: string | Date; id: string | number }): string {
  const at = value.at instanceof Date ? value.at.toISOString() : value.at;
  return Buffer.from(JSON.stringify({ at, id: value.id })).toString('base64url');
}

export function decodeCursor(cursor?: string): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed?.at !== 'string' || parsed?.id === undefined) return null;
    return { at: parsed.at, id: String(parsed.id) };
  } catch {
    throw badRequest('Malformed pagination cursor');
  }
}

/** HTML escaping for anything rendered into a snippet or notification. */
export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Filenames are never trusted; path traversal and control characters are removed. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || 'file').slice(0, 255);
}

const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'com', 'bat', 'cmd', 'scr', 'pif', 'msi', 'jar', 'vbs', 'js', 'ps1', 'lnk', 'reg', 'dll',
]);

export function isDangerousAttachment(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return DANGEROUS_EXTENSIONS.has(ext);
}
