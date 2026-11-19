import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { Ctx } from '@/lib/auth/context';
import { buildSetupChecklist } from '@/lib/setup/checklist';
import { loadSetupSnapshot } from '@/lib/setup/snapshot';

/** Dashboard: one line for owners and admins while a setup step their own workspace can finish is still open (never for the host's environment settings). Nothing otherwise. */
export async function SetupNudge({ ctx }: { ctx: Ctx }) {
  if (!ctx.can('settings:manage')) return null;
  const list = buildSetupChecklist(await loadSetupSnapshot(ctx));
  if (list.actionable.length === 0) return null;
  const open = list.actionable.map((t) => t.toLowerCase());
  return (
    <p className="mb-4 text-sm text-muted">
      Setup is not finished ({open.join(', ')}).{' '}
      <Link href="/app/setup" className="link inline-flex items-center gap-1">Finish setup <ArrowRight size={14} aria-hidden /></Link>
    </p>
  );
}
