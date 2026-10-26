'use server';

import { createClient } from '@/lib/supabase/server';
import { mfaCodeSchema } from '@/lib/validation';

/** Returns the verified factor, or starts a new TOTP enrollment (QR only on first enrollment). */
export async function startMfa(): Promise<{ factorId?: string; qr?: string }> {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return {};
  const { data } = await supabase.auth.mfa.listFactors();
  const verified = data?.totp.find((f) => f.status === 'verified');
  if (verified) return { factorId: verified.id };
  for (const f of data?.all ?? [])
    if (f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
  const enrolled = await supabase.auth.mfa.enroll({ factorType: 'totp' });
  return enrolled.data ? { factorId: enrolled.data.id, qr: enrolled.data.totp.qr_code } : {};
}

export async function verifyMfa(factorId: string, code: string): Promise<boolean> {
  if (!mfaCodeSchema.safeParse(code).success) return false;
  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  return !error;
}
