import { ActionForm, Field, Select, SubmitButton } from '@/components/forms';
import { Badge, Section } from '@/components/ui';
import type { Ctx } from '@/lib/auth/context';
import { loadMarks, loadReportedEntries, PI_BUREAUS, PI_KIND_LABEL, PI_KINDS } from '@/lib/credit/personal-info';
import { BUREAU_LABEL } from '@/lib/util';
import { addPersonalInfoMarkAction, draftPersonalInfoLetterAction, removePersonalInfoMarkAction } from '../letter-tools-actions';

/**
 * "Personal information on reports": which names, addresses, employers, phone numbers or date of birth on each
 * bureau's report the client says are wrong or not theirs. Names, addresses and employers are offered from the imported
 * report; anything else is typed as the report shows it. One button drafts the correction letter for a bureau as an
 * ordinary dispute with a draft letter. Nothing is sent from here.
 */
export async function PersonalInfoBlock({ ctx, clientId }: { ctx: Ctx; clientId: string }) {
  const d = await ctx.tx(async (db) => ({ marks: await loadMarks(db, clientId), reported: await loadReportedEntries(db, clientId) }));
  const canWrite = ctx.can('clients:write');
  const canDraft = ctx.can('disputes:write') && ctx.can('letters:write');
  const marked = new Set(d.marks.map((m) => `${m.bureau}|${m.kind}|${m.value.toLowerCase()}`));
  const pick = d.reported.filter((r) => !marked.has(`${r.bureau}|${r.kind}|${r.value.toLowerCase()}`));
  return (
    <Section plain id="personal-info" title="Personal information on reports"
      hint="Names, addresses, employers, phone numbers and dates of birth a bureau shows that the client says are wrong or not theirs. Mark only what the client has told you.">
      {d.marks.length === 0 ? <p className="text-sm text-muted">Nothing marked.</p> : (
        <ul className="divide-y divide-line/70">
          {PI_BUREAUS.filter((b) => d.marks.some((m) => m.bureau === b)).map((b) => (
            <li key={b} className="py-3 first:pt-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{BUREAU_LABEL[b]}</span>
                {canDraft && (
                  <ActionForm action={draftPersonalInfoLetterAction}>
                    <input type="hidden" name="clientId" value={clientId} /><input type="hidden" name="bureau" value={b} />
                    <SubmitButton variant="secondary" className="btn-sm" pendingText="Drafting…">Draft correction letter</SubmitButton>
                  </ActionForm>
                )}
              </div>
              <ul className="mt-2 space-y-1.5 text-sm">
                {d.marks.filter((m) => m.bureau === b).map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <span className="text-muted">{PI_KIND_LABEL[m.kind]}:</span> {m.value}
                      <span className="text-muted"> · {m.issue === 'not_mine' ? 'not theirs' : m.correctValue ? `not correct, should be ${m.correctValue}` : 'not correct'}</span>
                      {m.source === 'client' && <> <Badge>Marked by the client</Badge></>}
                    </span>
                    {canWrite && (
                      <ActionForm action={removePersonalInfoMarkAction}>
                        <input type="hidden" name="clientId" value={clientId} /><input type="hidden" name="markId" value={m.id} />
                        <SubmitButton variant="ghost" className="btn-sm">Remove</SubmitButton>
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <details className="mt-3 border-t border-line pt-3">
          <summary className="link cursor-pointer text-sm">Mark an entry</summary>
          <ActionForm action={addPersonalInfoMarkAction} resetOnSuccess className="mt-3 space-y-3">
            <input type="hidden" name="clientId" value={clientId} />
            {pick.length > 0 && (
              <Select label="Entry shown on a report" name="picked" placeholder="Not listed: type it below"
                options={pick.map((r) => ({ value: `${r.bureau}|${r.kind}|${r.value}`, label: `${BUREAU_LABEL[r.bureau]} · ${PI_KIND_LABEL[r.kind]} · ${r.value}`.slice(0, 120) }))}
                hint="From the newest approved report of each bureau." />
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="Bureau" name="bureau" options={PI_BUREAUS.map((b) => ({ value: b, label: BUREAU_LABEL[b] }))} />
              <Select label="Kind of entry" name="kind" options={PI_KINDS.map((k) => ({ value: k, label: PI_KIND_LABEL[k] }))} />
            </div>
            <Field label="Entry, exactly as the report shows it" name="value" maxLength={300} hint={pick.length ? 'Only when it is not in the list above.' : 'Phone numbers and dates of birth are always typed.'} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="What the client says" name="issue" options={[{ value: 'not_mine', label: 'Not theirs' }, { value: 'incorrect', label: 'Theirs, but not correct' }]} />
              <Field label="Correct entry (optional)" name="correctValue" maxLength={300} />
            </div>
            <SubmitButton variant="secondary">Mark</SubmitButton>
          </ActionForm>
        </details>
      )}
    </Section>
  );
}
