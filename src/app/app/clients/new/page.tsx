import type { Metadata } from 'next';
import Link from 'next/link';
import { ClientFields } from '@/components/client-form';
import { ActionForm, SubmitButton } from '@/components/forms';
import { PageHeader } from '@/components/ui';
import { agencyZone, loadAgency, paperDateRange } from '@/lib/agreements';
import { requireStaff } from '@/lib/auth/context';
import { savedTermsIssue } from '@/lib/compliance/agreement-terms';
import { memberLabel, staffMembers } from '@/lib/crm';
import { emailIsLive } from '@/lib/lead-outreach';
import { dayInZone } from '@/lib/util';
import { createClientAction } from '../actions';
import { QuickAdd } from './quick-add';

export const metadata: Metadata = { title: 'New client' };

/**
 * New client. An agency lands on "Invite a client" (./quick-add.tsx): a name and an email, and the client does the
 * rest from their welcome link. The full form, for staff who enter everything themselves or record paper signatures,
 * is the same address with `?manual=1`, and links back. The way to it is in the page header, so it is on screen when
 * the page opens whatever the size of the screen. A personal workspace has no client to invite, so it only ever sees
 * the full form.
 *
 * The card is told whether the agency's client agreement terms are ready (saved, and passing today's checks): a client
 * can be invited before they are, but cannot sign the service agreement until then, and the card says so.
 */
export default async function NewClientPage({ searchParams }: { searchParams: Promise<{ manual?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('clients:write');
  const personal = ctx.session.orgMode === 'personal';
  if (!personal && sp.manual !== '1') {
    const agency = await ctx.tx((db) => loadAgency(db, ctx.orgId));
    const terms = agency.terms ? 'ready' : savedTermsIssue(agency.settings) ? 'stale' : 'missing';
    return (
      <>
        <PageHeader title="New client" back={{ href: '/app/clients', label: 'Clients' }}
          actions={<Link href="/app/clients/new?manual=1" className="btn-secondary">Enter everything yourself</Link>} />
        <div className="mx-auto max-w-2xl">
          <QuickAdd emailLive={emailIsLive()} canSetUp={ctx.can('settings:manage')} terms={terms} />
          <p className="mt-5 text-center text-sm text-muted">No email address, or signed papers in front of you? Use “Enter everything yourself” at the top of this page.</p>
        </div>
      </>
    );
  }
  const { team, tz } = await ctx.tx(async (db) => ({ team: await staffMembers(db), tz: await agencyZone(db, ctx.orgId) }));
  return (
    <>
      <PageHeader title="New client" subtitle="Add the basics now — you can fill in the rest as onboarding progresses."
        back={personal ? { href: '/app/clients', label: 'Clients' } : { href: '/app/clients/new', label: 'Invite a client instead' }} />
      <ActionForm action={createClientAction} className="card card-pad mx-auto max-w-3xl">
        <ClientFields mode="create" canAssign={ctx.can('clients:assign')} team={team.map((m) => ({ id: m.id, label: memberLabel(m) }))}
          personal={personal} paperDates={paperDateRange(dayInZone(tz))} />
        <div className="mt-8 flex justify-end gap-3">
          <SubmitButton pendingText="Creating…">Create client</SubmitButton>
        </div>
      </ActionForm>
    </>
  );
}
