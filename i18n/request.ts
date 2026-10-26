import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { LOCALES, DEFAULT_LOCALE, type Locale } from './config';

export default getRequestConfig(async () => {
  const c = (await cookies()).get('locale')?.value;
  const locale: Locale = (LOCALES as readonly string[]).includes(c ?? '')
    ? (c as Locale)
    : DEFAULT_LOCALE;
  return { locale, messages: (await import(`../messages/${locale}.json`)).default };
});
