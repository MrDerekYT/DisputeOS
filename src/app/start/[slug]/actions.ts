'use server';

import { redirect } from 'next/navigation';
import { after } from 'next/server';
import type { ActionState } from '@/components/forms';
import { requestMeta } from '@/lib/auth/context';
import { leadFormPath, submitLead } from '@/lib/leads';
import { portalMessage, tr } from '@/lib/portal-i18n';
import { requestAgencySlug } from '@/lib/request-host';

export async function submitLeadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const slug = String(fd.get('slug') ?? '');
  const meta = await requestMeta();
  const r = await submitLead(slug, {
    fullName: fd.get('fullName') ?? '', email: fd.get('email') ?? '', phone: fd.get('phone') ?? '', message: fd.get('message') ?? '',
    goal: fd.get('goal') || undefined, language: fd.get('language') === 'es' ? 'es' : 'en', consent: fd.get('consent') === 'on',
    smsConsent: fd.get('smsConsent') === 'on', // the separate text-message box; absent unless the person ticked it
  }, { ip: meta.ip, userAgent: meta.userAgent, shownIn: fd.get('lang') === 'es' ? 'es' : 'en', honeypot: String(fd.get('company_website') ?? ''), src: String(fd.get('src') ?? ''), defer: after });
  // `lang` is the language the form was shown in (not the preferred-language answer): errors and the thank-you page follow it.
  const es = fd.get('lang') === 'es';
  if (!r.ok) return { error: es ? portalMessage('es', r.error) : r.error };
  // On the agency's own domain the page is found by its Host ("/" and "/start" are rewritten), and a redirect from a
  // server action is pre-rendered by the server calling itself, where that Host can be lost. So there the form is told
  // it worked and the browser opens the thank-you page itself (ActionForm onSuccessHref).
  if ((await requestAgencySlug()) === slug) return { ok: tr(es ? 'es' : 'en')('lead_thanksTitle') };
  redirect(`${leadFormPath(slug)}?sent=1${es ? '&lang=es' : ''}`);
}
