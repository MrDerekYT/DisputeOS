'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createClientAction } from '../actions';

export default function NewClient() {
  const t = useTranslations('clients');
  const [state, action, pending] = useActionState(createClientAction, undefined);
  return (
    <form action={action} className="max-w-md space-y-3">
      <h1 className="text-2xl font-bold">{t('new')}</h1>
      <label className="block text-sm">
        {t('fullName')}
        <Input name="fullName" required maxLength={120} className="mt-1" />
      </label>
      <label className="block text-sm">
        {t('email')}
        <Input name="email" type="email" maxLength={254} className="mt-1" />
      </label>
      <label className="block text-sm">
        {t('phone')}
        <Input name="phone" type="tel" maxLength={30} className="mt-1" />
      </label>
      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {t('error')}
        </p>
      )}
      <Button disabled={pending}>{t('create')}</Button>
    </form>
  );
}
