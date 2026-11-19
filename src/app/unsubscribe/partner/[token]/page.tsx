import type { Metadata } from 'next';
import { CheckCircle2 } from 'lucide-react';
import { AuthLayout, PlainPage } from '@/components/auth-layout';
import { InlineMessage } from '@/components/portal-kit';
import { orgBrandById } from '@/lib/org-brand';
import { partnerOptOutInfo } from '@/lib/partner-outreach';
import { stopPartnerEmailsAction } from './actions';

export const metadata: Metadata = { title: 'Email preferences', robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * The opt-out link in every email to a referral partner. One page, no sign-in: it asks "stop these emails?" and has
 * one button. Opening the page changes nothing, because mail security gateways open the links in incoming mail: if
 * opening were the opt-out, the first email would opt out every partner behind one before anyone read it. Pressing the
 * button is the opt-out, honoured at once and for good: that address is never emailed again, and it cannot be added
 * to the list again. A mail program's own "unsubscribe" button does the same through the List-Unsubscribe header
 * (/api/unsubscribe/partner/…). The token is signed, so it cannot be guessed for someone else; one that does not
 * verify gets an explanation instead of a bare "not found".
 */
export default async function PartnerUnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token;
  const r = await partnerOptOutInfo(token);
  if (!r) return (
    <PlainPage logo={false} title="This link is not valid or has expired">
      <p>Nothing was changed. To stop these emails, use the opt-out link at the bottom of the most recent email you received, or reply to that email and ask to be removed.</p>
      <p lang="es" className="mt-4"><strong className="font-semibold text-ink">Este enlace no es válido o ha caducado.</strong> No se cambió nada. Para dejar de recibir estos correos, use el enlace para darse de baja al final del correo más reciente, o responda a ese correo y pida que lo eliminen de la lista.</p>
    </PlainPage>
  );
  const es = r.lang === 'es';
  const brand = await orgBrandById(r.orgId);
  if (r.optedOut) return (
    <AuthLayout portal brand={brand} lang={r.lang}
      title={es ? 'Listo: no recibirá más correos' : 'Done: no more emails'}
      subtitle={es ? `${r.orgName} no volverá a escribir a esta dirección.` : `${r.orgName} will not email this address again.`}>
      <InlineMessage tone="ok" icon={<CheckCircle2 size={18} />}>
        {es ? 'No necesita hacer nada más. Esta baja es permanente. Si más adelante desea hablar con ellos, puede escribirles cuando quiera.' : 'You do not need to do anything else. This is permanent. If you would like to talk to them later, you can contact them whenever you choose.'}
      </InlineMessage>
    </AuthLayout>
  );
  return (
    <AuthLayout portal brand={brand} lang={r.lang}
      title={es ? `¿Dejar de recibir correos de ${r.orgName}?` : `Stop emails from ${r.orgName}?`}
      subtitle={es ? 'Un clic y esta dirección no recibirá más correos de ellos.' : 'One click, and this address gets no more email from them.'}>
      <form action={stopPartnerEmailsAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <button type="submit" className="btn-primary w-full">{es ? 'Sí, dejar de recibir estos correos' : 'Yes, stop these emails'}</button>
        <p className="text-sm text-muted">{es ? 'Es permanente: no volverán a escribir a esta dirección. Si no quiere cambiar nada, simplemente cierre esta página.' : 'It is permanent: they will not write to this address again. To change nothing, just close this page.'}</p>
      </form>
    </AuthLayout>
  );
}
