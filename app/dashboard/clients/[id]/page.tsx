import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { createClient } from '@/lib/supabase/server';
import { diffReports, type DiffItem } from '@/lib/diff';
import { maskLast4 } from '@/lib/crypto';
import { uploadReport } from '../../imports/actions';
import { UploadForm } from './upload-form';

type Row = DiffItem & { id: string; report_id: string };

export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const [{ id }, sp, t] = await Promise.all([params, searchParams, getTranslations('clients')]);
  const supabase = await createClient();
  const { data: client } = await supabase
    .from('clients')
    .select('id, full_name, email, status, ssn_last4')
    .eq('id', id)
    .single();
  if (!client) notFound();

  const { data: reports } = await supabase
    .from('credit_reports')
    .select('id, created_at')
    .eq('client_id', id)
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .limit(2);
  let diff = null;
  if (reports && reports.length === 2) {
    const { data: tl } = await supabase
      .from('tradelines')
      .select('id, report_id, bureau, creditor_name, account_last4, balance_cents, account_status')
      .in(
        'report_id',
        reports.map((r) => r.id),
      )
      .limit(5000);
    const rows = (tl ?? []) as Row[];
    diff = diffReports(
      rows.filter((r) => r.report_id === reports[1].id),
      rows.filter((r) => r.report_id === reports[0].id),
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{client.full_name}</h1>
      <p className="text-sm text-muted-foreground">
        {client.email} {client.ssn_last4 ? `· SSN ${maskLast4(client.ssn_last4)}` : ''}
      </p>
      {sp.stored && (
        <p role="status" className="text-sm">
          {t('stored')}
        </p>
      )}
      {sp.noitems && (
        <p role="alert" className="text-sm text-destructive">
          {t('noItems')}
        </p>
      )}
      <UploadForm clientId={id} action={uploadReport} />
      {diff && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t('changes')}</h2>
          <ul className="text-sm">
            {diff.deleted.map((i) => (
              <li key={`d${i.id}`}>
                ✅ {t('removed')}: {i.creditor_name} ({i.bureau})
              </li>
            ))}
            {diff.updated.map((u) => (
              <li key={`u${u.after.id}`}>
                ✏️ {t('updated')}: {u.after.creditor_name} — {u.changes.join(', ')}
              </li>
            ))}
            {diff.added.map((i) => (
              <li key={`a${i.id}`}>
                🆕 {t('added')}: {i.creditor_name} ({i.bureau})
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
