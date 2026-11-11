import { NextResponse } from 'next/server';
import { audit } from '@/lib/audit';
import { currentSession } from '@/lib/auth/context';
import { withTenant } from '@/lib/db';
import { getObject } from '@/lib/storage';
import { isUuid } from '@/lib/util';

export const dynamic = 'force-dynamic';

/** Decrypts and streams a stored document. Row-level security decides who may see it (staff: their org; client: their own). */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await currentSession();
  if (!s || !isUuid(id)) return new NextResponse('Not found', { status: 404 });
  const doc = await withTenant(s.userId, async (db) => {
    const d = await db.row<{ file_name: string; mime_type: string; storage_key: string; client_id: string }>('select file_name, mime_type, storage_key, client_id from public.documents where id = $1', [id]);
    if (d && s.role !== 'client') await audit(db, { orgId: s.orgId, actorId: s.userId, action: 'document.downloaded', entityType: 'document', entityId: id });
    return d;
  });
  if (!doc) return new NextResponse('Not found', { status: 404 });
  let bytes: Buffer;
  try { bytes = await getObject(doc.storage_key); } catch { return new NextResponse('File unavailable', { status: 410 }); }
  const safeName = doc.file_name.replace(/[^\w.\- ]+/g, '_');
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': doc.mime_type,
      'content-disposition': `attachment; filename="${safeName}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
}
