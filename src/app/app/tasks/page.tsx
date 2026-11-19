import Link from 'next/link';
import type { Metadata } from 'next';
import { Check as CheckIcon } from 'lucide-react';
import { ActionForm, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { Badge, EmptyState, PageHeader, Section } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { memberLabel, staffMembers } from '@/lib/crm';
import { getEnv } from '@/lib/env';
import { cn, dueDay, fmtDate } from '@/lib/util';
import { createTaskAction, setTaskStatusAction } from '../clients/actions';

export const metadata: Metadata = { title: 'Tasks' };

const TASK_LIMIT = 300;
const CLIENT_LIMIT = 1000;

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
        order by ${scope === 'done' ? 't.completed_at desc' : 't.due_at nulls last, t.created_at'} limit ${TASK_LIMIT}`, scope === 'mine' ? [ctx.userId] : []),
    team: await staffMembers(db),
    clients: await db.rows<{ id: string; full_name: string }>(`select id, full_name from public.clients where status <> 'cancelled' order by full_name limit ${CLIENT_LIMIT}`),
  }));
  // Due dates are days, not times: a task due today stays under "Today" all day and is overdue only from the next day.
  const tz = getEnv().APP_TIMEZONE;
  const day = (t: T) => (t.due_at ? dueDay(t.due_at, tz) : null);
  const groups = scope === 'done' ? [{ label: 'Completed in the last 30 days', rows: tasks }] : [
    { label: 'Overdue', rows: tasks.filter((t) => day(t) === 'overdue'), tone: 'bad' as const },
    { label: 'Today', rows: tasks.filter((t) => day(t) === 'today') },
    { label: 'Upcoming', rows: tasks.filter((t) => day(t) === 'upcoming') },
    { label: 'No due date', rows: tasks.filter((t) => !t.due_at) },
  ];
  return (
    <>
      <PageHeader title="Tasks" subtitle="Follow-ups, reviews and reminders — including the ones automations create." />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div>
          <nav aria-label="Task lists" className="mb-4 flex gap-2">{[['mine', 'Mine'], ['all', 'Everyone’s open'], ['done', 'Done']].map(([k, l]) => (
            <Link key={k} href={`/app/tasks?scope=${k}`} aria-current={scope === k ? 'page' : undefined} className={cn('rounded-full border px-3.5 py-1.5 text-sm font-medium', scope === k ? 'border-brand bg-brand-soft text-brand-strong' : 'border-line bg-surface text-muted hover:text-ink')}>{l}</Link>))}</nav>
          {tasks.length === 0 ? <EmptyState title={scope === 'done' ? 'Nothing completed yet' : 'No open tasks'} body="Tasks you create — and ones created by automations — appear here." /> : (
            <div className="space-y-6">{groups.filter((g) => g.rows.length).map((g) => (
              <section key={g.label}><h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">{g.label} <span className="rounded-full bg-raised px-2 text-xs font-normal text-muted ring-1 ring-inset ring-line">{g.rows.length}</span></h2>
                <ul className="card divide-y divide-line">{g.rows.map((t) => (
                  <li key={t.id} className="flex items-start gap-3 p-4">
                    <form action={setTaskStatusAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value={t.status === 'done' ? 'open' : 'done'} />
                      <button aria-label={t.status === 'done' ? 'Reopen task' : 'Complete task'} className="group -m-1.5 grid h-8 w-8 place-items-center rounded-full"><span className={cn('grid h-5 w-5 place-items-center rounded-full border', t.status === 'done' ? 'border-ok bg-ok text-surface' : 'border-line group-hover:border-brand')}>{t.status === 'done' && <CheckIcon size={12} />}</span></button></form>
                    <div className="min-w-0 flex-1"><div className={cn('text-sm font-medium', t.status === 'done' && 'text-muted line-through')}>{t.title}</div>{t.detail && <div className="text-sm text-muted">{t.detail}</div>}
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">{t.client_name && <Link href={`/app/clients/${t.client_id}`} className="hover:underline">{t.client_name}</Link>}<span>{t.assignee ?? 'Unassigned'}</span>{t.source === 'automation' && <Badge tone="info">Automation</Badge>}</div></div>
                    {t.due_at && <Badge tone={g.label === 'Overdue' ? 'bad' : 'neutral'}>{fmtDate(t.due_at)}</Badge>}
                  </li>))}</ul></section>))}
              {tasks.length === TASK_LIMIT && <p className="text-sm text-muted">Showing the first {TASK_LIMIT} tasks{scope === 'done' ? ' (most recently completed)' : ' by due date'}. Complete or reassign some to see the rest, or open a client to see all of their tasks.</p>}
            </div>
          )}
        </div>
        <Section title="New task">
          <ActionForm action={createTaskAction} resetOnSuccess className="space-y-3">
            <Field label="Title" name="title" required /><TextArea label="Details" name="detail" rows={2} />
            <Select label="Client (optional)" name="clientId" placeholder="Not tied to a client" options={clients.map((c) => ({ value: c.id, label: c.full_name }))}
              hint={clients.length === CLIENT_LIMIT ? `Listing the first ${CLIENT_LIMIT} clients by name. For anyone else, add the task from the Tasks tab on their client page.` : undefined} />
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
