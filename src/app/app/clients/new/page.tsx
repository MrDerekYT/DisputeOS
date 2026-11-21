import type { Metadata } from 'next';
import { ClientFields } from '@/components/client-form';
import { ActionForm, SubmitButton } from '@/components/forms';
import { PageHeader } from '@/components/ui';
import { agencyZone, paperDateRange } from '@/lib/agreements';
import { requireStaff } from '@/lib/auth/context';
import { memberLabel, staffMembers } from '@/lib/crm';
import { dayInZone } from '@/lib/util';
import { createClientAction } from '../actions';

export const metadata: Metadata = { title: 'New client' };

export default async function NewClientPage() {
  const ctx = await requireStaff('clients:write');
  const { team, tz } = await ctx.tx(async (db) => ({ team: await staffMembers(db), tz: await agencyZone(db, ctx.orgId) }));
  return (
    <>
      <PageHeader title="New client" subtitle="Add the basics now — you can fill in the rest as onboarding progresses." back={{ href: '/app/clients', label: 'Clients' }} />
      <ActionForm action={createClientAction} className="card card-pad mx-auto max-w-3xl">
        <ClientFields mode="create" canAssign={ctx.can('clients:assign')} team={team.map((m) => ({ id: m.id, label: memberLabel(m) }))}
          personal={ctx.session.orgMode === 'personal'} paperDates={paperDateRange(dayInZone(tz))} />
        <div className="mt-8 flex justify-end gap-3">
          <SubmitButton pendingText="Creating…">Create client</SubmitButton>
        </div>
      </ActionForm>
    </>
  );
}
