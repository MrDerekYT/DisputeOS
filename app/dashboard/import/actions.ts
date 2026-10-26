'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { MAX_IMPORT_BYTES, parseTradelineCsv } from '@/lib/import';

export async function importReport(_: { errors?: string[] } | undefined, formData: FormData) {
  const clientId = z.string().uuid().safeParse(formData.get('clientId'));
  const file = formData.get('file');
  if (!clientId.success) return { errors: ['Enter a valid client ID.'] };
  if (!(file instanceof File) || file.size === 0) return { errors: ['Choose a CSV file.'] };
  if (file.size > MAX_IMPORT_BYTES) return { errors: ['File is too large (max 1 MB).'] };

  const { rows, errors } = parseTradelineCsv(await file.text());
  if (errors.length) return { errors: errors.slice(0, 20) };

  const supabase = await createClient();
  const { data: profile } = await supabase.from('users').select('org_id').single();
  if (!profile) return { errors: ['Not authorized.'] };

  // RLS restricts all inserts to the caller's organization.
  const { data: report, error: reportErr } = await supabase
    .from('credit_reports')
    .insert({
      org_id: profile.org_id,
      client_id: clientId.data,
      source: 'other',
      status: 'pending_review',
    })
    .select('id')
    .single();
  if (reportErr || !report) return { errors: ['Could not create the credit report.'] };

  const { error: rowsErr } = await supabase.from('tradelines').insert(
    rows.map((r) => ({
      ...r,
      org_id: profile.org_id,
      client_id: clientId.data,
      report_id: report.id,
    })),
  );
  if (rowsErr) {
    await supabase.from('credit_reports').delete().eq('id', report.id);
    return { errors: ['Could not save tradelines.'] };
  }
  redirect('/dashboard/disputes');
}
