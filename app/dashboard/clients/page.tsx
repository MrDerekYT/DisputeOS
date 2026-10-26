import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { createClient } from '@/lib/supabase/server';
import { Button } from '@/components/ui/button';

export default async function Clients() {
  const t = await getTranslations('clients');
  const supabase = await createClient();
  const { data } = await supabase
    .from('clients')
    .select('id, full_name, status')
    .order('created_at', { ascending: false })
    .limit(200);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <Button asChild>
          <Link href="/dashboard/clients/new">{t('new')}</Link>
        </Button>
      </div>
      <ul className="divide-y rounded-lg border">
        {(data ?? []).map((c) => (
          <li key={c.id}>
            <Link
              className="flex justify-between p-3 hover:bg-muted"
              href={`/dashboard/clients/${c.id}`}
            >
              <span>{c.full_name}</span>
              <span className="text-sm text-muted-foreground">{c.status}</span>
            </Link>
          </li>
        ))}
        {!data?.length && <li className="p-3 text-sm text-muted-foreground">{t('empty')}</li>}
      </ul>
    </div>
  );
}
