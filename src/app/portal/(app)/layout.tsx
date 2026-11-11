import type { ReactNode } from 'react';
import { PortalShell } from '@/components/portal-shell';
import { brandCss } from '@/lib/brand';
import { portalContext } from '@/lib/portal';

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const { ctx, client, lang } = await portalContext();
  const color = await ctx.tx((db) => db.row<{ c: string | null }>("select settings->>'brand_color' as c from public.organizations where id = $1", [ctx.orgId]));
  const css = brandCss(color?.c);
  return (
    <div className="brand-scope">
      {css && <style dangerouslySetInnerHTML={{ __html: css }} />}
      <PortalShell lang={lang} orgName={ctx.session.orgName} name={client.full_name}>{children}</PortalShell>
    </div>
  );
}
