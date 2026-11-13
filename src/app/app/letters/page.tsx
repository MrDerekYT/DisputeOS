import Link from 'next/link';
import type { Metadata } from 'next';
import { FilePlus2, FileText } from 'lucide-react';
import { Badge, EmptyState, PageHeader, StatusBadge, Tabs } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { KIND_LABEL, TEMPLATES, type LetterKind } from '@/lib/letters/templates';
import { fmtDate, relTime } from '@/lib/util';
import { toggleTemplateAction } from './actions';

export const metadata: Metadata = { title: 'Letters' };

export default async function LettersPage({ searchParams }: { searchParams: Promise<{ tab?: string; status?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('clients:read');
  const tab = sp.tab === 'templates' ? 'templates' : 'history';
  const data = await ctx.tx(async (db) => {
    const w = sp.status ? 'where l.status = $1' : '';
    const letters = await db.rows<{ id: string; title: string; status: string; current_version: number; kind: string; client_id: string; client_name: string; created_at: string; language: string }>(
      `select l.id, l.title, l.status, l.current_version, l.kind, l.client_id, c.full_name as client_name, l.created_at, l.language from public.letters l join public.clients c on c.id = l.client_id ${w} order by l.created_at desc limit 200`, sp.status ? [sp.status] : []);
    const counts = await db.rows<{ status: string; n: number }>('select status, count(*)::int as n from public.letters group by status');
    const org = await db.rows<{ id: string; name: string; kind: LetterKind; language: string; active: boolean; version: number }>('select id, name, kind, language, active, version from public.letter_templates order by name');
    return { letters, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>, org };
  });
  const canTemplate = ctx.can('letters:approve');

  return (
    <>
      <PageHeader title="Letter center" subtitle="Templates, drafts, approvals and history — every letter is reviewed by a person before it can be sent."
        actions={<Link href="/app/letters/new" className="btn-primary"><FilePlus2 size={16} /> New letter</Link>} />
      <Tabs active={tab} tabs={[{ key: 'history', label: 'History', href: '/app/letters', count: data.letters.length }, { key: 'templates', label: 'Templates', href: '/app/letters?tab=templates' }]} />

      {tab === 'history' ? (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {[['', 'All'], ['draft', 'Drafts'], ['pending_approval', 'Awaiting approval'], ['approved', 'Approved'], ['sent', 'Sent']].map(([k, l]) => (
              <Link key={k} href={k ? `/app/letters?status=${k}` : '/app/letters'} className={`rounded-full border px-3 py-1 text-sm ${(sp.status ?? '') === k ? 'border-brand bg-brand-soft text-brand-strong' : 'border-line bg-surface text-muted hover:text-ink'}`}>
                {l}{k && data.counts[k] ? <span className="ml-1.5 text-xs tabular-nums opacity-70">{data.counts[k]}</span> : null}
              </Link>
            ))}
          </div>
          {data.letters.length === 0 ? <EmptyState title="No letters yet" body="Letters are created from a dispute, or from any template." action={<Link href="/app/letters/new" className="btn-primary">Create a letter</Link>} /> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Letter</th><th>Client</th><th>Status</th><th>Version</th><th>Created</th><th></th></tr></thead>
              <tbody>{data.letters.map((l) => (
                <tr key={l.id} className="row-link">
                  <td><Link href={`/app/letters/${l.id}`} className="flex items-center gap-2 font-medium hover:underline"><FileText size={16} className="shrink-0 text-muted" /><span className="truncate">{l.title}</span></Link></td>
                  <td><Link href={`/app/clients/${l.client_id}`} className="text-muted hover:underline">{l.client_name}</Link></td>
                  <td><StatusBadge status={l.status} /></td>
                  <td className="tabular-nums text-muted">v{l.current_version}</td>
                  <td className="whitespace-nowrap text-muted" title={fmtDate(l.created_at)}>{relTime(l.created_at)}</td>
                  <td className="text-right">{(l.status === 'approved' || l.status === 'sent') && <a className="btn-ghost btn-sm" href={`/api/letters/${l.id}/pdf`}>PDF</a>}</td>
                </tr>))}</tbody>
            </table></div>
          )}
        </>
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-1 text-lg font-semibold">Standard templates</h2>
            <p className="mb-4 text-sm text-muted">Starting points that cite the statute behind each request. They are not legal advice and promise no result — have counsel review them for your business and state.</p>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {TEMPLATES.map((t) => (
                <article key={t.key} className="card flex flex-col p-5">
                  <div className="mb-2 flex flex-wrap gap-1.5"><Badge tone="brand">{KIND_LABEL[t.kind]}</Badge><Badge>{t.language === 'es' ? 'Español' : 'English'}</Badge></div>
                  <h3 className="font-medium leading-snug">{t.name}</h3>
                  <p className="mt-1.5 flex-1 text-sm text-muted">{t.description}</p>
                  <div className="mt-4 flex gap-2">
                    <Link href={`/app/letters/new?templateKey=${t.key}`} className="btn-secondary btn-sm">Use</Link>
                    {canTemplate && <Link href={`/app/letters/templates/new?base=${t.key}`} className="btn-ghost btn-sm">Customize</Link>}
                  </div>
                </article>
              ))}
            </div>
          </section>
          <section>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">Your templates</h2>{canTemplate && <Link href="/app/letters/templates/new" className="btn-secondary btn-sm">New template</Link>}</div>
            {data.org.length === 0 ? <p className="text-sm text-muted">{canTemplate ? 'Customize a standard template to create your own version.' : 'No custom templates yet. Managers can create them.'}</p> : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{data.org.map((t) => (
                <article key={t.id} className={`card p-5 ${t.active ? '' : 'opacity-60'}`}>
                  <div className="mb-2 flex flex-wrap gap-1.5"><Badge tone="brand">{KIND_LABEL[t.kind]}</Badge><Badge>v{t.version}</Badge>{!t.active && <Badge tone="warn">Inactive</Badge>}</div>
                  <h3 className="font-medium">{t.name}</h3>
                  <div className="mt-4 flex gap-2">
                    {t.active && <Link href={`/app/letters/new?templateKey=org:${t.id}`} className="btn-secondary btn-sm">Use</Link>}
                    {canTemplate && <Link href={`/app/letters/templates/${t.id}`} className="btn-ghost btn-sm">Edit</Link>}
                    {canTemplate && <form action={toggleTemplateAction}><input type="hidden" name="id" value={t.id} /><button className="btn-ghost btn-sm" type="submit">{t.active ? 'Deactivate' : 'Activate'}</button></form>}
                  </div>
                </article>))}</div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
