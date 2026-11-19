'use server';

import { redirect } from 'next/navigation';
import { optOutPartner } from '@/lib/partner-outreach';

/**
 * The one button on the opt-out page. Pressing it is the opt-out: no sign-in, nothing else to fill in. The token in
 * the form is the signed one from the email, verified again here; a token that does not verify changes nothing.
 */
export async function stopPartnerEmailsAction(fd: FormData) {
  const token = String(fd.get('token') ?? '').slice(0, 200);
  await optOutPartner(token);
  redirect(`/unsubscribe/partner/${encodeURIComponent(token)}`);
}
