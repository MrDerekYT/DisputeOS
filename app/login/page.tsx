'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { signIn } from './actions';

export default function Login() {
  const t = useTranslations('auth');
  const [state, action, pending] = useActionState(signIn, undefined);
  return (
    <form action={action} className="mx-auto max-w-sm space-y-3">
      <h1 className="text-2xl font-bold">{t('signIn')}</h1>
      <label className="block text-sm">
        {t('email')}
        <Input name="email" type="email" required autoComplete="email" className="mt-1" />
      </label>
      <label className="block text-sm">
        {t('password')}
        <Input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="current-password"
          className="mt-1"
        />
      </label>
      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(state.error)}
        </p>
      )}
      <Button disabled={pending}>{pending ? t('pending') : t('signIn')}</Button>
      <p className="text-sm">
        <Link className="underline" href="/signup">
          {t('signUp')}
        </Link>
      </p>
    </form>
  );
}
