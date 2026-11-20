import Link from 'next/link';
import { ActionForm, Select, SubmitButton } from '@/components/forms';
import { Section } from '@/components/ui';
import type { Ctx } from '@/lib/auth/context';
import { setReferredByAction } from '../../partners/actions';

/**
 * "Referred by": the referral partner who sent this client, if one did. Shown only in an agency workspace that has
 * partners on its list, so a workspace that does not use partners sees nothing here. The link lives in its own table
 * (partner_referrals); the count of referred clients is shown on the partner.
 */
export async function ReferredByBlock({ ctx, clientId }: { ctx: Ctx; clientId: string }) {
  if (ctx.session.orgMode !== 'agency') return null;
  const { current, partners } = await ctx.tx(async (db) => ({
    current: await db.row<{ partner_id: string; business_name: string }>(
      'select r.partner_id, p.business_name from public.partner_referrals r join public.partners p on p.id = r.partner_id where r.client_id = $1', [clientId]),
    partners: await db.rows<{ id: string; business_name: string }>('select id, business_name from public.partners order by lower(business_name), id limit 500'),
  }));
  if (!partners.length) return null;
  return (
    <Section plain id="referred-by" title="Referred by" hint="The partner who sent this client to you, if one did.">
      <p className="text-sm">{current ? <Link href={`/app/partners/${current.partner_id}`} className="font-medium hover:underline">{current.business_name}</Link> : <span className="text-muted">No partner recorded.</span>}</p>
      {ctx.can('clients:write') && (
        <ActionForm action={setReferredByAction} className="mt-3 space-y-3">
          <input type="hidden" name="clientId" value={clientId} />
          <Select label="Partner" name="partnerId" defaultValue={current?.partner_id ?? ''} placeholder="No partner" options={partners.map((p) => ({ value: p.id, label: p.business_name }))} />
          <SubmitButton variant="secondary">Save</SubmitButton>
        </ActionForm>
      )}
    </Section>
  );
}
