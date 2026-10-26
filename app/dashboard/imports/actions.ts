'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { audit, getStaffProfile } from '@/lib/session';
import { MAX_UPLOAD_BYTES, detectMime, storagePath } from '@/lib/upload';
import { parseReportText, type ParsedItem } from '@/lib/parser';
import { fingerprint } from '@/lib/diff';

type State = { error?: string } | undefined;
const uuid = z.string().uuid();

export async function uploadReport(_: State, formData: FormData): Promise<State> {
  const clientId = uuid.safeParse(formData.get('clientId'));
  const file = formData.get('file');
  if (!clientId.success) return { error: 'invalid' };
  if (!(file instanceof File) || file.size === 0) return { error: 'noFile' };
  if (file.size > MAX_UPLOAD_BYTES) return { error: 'tooLarge' };

  const supabase = await createClient();
  const me = await getStaffProfile(supabase);
  if (!me) return { error: 'unauthorized' };
  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientId.data)
    .single();
  if (!client) return { error: 'unauthorized' }; // RLS hides other orgs' clients

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = detectMime(bytes);
  if (!mime) return { error: 'badType' };

  const path = storagePath(me.org_id, clientId.data, file.name);
  const { error: upErr } = await supabase.storage
    .from('vault')
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (upErr) return { error: 'failed' };

  const { data: doc, error: docErr } = await supabase
    .from('documents')
    .insert({
      org_id: me.org_id,
      client_id: clientId.data,
      uploaded_by: me.id,
      kind: 'credit_report',
      storage_path: path,
      file_name: file.name.slice(0, 200),
      mime_type: mime,
    })
    .select('id')
    .single();
  if (docErr || !doc) {
    await supabase.storage.from('vault').remove([path]);
    return { error: 'failed' };
  }
  await audit(supabase, me, 'document.upload', 'document', doc.id, { mime });

  // PDFs/images are vaulted now; OCR parsing arrives with the OCR provider (Phase 5).
  if (mime !== 'text/plain' && mime !== 'text/html')
    redirect(`/dashboard/clients/${clientId.data}?stored=1`);

  let items: ParsedItem[];
  try {
    items = parseReportText(
      new TextDecoder().decode(bytes),
      mime === 'text/html' ? 'html' : 'text',
    );
  } catch {
    return { error: 'failed' };
  }
  if (!items.length) redirect(`/dashboard/clients/${clientId.data}?noitems=1`);

  const { data: imp, error: impErr } = await supabase
    .from('report_imports')
    .insert({
      org_id: me.org_id,
      client_id: clientId.data,
      document_id: doc.id,
      parsed: items,
      created_by: me.id,
    })
    .select('id')
    .single();
  if (impErr || !imp) return { error: 'failed' };
  await audit(supabase, me, 'report.parse', 'report_import', imp.id, { items: items.length });
  redirect(`/dashboard/imports/${imp.id}`);
}

const money = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/);

export async function approveImport(importId: string, formData: FormData): Promise<void> {
  if (!uuid.safeParse(importId).success) return;
  const supabase = await createClient();
  const me = await getStaffProfile(supabase);
  if (!me) return;
  const { data: imp } = await supabase
    .from('report_imports')
    .select('id, client_id, document_id, status, parsed')
    .eq('id', importId)
    .single();
  if (!imp || imp.status !== 'pending_review') return;

  const parsed = imp.parsed as ParsedItem[];
  const rows = parsed.flatMap((it, i) => {
    if (formData.get(`include_${i}`) !== 'on') return [];
    const creditor =
      String(formData.get(`creditor_${i}`) ?? '')
        .trim()
        .slice(0, 200) || it.creditor_name.value;
    if (!creditor || !it.bureau.value) return []; // bureau is required; reviewer must fix the source
    const last4 = String(formData.get(`last4_${i}`) ?? '').trim();
    const bal = money.safeParse(formData.get(`balance_${i}`));
    const balanceCents = bal.success ? Math.round(Number(bal.data) * 100) : it.balance_cents.value;
    const acct = /^[0-9A-Za-z]{0,4}$/.test(last4) ? last4 || null : it.account_last4.value;
    return [
      {
        org_id: me.org_id,
        client_id: imp.client_id,
        bureau: it.bureau.value,
        item_type: it.item_type.value,
        creditor_name: creditor,
        original_creditor: it.original_creditor.value,
        account_last4: acct,
        balance_cents: balanceCents,
        account_status: it.account_status.value,
        date_opened: it.date_opened.value,
        date_reported: it.date_reported.value,
        date_of_first_delinquency: it.date_of_first_delinquency.value,
        confidence: Math.round(it.confidence * 100) / 100,
        fingerprint: fingerprint({
          bureau: it.bureau.value,
          creditor_name: creditor,
          account_last4: acct,
        }),
      },
    ];
  });
  if (!rows.length) return;

  const { data: report } = await supabase
    .from('credit_reports')
    .insert({
      org_id: me.org_id,
      client_id: imp.client_id,
      document_id: imp.document_id,
      status: 'approved',
      report_date: new Date().toISOString().slice(0, 10),
    })
    .select('id')
    .single();
  if (!report) return;
  const { error } = await supabase
    .from('tradelines')
    .insert(rows.map((r) => ({ ...r, report_id: report.id })));
  if (error) {
    await supabase.from('credit_reports').delete().eq('id', report.id);
    return;
  }
  await supabase
    .from('report_imports')
    .update({ status: 'approved', report_id: report.id })
    .eq('id', importId);
  await audit(supabase, me, 'report.approve', 'report_import', importId, { items: rows.length });
  redirect(`/dashboard/clients/${imp.client_id}`);
}

export async function rejectImport(importId: string): Promise<void> {
  if (!uuid.safeParse(importId).success) return;
  const supabase = await createClient();
  const me = await getStaffProfile(supabase);
  if (!me) return;
  const { data: imp } = await supabase
    .from('report_imports')
    .update({ status: 'rejected' })
    .eq('id', importId)
    .eq('status', 'pending_review')
    .select('client_id')
    .single();
  if (!imp) return;
  await audit(supabase, me, 'report.reject', 'report_import', importId);
  redirect(`/dashboard/clients/${imp.client_id}`);
}
