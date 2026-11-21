import { NextResponse } from 'next/server';
import { loadClientAgreements, renderFor } from '@/lib/agreements';
import { apiSession } from '@/lib/auth/context';
import { readingCopyBlocks } from '@/lib/compliance/consent-pdf';
import { isConsentKind, isRendered } from '@/lib/compliance/disclosures';
import { withTenant } from '@/lib/db';
import { renderPdfBlocks } from '@/lib/letters/pdf';

export const dynamic = 'force-dynamic';

/**
 * A reading copy, as a PDF, of a document the signed-in client has not signed yet, built exactly as their page shows
 * it today. The consent to electronic records asks the client to open it before agreeing: that is how they show they
 * can open the PDF copies the agency will give them (15 U.S.C. § 7001(c)(1)(C)(ii)). Clients only; nothing is stored.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const s = await apiSession();
  if (!s || s.role !== 'client' || !isConsentKind(kind)) return new NextResponse('Not found', { status: 404 });
  const r = await withTenant(s.userId, async (db) => {
    const client = await db.row<{ id: string }>('select id from public.clients where portal_user_id = $1', [s.userId]);
    const a = client ? await loadClientAgreements(db, s.orgId, client.id) : null;
    return a ? renderFor(a, kind) : null;
  });
  if (!r || !isRendered(r)) return new NextResponse('Not found', { status: 404 });
  const pdf = renderPdfBlocks(readingCopyBlocks(r.doc.title, r.blocks), { title: r.doc.title, footerNote: 'Copy for reading. Not signed.' });
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${kind.replace(/_/g, '-')}.pdf"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
