import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import './globals.css';
import { signOut } from './login/actions';
import { setLocale } from '@/i18n/actions';

export const metadata: Metadata = {
  title: 'DisputeOS',
  description: 'Credit repair platform with personal and agency modes.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers(); // opt into dynamic rendering so the per-request CSP nonce applies
  const [locale, messages, t] = await Promise.all([getLocale(), getMessages(), getTranslations()]);
  return (
    <html lang={locale}>
      <body className="min-h-screen">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <header className="flex flex-wrap items-center gap-6 border-b px-6 py-3">
            <Link href="/" className="font-bold">
              DisputeOS
            </Link>
            <Link href="/dashboard">{t('nav.dashboard')}</Link>
            <Link href="/dashboard/disputes">{t('nav.disputes')}</Link>
            <Link href="/dashboard/import">{t('nav.import')}</Link>
            <Link href="/dashboard/letters">{t('nav.letters')}</Link>
            <form action={setLocale} className="ml-auto">
              <input type="hidden" name="locale" value={locale === 'en' ? 'es' : 'en'} />
              <button className="text-sm underline">{t('nav.language')}</button>
            </form>
            <form action={signOut}>
              <button className="text-sm underline">{t('nav.signOut')}</button>
            </form>
          </header>
          <main className="mx-auto max-w-4xl p-6">{children}</main>
          <footer className="p-6 text-xs text-muted-foreground">{t('footer.disclaimer')}</footer>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
