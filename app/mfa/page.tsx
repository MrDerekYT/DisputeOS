'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { startMfa, verifyMfa } from './actions';

export default function Mfa() {
  const t = useTranslations('mfa');
  const router = useRouter();
  const [factorId, setFactorId] = useState<string>();
  const [qr, setQr] = useState<string>();
  const [error, setError] = useState(false);

  useEffect(() => {
    startMfa().then((r) => {
      setFactorId(r.factorId);
      setQr(r.qr);
    });
  }, []);

  async function verify(formData: FormData) {
    if (!factorId || !(await verifyMfa(factorId, String(formData.get('code')))))
      return setError(true);
    router.replace('/dashboard');
    router.refresh();
  }

  return (
    <form action={verify} className="mx-auto max-w-sm space-y-3">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <p className="text-sm">{qr ? t('enrollIntro') : t('verifyIntro')}</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {qr && <img src={qr} alt="TOTP QR code" width={192} height={192} />}
      <label className="block text-sm">
        {t('code')}
        <Input
          name="code"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          required
          autoComplete="one-time-code"
          className="mt-1"
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t('invalid')}
        </p>
      )}
      <Button>{t('verify')}</Button>
    </form>
  );
}
