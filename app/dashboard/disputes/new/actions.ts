'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { newDisputeSchema } from '@/lib/validation';

export async function createDispute(_: { error?: string } | undefined, formData: FormData) {
  const parsed = newDisputeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const supabase = await createClient();
  const { data: profile } = await supabase.from('users').select('org_id').single();
  if (!profile) return { error: 'Not authorized.' };
  const { clientId, tradelineId, bureau, reason } = parsed.data;
  // RLS additionally restricts inserts to the caller's organization.
  const { error } = await supabase.from('disputes').insert({
    org_id: profile.org_id,
    client_id: clientId,
    tradeline_id: tradelineId,
    bureau,
    reason,
  });
  if (error) return { error: 'Could not create dispute.' };
  redirect('/dashboard/disputes');
}
