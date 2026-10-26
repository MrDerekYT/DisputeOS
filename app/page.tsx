import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';

export default async function Home() {
  const t = await getTranslations('home');
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">{t('title')}</h1>
      <p>{t('tagline')}</p>
      <div className="flex gap-3">
        <Button asChild>
          <Link href="/dashboard">{t('cta')}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/signup">{t('signUp')}</Link>
        </Button>
      </div>
    </div>
  );
}
