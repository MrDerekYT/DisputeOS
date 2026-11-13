import { NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth/context';
import { withTenant } from '@/lib/db';
import { currentBody } from '@/lib/letters/service';
import { renderPdf } from '@/lib/letters/pdf';
import { audit } from '@/lib/audit';
import { isUuid } from '@/lib/util';

export const dynamic = 'force-dynamic';

/** PDF of a letter's current version. Row-level security decides visibility: staff see their org's letters, clients only approved/sent letters of their own. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await currentSession();
  if (!s || !isUuid(id)) return new NextResponse('Not found', { status: 404 });
  const wantVersion = Number(new URL(req.url).searchParams.get('version')) || null;

  const out = await withTenant(s.userId, async (db) => {
    const l = await db.row<{ id: string; title: string; status: string; client_id: string; current_version: number }>('select id, title, status, client_id, current_version from public.letters where id = $1', [id]);
    if (!l) return null;
    const v = wantVersion && s.role !== 'client'
      ? await db.row<{ body: string; version: number }>('select body, version from public.letter_versions where letter_id = $1 and version = $2', [id, wantVersion])
      : await currentBody(db, id);
    if (!v) return null;
    if (s.role !== 'client') await audit(db, { orgId: s.orgId, actorId: s.userId, action: 'letter.downloaded', entityType: 'letter', entityId: id, meta: { version: v.version } });
    return { l, v };
  });
  if (!out) return new NextResponse('Not found', { status: 404 });

  const final = out.l.status === 'approved' || out.l.status === 'sent';
  const pdf = renderPdf(out.v.body, { title: out.l.title, footerNote: final ? undefined : 'DRAFT — not approved for sending' });
  const name = out.l.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'letter';
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${name}-v${out.v.version}.pdf"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
