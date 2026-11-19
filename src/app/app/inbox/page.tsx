import Link from 'next/link';
import type { Metadata } from 'next';
import { Bell, MessageSquare, ShieldCheck } from 'lucide-react';
import { Badge, EmptyState, ListRow, PageHeader, RowList, Section } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { fmtDate, relTime } from '@/lib/util';
import { decideRunAction, markNotificationReadAction } from './actions';

export const metadata: Metadata = { title: 'Inbox' };

export default async function InboxPage() {
  const ctx = await requireStaff();
  const d = await ctx.tx(async (db) => ({
    runs: await db.rows<{ id: string; created_at: string; result: { planned?: { type: string; title?: string; body?: string; kind?: string }[]; client_name?: string; automation?: string; client_id?: string } }>(
      "select id, created_at, result from public.automation_runs where status = 'pending_approval' order by created_at"),
    messages: await db.rows<{ client_id: string; client_name: string; body: string; created_at: string }>(
      `select distinct on (m.client_id) m.client_id, c.full_name as client_name, m.body, m.created_at from public.communications m join public.clients c on c.id = m.client_id
        where m.direction = 'inbound' and m.read_at is null order by m.client_id, m.created_at desc`),
    notes: await db.rows<{ id: string; title: string; body: string | null; href: string | null; read_at: string | null; created_at: string }>('select id, title, body, href, read_at, created_at from public.notifications where user_id = $1 order by created_at desc limit 30', [ctx.userId]),
    letters: await db.row<{ n: number }>("select count(*)::int as n from public.letters where status = 'pending_approval'"),
  }));
  const canApprove = ctx.can('automations:approve');
  const empty = !d.runs.length && !d.messages.length && !d.notes.length;
  return (
    <>
      <PageHeader title="Inbox" subtitle="Things waiting on you: approvals, client messages and notifications." />
      {empty && <EmptyState title="Inbox zero" body="Approvals for automated messages, new client messages and alerts will show up here." action={<Link href="/app" className="btn-primary">Back to the dashboard</Link>} />}
      <div className="space-y-6">
        {(d.letters?.n ?? 0) > 0 && ctx.can('letters:approve') && (
          <div className="panel overflow-hidden"><RowList>
            <ListRow icon={<ShieldCheck size={18} />} title={<>{d.letters!.n} letter{d.letters!.n > 1 ? 's' : ''} waiting for your approval</>} action={{ href: '/app/letters?status=pending_approval', label: 'Review', primary: true }} />
          </RowList></div>
        )}

        {d.runs.length > 0 && (
          <Section title={`Automated messages awaiting approval (${d.runs.length})`} hint="Nothing client-facing is sent by an automation until a person approves the exact text.">
            <ul className="divide-y divide-line/70">{d.runs.map((r) => (
              <li key={r.id} className="py-4 first:pt-0 last:pb-0">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm"><span><strong>{r.result.automation}</strong> → {r.result.client_id ? <Link className="link" href={`/app/clients/${r.result.client_id}`}>{r.result.client_name}</Link> : r.result.client_name}</span><span className="text-[0.8125rem] text-muted">{relTime(r.created_at)}</span></div>
                {(r.result.planned ?? []).map((p, i) => (
                  <div key={i} className="mb-2 rounded-lg bg-raised p-3 text-sm"><Badge>{p.type === 'portal_message' ? 'Portal message' : p.type === 'request_document' ? 'Document request' : p.type}</Badge>{p.title && <div className="mt-1.5 font-medium">{p.title}</div>}<p className="mt-1 whitespace-pre-wrap text-muted">{p.body ?? (p.kind ? `Request: ${p.kind.replace(/_/g, ' ')}` : '')}</p></div>))}
                {canApprove ? (
                  <div className="flex gap-2">
                    <form action={decideRunAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="decision" value="approve" /><button className="btn-primary btn-sm">Approve & send</button></form>
                    <form action={decideRunAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="decision" value="cancel" /><button className="btn-secondary btn-sm">Discard</button></form>
                  </div>) : <p className="text-[0.8125rem] text-muted">A manager or admin approves these.</p>}
              </li>))}</ul>
          </Section>
        )}

        {d.messages.length > 0 && (
          <section aria-labelledby="unread" className="panel overflow-hidden">
            <h2 id="unread" className="px-5 pb-3 pt-5 text-lg font-semibold sm:px-6">Unread client messages ({d.messages.length})</h2>
            <RowList className="border-t border-line/70">{d.messages.map((m) => (
              <ListRow key={m.client_id} icon={<MessageSquare size={18} />} title={m.client_name} detail={<span className="line-clamp-2">{m.body}</span>} aside={relTime(m.created_at)} action={{ href: `/app/clients/${m.client_id}?tab=messages`, label: 'Reply' }} />))}</RowList>
          </section>
        )}

        {d.notes.length > 0 && (
          <Section plain title="Notifications" actions={<form action={markNotificationReadAction}><input type="hidden" name="id" value="" /><button className="btn-ghost btn-sm">Mark all read</button></form>}>
            <ul className="divide-y divide-line/70">{d.notes.map((n) => (
              <li key={n.id} className="flex items-start gap-3 py-3"><Bell size={16} aria-hidden className={`mt-1 shrink-0 ${n.read_at ? 'text-faint' : 'text-ink'}`} />
                <div className="min-w-0 flex-1"><div className={`text-sm ${n.read_at ? 'text-muted' : 'font-semibold'}`}>{!n.read_at && <span className="sr-only">Unread: </span>}{n.href ? <Link className="hover:underline" href={n.href}>{n.title}</Link> : n.title}</div>{n.body && <p className="text-sm text-muted">{n.body}</p>}<div className="text-xs text-muted">{fmtDate(n.created_at)}</div></div>
                {!n.read_at && <form action={markNotificationReadAction}><input type="hidden" name="id" value={n.id} /><button className="btn-ghost btn-sm shrink-0">Mark read</button></form>}</li>))}</ul>
          </Section>
        )}
      </div>
    </>
  );
}
