import { NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth/context';
import { withTenant } from '@/lib/db';
import { isStaffRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

const esc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Staff-only quick search. Runs under row-level security, so it can only ever return the caller's own organization. */
export async function GET(req: Request) {
  const s = await currentSession();
  if (!s || !isStaffRole(s.role) || s.role === 'client') return new NextResponse('Not found', { status: 404 });
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim().slice(0, 60);
  if (q.length < 2) return NextResponse.json({ results: [] });
  const like = `%${esc(q)}%`;
  const results = await withTenant(s.userId, async (db) => {
    const [clients, disputes, letters] = await Promise.all([
      db.rows<{ id: string; full_name: string; email: string | null; status: string }>('select id, full_name, email, status from public.clients where full_name ilike $1 or email ilike $1 or phone ilike $1 order by last_activity_at desc limit 5', [like]),
      db.rows<{ id: string; item_label: string; status: string; client_name: string }>('select d.id, d.item_label, d.status, c.full_name as client_name from public.disputes d join public.clients c on c.id = d.client_id where d.item_label ilike $1 or c.full_name ilike $1 order by d.updated_at desc limit 5', [like]),
      db.rows<{ id: string; title: string; status: string; client_name: string }>('select l.id, l.title, l.status, c.full_name as client_name from public.letters l join public.clients c on c.id = l.client_id where l.title ilike $1 order by l.created_at desc limit 4', [like]),
    ]);
    return [
      ...clients.map((c) => ({ type: 'Client', title: c.full_name, sub: c.email ?? c.status, href: `/app/clients/${c.id}` })),
      ...disputes.map((d) => ({ type: 'Dispute', title: d.item_label, sub: `${d.client_name} · ${d.status.replace(/_/g, ' ')}`, href: `/app/disputes/${d.id}` })),
      ...letters.map((l) => ({ type: 'Letter', title: l.title, sub: `${l.client_name} · ${l.status.replace(/_/g, ' ')}`, href: `/app/letters/${l.id}` })),
    ];
  });
  return NextResponse.json({ results }, { headers: { 'cache-control': 'private, no-store' } });
}
