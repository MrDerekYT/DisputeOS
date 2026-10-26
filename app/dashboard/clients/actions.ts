'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { audit, getStaffProfile } from '@/lib/session';
import { newClientSchema } from '@/lib/validation';

export async function createClientAction(_: { error?: string } | undefined, formData: FormData) {
  const parsed = newClientSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: 'invalid' };
  const supabase = await createClient();
  const me = await getStaffProfile(supabase);
  if (!me) return { error: 'unauthorized' };
  const { data, error } = await supabase
    .from('clients')
    .insert({
      org_id: me.org_id,
      full_name: parsed.data.fullName,
      email: parsed.data.email,
      phone: parsed.data.phone || null,
    })
    .select('id')
    .single();
  if (error || !data) return { error: 'failed' };
  await audit(supabase, me, 'client.create', 'client', data.id);
  redirect(`/dashboard/clients/${data.id}`);
}
