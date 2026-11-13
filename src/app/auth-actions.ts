'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { parseForm, run, UserError, zOpt } from '@/lib/action';
import {
  clearSessionCookie, currentSession, requestMeta, sessionToken, setSessionCookie,
} from '@/lib/auth/context';
import {
  acceptInvite, authenticate, confirmTotp, createSession, requestPasswordReset, resetPassword, revokeSession, signUp,
} from '@/lib/auth/service';
import type { ActionState } from '@/components/forms';

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

function safeNext(n: string | undefined, fallback: string) {
  return n && n.startsWith('/') && !n.startsWith('//') && !n.includes('\\') ? n : fallback;
}

export async function loginAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const d = parseForm(z.object({ email, password: z.string().min(1, 'Enter your password').max(200), next: zOpt(300), portal: zOpt(5) }), fd);
    const r = await authenticate({ email: d.email, password: d.password, portal: d.portal === 'true' }, await requestMeta());
    if (!r.ok) return { error: r.error };
    await setSessionCookie(r.token, r.role);
    if (d.portal === 'true') redirect(r.needsMfa ? '/mfa' : '/portal');
    redirect(r.needsEnrollment ? '/mfa/setup' : r.needsMfa ? '/mfa' : safeNext(d.next, '/app'));
  });
}

export async function signUpAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const d = parseForm(
      z.object({
        fullName: z.string().trim().min(2, 'Enter your name').max(120),
        email,
        password: z.string().min(1).max(200),
        orgName: z.string().trim().min(2, 'Enter your business name').max(120),
        mode: z.enum(['agency', 'personal']).default('agency'),
        stateCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two-letter state code').optional().or(z.literal('')),
        terms: z.literal('on', { error: 'Please accept the terms to continue' }),
      }),
      fd,
    );
    const meta = await requestMeta();
    const r = await signUp({ ...d, stateCode: d.stateCode || undefined }, meta);
    if (!r.ok) return { error: r.error };
    const token = await createSession(r.userId, r.orgId, 'owner', meta, false);
    await setSessionCookie(token, 'owner');
    redirect('/mfa/setup');
  });
}

export async function logoutAction() {
  const t = await sessionToken();
  if (t) await revokeSession(t);
  await clearSessionCookie();
  redirect('/login');
}

export async function verifyMfaAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const s = await currentSession();
    if (!s) redirect('/login');
    const { code } = parseForm(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }), fd);
    const r = await confirmTotp(s.userId, s.sessionId, code, false);
    if (!r.ok) return { error: r.error };
    redirect(s.role === 'client' ? '/portal' : '/app');
  });
}

export async function enrollMfaAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const s = await currentSession();
    if (!s) redirect('/login');
    const { code } = parseForm(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }), fd);
    const r = await confirmTotp(s.userId, s.sessionId, code, true);
    if (!r.ok) return { error: r.error };
    redirect(s.role === 'client' ? '/portal' : '/app');
  });
}

export async function forgotPasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const d = parseForm(z.object({ email }), fd);
    await requestPasswordReset(d.email, await requestMeta());
    return { ok: 'If an account exists for that email, a reset link is on its way. It expires in 1 hour.' };
  });
}

export async function resetPasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const d = parseForm(z.object({ token: z.string().min(20).max(200), password: z.string().min(1).max(200), confirm: z.string() }), fd);
    if (d.password !== d.confirm) throw new UserError('The two passwords do not match.');
    const r = await resetPassword(d.token, d.password);
    if (!r.ok) return { error: r.error };
    redirect('/login?reset=1');
  });
}

export async function acceptInviteAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const d = parseForm(z.object({ token: z.string().min(20).max(200), fullName: z.string().trim().min(2).max(120), password: z.string().min(1).max(200) }), fd);
    const meta = await requestMeta();
    const r = await acceptInvite(d.token, { fullName: d.fullName, password: d.password }, meta);
    if (!r.ok) return { error: r.error };
    await setSessionCookie(r.token, r.role);
    redirect(r.role === 'client' ? '/portal' : '/mfa/setup');
  });
}
