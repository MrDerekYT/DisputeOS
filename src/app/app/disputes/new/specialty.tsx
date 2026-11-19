import Link from 'next/link';
import { ActionForm, Check, Field, SubmitButton, TextArea } from '@/components/forms';
import { Badge, Notice, PageHeader } from '@/components/ui';
import { MailRequirements } from '@/components/mail-requirements';
import { AGENCY_KIND_LABEL, SPECIALTY_AGENCIES, specialtyAgency, type Agency } from '@/lib/credit/agencies';
import { fmtDate } from '@/lib/util';
import { createSpecialtyDisputeAction } from '../actions';

/** Where the letter will be addressed: the verified address with its source, or a required field when none is verified. */
function Address({ agency }: { agency: Agency }) {
  const a = agency.disputeAddress;
  if (a) {
    return (
      <div className="rounded-xl bg-raised p-3.5 text-sm">
        <p className="text-muted">The letter will be addressed to</p>
        <p className="mt-1 whitespace-pre-line font-medium">{[agency.name, ...a.lines].join('\n')}</p>
        <p className="mt-2 text-[0.8125rem] text-muted">Read on <a className="link" href={a.sourceUrl} target="_blank" rel="noreferrer">{new URL(a.sourceUrl).hostname}</a> on {fmtDate(a.verifiedOn)}. Check the agency’s page if that was a while ago.</p>
      </div>
    );
  }
  return (
    <TextArea label="Dispute mailing address" name="recipientAddress" rows={3} required maxLength={400}
      hint={`There is no verified dispute address on file for ${agency.shortName}, so nothing is filled in. Copy it from the agency’s current instructions or its dispute form.`} />
  );
}

/** Step 2 and 3 for an item on a specialty agency's disclosure: choose the agency, then type the item in. */
export function SpecialtySteps({ client, agencyKey }: { client: { id: string; full_name: string }; agencyKey?: string }) {
  const agency = specialtyAgency(agencyKey);
  const base = `/app/disputes/new?clientId=${client.id}`;

  if (!agency) {
    return (
      <>
        <PageHeader title="New dispute" subtitle={`Step 2 of 3 · Which agency reported the item for ${client.full_name}?`} back={{ href: base, label: 'Change item' }} />
        <div className="mx-auto max-w-2xl space-y-4">
          <p className="text-sm text-muted">These reports are not read by the system. A person types in the item from the client’s disclosure.</p>
          <ul className="space-y-3">
            {SPECIALTY_AGENCIES.map((a) => (
              <li key={a.key}>
                <Link href={`${base}&agency=${a.key}`} className="card block p-4 transition hover:border-brand/50">
                  <span className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{a.shortName}</span><Badge>{AGENCY_KIND_LABEL[a.kind].en}</Badge></span>
                  <span className="mt-1 block text-sm text-muted">{a.reports.en}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="New dispute" subtitle={`Step 3 of 3 · ${client.full_name} · ${agency.shortName}`} back={{ href: `${base}&specialty=1`, label: 'Change agency' }} />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <ActionForm action={createSpecialtyDisputeAction} className="card card-pad space-y-5">
          <input type="hidden" name="clientId" value={client.id} /><input type="hidden" name="agency" value={agency.key} />
          <fieldset className="space-y-4">
            <legend className="label">The item, as it appears on the disclosure</legend>
            <Field label="Company or account name" name="itemName" required maxLength={160} />
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Reference or masked number" name="itemReference" maxLength={60} hint="Never a full account number." />
              <Field label="Date shown" name="itemDate" maxLength={40} />
              <Field label="Amount shown" name="itemAmount" maxLength={40} />
            </div>
            <Field label="Consumer ID or file number" name="consumerId" maxLength={60} required={agency.letterNeeds.includes('consumer_id')}
              hint={agency.letterNeeds.includes('consumer_id') ? `Printed on the first page of the ${agency.shortName} disclosure.` : 'Only if the disclosure prints one for the consumer.'} />
          </fieldset>
          <TextArea label="What is inaccurate, incomplete or unverifiable, and why" name="reason" rows={7} required maxLength={4000}
            hint="State facts from the disclosure and the client’s records. The letter repeats this text as written." />
          <Address agency={agency} />
          <Check name="makeLetter" defaultChecked>Also draft the letter (you will review and edit it before anything can be approved)</Check>
          <div className="flex justify-end gap-3"><SubmitButton pendingText="Creating…">Create dispute draft</SubmitButton></div>
        </ActionForm>

        <aside className="space-y-4">
          <Notice tone="info" title="Before you dispute">
            Dispute only information you have reason to believe is inaccurate, incomplete or unverifiable. Accurate information generally stays on the report. Nothing is sent until a person approves it.
          </Notice>
          <MailRequirements agency={agency} />
        </aside>
      </div>
    </>
  );
}
