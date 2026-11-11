import Link from 'next/link';
import type { Metadata } from 'next';
import { Bell, MessageSquare, ShieldCheck } from 'lucide-react';
import { Badge, EmptyState, PageHeader, Section } from '@/components/ui';
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
      {empty && <EmptyState title="Inbox zero" body="Approvals for automated messages, new client messages and alerts will show up here." />}
      <div className="space-y-6">
        {(d.letters?.n ?? 0) > 0 && ctx.can('letters:approve') && (
          <Link href="/app/letters?status=pending_approval" className="card flex items-center justify-between gap-3 p-4 transition hover:border-brand/50"><span className="flex items-center gap-3"><ShieldCheck size={18} className="text-warn" /><span><strong>{d.letters!.n}</strong> letter{d.letters!.n > 1 ? 's' : ''} waiting for your approval</span></span><span className="text-sm text-brand-strong">Review →</span></Link>
        )}

        {d.runs.length > 0 && (
          <Section title={`Automated messages awaiting approval (${d.runs.length})`} hint="Nothing client-facing is sent by an automation until a person approves the exact text.">
            <ul className="space-y-3">{d.runs.map((r) => (
              <li key={r.id} className="rounded-xl border border-line p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm"><span><strong>{r.result.automation}</strong> → {r.result.client_id ? <Link className="underline" href={`/app/clients/${r.result.client_id}`}>{r.result.client_name}</Link> : r.result.client_name}</span><span className="text-xs text-muted">{relTime(r.created_at)}</span></div>
                {(r.result.planned ?? []).map((p, i) => (
                  <div key={i} className="mb-2 rounded-lg bg-raised p-3 text-sm"><Badge>{p.type === 'portal_message' ? 'Portal message' : p.type === 'request_document' ? 'Document request' : p.type}</Badge>{p.title && <div className="mt-1.5 font-medium">{p.title}</div>}<p className="mt-1 whitespace-pre-wrap text-muted">{p.body ?? (p.kind ? `Request: ${p.kind.replace(/_/g, ' ')}` : '')}</p></div>))}
                {canApprove ? (
                  <div className="flex gap-2">
                    <form action={decideRunAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="decision" value="approve" /><button className="btn-primary btn-sm">Approve & send</button></form>
                    <form action={decideRunAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="decision" value="cancel" /><button className="btn-secondary btn-sm">Discard</button></form>
                  </div>) : <p className="text-xs text-muted">A manager or admin approves these.</p>}
              </li>))}</ul>
          </Section>
        )}

        {d.messages.length > 0 && (
          <Section title={`Unread client messages (${d.messages.length})`}>
            <ul className="divide-y divide-line">{d.messages.map((m) => (
              <li key={m.client_id}><Link href={`/app/clients/${m.client_id}?tab=messages`} className="flex items-start gap-3 py-3 hover:bg-raised"><MessageSquare size={16} className="mt-1 shrink-0 text-brand" /><div className="min-w-0"><div className="text-sm font-medium">{m.client_name} <span className="font-normal text-muted">· {relTime(m.created_at)}</span></div><p className="truncate text-sm text-muted">{m.body}</p></div></Link></li>))}</ul>
          </Section>
        )}

        {d.notes.length > 0 && (
          <Section title="Notifications" actions={<form action={markNotificationReadAction}><input type="hidden" name="id" value="" /><button className="text-sm text-brand-strong hover:underline">Mark all read</button></form>}>
            <ul className="divide-y divide-line">{d.notes.map((n) => (
              <li key={n.id} className="flex items-start gap-3 py-3"><Bell size={16} className={`mt-1 shrink-0 ${n.read_at ? 'text-faint' : 'text-brand'}`} />
                <div className="min-w-0 flex-1"><div className={`text-sm ${n.read_at ? 'text-muted' : 'font-medium'}`}>{n.href ? <Link className="hover:underline" href={n.href}>{n.title}</Link> : n.title}</div>{n.body && <p className="text-sm text-muted">{n.body}</p>}<div className="text-xs text-faint">{fmtDate(n.created_at)}</div></div>
                {!n.read_at && <form action={markNotificationReadAction}><input type="hidden" name="id" value={n.id} /><button className="text-xs text-muted underline">Mark read</button></form>}</li>))}</ul>
          </Section>
        )}
      </div>
    </>
  );
}
