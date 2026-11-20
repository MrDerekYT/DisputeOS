import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { Badge, Notice, Section } from '@/components/ui';
import { domainForOrg } from '@/lib/agency-domains';
import type { Ctx } from '@/lib/auth/context';
import { bareDomain, ownershipHost } from '@/lib/domain-rules';
import { vercelMissing } from '@/lib/vercel-domains';
import { checkDomainAction, connectDomainAction, removeDomainAction } from './domain-actions';

const STATUS = { pending: ['warn', 'Not connected yet'], verified: ['ok', 'Connected'], failed: ['bad', 'Needs attention'] } as const;

/** "Your own domain" on the Website page: connect a domain the agency already owns, see the DNS records it needs, check and remove it. */
export async function DomainSection({ ctx }: { ctx: Ctx }) {
  const d = await ctx.tx((db) => domainForOrg(db, ctx.orgId));
  const missing = vercelMissing();
  const manual = d ? d.details.source === 'manual' && d.status !== 'verified' : missing.length > 0;
  const operatorNote = (
    <Notice tone="warn" title="Domains are added by hand here">
      This app is not connected to its hosting provider ({missing.join(', ') || 'VERCEL_API_TOKEN'} not set), so it cannot add a domain itself.
      {d ? ' Your domain is saved, and it is not live until the platform operator adds it at the hosting provider and confirms it.' : ' You can save your domain; the platform operator then has to add it at the hosting provider before it works.'}
    </Notice>
  );
  if (!d) {
    return (
      <Section title="Your own domain" hint="Use a domain you already own for your site and client sign-in. Your address on this app keeps working.">
        <ActionForm action={connectDomainAction} className="space-y-4">
          <Field label="Domain" name="domain" placeholder="www.youragency.com" maxLength={253} required autoComplete="off" />
          {manual && operatorNote}
          <SubmitButton pendingText="Connecting…">Connect domain</SubmitButton>
        </ActionForm>
        <p className="mt-4 text-[0.8125rem] text-muted">Don’t have a domain yet? Buy one from any registrar, then connect it here.</p>
      </Section>
    );
  }
  const [tone, label] = STATUS[d.status];
  const twin = d.domain.startsWith('www.') ? bareDomain(d.domain) : `www.${d.domain}`;
  return (
    <Section title="Your own domain" actions={<Badge tone={tone}>{label}</Badge>}>
      <code className="block break-all rounded-lg bg-raised px-3 py-2 text-xs">{d.domain}</code>
      {d.status === 'verified' ? (
        <p className="mt-3 text-[0.8125rem] text-muted">Your site is at <span className="text-ink">https://{d.domain}</span> and your clients sign in at <span className="text-ink">https://{d.domain}/portal/login</span>. Your address on this app keeps working.</p>
      ) : (
        <>
          {d.details.error && <div className="mt-3"><Notice tone={d.status === 'failed' ? 'bad' : 'warn'}>{d.details.error}</Notice></div>}
          {manual && <div className="mt-3">{operatorNote}</div>}
          <p className="mt-4 text-[0.8125rem] text-muted">Create these records where you manage the domain’s DNS (usually the registrar you bought it from):</p>
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-muted"><tr><th className="py-1 pr-3 font-medium">Type</th><th className="py-1 pr-3 font-medium">Name</th><th className="py-1 font-medium">Value</th></tr></thead>
            <tbody>
              {[...d.details.records, d.ownership].map((r, i) => (
                <tr key={i} className="border-t border-line align-top"><td className="py-1.5 pr-3">{r.type}</td><td className="py-1.5 pr-3 break-all">{r.name}</td><td className="py-1.5 break-all">{r.value}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[0.8125rem] text-muted">The TXT record named {d.ownership.name} (in full: {ownershipHost(d.domain)}) proves the domain is yours: only someone who manages its DNS can create it. Your domain is not verified, and so not connected, until that record is there.</p>
          {manual && <p className="mt-2 text-[0.8125rem] text-muted">The {d.details.records[0]?.type ?? 'A or CNAME'} value above is the hosting provider’s general one. The platform operator confirms the exact value when adding your domain. The TXT record is exactly as shown.</p>}
        </>
      )}
      <p className="mt-3 text-[0.8125rem] text-muted">Only {d.domain} is connected. To make {twin} work too, forward it to {d.domain} at your registrar.</p>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
        <ActionForm action={checkDomainAction}><SubmitButton variant="secondary" pendingText="Checking…">Check now</SubmitButton></ActionForm>
        <ActionForm action={removeDomainAction}><SubmitButton variant="ghost" pendingText="Removing…">Remove domain</SubmitButton></ActionForm>
      </div>
    </Section>
  );
}
