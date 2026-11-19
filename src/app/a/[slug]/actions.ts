'use server';

import { redirect } from 'next/navigation';
import { after } from 'next/server';
import type { ActionState } from '@/components/forms';
import { sitePath } from '@/lib/agency-site';
import { requestMeta } from '@/lib/auth/context';
import { submitLead } from '@/lib/leads';
import { portalMessage } from '@/lib/portal-i18n';

/** The enquiry form on an agency's website. Same checks as /start/<slug> (submitLead); the lead's source is "website". */
export async function submitSiteLeadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const slug = String(fd.get('slug') ?? '');
  const meta = await requestMeta();
  const r = await submitLead(slug, {
    fullName: fd.get('fullName') ?? '', email: fd.get('email') ?? '', phone: fd.get('phone') ?? '', message: fd.get('message') ?? '',
    goal: fd.get('goal') || undefined, language: fd.get('language') === 'es' ? 'es' : 'en', consent: fd.get('consent') === 'on',
  }, { ip: meta.ip, honeypot: String(fd.get('company_website') ?? ''), src: 'website', defer: after });
  const es = fd.get('lang') === 'es';
  if (!r.ok) return { error: es ? portalMessage('es', r.error) : r.error };
  redirect(`${sitePath(slug)}?sent=1${es ? '&lang=es' : ''}#contact`);
}
