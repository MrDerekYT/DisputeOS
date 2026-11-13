import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ClientFields, type ClientDefaults } from '@/components/client-form';
import { ActionForm, ConfirmButton, Field, SubmitButton } from '@/components/forms';
import { Notice, PageHeader, Section } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { memberLabel, staffMembers } from '@/lib/crm';
import { isUuid } from '@/lib/util';
import { deleteClientAction, updateClientAction } from '../../actions';

export const metadata: Metadata = { title: 'Edit client' };

export default async function EditClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const ctx = await requireStaff('clients:write');
  const { client, team } = await ctx.tx(async (db) => ({
    client: await db.row<ClientDefaults & { id: string }>(
      'select id, full_name, email, phone, preferred_language, status, stage, source, goals, assigned_to, tags, address, ssn_last4 from public.clients where id = $1', [id]),
    team: await staffMembers(db),
  }));
  if (!client) notFound();
  return (
    <>
      <PageHeader title={`Edit ${client.full_name}`} back={{ href: `/app/clients/${id}`, label: client.full_name ?? 'Client' }} />
      <div className="mx-auto max-w-3xl space-y-6">
        <ActionForm action={updateClientAction} className="card card-pad">
          <ClientFields mode="edit" d={client} canAssign={ctx.can('clients:assign')} team={team.map((m) => ({ id: m.id, label: memberLabel(m) }))} />
          <div className="mt-8 flex justify-end"><SubmitButton pendingText="Saving…">Save changes</SubmitButton></div>
        </ActionForm>

        {ctx.can('clients:delete') && (
          <Section title="Delete client" hint="Permanently removes the client, their documents, reports, disputes and letters. This cannot be undone.">
            <Notice tone="warn">Consider exporting their data first, and check your retention obligations before deleting.</Notice>
            <ActionForm action={deleteClientAction} className="mt-4 flex flex-wrap items-end gap-3">
              <input type="hidden" name="id" value={id} />
              <Field label={`Type “${client.full_name}” to confirm`} name="confirm" className="min-w-[16rem] flex-1" autoComplete="off" />
              <ConfirmButton className="btn-danger" message="Permanently delete this client and all of their records?">Delete permanently</ConfirmButton>
            </ActionForm>
            <p className="mt-3 text-sm"><a className="text-brand-strong underline" href={`/api/clients/${id}/export`}>Download this client’s data (JSON)</a></p>
          </Section>
        )}
      </div>
    </>
  );
}
