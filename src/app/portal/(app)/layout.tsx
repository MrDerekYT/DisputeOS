import type { ReactNode } from 'react';
import { CreditGuide } from '@/components/credit-guide';
import { PortalShell } from '@/components/portal-shell';
import { brandCss } from '@/lib/brand';
import { guideLabels, guideStarters } from '@/lib/guide/labels';
import { portalContext } from '@/lib/portal';

// Server actions under this layout may wait on an AI provider for up to 30 s (TIMEOUT_MS in src/lib/ai/provider.ts).
// The host must not stop the request before that call returns and its charge is settled or refunded.
export const maxDuration = 60;

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const { ctx, client, lang } = await portalContext();
  const color = await ctx.tx((db) => db.row<{ c: string | null }>("select settings->>'brand_color' as c from public.organizations where id = $1", [ctx.orgId]));
  const css = brandCss(color?.c);
  return (
    <div className="brand-scope">
      {css && <style dangerouslySetInnerHTML={{ __html: css }} />}
      <PortalShell lang={lang} orgName={ctx.session.orgName} name={client.full_name}>{children}</PortalShell>
      <CreditGuide audience="portal" labels={guideLabels('portal', lang)} starters={guideStarters('portal', lang)} />
    </div>
  );
}
