import Link from 'next/link';
import type { Metadata } from 'next';
import { Check as CheckIcon } from 'lucide-react';
import { ActionForm, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { Badge, EmptyState, PageHeader, Section } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { memberLabel, staffMembers } from '@/lib/crm';
import { cn, fmtDate } from '@/lib/util';
import { createTaskAction, setTaskStatusAction } from '../clients/actions';

export const metadata: Metadata = { title: 'Tasks' };

interface T { id: string; title: string; detail: string | null; status: string; due_at: string | null; kind: string; client_id: string | null; client_name: string | null; assignee: string | null; assignee_id: string | null; source: string }

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('tasks:manage');
  const scope = sp.scope === 'all' ? 'all' : sp.scope === 'done' ? 'done' : 'mine';
  const { tasks, team, clients } = await ctx.tx(async (db) => ({
    tasks: await db.rows<T>(
      `select t.id, t.title, t.detail, t.status, t.due_at, t.kind, t.client_id, c.full_name as client_name, u.full_name as assignee, t.assignee_id, t.source
         from public.tasks t left join public.clients c on c.id = t.client_id left join public.users u on u.id = t.assignee_id
        where ${scope === 'done' ? "t.status = 'done' and t.completed_at > now() - interval '30 days'" : scope === 'all' ? "t.status = 'open'" : "t.status = 'open' and (t.assignee_id = $1 or t.assignee_id is null)"}
        order by t.due_at nulls last, t.created_at limit 300`, scope === 'mine' ? [ctx.userId] : []),
    team: await staffMembers(db),
    clients: await db.rows<{ id: string; full_name: string }>("select id, full_name from public.clients where status <> 'cancelled' order by full_name limit 200"),
  }));
  const now = Date.now();
  const startOfTomorrow = new Date(); startOfTomorrow.setHours(24, 0, 0, 0);
  const groups = scope === 'done' ? [{ label: 'Completed in the last 30 days', rows: tasks }] : [
    { label: 'Overdue', rows: tasks.filter((t) => t.due_at && new Date(t.due_at).getTime() < now), tone: 'bad' as const },
    { label: 'Today', rows: tasks.filter((t) => t.due_at && new Date(t.due_at).getTime() >= now && new Date(t.due_at) < startOfTomorrow) },
    { label: 'Upcoming', rows: tasks.filter((t) => t.due_at && new Date(t.due_at) >= startOfTomorrow) },
    { label: 'No due date', rows: tasks.filter((t) => !t.due_at) },
  ];
  return (
    <>
      <PageHeader title="Tasks" subtitle="Follow-ups, reviews and reminders — including the ones automations create." />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div>
          <div className="mb-4 flex gap-2">{[['mine', 'Mine'], ['all', 'Everyone’s open'], ['done', 'Done']].map(([k, l]) => (
            <Link key={k} href={`/app/tasks?scope=${k}`} className={cn('rounded-full border px-3.5 py-1.5 text-sm font-medium', scope === k ? 'border-brand bg-brand-soft text-brand-strong' : 'border-line bg-surface text-muted hover:text-ink')}>{l}</Link>))}</div>
          {tasks.length === 0 ? <EmptyState title={scope === 'done' ? 'Nothing completed yet' : 'No open tasks'} body="Tasks you create — and ones created by automations — appear here." /> : (
            <div className="space-y-6">{groups.filter((g) => g.rows.length).map((g) => (
              <section key={g.label}><h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">{g.label} <span className="rounded-full bg-raised px-2 text-xs font-normal text-muted ring-1 ring-inset ring-line">{g.rows.length}</span></h2>
                <ul className="card divide-y divide-line">{g.rows.map((t) => (
                  <li key={t.id} className="flex items-start gap-3 p-4">
                    <form action={setTaskStatusAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value={t.status === 'done' ? 'open' : 'done'} />
                      <button aria-label={t.status === 'done' ? 'Reopen task' : 'Complete task'} className={cn('mt-0.5 grid h-5 w-5 place-items-center rounded-full border', t.status === 'done' ? 'border-ok bg-ok text-white' : 'border-line hover:border-brand')}>{t.status === 'done' && <CheckIcon size={12} />}</button></form>
                    <div className="min-w-0 flex-1"><div className={cn('text-sm font-medium', t.status === 'done' && 'text-muted line-through')}>{t.title}</div>{t.detail && <div className="text-sm text-muted">{t.detail}</div>}
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">{t.client_name && <Link href={`/app/clients/${t.client_id}`} className="hover:underline">{t.client_name}</Link>}<span>{t.assignee ?? 'Unassigned'}</span>{t.source === 'automation' && <Badge tone="info">Automation</Badge>}</div></div>
                    {t.due_at && <Badge tone={g.label === 'Overdue' ? 'bad' : 'neutral'}>{fmtDate(t.due_at)}</Badge>}
                  </li>))}</ul></section>))}</div>
          )}
        </div>
        <Section title="New task">
          <ActionForm action={createTaskAction} resetOnSuccess className="space-y-3">
            <Field label="Title" name="title" required /><TextArea label="Details" name="detail" rows={2} />
            <Select label="Client (optional)" name="clientId" placeholder="Not tied to a client" options={clients.map((c) => ({ value: c.id, label: c.full_name }))} />
            <Select label="Type" name="kind" defaultValue="general" options={[{ value: 'general', label: 'General' }, { value: 'follow_up', label: 'Follow-up' }, { value: 'document', label: 'Document' }, { value: 'review', label: 'Review' }, { value: 'deadline', label: 'Deadline' }]} />
            <Field label="Due" name="due" type="date" />
            <Select label="Assign to" name="assigneeId" placeholder="Me" options={team.map((m) => ({ value: m.id, label: memberLabel(m) }))} />
            <SubmitButton>Add task</SubmitButton>
          </ActionForm>
        </Section>
      </div>
    </>
  );
}
