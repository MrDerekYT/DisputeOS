'use server';

import { redirect } from 'next/navigation';
import type { ActionState } from '@/components/forms';
import { requestMeta } from '@/lib/auth/context';
import { leadFormPath, submitLead } from '@/lib/leads';

export async function submitLeadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const slug = String(fd.get('slug') ?? '');
  const meta = await requestMeta();
  const r = await submitLead(slug, {
    fullName: fd.get('fullName') ?? '', email: fd.get('email') ?? '', phone: fd.get('phone') ?? '', message: fd.get('message') ?? '',
    goal: fd.get('goal') || undefined, language: fd.get('language') === 'es' ? 'es' : 'en', consent: fd.get('consent') === 'on',
  }, { ip: meta.ip, honeypot: String(fd.get('company_website') ?? '') });
  if (!r.ok) return { error: r.error };
  redirect(`${leadFormPath(slug)}?sent=1`);
}
