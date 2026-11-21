import { NextResponse } from 'next/server';
import { loadAgency } from '@/lib/agreements';
import { audit } from '@/lib/audit';
import { apiSession } from '@/lib/auth/context';
import { copyTitle, signedCopyBlocks, type SignedConsent } from '@/lib/compliance/consent-pdf';
import { signatureSource } from '@/lib/compliance/disclosures';
import { withTenant } from '@/lib/db';
import { renderPdfBlocks } from '@/lib/letters/pdf';
import { isUuid } from '@/lib/util';

export const dynamic = 'force-dynamic';

/**
 * The PDF copy of one signed agreement: the exact text stored with the signature, the signature block, and for the
 * service agreement the Notice of Cancellation twice (15 U.S.C. § 1679e(b), (c)). For a paper signature recorded by
 * staff it is the app's text on the recording day, labelled as such (src/lib/compliance/consent-pdf.ts); in a personal
 * workspace, the account holder's own consent, labelled as given by them. Row-level security decides who may
 * read it: staff of the client's agency, and the client themselves. A signature recorded before texts were stored has
 * no copy (404); the client page shows "Signed <date>" for it, as before.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await apiSession();
  if (!s || !isUuid(id)) return new NextResponse('Not found', { status: 404 });
  const out = await withTenant(s.userId, async (db) => {
    const row = await db.row<SignedConsent & { org_id: string; client_id: string }>(
      'select org_id, client_id, kind, text_shown, text_sha256, signed_name, signed_at, ip, recorded_by, signed_on::text, revoked_at from public.client_consents where id = $1 and text_shown is not null', [id]);
    if (!row) return null;
    const agency = await loadAgency(db, row.org_id);
    if (s.role !== 'client') await audit(db, { orgId: s.orgId, actorId: s.userId, action: 'consent.copy_downloaded', entityType: 'client', entityId: row.client_id, meta: { consent_id: id, kind: row.kind } });
    return { row, agency };
  });
  if (!out) return new NextResponse('Not found', { status: 404 });
  // A paper signature recorded by staff stores the app's text on the recording day, not a copy of the paper: its PDF
  // and file name say so, and never call it a signed copy. A personal workspace's own consent says who gave it.
  const source = signatureSource(out.row, out.agency.personal);
  const pdf = renderPdfBlocks(signedCopyBlocks(out.row, out.agency.tz, out.agency.agencyName, source), { title: copyTitle(out.row.kind, source) });
  const day = new Date(out.row.signed_at).toISOString().slice(0, 10);
  const named = { portal: 'signed', paper: 'app-text-recorded', self: 'given' } as const;
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${out.row.kind.replace(/_/g, '-')}-${named[source]}-${day}.pdf"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
