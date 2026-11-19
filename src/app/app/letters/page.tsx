import Link from 'next/link';
import type { Metadata } from 'next';
import { FilePlus2, FileText } from 'lucide-react';
import { AiTag, Badge, EmptyState, PageHeader, Pagination, StatusBadge, Tabs } from '@/components/ui';
import { aiUnapproved, FilterChips } from '@/components/staff-kit';
import { requireStaff } from '@/lib/auth/context';
import { KIND_LABEL, TEMPLATES, type LetterKind } from '@/lib/letters/templates';
import { fmtDate, pageParam, relTime } from '@/lib/util';
import { toggleTemplateAction } from './actions';

export const metadata: Metadata = { title: 'Letters' };

const PAGE_SIZE = 50;
const STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'void'];

export default async function LettersPage({ searchParams }: { searchParams: Promise<{ tab?: string; status?: string; page?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('clients:read');
  const tab = sp.tab === 'templates' ? 'templates' : 'history';
  const status = sp.status && STATUSES.includes(sp.status) ? sp.status : '';
  const page = pageParam(sp.page);
  const data = await ctx.tx(async (db) => {
    const w = status ? 'where l.status = $1' : '';
    const letters = await db.rows<{ id: string; title: string; status: string; current_version: number; kind: string; client_id: string; client_name: string; created_at: string; language: string; source: string | null }>(
      `select l.id, l.title, l.status, l.current_version, l.kind, l.client_id, c.full_name as client_name, l.created_at, l.language,
              (select v.source from public.letter_versions v where v.letter_id = l.id and v.version = l.current_version) as source
         from public.letters l join public.clients c on c.id = l.client_id ${w} order by l.created_at desc, l.id limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`, status ? [status] : []);
    const counts = await db.rows<{ status: string; n: number }>('select status, count(*)::int as n from public.letters group by status');
    const org = await db.rows<{ id: string; name: string; kind: LetterKind; language: string; active: boolean; version: number }>('select id, name, kind, language, active, version from public.letter_templates order by name');
    return { letters, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>, org };
  });
  const canTemplate = ctx.can('letters:approve');
  // Totals come from the per-status counts, not from the page of rows on screen.
  const allCount = Object.values(data.counts).reduce((a, n) => a + n, 0);
  const total = status ? data.counts[status] ?? 0 : allCount;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader title="Letter center" subtitle="Every letter is reviewed by a person before it can be sent."
        actions={<Link href="/app/letters/new" className="btn-primary"><FilePlus2 size={16} aria-hidden /> New letter</Link>} />
      <Tabs active={tab} tabs={[{ key: 'history', label: 'History', href: '/app/letters', count: allCount }, { key: 'templates', label: 'Templates', href: '/app/letters?tab=templates' }]} />

      {tab === 'history' ? (
        <>
          <FilterChips label="Letter status" items={([['', 'All'], ['draft', 'Drafts'], ['pending_approval', 'Awaiting approval'], ['approved', 'Approved'], ['sent', 'Sent']] as const).map(([k, l]) => (
            { key: k || 'all', label: l, href: k ? `/app/letters?status=${k}` : '/app/letters', count: k && data.counts[k] ? data.counts[k] : null, active: status === k }))} />
          {data.letters.length === 0 && (status || page > 1) ? <EmptyState title={status ? 'No letters with this status' : 'No more letters'} body="Choose a different status, or go back to all letters." action={<Link href="/app/letters" className="btn-secondary">All letters</Link>} />
          : data.letters.length === 0 ? <EmptyState title="No letters yet" body="Letters are created from a dispute, or from any template." action={<Link href="/app/letters/new" className="btn-primary">Create a letter</Link>} /> : (
            <div className="table-wrap"><table className="table table-stack">
              <thead><tr><th>Letter</th><th>Client</th><th>Status</th><th>Version</th><th>Created</th><th><span className="sr-only">Download</span></th></tr></thead>
              <tbody>{data.letters.map((l) => (
                <tr key={l.id} className="row-link">
                  <td className="cell-main"><Link href={`/app/letters/${l.id}`} className="flex items-start gap-2 font-semibold hover:underline sm:items-center"><FileText size={16} aria-hidden className="mt-0.5 shrink-0 text-muted sm:mt-0" /><span className="min-w-0 [overflow-wrap:anywhere] sm:truncate">{l.title}</span></Link></td>
                  <td className="max-sm:order-2"><Link href={`/app/clients/${l.client_id}`} className="text-muted hover:underline">{l.client_name}</Link></td>
                  <td className="max-sm:order-1"><span className="flex flex-wrap items-center gap-1.5"><StatusBadge status={l.status} />{aiUnapproved(l) && <AiTag title="This version was worded by AI and has not been approved by a person yet">AI wording</AiTag>}</span></td>
                  <td className="tabular-nums text-muted max-sm:order-3">v{l.current_version}</td>
                  <td className="whitespace-nowrap text-muted max-sm:order-3" title={fmtDate(l.created_at)}>{relTime(l.created_at)}</td>
                  <td className={(l.status === 'approved' || l.status === 'sent') ? 'cell-end text-right max-sm:order-4' : 'cell-none'}>{(l.status === 'approved' || l.status === 'sent') && <a className="btn-ghost btn-sm" href={`/api/letters/${l.id}/pdf`}>PDF</a>}</td>
                </tr>))}</tbody>
            </table></div>
          )}
          <Pagination page={page} pages={pages} hrefFor={(n) => `/app/letters?${status ? `status=${status}&` : ''}page=${n}`} />
        </>
      ) : (
        <div className="space-y-10">
          <section>
            <h2 className="mb-1 text-lg font-semibold">Standard templates</h2>
            <p className="mb-4 max-w-3xl text-sm text-muted">Starting points that cite the statute behind each request. They are not legal advice and promise no result — have counsel review them for your business and state.</p>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {TEMPLATES.map((t) => (
                <article key={t.key} className="panel flex flex-col p-5">
                  <div className="mb-2 text-[0.8125rem] font-medium text-muted">{KIND_LABEL[t.kind]} · {t.language === 'es' ? 'Español' : 'English'}</div>
                  <h3 className="font-semibold leading-snug">{t.name}</h3>
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
            <div className="mb-3 flex items-center justify-between gap-3 border-t border-line pt-6"><h2 className="text-lg font-semibold">Your templates</h2>{canTemplate && <Link href="/app/letters/templates/new" className="btn-secondary btn-sm">New template</Link>}</div>
            {data.org.length === 0 ? <p className="text-sm text-muted">{canTemplate ? 'Customize a standard template to create your own version.' : 'No custom templates yet. Managers can create them.'}</p> : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{data.org.map((t) => (
                <article key={t.id} className="panel p-5">
                  <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] font-medium text-muted">{KIND_LABEL[t.kind]} · v{t.version}{!t.active && <Badge tone="warn">Inactive</Badge>}</div>
                  <h3 className={`font-semibold ${t.active ? '' : 'text-muted'}`}>{t.name}</h3>
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
