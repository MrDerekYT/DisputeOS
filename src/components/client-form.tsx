import { Check, Field, Select, TextArea } from '@/components/forms';
import { CLIENT_STAGES, CLIENT_STATUSES, STAGE_LABEL } from '@/lib/crm';

export interface ClientDefaults {
  id?: string; full_name?: string; email?: string | null; phone?: string | null; preferred_language?: string; status?: string; stage?: string;
  source?: string | null; goals?: string | null; assigned_to?: string | null; tags?: string[];
  address?: { line1?: string; line2?: string; city?: string; state?: string; zip?: string };
  ssn_last4?: string | null;
}

/** Shared by "New client" and "Edit client". Sensitive identifiers are write-only: never pre-filled. */
export function ClientFields({ d = {}, team, canAssign, mode }: { d?: ClientDefaults; team: { id: string; label: string }[]; canAssign: boolean; mode: 'create' | 'edit' }) {
  const a = d.address ?? {};
  return (
    <div className="space-y-8">
      {d.id && <input type="hidden" name="id" value={d.id} />}
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-base font-semibold">Contact</legend>
        <Field label="Full legal name" name="fullName" defaultValue={d.full_name} required autoComplete="off" className="sm:col-span-2" />
        <Field label="Email" name="email" type="email" defaultValue={d.email} autoComplete="off" />
        <Field label="Phone" name="phone" type="tel" defaultValue={d.phone} autoComplete="off" />
        <Select label="Preferred language" name="preferredLanguage" defaultValue={d.preferred_language ?? 'en'} options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]} />
        <Field label="How did they find you?" name="source" defaultValue={d.source} placeholder="Referral, website, event…" />
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-6">
        <legend className="mb-3 text-base font-semibold">Mailing address</legend>
        <Field label="Street" name="line1" defaultValue={a.line1} autoComplete="off" className="sm:col-span-4" />
        <Field label="Apt / unit" name="line2" defaultValue={a.line2} autoComplete="off" className="sm:col-span-2" />
        <Field label="City" name="city" defaultValue={a.city} autoComplete="off" className="sm:col-span-3" />
        <Field label="State" name="state" defaultValue={a.state} maxLength={2} placeholder="FL" autoComplete="off" className="sm:col-span-1" />
        <Field label="ZIP" name="zip" defaultValue={a.zip} autoComplete="off" className="sm:col-span-2" />
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-1 text-base font-semibold">Identity <span className="text-xs font-normal text-muted">— encrypted at rest; the full number is never shown again</span></legend>
        <Field label="Date of birth" name="dob" type="date" autoComplete="off" hint={mode === 'edit' ? 'Leave blank to keep the stored value.' : undefined} />
        <Field label="Social Security number" name="ssn" inputMode="numeric" autoComplete="off" placeholder={d.ssn_last4 ? `••• •• ${d.ssn_last4}` : '000-00-0000'} hint={mode === 'edit' ? 'Leave blank to keep the stored value.' : 'Optional now; only needed if you will submit it with disputes.'} />
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-base font-semibold">Case</legend>
        {mode === 'edit' ? (
          <>
            <Select label="Status" name="status" defaultValue={d.status} options={CLIENT_STATUSES.map((s) => ({ value: s, label: s.replace(/^\w/, (c) => c.toUpperCase()) }))} />
            <Select label="Journey stage" name="stage" defaultValue={d.stage} options={CLIENT_STAGES.map((s) => ({ value: s, label: STAGE_LABEL[s] }))} />
          </>
        ) : (
          <Select label="Status" name="status" defaultValue="onboarding" options={[{ value: 'lead', label: 'Lead' }, { value: 'onboarding', label: 'Onboarding' }, { value: 'active', label: 'Active' }]} />
        )}
        <Select label="Assigned specialist" name="assignedTo" defaultValue={d.assigned_to ?? ''} placeholder={mode === 'create' ? 'Me' : 'Unassigned'} options={team.map((t) => ({ value: t.id, label: t.label }))} hint={!canAssign ? 'Only managers and above can reassign clients.' : undefined} />
        <Field label="Tags" name="tags" defaultValue={d.tags?.join(', ')} placeholder="vip, referral" hint="Comma separated" />
        <TextArea label="Goals" name="goals" rows={3} defaultValue={d.goals} className="sm:col-span-2" placeholder="e.g. Qualify for an auto loan in 12 months" hint="In the client’s own words. Do not record promises or targets on their behalf." />
      </fieldset>

      {mode === 'create' && (
        <fieldset className="space-y-3 rounded-2xl border border-line bg-raised p-5">
          <legend className="px-1 text-base font-semibold">Consents &amp; portal</legend>
          <p className="text-sm text-muted">Record what the client has already received and signed. Disputes cannot be submitted until all three are on file (you can also record them later).</p>
          <Check name="consentDisclosure">Client received the <strong>Consumer Credit File Rights</strong> disclosure</Check>
          <Check name="consentContract">Client signed the <strong>service agreement</strong> (3-business-day cancellation right explained)</Check>
          <Check name="consentAuthorization">Client authorized us to <strong>review their reports and dispute on their behalf</strong></Check>
          <Field label="Name the client signed with" name="signedName" hint="Required if you tick any consent above." />
          <Check name="invite">Email an invitation to the client portal (needs an email address)</Check>
        </fieldset>
      )}
    </div>
  );
}
