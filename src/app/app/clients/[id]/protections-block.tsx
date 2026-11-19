import { Badge, Section } from '@/components/ui';
import type { Ctx } from '@/lib/auth/context';
import { PROTECTION_GROUPS, PROTECTION_KIND_LABEL, protectionTicks } from '@/lib/credit/protections';
import { fmtDate } from '@/lib/util';

/**
 * What the client says they placed themselves on "Protect your file" in the portal: security freezes, fraud alerts,
 * opt-outs. Read-only for staff. The agency never submits these for a client (a freeze is requested directly by the
 * consumer, 15 U.S.C. 1681c-1(i)(2)) and the database refuses a tick from anyone but the client (migration 0022).
 */
export async function ProtectionsBlock({ ctx, clientId }: { ctx: Ctx; clientId: string }) {
  const row = await ctx.tx((db) => db.row<{ file_protections: unknown; portal_user_id: string | null }>('select file_protections, portal_user_id from public.clients where id = $1', [clientId]));
  if (!row) return null;
  const ticks = protectionTicks(row.file_protections);
  const marked = PROTECTION_GROUPS.flatMap((g) => g.options.filter((o) => ticks[o.key]).map((o) => ({ g, o })));
  return (
    <Section plain id="protections" title="Freezes, alerts and opt-outs"
      hint="Marked by the client in their portal, as steps they took themselves. Staff cannot place or mark these. A freeze does not remove or correct anything; lifting one is also the client’s own step.">
      {marked.length === 0 ? (
        <p className="text-sm text-muted">{row.portal_user_id ? 'The client has not marked any yet.' : 'The client has no portal access yet, so nothing can be marked.'}</p>
      ) : (
        <ul className="divide-y divide-line/70 text-sm">
          {marked.map(({ g, o }) => (
            <li key={o.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0">
              <span className="min-w-0"><span className="font-medium">{g.name}</span> <span className="text-[0.8125rem] text-muted">· {PROTECTION_KIND_LABEL[o.kind].en}</span></span>
              <Badge tone="ok">Client marked {fmtDate(ticks[o.key])}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
