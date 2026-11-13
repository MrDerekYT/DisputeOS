import type { Metadata } from 'next';
import { Play, ShieldCheck, Zap } from 'lucide-react';
import { ActionForm, Check, ConfirmButton, Field, Select, SubmitButton } from '@/components/forms';
import { Badge, EmptyState, Notice, PageHeader, Section, StatusBadge } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { ACTION_TYPES, TRIGGERS, type ActionDef, type AutomationRow } from '@/lib/automation/engine';
import { DOC_KIND_LABEL, DOC_KINDS } from '@/lib/crm';
import { fmtDate, relTime } from '@/lib/util';
import { addStartersAction, deleteAutomationAction, runNowAction, saveAutomationAction, toggleAutomationAction } from './actions';

export const metadata: Metadata = { title: 'Automations' };

const actionOpts = [{ value: '', label: '— none —' }, ...Object.entries(ACTION_TYPES).map(([k, v]) => ({ value: k, label: `${v.label}${v.clientFacing ? ' (client-facing)' : ''}` }))];
const triggerOpts = Object.entries(TRIGGERS).map(([k, v]) => ({ value: k, label: `${v.label}${v.kind === 'sweep' ? ' · scheduled' : ''}` }));

function Describe({ a }: { a: AutomationRow }) {
  const c = a.conditions;
  const bits = [c.days && `${c.days}+ days`, c.afterDays && `after ${c.afterDays} days`, c.withinDays && `within ${c.withinDays} days`, c.toStatus && `to “${c.toStatus.replace(/_/g, ' ')}”`].filter(Boolean);
  return <span className="text-sm text-muted">When <strong className="text-ink">{TRIGGERS[a.trigger]?.label.toLowerCase()}</strong>{bits.length ? ` (${bits.join(', ')})` : ''} → {a.actions.map((x: ActionDef) => ACTION_TYPES[x.type]?.label.toLowerCase()).join(', then ')}</span>;
}

export default async function AutomationsPage() {
  const ctx = await requireStaff('automations:manage');
  const { autos, runs, jobs } = await ctx.tx(async (db) => ({
    jobs: await db.rows<{ id: string; status: string; started_at: string; executed: number; pending: number; skipped: number; error: string | null }>('select id, status, started_at, executed, pending, skipped, error from public.job_runs order by started_at desc limit 5'),
    autos: await db.rows<AutomationRow>('select * from public.automations order by created_at'),
    runs: await db.rows<{ id: string; status: string; created_at: string; name: string; client: string | null }>(
      `select r.id, r.status, r.created_at, a.name, r.result->>'client_name' as client from public.automation_runs r join public.automations a on a.id = r.automation_id order by r.created_at desc limit 15`),
  }));
  return (
    <>
      <PageHeader title="Automations" subtitle="Save your team time on reminders and follow-ups — with guardrails so nothing is sent twice or without approval."
        actions={<><ActionForm action={addStartersAction} className="inline"><SubmitButton variant="secondary">Add recommended set</SubmitButton></ActionForm><ActionForm action={runNowAction} className="inline"><SubmitButton variant="secondary"><Play size={14} /> Run scheduled checks now</SubmitButton></ActionForm></>} />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {[['No duplicates', 'Each automation runs once per client or dispute per cooldown window — enforced in the database.'], ['People approve', 'Client-facing messages wait in your Inbox until someone approves the exact text.'], ['Capped runs', 'A single run can touch only a limited number of clients, so nothing becomes a mass message by accident.']].map(([t, b]) => (
          <div key={t} className="card flex gap-3 p-4"><ShieldCheck size={18} className="mt-0.5 shrink-0 text-brand" /><div><div className="text-sm font-semibold">{t}</div><p className="text-xs text-muted">{b}</p></div></div>))}
      </div>

      {autos.length === 0 ? <EmptyState title="No automations yet" body="Start with the recommended set — they are created switched off so you can review each one." icon={<Zap size={20} />} /> : (
        <div className="space-y-3">{autos.map((a) => (
          <article key={a.id} className="card card-pad">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{a.name}</h2><Badge tone={a.enabled ? 'ok' : 'neutral'} dot>{a.enabled ? 'On' : 'Off'}</Badge>{a.requires_approval && <Badge tone="info">Needs approval</Badge>}</div><div className="mt-1"><Describe a={a} /></div>
                <div className="mt-1 text-xs text-faint">Cap {a.max_subjects_per_run} per run · cooldown {a.cooldown_days} day{a.cooldown_days === 1 ? '' : 's'}</div></div>
              <div className="flex gap-2">
                <form action={toggleAutomationAction}><input type="hidden" name="id" value={a.id} /><button className={a.enabled ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}>{a.enabled ? 'Turn off' : 'Turn on'}</button></form>
                <form action={deleteAutomationAction}><input type="hidden" name="id" value={a.id} /><ConfirmButton message="Delete this automation and its run history?" className="btn-ghost btn-sm">Delete</ConfirmButton></form>
              </div>
            </div>
            <details className="mt-3"><summary className="cursor-pointer text-sm font-medium text-brand-strong">Edit</summary><div className="mt-4"><AutomationForm a={a} /></div></details>
          </article>))}</div>
      )}

      <details className="mt-6"><summary className="btn-secondary w-fit cursor-pointer list-none">New automation</summary><div className="card card-pad mt-3"><AutomationForm /></div></details>

      <Section title="Scheduled checks" className="mt-8" hint="Reminders and deadline checks run on a schedule set up by whoever hosts the app. Each run is recorded here, including failures.">
        {jobs.length === 0 ? <p className="text-sm text-muted">No scheduled run has been recorded yet. Until the schedule is set up, use “Run scheduled checks now” above. See docs/INTEGRATIONS.md for the scheduler command.</p> : (
          <>
            {jobs[0]!.status === 'failed' && <div className="mb-3"><Notice tone="bad" title="The last scheduled run failed">{jobs[0]!.error ?? 'No details were recorded.'} Nothing was half-done: a failed run is rolled back and retried on the next schedule.</Notice></div>}
            <ul className="divide-y divide-line text-sm">{jobs.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex items-center gap-2"><Badge tone={j.status === 'ok' ? 'ok' : 'bad'}>{j.status === 'ok' ? 'Completed' : 'Failed'}</Badge><span className="text-muted">{fmtDate(j.started_at)} · {relTime(j.started_at)}</span></span>
                <span className="text-muted">{j.status === 'ok' ? `${j.executed} done · ${j.pending} waiting for approval · ${j.skipped} already handled` : j.error}</span>
              </li>))}</ul>
          </>
        )}
      </Section>

      <Section title="Recent runs" className="mt-8" hint="Every execution is recorded.">
        {runs.length === 0 ? <p className="text-sm text-muted">Nothing has run yet.</p> : (
          <ul className="divide-y divide-line text-sm">{runs.map((r) => (<li key={r.id} className="flex items-center justify-between gap-3 py-2.5"><span><strong>{r.name}</strong>{r.client && <span className="text-muted"> · {r.client}</span>}</span><span className="flex items-center gap-3"><StatusBadge status={r.status === 'completed' ? 'completed_run' : r.status} text={r.status.replace(/_/g, ' ')} /><span className="text-xs text-muted">{relTime(r.created_at)}</span></span></li>))}</ul>)}
      </Section>
      <div className="mt-6"><Notice tone="info" title="Scheduling">Scheduled checks (reminders, deadlines, inactivity, weekly summary) run when <code>POST /api/jobs/run</code> is called with your <code>CRON_SECRET</code> — set it up on your host’s scheduler (every 15–60 minutes). You can also run them manually above.</Notice></div>
    </>
  );
}

function AutomationForm({ a }: { a?: AutomationRow }) {
  const acts = a?.actions ?? [];
  const c = a?.conditions ?? {};
  return (
    <ActionForm action={saveAutomationAction} className="space-y-5">
      {a && <input type="hidden" name="id" value={a.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" name="name" defaultValue={a?.name} required />
        <Select label="When" name="trigger" defaultValue={a?.trigger ?? 'client_created'} options={triggerOpts} />
        <Field label="Inactive for (days)" name="days" type="number" min={1} defaultValue={c.days} hint="For “client inactive”" />
        <Field label="Documents missing for (days)" name="afterDays" type="number" min={1} defaultValue={c.afterDays} hint="For “documents missing”" />
        <Field label="Deadline within (days)" name="withinDays" type="number" min={1} defaultValue={c.withinDays} hint="For “deadline approaching”" />
        <Select label="Only when status becomes" name="toStatus" defaultValue={c.toStatus ?? ''} placeholder="Any status" options={['submitted', 'under_investigation', 'response_received', 'resolved', 'approved'].map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))} hint="For “dispute changes status”" />
      </div>
      {[1, 2, 3].map((n) => {
        const x = acts[n - 1];
        return (
          <fieldset key={n} className="grid gap-3 rounded-xl border border-line p-4 sm:grid-cols-2">
            <legend className="px-1 text-sm font-semibold">Then{n > 1 ? ` (${n})` : ''}</legend>
            <Select label="Action" name={`a${n}`} defaultValue={x?.type ?? ''} options={actionOpts} className="sm:col-span-2" />
            <Field label="Title" name={`t${n}`} defaultValue={x?.title} />
            <Select label="Document (for requests)" name={`k${n}`} defaultValue={x?.kind ?? ''} placeholder="—" options={DOC_KINDS.map((k) => ({ value: k, label: DOC_KIND_LABEL[k]! }))} />
            <Field label="Message / details" name={`b${n}`} defaultValue={x?.body} className="sm:col-span-2" hint="Merge fields: {{client_first_name}} {{client_name}} {{item}} {{due_date}}. No promises of results — prohibited claims are rejected." />
            <Field label="Task due in (days)" name={`d${n}`} type="number" min={0} defaultValue={x?.dueInDays} />
          </fieldset>
        );
      })}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Max clients per run" name="cap" type="number" min={1} max={500} defaultValue={a?.max_subjects_per_run ?? 25} />
        <Field label="Cooldown (days)" name="cooldown" type="number" min={0} defaultValue={a?.cooldown_days ?? 7} hint="Minimum gap before the same client is touched again" />
        <div className="space-y-2 self-end pb-2"><Check name="requiresApproval" defaultChecked={a?.requires_approval ?? true}>Client-facing actions need approval</Check><Check name="enabled" defaultChecked={a?.enabled ?? false}>Turn on now</Check></div>
      </div>
      <SubmitButton>{a ? 'Save changes' : 'Create automation'}</SubmitButton>
    </ActionForm>
  );
}
