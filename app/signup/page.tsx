'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { signUp } from '@/app/login/actions';

export default function SignUp() {
  const t = useTranslations('auth');
  const [state, action, pending] = useActionState(signUp, undefined);
  return (
    <form action={action} className="mx-auto max-w-sm space-y-3">
      <h1 className="text-2xl font-bold">{t('signUp')}</h1>
      <label className="block text-sm">
        {t('fullName')}
        <Input name="fullName" required maxLength={120} autoComplete="name" className="mt-1" />
      </label>
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
          minLength={10}
          autoComplete="new-password"
          className="mt-1"
        />
      </label>
      <label className="block text-sm">
        {t('mode')}
        <select
          name="mode"
          className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3"
        >
          <option value="personal">{t('modePersonal')}</option>
          <option value="agency">{t('modeAgency')}</option>
        </select>
      </label>
      <label className="block text-sm">
        {t('orgName')}
        <Input name="orgName" maxLength={120} className="mt-1" />
      </label>
      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(state.error)}
        </p>
      )}
      {state?.ok && (
        <p role="status" className="text-sm">
          {t(state.ok)}
        </p>
      )}
      <Button disabled={pending}>{pending ? t('pending') : t('signUp')}</Button>
    </form>
  );
}
