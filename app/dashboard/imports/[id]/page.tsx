import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { createClient } from '@/lib/supabase/server';
import { lowConfidenceFields, type ParsedItem } from '@/lib/parser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { approveImport, rejectImport } from '../actions';

export default async function ReviewImport({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations('review');
  const supabase = await createClient();
  const { data: imp } = await supabase
    .from('report_imports')
    .select('id, status, parsed')
    .eq('id', id)
    .single();
  if (!imp) notFound();
  const items = imp.parsed as ParsedItem[];
  const pending = imp.status === 'pending_review';

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <form action={approveImport.bind(null, id)} className="space-y-4">
        {items.map((it, i) => {
          const low = lowConfidenceFields(it);
          const needsReview = low.length > 0 || !it.bureau.value;
          return (
            <fieldset
              key={i}
              className={`space-y-2 rounded-lg border p-4 ${needsReview ? 'border-destructive' : ''}`}
              disabled={!pending}
            >
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" name={`include_${i}`} defaultChecked={!needsReview} />
                {it.creditor_name.value} · {it.item_type.value} ·{' '}
                {it.bureau.value ?? t('bureauMissing')}
              </label>
              {needsReview && (
                <p className="text-xs text-destructive">
                  {t('needsReview', { fields: low.join(', ') || 'bureau' })}
                </p>
              )}
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="text-xs">
                  {t('creditor')}
                  <Input
                    name={`creditor_${i}`}
                    defaultValue={it.creditor_name.value ?? ''}
                    maxLength={200}
                  />
                </label>
                <label className="text-xs">
                  {t('last4')}
                  <Input
                    name={`last4_${i}`}
                    defaultValue={it.account_last4.value ?? ''}
                    maxLength={4}
                  />
                </label>
                <label className="text-xs">
                  {t('balance')}
                  <Input
                    name={`balance_${i}`}
                    defaultValue={
                      it.balance_cents.value === null
                        ? ''
                        : (it.balance_cents.value / 100).toFixed(2)
                    }
                    inputMode="decimal"
                  />
                </label>
              </div>
              <dl className="grid gap-1 text-xs text-muted-foreground">
                {(
                  [
                    'creditor_name',
                    'account_last4',
                    'balance_cents',
                    'date_opened',
                    'date_reported',
                    'date_of_first_delinquency',
                  ] as const
                ).map((k) =>
                  it[k].snippet ? (
                    <div key={k} className="flex gap-2">
                      <dt className="w-40 shrink-0">
                        {k} ({Math.round(it[k].confidence * 100)}%)
                      </dt>
                      <dd className="font-mono">{it[k].snippet}</dd>
                    </div>
                  ) : null,
                )}
              </dl>
            </fieldset>
          );
        })}
        {pending && (
          <div className="flex gap-3">
            <Button>{t('approve')}</Button>
            <Button type="submit" variant="outline" formAction={rejectImport.bind(null, id)}>
              {t('reject')}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}
