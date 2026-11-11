import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { isHTTPAccessFallbackError } from 'next/dist/client/components/http-access-fallback/http-access-fallback';
import { z } from 'zod';
import { PermissionError } from './rbac';
import type { ActionState } from '@/components/forms';

import { UserError } from './errors';
export { UserError };

/** Wraps a server action body: user errors and permission errors become form messages; redirects pass through. */
export async function run(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  try {
    return (await fn()) ?? { ok: 'Saved.' };
  } catch (e) {
    if (isRedirectError(e) || isHTTPAccessFallbackError(e)) throw e;
    if (e instanceof UserError) return { error: e.message };
    if (e instanceof PermissionError) return { error: 'Your role does not allow that action.' };
    const code = (e as { code?: string }).code;
    if (code === '42501') return { error: 'You do not have access to that record.' };
    if (code === '23505') return { error: 'That already exists.' };
    console.error('[action]', e);
    return { error: 'Something went wrong. Please try again.' };
  }
}

export function parseForm<S extends z.ZodType>(schema: S, fd: FormData): z.infer<S> {
  const raw: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) {
    if (k.startsWith('$ACTION')) continue;
    if (typeof v !== 'string') continue;
    raw[k] = k in raw ? ([] as unknown[]).concat(raw[k], v) : v;
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = issue?.path.join('.') || 'input';
    throw new UserError(`${field}: ${issue?.message ?? 'invalid value'}`.replace(/^input: /, ''));
  }
  return r.data;
}

/** Loose UUID (accepts any 8-4-4-4-12 hex). */
export const zUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'invalid id');
export const zText = (max = 200) => z.string().trim().min(1, 'required').max(max);
export const zOpt = (max = 200) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
/** Checkbox: browsers OMIT unchecked boxes from the form, so the key must be optional (absent = false). */
export const zBool = z.union([z.literal('on'), z.literal('true')]).optional().transform((v) => v === 'on' || v === 'true');
