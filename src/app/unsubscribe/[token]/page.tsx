import type { Metadata } from 'next';
import { CheckCircle2 } from 'lucide-react';
import { AuthLayout, PlainPage } from '@/components/auth-layout';
import { InlineMessage } from '@/components/portal-kit';
import { optOutLead } from '@/lib/lead-outreach';
import { orgBrandById } from '@/lib/org-brand';

export const metadata: Metadata = { title: 'Email preferences', robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * The opt-out link in every automatic lead email. Opening it is the whole action: no sign-in, no form. The token is
 * signed, so it cannot be guessed for someone else; opening it again changes nothing. A token that does not verify
 * gets an explanation instead of a bare "not found".
 */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const r = await optOutLead((await params).token);
  // A damaged or outdated link: say so plainly, in both languages (the reader's language is not known without a valid token).
  if (!r) return (
    <PlainPage logo={false} title="This link is not valid or has expired">
      <p>Nothing was changed. To stop automatic emails, use the opt-out link at the bottom of the most recent email you received, or reply to that email and ask to be removed.</p>
      <p lang="es" className="mt-4"><strong className="font-semibold text-ink">Este enlace no es válido o ha caducado.</strong> No se cambió nada. Para dejar de recibir correos automáticos, use el enlace para darse de baja al final del correo más reciente, o responda a ese correo y pida que lo eliminen de la lista.</p>
    </PlainPage>
  );
  const es = r.lang === 'es';
  return (
    <AuthLayout portal brand={await orgBrandById(r.orgId)} lang={r.lang}
      title={es ? 'Listo: no recibirá más correos automáticos' : 'Done — no more automatic emails'}
      subtitle={es ? `${r.orgName} ya no le enviará correos automáticos de seguimiento.` : `${r.orgName} will not send you any more automatic follow-up emails.`}>
      <InlineMessage tone="ok" icon={<CheckCircle2 size={18} />}>
        {es ? 'No necesita hacer nada más. Si más adelante desea hablar con ellos, puede escribirles cuando quiera.' : 'You do not need to do anything else. If you would like to talk to them later, you can contact them whenever you choose.'}
      </InlineMessage>
    </AuthLayout>
  );
}
